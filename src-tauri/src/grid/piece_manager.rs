//! PieceManager - 파일 조각 및 검증 관리
//!
//! 파일을 논리적으로 조각(Piece)으로 나누고, 각 조각의 해시를 관리합니다.
//! Merkle Tree 기반 검증으로 데이터 무결성을 보장합니다.

use crate::grid::bitfield::Bitfield;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/// 파일 조각 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PieceInfo {
    pub index: usize,
    pub offset: u64,
    pub length: u32,
    pub hash: [u8; 32], // SHA-256 해시
}

/// 파일 메타데이터 (토렌트의 .torrent 파일과 유사)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub info_hash: [u8; 32],      // 전체 파일 식별자
    pub file_name: String,
    pub file_size: u64,
    pub piece_size: u32,
    pub total_pieces: usize,
    pub piece_hashes: Vec<[u8; 32]>, // 각 조각의 해시
    pub merkle_root: Option<[u8; 32]>, // Merkle Tree 루트 (선택적)
}

impl FileMetadata {
    /// 파일로부터 메타데이터 생성
    pub async fn from_file(path: &PathBuf, piece_size: u32) -> anyhow::Result<Self> {
        use tokio::fs::File;
        use tokio::io::{AsyncReadExt, BufReader};

        let file = File::open(path).await?;
        let file_size = file.metadata().await?.len();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let total_pieces = ((file_size + piece_size as u64 - 1) / piece_size as u64) as usize;
        let mut piece_hashes = Vec::with_capacity(total_pieces);

        let mut reader = BufReader::new(file);
        let mut buffer = vec![0u8; piece_size as usize];

        for i in 0..total_pieces {
            let bytes_to_read = if i == total_pieces - 1 {
                (file_size - (i as u64 * piece_size as u64)) as usize
            } else {
                piece_size as usize
            };

            reader.read_exact(&mut buffer[..bytes_to_read]).await?;

            let mut hasher = Sha256::new();
            hasher.update(&buffer[..bytes_to_read]);
            let hash: [u8; 32] = hasher.finalize().into();
            piece_hashes.push(hash);
        }

        // Info Hash 계산 (모든 조각 해시의 해시)
        let mut info_hasher = Sha256::new();
        for hash in &piece_hashes {
            info_hasher.update(hash);
        }
        let info_hash: [u8; 32] = info_hasher.finalize().into();

        // Merkle Root 계산 (선택적)
        let merkle_root = Self::compute_merkle_root(&piece_hashes);

        Ok(Self {
            info_hash,
            file_name,
            file_size,
            piece_size,
            total_pieces,
            piece_hashes,
            merkle_root: Some(merkle_root),
        })
    }

    /// Merkle Tree 루트 계산
    fn compute_merkle_root(hashes: &[[u8; 32]]) -> [u8; 32] {
        if hashes.is_empty() {
            return [0u8; 32];
        }
        if hashes.len() == 1 {
            return hashes[0];
        }

        let mut current_level: Vec<[u8; 32]> = hashes.to_vec();

        while current_level.len() > 1 {
            let mut next_level = Vec::new();

            for chunk in current_level.chunks(2) {
                let mut hasher = Sha256::new();
                hasher.update(&chunk[0]);
                if chunk.len() > 1 {
                    hasher.update(&chunk[1]);
                } else {
                    hasher.update(&chunk[0]); // 홀수인 경우 자기 자신과 해시
                }
                next_level.push(hasher.finalize().into());
            }

            current_level = next_level;
        }

        current_level[0]
    }

    /// Info Hash를 hex 문자열로 변환
    pub fn info_hash_hex(&self) -> String {
        hex::encode(self.info_hash)
    }
}

/// Swarm 내의 파일 상태 관리자
pub struct PieceManager {
    metadata: FileMetadata,
    pieces: Vec<PieceInfo>,
    my_bitfield: Bitfield,
    /// 현재 다운로드 중인 조각 (중복 요청 방지)
    pending_pieces: RwLock<HashMap<usize, PendingPiece>>,
    /// 저장 경로
    save_path: Option<PathBuf>,
}

/// 다운로드 중인 조각 정보
#[derive(Debug, Clone)]
pub struct PendingPiece {
    pub index: usize,
    pub requested_at: std::time::Instant,
    pub from_peer: String,
    pub received_bytes: u32,
}

impl PieceManager {
    /// 새로운 PieceManager 생성 (다운로더용 - 빈 비트필드)
    pub fn new(metadata: FileMetadata) -> Self {
        let total_pieces = metadata.total_pieces;
        let pieces = Self::build_piece_infos(&metadata);

        Self {
            metadata,
            pieces,
            my_bitfield: Bitfield::new(total_pieces),
            pending_pieces: RwLock::new(HashMap::new()),
            save_path: None,
        }
    }

    /// Seeder용 PieceManager 생성 (모든 조각 보유)
    pub fn new_seeder(metadata: FileMetadata) -> Self {
        let total_pieces = metadata.total_pieces;
        let pieces = Self::build_piece_infos(&metadata);

        Self {
            metadata,
            pieces,
            my_bitfield: Bitfield::full(total_pieces),
            pending_pieces: RwLock::new(HashMap::new()),
            save_path: None,
        }
    }

    /// 조각 정보 목록 생성
    fn build_piece_infos(metadata: &FileMetadata) -> Vec<PieceInfo> {
        let mut pieces = Vec::with_capacity(metadata.total_pieces);

        for i in 0..metadata.total_pieces {
            let offset = i as u64 * metadata.piece_size as u64;
            let length = if i == metadata.total_pieces - 1 {
                (metadata.file_size - offset) as u32
            } else {
                metadata.piece_size
            };

            pieces.push(PieceInfo {
                index: i,
                offset,
                length,
                hash: metadata.piece_hashes[i],
            });
        }

        pieces
    }

    /// 저장 경로 설정
    pub fn set_save_path(&mut self, path: PathBuf) {
        self.save_path = Some(path);
    }

    /// 데이터 무결성 검증
    pub fn verify_piece(&self, index: usize, data: &[u8]) -> bool {
        if index >= self.pieces.len() {
            warn!("Invalid piece index: {}", index);
            return false;
        }

        let piece = &self.pieces[index];
        if data.len() as u32 != piece.length {
            warn!(
                "Piece {} length mismatch: expected {}, got {}",
                index,
                piece.length,
                data.len()
            );
            return false;
        }

        let mut hasher = Sha256::new();
        hasher.update(data);
        let hash: [u8; 32] = hasher.finalize().into();

        if hash != piece.hash {
            warn!("Piece {} hash mismatch", index);
            return false;
        }

        debug!("Piece {} verified successfully", index);
        true
    }

    /// 조각 완료 표시
    pub fn mark_completed(&mut self, index: usize) {
        self.my_bitfield.mark(index);
        info!(
            "Piece {} completed. Progress: {:.1}%",
            index,
            self.my_bitfield.progress() * 100.0
        );
    }

    /// 조각 요청 등록 (중복 요청 방지)
    pub async fn request_piece(&self, index: usize, peer_id: &str) -> bool {
        let mut pending = self.pending_pieces.write().await;

        if pending.contains_key(&index) {
            return false; // 이미 요청 중
        }

        pending.insert(
            index,
            PendingPiece {
                index,
                requested_at: std::time::Instant::now(),
                from_peer: peer_id.to_string(),
                received_bytes: 0,
            },
        );

        true
    }

    /// 조각 요청 완료/취소
    pub async fn complete_request(&self, index: usize) {
        self.pending_pieces.write().await.remove(&index);
    }

    /// 타임아웃된 요청 정리 (30초 이상 경과)
    pub async fn cleanup_stale_requests(&self) -> Vec<usize> {
        let mut pending = self.pending_pieces.write().await;
        let now = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(30);

        let stale: Vec<usize> = pending
            .iter()
            .filter(|(_, p)| now.duration_since(p.requested_at) > timeout)
            .map(|(&idx, _)| idx)
            .collect();

        for idx in &stale {
            pending.remove(idx);
        }

        stale
    }

    /// 비트필드 반환
    pub fn get_bitfield(&self) -> &Bitfield {
        &self.my_bitfield
    }

    /// 메타데이터 반환
    pub fn get_metadata(&self) -> &FileMetadata {
        &self.metadata
    }

    /// 조각 정보 반환
    pub fn get_piece_info(&self, index: usize) -> Option<&PieceInfo> {
        self.pieces.get(index)
    }

    /// 총 조각 수
    pub fn total_pieces(&self) -> usize {
        self.metadata.total_pieces
    }

    /// 완료된 조각 수
    pub fn completed_pieces(&self) -> usize {
        self.my_bitfield.count_ones()
    }

    /// 진행률
    pub fn progress(&self) -> f32 {
        self.my_bitfield.progress()
    }

    /// 완료 여부
    pub fn is_complete(&self) -> bool {
        self.my_bitfield.is_complete()
    }

    /// 미보유 조각 목록
    pub fn missing_pieces(&self) -> Vec<usize> {
        self.my_bitfield.missing_pieces()
    }

    /// Info Hash
    pub fn info_hash(&self) -> &[u8; 32] {
        &self.metadata.info_hash
    }

    /// 소스 파일 경로 설정 (Seeder용)
    pub fn set_source_path(&mut self, path: PathBuf) {
        self.save_path = Some(path);
    }

    /// 파일에서 조각 데이터 읽기 (Seeder용)
    pub async fn read_piece(&self, index: usize) -> anyhow::Result<Vec<u8>> {
        use tokio::fs::File;
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let piece = self.pieces.get(index)
            .ok_or_else(|| anyhow::anyhow!("Invalid piece index: {}", index))?;

        let path = self.save_path.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Source path not set"))?;

        let mut file = File::open(path).await?;
        file.seek(std::io::SeekFrom::Start(piece.offset)).await?;

        let mut buffer = vec![0u8; piece.length as usize];
        file.read_exact(&mut buffer).await?;

        Ok(buffer)
    }

    /// 파일에 조각 데이터 쓰기 (Leecher용)
    pub async fn write_piece(&mut self, index: usize, data: &[u8]) -> anyhow::Result<()> {
        use tokio::fs::OpenOptions;
        use tokio::io::{AsyncSeekExt, AsyncWriteExt};

        let piece = self.pieces.get(index)
            .ok_or_else(|| anyhow::anyhow!("Invalid piece index: {}", index))?;

        if data.len() as u32 != piece.length {
            return Err(anyhow::anyhow!(
                "Piece {} length mismatch: expected {}, got {}",
                index, piece.length, data.len()
            ));
        }

        // 해시 검증
        if !self.verify_piece(index, data) {
            return Err(anyhow::anyhow!("Piece {} hash verification failed", index));
        }

        let path = self.save_path.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Save path not set"))?;

        // 파일이 없으면 생성하고 크기 할당
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .open(path)
            .await?;

        // 파일 크기 확보 (sparse file)
        file.set_len(self.metadata.file_size).await?;

        // 해당 위치에 쓰기
        file.seek(std::io::SeekFrom::Start(piece.offset)).await?;
        file.write_all(data).await?;
        file.flush().await?;

        // 완료 표시
        self.mark_completed(index);

        info!("📝 Piece {} written to disk", index);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_metadata() -> FileMetadata {
        FileMetadata {
            info_hash: [0u8; 32],
            file_name: "test.bin".to_string(),
            file_size: 10 * 1024 * 1024, // 10MB
            piece_size: 1024 * 1024,      // 1MB
            total_pieces: 10,
            piece_hashes: vec![[0u8; 32]; 10],
            merkle_root: None,
        }
    }

    #[test]
    fn test_piece_manager_creation() {
        let metadata = create_test_metadata();
        let pm = PieceManager::new(metadata);

        assert_eq!(pm.total_pieces(), 10);
        assert_eq!(pm.completed_pieces(), 0);
        assert!(!pm.is_complete());
    }

    #[test]
    fn test_seeder_creation() {
        let metadata = create_test_metadata();
        let pm = PieceManager::new_seeder(metadata);

        assert_eq!(pm.total_pieces(), 10);
        assert_eq!(pm.completed_pieces(), 10);
        assert!(pm.is_complete());
    }

    #[test]
    fn test_mark_completed() {
        let metadata = create_test_metadata();
        let mut pm = PieceManager::new(metadata);

        pm.mark_completed(0);
        pm.mark_completed(5);

        assert_eq!(pm.completed_pieces(), 2);
        assert!((pm.progress() - 0.2).abs() < 0.001);
    }
}
