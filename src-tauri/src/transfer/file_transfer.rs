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

    /// QUIC 스트림을 통해 파일 전송 (Sender)
    pub async fn send_file(
        &self,
        conn: &quinn::Connection,
        file_path: PathBuf,
        job_id: &str,
    ) -> Result<u64> {
        self.update_state(TransferState::Preparing).await;
        *self.current_job_id.write().await = Some(job_id.to_string());

        // 파일 열기
        let file = File::open(&file_path).await?;
        let metadata = file.metadata().await?;
        let total_size = metadata.len();
        let file_name = file_path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        info!("📤 파일 전송 시작: {} ({} bytes)", file_name, total_size);

        // 매니페스트 전송
        let manifest = TransferManifest {
            job_id: job_id.to_string(),
            files: vec![FileMetadata {
                name: file_name.clone(),
                size: total_size,
                mime_type: None,
                checksum: None,
            }],
            total_size,
            is_folder: false,
            root_name: file_name,
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

        // 파일 데이터 전송 (4MB 버퍼로 고속 전송)
        let mut reader = BufReader::with_capacity(4 * 1024 * 1024, file);
        let mut buffer = vec![0u8; CHUNK_SIZE];
        let mut bytes_sent: u64 = 0;
        let start_time = std::time::Instant::now();
        let mut last_progress_time = std::time::Instant::now();

        loop {
            let n = reader.read(&mut buffer).await?;
            if n == 0 {
                break;
            }

            send.write_all(&buffer[..n]).await?;
            bytes_sent += n as u64;

            // 진행률 보고 (200ms마다 - UI 스로틀링과 동기화)
            let now = std::time::Instant::now();
            if now.duration_since(last_progress_time).as_millis() >= 200 {
                last_progress_time = now;
                let elapsed = start_time.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 {
                    ((bytes_sent as f64) / elapsed) as u64
                } else {
                    0
                };
                self.report_progress(job_id, bytes_sent, total_size, speed).await;
            }
        }

        // 🚨 [핵심 수정] 스트림 종료 - 빠른 완료 처리
        // 1. send 스트림을 finish()하여 EOF를 보냄 (Receiver가 데이터 끝을 알 수 있도록)
        info!("📤 모든 데이터 전송 완료, 스트림 종료 신호 전송...");
        if let Err(e) = send.finish() {
            warn!("스트림 종료 중 오류 (무시): {}", e);
        }

        // 2. Receiver의 DONE 응답 대기 (최대 500ms - 빠른 UI 응답을 위해)
        // DONE을 못 받아도 데이터는 이미 전송 완료됨
        let mut done_buf = [0u8; 4];
        match tokio::time::timeout(std::time::Duration::from_millis(500), recv.read_exact(&mut done_buf)).await {
            Ok(Ok(_)) if &done_buf == b"DONE" => {
                info!("✅ Receiver 완료 확인 수신: DONE");
            }
            _ => {
                // 타임아웃이나 에러 - 정상적인 상황 (Receiver가 이미 스트림을 닫았을 수 있음)
                info!("📤 Receiver 응답 대기 완료 (데이터 전송은 성공)");
            }
        }

        self.update_state(TransferState::Completed).await;
        self.report_progress(job_id, total_size, total_size, 0).await;

        info!("✅ 파일 전송 완료: {} bytes", bytes_sent);
        Ok(bytes_sent)
    }

    /// QUIC 스트림을 통해 파일 수신 (Receiver)
    /// Receiver가 클라이언트로 연결한 경우, Sender(서버)가 open_bi()로 스트림을 열면
    /// 클라이언트는 accept_bi()로 해당 스트림을 수락합니다.
    pub async fn receive_file(
        &self,
        conn: &quinn::Connection,
        save_dir: PathBuf,
        job_id: &str,
    ) -> Result<PathBuf> {
        self.update_state(TransferState::Connecting).await;
        *self.current_job_id.write().await = Some(job_id.to_string());

        info!("📥 파일 수신 대기 중... (accept_bi)");
        
        // 스트림 수락 (Sender가 open_bi()로 연 스트림을 받음)
        let (mut send, mut recv) = conn.accept_bi().await?;
        
        info!("📥 스트림 수락됨, 매니페스트 수신 중...");

        // 매니페스트 수신
        let mut len_buf = [0u8; 4];
        recv.read_exact(&mut len_buf).await?;
        let manifest_len = u32::from_le_bytes(len_buf) as usize;

        let mut manifest_buf = vec![0u8; manifest_len];
        recv.read_exact(&mut manifest_buf).await?;
        let manifest: TransferManifest = serde_json::from_slice(&manifest_buf)?;

        info!("📥 매니페스트 수신: {:?}", manifest);

        let file_name = &manifest.files[0].name;
        let total_size = manifest.total_size;
        let save_path = save_dir.join(file_name);

        // 저장 디렉토리 생성
        if let Some(parent) = save_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // READY 응답 전송
        send.write_all(b"READY").await?;

        self.update_state(TransferState::Transferring).await;

        // 파일 수신 (4MB 버퍼로 고속 수신)
        let file = File::create(&save_path).await?;
        let mut writer = BufWriter::with_capacity(4 * 1024 * 1024, file);
        let mut buffer = vec![0u8; CHUNK_SIZE];
        let mut bytes_received: u64 = 0;
        let start_time = std::time::Instant::now();
        let mut last_progress_time = std::time::Instant::now();

        loop {
            match recv.read(&mut buffer).await? {
                Some(n) if n > 0 => {
                    writer.write_all(&buffer[..n]).await?;
                    bytes_received += n as u64;

                    // 진행률 보고 (200ms마다 - UI 스로틀링과 동기화)
                    let now = std::time::Instant::now();
                    if now.duration_since(last_progress_time).as_millis() >= 200 {
                        last_progress_time = now;
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed = if elapsed > 0.0 {
                            ((bytes_received as f64) / elapsed) as u64
                        } else {
                            0
                        };
                        self.report_progress(job_id, bytes_received, total_size, speed).await;
                    }
                }
                _ => break,
            }
        }

        writer.flush().await?;
        info!("📥 파일 쓰기 완료, DONE 응답 전송...");

        // 완료 응답 전송 (Sender에게 알림) - 즉시 전송
        if let Err(e) = send.write_all(b"DONE").await {
            warn!("DONE 응답 전송 실패 (무시 가능): {}", e);
        }
        
        // 스트림 종료 (에러 무시 - Sender가 이미 닫았을 수 있음)
        let _ = send.finish();

        self.update_state(TransferState::Completed).await;
        self.report_progress(job_id, total_size, total_size, 0).await;

        info!("✅ 파일 수신 완료: {} -> {:?}", bytes_received, save_path);
        Ok(save_path)
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
