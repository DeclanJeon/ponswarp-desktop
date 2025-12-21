//! 파일 전송 모듈 - QUIC 기반 P2P 파일 전송
//!
//! WebRTC를 대체하여 Native 환경에서 파일 전송을 담당합니다.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::{mpsc, RwLock};
use anyhow::Result;
use tracing::{info, warn};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use zip::write::FileOptions;
use std::io::Write;

/// 전송 상태
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferState {
    Idle,
    Preparing,
    Connecting,
    Transferring,
    Completed,
    Failed(String),
}

/// 전송 진행률 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub job_id: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub progress_percent: f64,
    pub speed_bps: u64,
    pub state: TransferState,
}

/// 파일 메타데이터
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub name: String,
    pub size: u64,
    pub mime_type: Option<String>,
    pub checksum: Option<String>,
}

/// 전송 매니페스트
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferManifest {
    pub job_id: String,
    pub files: Vec<FileMetadata>,
    pub total_size: u64,
    pub is_folder: bool,
    pub root_name: String,
}

/// 청크 크기 (1MB - 고속 전송을 위해 증가)
const CHUNK_SIZE: usize = 1024 * 1024;

/// 파일 전송 엔진
pub struct FileTransferEngine {
    state: Arc<RwLock<TransferState>>,
    progress_tx: Option<mpsc::Sender<TransferProgress>>,
    current_job_id: Arc<RwLock<Option<String>>>,
}

impl FileTransferEngine {
    pub fn new() -> Self {
        Self {
            state: Arc::new(RwLock::new(TransferState::Idle)),
            progress_tx: None,
            current_job_id: Arc::new(RwLock::new(None)),
        }
    }

    /// 진행률 채널 설정
    pub fn set_progress_channel(&mut self, tx: mpsc::Sender<TransferProgress>) {
        self.progress_tx = Some(tx);
    }

    /// 현재 상태 조회
    pub async fn get_state(&self) -> TransferState {
        self.state.read().await.clone()
    }

    /// 상태 업데이트 및 이벤트 발생
    async fn update_state(&self, new_state: TransferState) {
        let mut state = self.state.write().await;
        *state = new_state;
    }

    /// 진행률 보고
    async fn report_progress(&self, job_id: &str, bytes_transferred: u64, total_bytes: u64, speed_bps: u64) {
        let progress = TransferProgress {
            job_id: job_id.to_string(),
            bytes_transferred,
            total_bytes,
            progress_percent: if total_bytes > 0 {
                (bytes_transferred as f64 / total_bytes as f64) * 100.0
            } else {
                0.0
            },
            speed_bps,
            state: self.state.read().await.clone(),
        };

        if let Some(tx) = &self.progress_tx {
            let _ = tx.send(progress).await;
        }
    }

    /// QUIC 스트림을 통해 파일/폴더 목록 전송 (Sender)
    pub async fn send_files(
        &self,
        conn: &quinn::Connection,
        paths: Vec<PathBuf>,
        job_id: &str,
    ) -> Result<u64> {
        self.update_state(TransferState::Preparing).await;
        *self.current_job_id.write().await = Some(job_id.to_string());

        if paths.is_empty() {
            return Err(anyhow::anyhow!("No files to send"));
        }

        let mut files_metadata = Vec::new();
        let mut absolute_paths = Vec::new();
        
        // 루트 이름 결정 (단일 항목이면 해당 이름, 다수면 "Multiple Files")
        let root_name = if paths.len() == 1 {
            paths[0].file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string())
        } else {
            "Multiple Files".to_string()
        };

        let is_folder = paths.len() > 1 || (paths.len() == 1 && tokio::fs::metadata(&paths[0]).await?.is_dir());

        if paths.len() > 1 || (paths.len() == 1 && tokio::fs::metadata(&paths[0]).await?.is_dir()) {
            // 다중 파일 또는 폴더인 경우 ZIP 압축
            let (zip_path, zip_name, zip_size) = Self::create_zip_archive(&paths).await?;
            info!("📦 ZIP 압축 완료: {} ({} bytes)", zip_path.display(), zip_size);

            files_metadata.push(FileMetadata {
                name: zip_name.clone(),
                size: zip_size,
                mime_type: Some("application/zip".to_string()),
                checksum: None,
            });
            absolute_paths.push(zip_path);
            
            // ZIP 파일 하나로 취급하므로 root_name은 ZIP 파일명(확장자 제외)으로 설정하거나
            // 원본 의도를 살려 "Multiple Files" 등으로 유지할 수 있음.
            // 여기서는 zip_name 사용
        } else {
            // 단일 파일인 경우 기존 로직
            let path = &paths[0];
            let metadata = tokio::fs::metadata(path).await?;
            
            let file_name = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            
            files_metadata.push(FileMetadata {
                name: file_name,
                size: metadata.len(),
                mime_type: None,
                checksum: None,
            });
            absolute_paths.push(path.clone());
        }

        let total_size: u64 = files_metadata.iter().map(|f| f.size).sum();
        info!("📤 전송 시작: {} (파일 수: {}, 총 용량: {} bytes)", root_name, files_metadata.len(), total_size);

        // 매니페스트 생성
        let manifest = TransferManifest {
            job_id: job_id.to_string(),
            files: files_metadata,
            total_size,
            is_folder,
            root_name: root_name.clone(),
        };

        let (mut send, mut recv) = conn.open_bi().await?;
        
        // 매니페스트 전송
        let manifest_json = serde_json::to_vec(&manifest)?;
        let manifest_len = manifest_json.len() as u32;
        send.write_all(&manifest_len.to_le_bytes()).await?;
        send.write_all(&manifest_json).await?;

        // 상대방의 READY 응답 대기
        let mut ready_buf = [0u8; 5];
        recv.read_exact(&mut ready_buf).await?;
        if &ready_buf != b"READY" {
            return Err(anyhow::anyhow!("Receiver not ready"));
        }

        self.update_state(TransferState::Transferring).await;

        let start_time = std::time::Instant::now();
        let mut last_progress_time = std::time::Instant::now();
        let mut bytes_sent_total: u64 = 0;

        // 모든 파일 순차 전송
        for (i, abs_path) in absolute_paths.iter().enumerate() {
            let file_meta = &manifest.files[i];
            
            let file = File::open(abs_path).await?;
            let mut reader = BufReader::with_capacity(CHUNK_SIZE, file);
            let mut buffer = vec![0u8; CHUNK_SIZE];
            let mut file_bytes_sent: u64 = 0;

            while file_bytes_sent < file_meta.size {
                let to_read = std::cmp::min(CHUNK_SIZE as u64, file_meta.size - file_bytes_sent) as usize;
                let n = reader.read(&mut buffer[..to_read]).await?;
                if n == 0 {
                    break;
                }

                send.write_all(&buffer[..n]).await?;
                file_bytes_sent += n as u64;
                bytes_sent_total += n as u64;

                // 진행률 보고
                let now = std::time::Instant::now();
                if now.duration_since(last_progress_time).as_millis() >= 200 {
                    last_progress_time = now;
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        ((bytes_sent_total as f64) / elapsed) as u64
                    } else {
                        0
                    };
                    self.report_progress(job_id, bytes_sent_total, total_size, speed).await;
                }
            }
        }

        // 스트림 종료
        info!("📤 모든 데이터 전송 완료, 스트림 종료 신호 전송...");
        let _ = send.finish();

        // Receiver의 DONE 응답 대기
        let mut done_buf = [0u8; 4];
        let _ = tokio::time::timeout(std::time::Duration::from_millis(1000), recv.read_exact(&mut done_buf)).await;

        self.update_state(TransferState::Completed).await;
        self.report_progress(job_id, total_size, total_size, 0).await;

        info!("✅ 전송 완료: 총 {} bytes", bytes_sent_total);
        Ok(bytes_sent_total)
    }

    /// ZIP 아카이브 생성
    async fn create_zip_archive(paths: &[PathBuf]) -> Result<(PathBuf, String, u64)> {
        let temp_dir = std::env::temp_dir();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        
        // ZIP 파일명 결정
        let zip_name = if paths.len() == 1 {
            let stem = paths[0].file_stem().unwrap_or_default().to_string_lossy();
            format!("{}.zip", stem)
        } else {
            format!("archive_{}.zip", timestamp)
        };
        
        let zip_path = temp_dir.join(&zip_name);
        let zip_file = std::fs::File::create(&zip_path)?;
        let mut zip = zip::ZipWriter::new(zip_file);
        
        let options = FileOptions::default()
            .compression_method(zip::CompressionMethod::Stored) // 속도를 위해 압축률(Stored) 사용, 필요시 Deflated
            .unix_permissions(0o755);

        for path in paths {
            let walker = WalkDir::new(path).into_iter();
            
            // 경로 계산을 위한 부모 디렉토리
            let parent_dir = path.parent().unwrap_or(path);

            for entry in walker.filter_map(|e| e.ok()) {
                let entry_path = entry.path();
                
                // 아카이브 내 경로 계산 (상대 경로)
                let name = entry_path.strip_prefix(parent_dir)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| entry_path.file_name().unwrap().to_string_lossy().into_owned());

                if entry_path.is_file() {
                    zip.start_file(&name, options)?;
                    let mut f = std::fs::File::open(entry_path)?;
                    std::io::copy(&mut f, &mut zip)?;
                } else if !name.is_empty() {
                    // 디렉토리 추가 (빈 디렉토리 등)
                    zip.add_directory(&name, options)?;
                }
            }
        }
        
        zip.finish()?;
        
        let metadata = std::fs::metadata(&zip_path)?;
        Ok((zip_path, zip_name, metadata.len()))
    }

    /// 재귀적으로 파일 목록 수집 (Legacy - ZIP 사용시 미사용될 수 있음)
    async fn collect_files_recursively(
        root: &PathBuf,
        relative_path: PathBuf,
        files: &mut Vec<FileMetadata>,
        absolute_paths: &mut Vec<PathBuf>,
    ) -> Result<()> {
        let full_path = root.join(&relative_path);
        let mut entries = tokio::fs::read_dir(full_path).await?; // Keep for compatibility if needed
        // ... implementation kept for reference or mixed usage
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let metadata = entry.metadata().await?;
            let name = entry.file_name().to_string_lossy().to_string();
            let mut new_relative = relative_path.clone();
            new_relative.push(name);

            if metadata.is_dir() {
                Box::pin(Self::collect_files_recursively(root, new_relative, files, absolute_paths)).await?;
            } else {
                files.push(FileMetadata {
                    name: new_relative.to_string_lossy().to_string(),
                    size: metadata.len(),
                    mime_type: None,
                    checksum: None,
                });
                absolute_paths.push(path);
            }
        }
        Ok(())
    }

    /// QUIC 스트림을 통해 파일/폴더 수신 (Receiver)
    pub async fn receive_file(
        &self,
        conn: &quinn::Connection,
        save_dir: PathBuf,
        job_id: &str,
    ) -> Result<PathBuf> {
        self.update_state(TransferState::Connecting).await;
        *self.current_job_id.write().await = Some(job_id.to_string());

        info!("📥 수신 대기 중... (accept_bi)");
        
        let (mut send, mut recv) = conn.accept_bi().await?;
        
        // 매니페스트 수신
        let mut len_buf = [0u8; 4];
        recv.read_exact(&mut len_buf).await?;
        let manifest_len = u32::from_le_bytes(len_buf) as usize;

        let mut manifest_buf = vec![0u8; manifest_len];
        recv.read_exact(&mut manifest_buf).await?;
        let manifest: TransferManifest = serde_json::from_slice(&manifest_buf)?;

        info!("📥 매니페스트 수신: {}개 파일, 총 {} bytes", manifest.files.len(), manifest.total_size);

        // READY 응답 전송
        send.write_all(b"READY").await?;

        self.update_state(TransferState::Transferring).await;

        let start_time = std::time::Instant::now();
        let mut last_progress_time = std::time::Instant::now();
        let mut bytes_received_total: u64 = 0;

        // 최종 저장될 루트 경로
        let final_root = if manifest.is_folder {
            save_dir.join(&manifest.root_name)
        } else {
            save_dir.clone()
        };

        // 모든 파일 순차 수신
        for file_meta in &manifest.files {
            let save_path = if manifest.is_folder {
                final_root.join(&file_meta.name)
            } else {
                save_dir.join(&file_meta.name)
            };

            // 부모 디렉토리 생성 (폴더 재구성의 핵심)
            if let Some(parent) = save_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            let file = File::create(&save_path).await?;
            let mut writer = BufWriter::with_capacity(CHUNK_SIZE, file);
            let mut file_bytes_received: u64 = 0;

            while file_bytes_received < file_meta.size {
                let to_read = std::cmp::min(CHUNK_SIZE as u64, file_meta.size - file_bytes_received) as usize;
                let mut buffer = vec![0u8; to_read];
                recv.read_exact(&mut buffer).await?;
                
                writer.write_all(&buffer).await?;
                file_bytes_received += to_read as u64;
                bytes_received_total += to_read as u64;

                // 진행률 보고
                let now = std::time::Instant::now();
                if now.duration_since(last_progress_time).as_millis() >= 200 {
                    last_progress_time = now;
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        ((bytes_received_total as f64) / elapsed) as u64
                    } else {
                        0
                    };
                    self.report_progress(job_id, bytes_received_total, manifest.total_size, speed).await;
                }
            }
            writer.flush().await?;
        }

        info!("📥 모든 파일 수신 완료, DONE 응답 전송...");
        if let Err(e) = send.write_all(b"DONE").await {
            warn!("DONE 응답 전송 실패 (무시 가능): {}", e);
        }
        let _ = send.finish();

        self.update_state(TransferState::Completed).await;
        self.report_progress(job_id, manifest.total_size, manifest.total_size, 0).await;

        info!("✅ 수신 완료: {} -> {:?}", bytes_received_total, final_root);
        Ok(final_root)
    }

    /// 전송 취소
    pub async fn cancel(&self) {
        self.update_state(TransferState::Failed("Cancelled by user".to_string())).await;
    }
}

impl Default for FileTransferEngine {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn test_collect_files_recursively() -> Result<()> {
        let root_dir = std::env::temp_dir().join(format!("ponswarp_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root_dir)?;
        
        let sub_dir = root_dir.join("sub");
        fs::create_dir_all(&sub_dir)?;
        
        let file1 = root_dir.join("file1.txt");
        fs::write(&file1, "file1 content")?;
        
        let file2 = sub_dir.join("file2.txt");
        fs::write(&file2, "file2 content")?;

        let mut files_metadata = Vec::new();
        let mut absolute_paths = Vec::new();
        
        // base_path는 실제 물리 경로, PathBuf::new()는 논리적 루트(비어있으면 파일명만 사용됨)
        FileTransferEngine::collect_files_recursively(
            &root_dir,
            PathBuf::new(),
            &mut files_metadata,
            &mut absolute_paths
        ).await?;

        // 2 files should be collected
        assert_eq!(files_metadata.len(), 2);
        
        // Check file1 (이름은 "file1.txt"이어야 함)
        assert!(files_metadata.iter().any(|f| f.name == "file1.txt"));
        
        // Check file2 (이름은 "sub/file2.txt"이어야 함)
        assert!(files_metadata.iter().any(|f| f.name == "sub/file2.txt"));

        // Cleanup
        fs::remove_dir_all(&root_dir)?;
        Ok(())
    }
}
