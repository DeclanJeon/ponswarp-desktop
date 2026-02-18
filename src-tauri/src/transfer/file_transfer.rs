//! 파일 전송 모듈 - QUIC 기반 P2P 파일 전송
//!
//! WebRTC를 대체하여 Native 환경에서 파일 전송을 담당합니다.

use crate::protocol::commands::{TransferRequest, TransferResponse};
use anyhow::Result;
use hex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File as StdFile};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::{mpsc, RwLock};
use tracing::{info, warn};

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

// --- State Management for File Streams (Tauri Commands) ---

/// 파일 스트림 상태 관리 (여러 파일의 동시 쓰기를 위해)
#[derive(Debug)]
pub struct FileStreamManager {
    /// 활성 파일 스트림 맵: FileId -> File Handle
    pub file_streams: Mutex<HashMap<String, StdFile>>,
}

impl FileStreamManager {
    pub fn new() -> Self {
        Self {
            file_streams: Mutex::new(HashMap::new()),
        }
    }
}

/// 전송 승인 관리자
pub struct TransferApprovalManager {
    pub pending_requests: Arc<RwLock<HashMap<String, TransferRequest>>>,
    pub approval_tx: Arc<RwLock<HashMap<String, mpsc::Sender<TransferResponse>>>>,
    expiry_duration: Duration,
}

impl TransferApprovalManager {
    pub fn new() -> Self {
        Self {
            pending_requests: Arc::new(RwLock::new(HashMap::new())),
            approval_tx: Arc::new(RwLock::new(HashMap::new())),
            expiry_duration: Duration::from_secs(30), // 30초 타임아웃
        }
    }

    /// 전송 요청 등록 (Receiver에서 호출)
    pub async fn register_request(
        &self,
        request: TransferRequest,
    ) -> (String, mpsc::Receiver<TransferResponse>) {
        let job_id = request.job_id.clone();
        let (tx, rx) = mpsc::channel(1);

        self.pending_requests
            .write()
            .await
            .insert(job_id.clone(), request);
        self.approval_tx.write().await.insert(job_id.clone(), tx);

        (job_id, rx)
    }

    /// 승인/거절 처리 (Receiver UI에서 호출)
    pub async fn approve(
        &self,
        job_id: &str,
        approved: bool,
        reason: Option<String>,
    ) -> Result<(), String> {
        let response = TransferResponse {
            job_id: job_id.to_string(),
            approved,
            reason,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };

        let tx = {
            let map = self.approval_tx.read().await;
            map.get(job_id).cloned()
        };

        if let Some(tx) = tx {
            tx.send(response).await.map_err(|e| e.to_string())?;
            self.cleanup(job_id).await;
            Ok(())
        } else {
            Err("Request not found".to_string())
        }
    }

    async fn cleanup(&self, job_id: &str) {
        self.pending_requests.write().await.remove(job_id);
        self.approval_tx.write().await.remove(job_id);
    }
}

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
    async fn report_progress(
        &self,
        job_id: &str,
        bytes_transferred: u64,
        total_bytes: u64,
        speed_bps: u64,
    ) {
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
        let file_name = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        info!("📤 파일 전송 시작: {} ({} bytes)", file_name, total_size);

        // SHA-256 해시 계산 (파일 무결성 검증을 위해)
        let mut hasher = Sha256::new();
        let mut reader = BufReader::with_capacity(4 * 1024 * 1024, file);
        let mut buffer = vec![0u8; CHUNK_SIZE];

        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    hasher.update(&buffer[..n]);
                }
                Err(e) => return Err(anyhow::anyhow!("해시 계산 중 파일 읽기 오류: {}", e)),
            }
        }

        let checksum = hex::encode(hasher.finalize());
        info!("🔐 SHA-256 해시 계산 완료: {}", checksum);

        // 파일 포인터를 처음으로 되돌림 (재전송을 위해)
        let mut file = File::open(&file_path).await?;

        // 매니페스트 전송
        let manifest = TransferManifest {
            job_id: job_id.to_string(),
            files: vec![FileMetadata {
                name: file_name.clone(),
                size: total_size,
                mime_type: None,
                checksum: Some(checksum),
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

        info!("📤 데이터 전송 루프 시작: {} bytes", total_size);

        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => {
                    info!("📤 파일 끝에 도달 (EOF)");
                    break;
                }
                Ok(n) => {
                    info!("📤 {} bytes 읽음, 전송 중...", n);

                    if let Err(e) = send.write_all(&buffer[..n]).await {
                        warn!("📤 데이터 전송 실패: {}", e);
                        return Err(anyhow::anyhow!("데이터 전송 실패: {}", e));
                    }

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
                        self.report_progress(job_id, bytes_sent, total_size, speed)
                            .await;
                    }
                }
                Err(e) => {
                    warn!("📤 파일 읽기 오류: {}", e);
                    return Err(anyhow::anyhow!("파일 읽기 오류: {}", e));
                }
            }
        }

        info!("📤 데이터 전송 루프 완료: {} bytes 전송됨", bytes_sent);

        // 🚨 [핵심 수정] 스트림 종료 - 빠른 완료 처리
        // 1. send 스트림을 finish()하여 EOF를 보냄 (Receiver가 데이터 끝을 알 수 있도록)
        info!("📤 모든 데이터 전송 완료, 스트림 종료 신호 전송...");
        if let Err(e) = send.finish() {
            warn!("스트림 종료 중 오류 (무시): {}", e);
        }

        // 2. Receiver의 DONE 응답 대기 (최대 500ms - 빠른 UI 응답을 위해)
        // DONE을 못 받아도 데이터는 이미 전송 완료됨
        let mut done_buf = [0u8; 4];
        match tokio::time::timeout(
            std::time::Duration::from_millis(500),
            recv.read_exact(&mut done_buf),
        )
        .await
        {
            Ok(Ok(_)) if &done_buf == b"DONE" => {
                info!("✅ Receiver 완료 확인 수신: DONE");
            }
            _ => {
                // 타임아웃이나 에러 - 정상적인 상황 (Receiver가 이미 스트림을 닫았을 수 있음)
                info!("📤 Receiver 응답 대기 완료 (데이터 전송은 성공)");
            }
        }

        self.update_state(TransferState::Completed).await;
        self.report_progress(job_id, total_size, total_size, 0)
            .await;

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
        let expected_checksum = manifest.files[0].checksum.clone();

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

        // 수신하면서 SHA-256 해시 계산
        let mut hasher = Sha256::new();

        loop {
            match recv.read(&mut buffer).await? {
                Some(n) if n > 0 => {
                    writer.write_all(&buffer[..n]).await?;
                    hasher.update(&buffer[..n]);
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
                        self.report_progress(job_id, bytes_received, total_size, speed)
                            .await;
                    }
                }
                _ => break,
            }
        }

        // 해시 검증
        let calculated_checksum = hex::encode(hasher.finalize());

        if let Some(ref expected) = expected_checksum {
            if calculated_checksum != *expected {
                // 해시 불일치 - 파일 삭제 후 에러 반환
                warn!(
                    "🔐 해시 불일치! 예상: {}, 계산: {}",
                    expected, calculated_checksum
                );
                tokio::fs::remove_file(&save_path).await?;
                return Err(anyhow::anyhow!(
                    "파일 무결성 검증 실패: 해시 불일치\n예상: {}\n계산: {}",
                    expected,
                    calculated_checksum
                ));
            } else {
                info!("✅ SHA-256 해시 검증 성공: {}", calculated_checksum);
            }
        } else {
            info!("⚠️  매니페스트에 체크섬이 없습니다. 검증 스킵.");
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
        self.report_progress(job_id, total_size, total_size, 0)
            .await;

        info!("✅ 파일 수신 완료: {} -> {:?}", bytes_received, save_path);
        Ok(save_path)
    }

    /// 전송 취소
    pub async fn cancel(&self) {
        self.update_state(TransferState::Failed("Cancelled by user".to_string()))
            .await;
    }
}

// --- Warp Engine v2.0 File System Commands ---

/// [Utility] 상대 경로를 절대 경로로 변환 (OS 구분자 자동 처리)
#[tauri::command]
pub fn resolve_path(base: String, relative: String) -> String {
    let base_path = Path::new(&base);
    let full_path = base_path.join(relative);
    // 경로 정규화 및 문자열 변환
    full_path.to_string_lossy().to_string()
}

/// [Scanning] 폴더 재귀적 스캔 (Sender용) - Warp Engine v2.0
/// 폴더 내 모든 파일의 상대 경로와 메타데이터를 반환합니다.
#[tauri::command]
pub fn scan_folder(path: String) -> Result<Vec<serde_json::Value>, String> {
    let mut files = Vec::new();

    fn scan_recursive(dir: &Path, base_path: &Path, files: &mut Vec<serde_json::Value>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();

                if entry_path.is_dir() {
                    // 하위 폴더 재귀 스캔 (숨겨진 폴더 제외)
                    let folder_name = entry.file_name();
                    if !folder_name.to_string_lossy().starts_with('.') {
                        scan_recursive(&entry_path, base_path, files);
                    }
                } else if entry_path.is_file() {
                    // 파일 메타데이터 수집
                    let metadata = match fs::metadata(&entry_path) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };

                    let file_name = entry.file_name().to_string_lossy().to_string();

                    // 숨겨진 파일 제외 (.DS_Store, .git 등)
                    if file_name.starts_with('.') {
                        continue;
                    }

                    // 상대 경로 계산 (예: "src/utils/logger.ts")
                    let relative_path = entry_path
                        .strip_prefix(base_path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| file_name.clone());

                    // OS 경로 구분자를 /로 정규화
                    let relative_path = relative_path.replace('\\', "/");

                    files.push(serde_json::json!({
                        "name": file_name,
                        "path": relative_path,
                        "size": metadata.len(),
                        "isFile": true
                    }));
                }
            }
        }
    }

    let base_path = Path::new(&path);
    scan_recursive(base_path, base_path, &mut files);

    println!(
        "[Rust] 📁 Scanned {} files from folder: {}",
        files.len(),
        path
    );
    Ok(files)
}

/// [Filesystem] 해당 파일 경로의 상위 디렉토리가 존재하는지 확인하고, 없으면 생성 (mkdir -p)
#[tauri::command]
pub fn ensure_dir_exists(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }
    Ok(())
}

/// [File I/O] 파일 스트림 시작 (Create & Pre-allocate) - Warp Engine v2.0
#[tauri::command]
pub fn start_native_file_stream(
    state: tauri::State<'_, FileStreamManager>,
    file_id: String,
    save_path: String,
    total_size: u64,
) -> Result<(), String> {
    let path = Path::new(&save_path);

    // 1. 파일 생성 (Create/Overwrite)
    let file = StdFile::options()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    // 2. 공간 미리 할당 (Pre-allocation for performance)
    if total_size > 0 {
        if let Err(e) = file.set_len(total_size) {
            println!(
                "[Rust] Warning: Failed to pre-allocate file ({} bytes): {}",
                total_size, e
            );
            // Pre-allocation 실패는 치명적이지 않으므로 경고만 출력하고 진행
        }
    }

    // 3. 상태 저장
    state
        .file_streams
        .lock()
        .map_err(|_| "File stream state lock poisoned".to_string())?
        .insert(file_id.clone(), file);

    println!("[Rust] File stream started: {}", save_path);
    Ok(())
}

/// [File I/O] 청크 쓰기 (Seek & Write) - Warp Engine v2.0
#[tauri::command]
pub fn write_native_file_chunk(
    state: tauri::State<'_, FileStreamManager>,
    file_id: String,
    chunk: Vec<u8>,
    offset: i64,
) -> Result<(), String> {
    let mut streams = state
        .file_streams
        .lock()
        .map_err(|_| "File stream state lock poisoned".to_string())?;

    if let Some(file) = streams.get_mut(&file_id) {
        // Offset이 -1이면 현재 위치(Append), 아니면 Seek
        if offset >= 0 {
            file.seek(SeekFrom::Start(offset as u64))
                .map_err(|e| format!("Seek failed: {}", e))?;
        } else {
            // -1인 경우 End로 이동 (혹은 현재 커서 유지)
            // 보통 순차 쓰기이므로 seek이 필요 없을 수 있으나, 명시적으로 End로 이동
            file.seek(SeekFrom::End(0))
                .map_err(|e| format!("Seek end failed: {}", e))?;
        }

        file.write_all(&chunk)
            .map_err(|e| format!("Write failed: {}", e))?;

        Ok(())
    } else {
        Err(format!("File stream not found: {}", file_id))
    }
}

/// [File I/O] 스트림 종료 및 정리 - Warp Engine v2.0
#[tauri::command]
pub fn close_native_file_stream(
    state: tauri::State<'_, FileStreamManager>,
    file_id: String,
) -> Result<(), String> {
    let mut streams = state
        .file_streams
        .lock()
        .map_err(|_| "File stream state lock poisoned".to_string())?;

    if let Some(file) = streams.remove(&file_id) {
        // File은 Scope를 벗어나면 자동으로 close되지만, 확실하게 sync() 호출
        file.sync_all().map_err(|e| format!("Sync failed: {}", e))?;
        println!("[Rust] File stream closed: {}", file_id);
        Ok(())
    } else {
        // 이미 닫혔거나 없는 경우 에러 처리하지 않음 (Idempotent)
        Ok(())
    }
}

impl Default for FileTransferEngine {
    fn default() -> Self {
        Self::new()
    }
}
