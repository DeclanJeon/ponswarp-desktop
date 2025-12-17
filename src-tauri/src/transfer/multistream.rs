//! QUIC 멀티스트림 전송 모듈
//!
//! TB급 파일 전송 시 단일 스트림의 Head-of-Line Blocking을 방지하고
//! 대역폭을 최대한 활용하기 위해 다중 스트림으로 동시 전송합니다.
//!
//! 전략:
//! - 파일을 4MB~16MB 블록으로 분할
//! - 각 블록을 독립적인 QUIC 스트림으로 전송
//! - 수신 측에서 블록 순서 재조립

use std::path::PathBuf;
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::{mpsc, RwLock, Semaphore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use anyhow::Result;
use tracing::{info, warn, debug};
use serde::{Deserialize, Serialize};

use super::zero_copy_io::{BlockInfo, split_file_into_blocks, HighPerformanceFileSender};

/// 동시 스트림 수 (QUIC max_concurrent_bidi_streams와 연동)
pub const MAX_CONCURRENT_STREAMS: usize = 32;

/// 블록 크기 (8MB - 대역폭과 지연 시간의 균형)
pub const BLOCK_SIZE: usize = 8 * 1024 * 1024;

/// 멀티스트림 전송 매니페스트
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiStreamManifest {
    pub job_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub block_size: u32,
    pub total_blocks: u32,
    pub checksum: Option<String>,
}

/// 블록 헤더 (각 스트림의 첫 부분에 전송)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockHeader {
    pub job_id: String,
    pub block_index: u32,
    pub offset: u64,
    pub size: u32,
    pub checksum: u32, // CRC32
}

impl BlockHeader {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        Ok(serde_json::from_slice(data)?)
    }
}


/// 멀티스트림 전송 진행률
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiStreamProgress {
    pub job_id: String,
    pub blocks_completed: u32,
    pub total_blocks: u32,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub active_streams: u32,
    pub speed_bps: u64,
}

/// 멀티스트림 파일 전송기 (Sender)
pub struct MultiStreamSender {
    conn: quinn::Connection,
    block_size: usize,
    max_concurrent: usize,
    progress_tx: Option<mpsc::Sender<MultiStreamProgress>>,
}

impl MultiStreamSender {
    pub fn new(conn: quinn::Connection) -> Self {
        Self {
            conn,
            block_size: BLOCK_SIZE,
            max_concurrent: MAX_CONCURRENT_STREAMS,
            progress_tx: None,
        }
    }

    /// 블록 크기 설정
    pub fn with_block_size(mut self, size: usize) -> Self {
        self.block_size = size;
        self
    }

    /// 동시 스트림 수 설정
    pub fn with_max_concurrent(mut self, count: usize) -> Self {
        self.max_concurrent = count;
        self
    }

    /// 진행률 채널 설정
    pub fn with_progress_channel(mut self, tx: mpsc::Sender<MultiStreamProgress>) -> Self {
        self.progress_tx = Some(tx);
        self
    }

    /// 파일 전송 (멀티스트림 + Zero-Copy)
    pub async fn send_file(&self, file_path: PathBuf, job_id: &str) -> Result<u64> {
        // Zero-Copy Sender 초기화
        let file_sender = Arc::new(HighPerformanceFileSender::open(&file_path, self.block_size)?);
        let file_size = file_sender.file_size();
        let file_name = file_path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        info!("📤 멀티스트림 전송 시작 (Zero-Copy): {} ({} bytes)", file_name, file_size);

        // 블록 생성
        let blocks = file_sender.get_blocks(self.block_size);
        let total_blocks = blocks.len() as u32;

        info!("📦 {} 블록으로 분할 (블록 크기: {} bytes)", total_blocks, self.block_size);

        // 매니페스트 전송 (제어 스트림)
        let manifest = MultiStreamManifest {
            job_id: job_id.to_string(),
            file_name: file_name.clone(),
            file_size,
            block_size: self.block_size as u32,
            total_blocks,
            checksum: None,
        };

        self.send_manifest(&manifest).await?;

        // 동시성 제어를 위한 세마포어
        let semaphore = Arc::new(Semaphore::new(self.max_concurrent));
        
        // 진행률 추적
        let completed_blocks = Arc::new(RwLock::new(0u32));
        let bytes_transferred = Arc::new(RwLock::new(0u64));
        let start_time = std::time::Instant::now();

        // 블록 전송 태스크들
        let mut handles = Vec::with_capacity(blocks.len());

        for block in blocks {
            let conn = self.conn.clone();
            let sem = semaphore.clone();
            let sender = file_sender.clone(); // Arc 공유
            let job_id = job_id.to_string();
            let completed = completed_blocks.clone();
            let transferred = bytes_transferred.clone();
            let progress_tx = self.progress_tx.clone();
            let total_bytes = file_size;

            let handle = tauri::async_runtime::spawn(async move {
                // 세마포어 획득 (동시 스트림 수 제한)
                let _permit = sem.acquire().await.unwrap();

                // Zero-Copy send_block 호출
                let result = Self::send_block_zerocopy(&conn, &sender, &block, &job_id).await;

                if result.is_ok() {
                    // 진행률 업데이트
                    let mut comp = completed.write().await;
                    *comp += 1;
                    let blocks_done = *comp;
                    drop(comp);

                    let mut trans = transferred.write().await;
                    *trans += block.size as u64;
                    let bytes_done = *trans;
                    drop(trans);

                    // 진행률 이벤트
                    if let Some(tx) = progress_tx {
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed = if elapsed > 0.0 {
                            (bytes_done as f64 / elapsed) as u64
                        } else {
                            0
                        };

                        let _ = tx.send(MultiStreamProgress {
                            job_id: job_id.clone(),
                            blocks_completed: blocks_done,
                            total_blocks,
                            bytes_transferred: bytes_done,
                            total_bytes,
                            active_streams: sem.available_permits() as u32,
                            speed_bps: speed,
                        }).await;
                    }
                }

                result
            });

            handles.push(handle);
        }

        // 모든 블록 전송 완료 대기
        let mut total_sent = 0u64;
        for handle in handles {
            match handle.await {
                Ok(Ok(bytes)) => total_sent += bytes,
                Ok(Err(e)) => warn!("블록 전송 실패: {}", e),
                Err(e) => warn!("태스크 실패: {}", e),
            }
        }

        // 완료 신호 전송
        self.send_completion_signal(job_id).await?;

        info!("✅ 멀티스트림 전송 완료: {} bytes", total_sent);
        Ok(total_sent)
    }


    /// 매니페스트 전송 (제어 스트림)
    async fn send_manifest(&self, manifest: &MultiStreamManifest) -> Result<()> {
        let (mut send, mut recv) = self.conn.open_bi().await?;

        // 매니페스트 타입 마커
        send.write_all(b"MNFT").await?;
        
        let manifest_json = serde_json::to_vec(manifest)?;
        let len = manifest_json.len() as u32;
        send.write_all(&len.to_le_bytes()).await?;
        send.write_all(&manifest_json).await?;
        send.finish()?;

        // ACK 대기
        let mut ack = [0u8; 4];
        recv.read_exact(&mut ack).await?;
        if &ack != b"MACK" {
            return Err(anyhow::anyhow!("Manifest ACK failed"));
        }

        debug!("📋 매니페스트 전송 완료");
        Ok(())
    }

    /// 최적화된 블록 전송 (스레드 차단 방지 적용)
    async fn send_block_zerocopy(
        conn: &quinn::Connection,
        sender: &Arc<HighPerformanceFileSender>, // Arc로 공유
        block: &BlockInfo,
        job_id: &str,
    ) -> Result<u64> {
        let (mut send, mut recv) = conn.open_bi().await?;

        // 1. 헤더 전송 (가벼운 작업이므로 바로 처리)
        let header = BlockHeader {
            job_id: job_id.to_string(),
            block_index: block.index,
            offset: block.offset,
            size: block.size,
            checksum: 0,
        };
        send.write_all(b"BLCK").await?;
        let header_json = header.to_bytes();
        let header_len = header_json.len() as u32;
        send.write_all(&header_len.to_le_bytes()).await?;
        send.write_all(&header_json).await?;

        // 2. [핵심 수정] 데이터 읽기 작업을 Blocking 스레드로 격리
        // 네트워크 스레드(Tokio Core)가 디스크 I/O 때문에 멈추는 것을 방지
        let sender_clone = sender.clone();
        let block_clone = block.clone();

        // 🚀 [핵심 수정] 완전한 I/O 격리
        // 디스크 읽기를 전용 스레드 풀에서 처리하여 네트워크 스레드 보호
        let sender_clone = sender.clone();
        let block_clone = block.clone();

        // spawn_blocking을 사용하여 별도 스레드에서 모든 I/O 처리
        // 이 안에서 Page Fault가 발생해도 네트워크 스레드는 영향 없음
        let data = tokio::task::spawn_blocking(move || {
            // 🚀 [개선] Owned 데이터 반환으로 수명 문제 해결
            sender_clone.read_block_owned(&block_clone)
        }).await??;

        // 3. 준비된 데이터를 소켓에 씀 (네트워크 스레드는 보내기만 집중)
        send.write_all(&data).await?;
        send.finish()?;

        // 4. ACK 대기 (기존과 동일)
        let mut ack = [0u8; 4];
        match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            recv.read_exact(&mut ack)
        ).await {
            Ok(Ok(_)) if &ack == b"BACK" => {
                debug!("✅ 블록 {} 전송 완료", block.index);
            }
            _ => {
                warn!("⚠️ 블록 {} ACK 타임아웃 (데이터는 전송됨)", block.index);
            }
        }
        
        Ok(block.size as u64)
    }

    /// 완료 신호 전송
    async fn send_completion_signal(&self, job_id: &str) -> Result<()> {
        let (mut send, _) = self.conn.open_bi().await?;
        
        send.write_all(b"DONE").await?;
        send.write_all(job_id.as_bytes()).await?;
        send.finish()?;

        debug!("🏁 완료 신호 전송");
        Ok(())
    }
}

use tokio::io::AsyncSeekExt;


/// 멀티스트림 파일 수신기 (Receiver)
pub struct MultiStreamReceiver {
    conn: quinn::Connection,
    save_dir: PathBuf,
    progress_tx: Option<mpsc::Sender<MultiStreamProgress>>,
}

impl MultiStreamReceiver {
    pub fn new(conn: quinn::Connection, save_dir: PathBuf) -> Self {
        Self {
            conn,
            save_dir,
            progress_tx: None,
        }
    }

    /// 진행률 채널 설정
    pub fn with_progress_channel(mut self, tx: mpsc::Sender<MultiStreamProgress>) -> Self {
        self.progress_tx = Some(tx);
        self
    }

    /// 파일 수신 (멀티스트림)
    pub async fn receive_file(&self, job_id: &str) -> Result<PathBuf> {
        info!("📥 멀티스트림 수신 대기 중...");

        // 매니페스트 수신
        let manifest = self.receive_manifest().await?;
        
        if manifest.job_id != job_id {
            return Err(anyhow::anyhow!("Job ID mismatch"));
        }

        let save_path = self.save_dir.join(&manifest.file_name);
        
        // 저장 디렉토리 생성
        if let Some(parent) = save_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        info!("📥 파일 수신 시작: {} ({} bytes, {} 블록)", 
              manifest.file_name, manifest.file_size, manifest.total_blocks);

        // 파일 생성 및 크기 예약
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&save_path)
            .await?;
        file.set_len(manifest.file_size).await?;
        drop(file);

        // 블록 수신 상태 추적
        let received_blocks = Arc::new(RwLock::new(HashMap::<u32, bool>::new()));
        let bytes_received = Arc::new(RwLock::new(0u64));
        let start_time = std::time::Instant::now();

        // 블록 수신 루프
        let mut completed = false;
        while !completed {
            match self.conn.accept_bi().await {
                Ok((mut send, mut recv)) => {
                    // 스트림 타입 확인
                    let mut marker = [0u8; 4];
                    if recv.read_exact(&mut marker).await.is_err() {
                        continue;
                    }

                    match &marker {
                        b"BLCK" => {
                            // 블록 수신
                            let result = Self::receive_block(
                                &mut send,
                                &mut recv,
                                &save_path,
                            ).await;

                            if let Ok((block_index, block_size)) = result {
                                // 상태 업데이트
                                received_blocks.write().await.insert(block_index, true);
                                *bytes_received.write().await += block_size as u64;

                                // 진행률 이벤트
                                if let Some(tx) = &self.progress_tx {
                                    let blocks_done = received_blocks.read().await.len() as u32;
                                    let bytes_done = *bytes_received.read().await;
                                    let elapsed = start_time.elapsed().as_secs_f64();
                                    let speed = if elapsed > 0.0 {
                                        (bytes_done as f64 / elapsed) as u64
                                    } else {
                                        0
                                    };

                                    let _ = tx.send(MultiStreamProgress {
                                        job_id: job_id.to_string(),
                                        blocks_completed: blocks_done,
                                        total_blocks: manifest.total_blocks,
                                        bytes_transferred: bytes_done,
                                        total_bytes: manifest.file_size,
                                        active_streams: 0,
                                        speed_bps: speed,
                                    }).await;
                                }
                            }
                        }
                        b"DONE" => {
                            info!("🏁 완료 신호 수신");
                            completed = true;
                        }
                        _ => {
                            warn!("알 수 없는 스트림 타입: {:?}", marker);
                        }
                    }
                }
                Err(quinn::ConnectionError::ApplicationClosed(_)) => {
                    info!("연결 종료");
                    break;
                }
                Err(e) => {
                    warn!("스트림 수락 오류: {}", e);
                    break;
                }
            }
        }

        // 모든 블록 수신 확인
        let received = received_blocks.read().await;
        if received.len() as u32 != manifest.total_blocks {
            warn!("⚠️ 일부 블록 누락: {}/{}", received.len(), manifest.total_blocks);
        }

        info!("✅ 멀티스트림 수신 완료: {:?}", save_path);
        Ok(save_path)
    }


    /// 매니페스트 수신
    async fn receive_manifest(&self) -> Result<MultiStreamManifest> {
        loop {
            let (mut send, mut recv) = self.conn.accept_bi().await?;

            // 스트림 타입 확인
            let mut marker = [0u8; 4];
            recv.read_exact(&mut marker).await?;

            if &marker == b"MNFT" {
                // 매니페스트 길이
                let mut len_buf = [0u8; 4];
                recv.read_exact(&mut len_buf).await?;
                let len = u32::from_le_bytes(len_buf) as usize;

                // 매니페스트 데이터
                let mut manifest_buf = vec![0u8; len];
                recv.read_exact(&mut manifest_buf).await?;

                let manifest: MultiStreamManifest = serde_json::from_slice(&manifest_buf)?;

                // ACK 전송
                send.write_all(b"MACK").await?;
                send.finish()?;

                debug!("📋 매니페스트 수신: {:?}", manifest);
                return Ok(manifest);
            }
        }
    }

    /// 단일 블록 수신
    async fn receive_block(
        send: &mut quinn::SendStream,
        recv: &mut quinn::RecvStream,
        save_path: &PathBuf,
    ) -> Result<(u32, u32)> {
        // 헤더 길이
        let mut len_buf = [0u8; 4];
        recv.read_exact(&mut len_buf).await?;
        let header_len = u32::from_le_bytes(len_buf) as usize;

        // 헤더 데이터
        let mut header_buf = vec![0u8; header_len];
        recv.read_exact(&mut header_buf).await?;
        let header = BlockHeader::from_bytes(&header_buf)?;

        debug!("📦 블록 {} 수신 중 (offset: {}, size: {})", 
               header.block_index, header.offset, header.size);

        // 블록 데이터 수신
        let mut buffer = vec![0u8; header.size as usize];
        recv.read_exact(&mut buffer).await?;

        // 파일에 쓰기 (특정 오프셋)
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(save_path)
            .await?;
        file.seek(std::io::SeekFrom::Start(header.offset)).await?;
        file.write_all(&buffer).await?;
        file.sync_data().await?;

        // ACK 전송
        send.write_all(b"BACK").await?;
        let _ = send.finish();

        debug!("✅ 블록 {} 저장 완료", header.block_index);
        Ok((header.block_index, header.size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_block_header_serialization() {
        let header = BlockHeader {
            job_id: "test-job".to_string(),
            block_index: 5,
            offset: 1024 * 1024 * 40, // 40MB offset
            size: 8 * 1024 * 1024,    // 8MB
            checksum: 0x12345678,
        };

        let bytes = header.to_bytes();
        let parsed = BlockHeader::from_bytes(&bytes).unwrap();

        assert_eq!(parsed.job_id, header.job_id);
        assert_eq!(parsed.block_index, header.block_index);
        assert_eq!(parsed.offset, header.offset);
        assert_eq!(parsed.size, header.size);
    }

    #[test]
    fn test_manifest_serialization() {
        let manifest = MultiStreamManifest {
            job_id: "test-job".to_string(),
            file_name: "large_file.zip".to_string(),
            file_size: 100 * 1024 * 1024 * 1024, // 100GB
            block_size: 8 * 1024 * 1024,
            total_blocks: 12800,
            checksum: Some("abc123".to_string()),
        };

        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: MultiStreamManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.file_size, manifest.file_size);
        assert_eq!(parsed.total_blocks, manifest.total_blocks);
    }
}
