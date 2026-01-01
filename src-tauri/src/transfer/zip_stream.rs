//! Zip 스트리밍 전송 모듈
//!
//! 다중 파일을 실시간으로 Zip 압축하여 QUIC 스트림으로 전송합니다.
//! - Sender: 파일들을 순차적으로 읽어 Zip Entry로 추가하며 스트림 전송
//! - Receiver: 스트림에서 읽어 직접 파일로 저장

use std::fs::File;
use std::io::{BufReader, Read, Write, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{info, warn, error, debug};
use zip::write::FileOptions;
use zip::{ZipWriter, CompressionMethod};

use super::TransferProgress;

/// Zip 스트리밍 전송 설정
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZipStreamConfig {
    /// 압축 레벨 (0 = 저장만, 1-9 = 압축)
    pub compression_level: u32,
    /// 청크 크기 (기본 1MB)
    pub chunk_size: usize,
    /// 진행률 보고 간격 (밀리초)
    pub progress_interval_ms: u64,
}

impl Default for ZipStreamConfig {
    fn default() -> Self {
        Self {
            compression_level: 1, // 빠른 압축
            chunk_size: 1024 * 1024, // 1MB
            progress_interval_ms: 200,
        }
    }
}

/// 전송할 파일 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// 절대 경로 (로컬 파일 시스템)
    pub absolute_path: String,
    /// Zip 내부 상대 경로 (폴더 구조 보존)
    pub relative_path: String,
    /// 파일 크기
    pub size: u64,
}

/// Zip 스트리밍 전송기 (Sender)
pub struct ZipStreamSender {
    config: ZipStreamConfig,
    progress_tx: Option<mpsc::Sender<TransferProgress>>,
}

impl ZipStreamSender {
    pub fn new(config: ZipStreamConfig) -> Self {
        Self {
            config,
            progress_tx: None,
        }
    }

    pub fn with_progress_channel(mut self, tx: mpsc::Sender<TransferProgress>) -> Self {
        self.progress_tx = Some(tx);
        self
    }

    /// QUIC 연결을 통해 Zip 스트림 전송
    /// 
    /// 파일들을 순차적으로 읽어 Zip으로 압축하면서 QUIC 스트림으로 전송합니다.
    pub async fn send_zip_stream(
        &self,
        conn: &quinn::Connection,
        files: Vec<FileEntry>,
        job_id: &str,
    ) -> Result<u64> {
        let total_size: u64 = files.iter().map(|f| f.size).sum();
        let file_count = files.len();
        
        info!("🗜️ Zip 스트리밍 시작: {} 파일, 총 {} bytes", file_count, total_size);

        // QUIC 양방향 스트림 열기
        let (mut send, mut recv) = conn.open_bi().await?;
        
        // 헤더 전송: "ZIPS" + job_id 길이 + job_id + 파일 수 + 총 크기
        send.write_all(b"ZIPS").await?;
        let job_id_bytes = job_id.as_bytes();
        send.write_all(&(job_id_bytes.len() as u32).to_le_bytes()).await?;
        send.write_all(job_id_bytes).await?;
        send.write_all(&(file_count as u32).to_le_bytes()).await?;
        send.write_all(&total_size.to_le_bytes()).await?;

        // Receiver의 READY 응답 대기
        let mut ready_buf = [0u8; 5];
        recv.read_exact(&mut ready_buf).await?;
        if &ready_buf != b"READY" {
            return Err(anyhow::anyhow!("Receiver not ready for zip stream"));
        }

        // 메모리 버퍼에 Zip 생성 후 스트림으로 전송
        // 대용량 파일의 경우 청크 단위로 처리
        let mut total_sent: u64 = 0;
        let mut bytes_processed: u64 = 0;
        let start_time = Instant::now();
        let mut last_progress = Instant::now();

        // Zip 압축 옵션
        let options = FileOptions::default()
            .compression_method(if self.config.compression_level == 0 {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            })
            .compression_level(Some(self.config.compression_level as i32));

        // 임시 버퍼에 Zip 생성
        let mut zip_buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip_writer = ZipWriter::new(&mut zip_buffer);

            for (idx, file_entry) in files.iter().enumerate() {
                debug!("📦 파일 추가 중 ({}/{}): {}", idx + 1, file_count, file_entry.relative_path);

                // Zip Entry 시작
                zip_writer.start_file(&file_entry.relative_path, options)?;

                // 파일 읽기 및 Zip에 쓰기
                let file = File::open(&file_entry.absolute_path)?;
                let mut reader = BufReader::with_capacity(self.config.chunk_size, file);
                let mut chunk_buf = vec![0u8; self.config.chunk_size];

                loop {
                    let bytes_read = reader.read(&mut chunk_buf)?;
                    if bytes_read == 0 {
                        break;
                    }

                    zip_writer.write_all(&chunk_buf[..bytes_read])?;
                    bytes_processed += bytes_read as u64;

                    // 진행률 보고
                    if last_progress.elapsed().as_millis() >= self.config.progress_interval_ms as u128 {
                        last_progress = Instant::now();
                        self.report_progress(job_id, bytes_processed, total_size, &start_time).await;
                    }
                }
            }

            // Zip 마무리 (Central Directory 작성)
            zip_writer.finish()?;
        }

        // Zip 버퍼를 QUIC 스트림으로 전송
        let zip_data = zip_buffer.into_inner();
        let zip_size = zip_data.len();
        
        info!("📤 Zip 데이터 전송 시작: {} bytes (압축률: {:.1}%)", 
            zip_size, 
            (1.0 - zip_size as f64 / total_size as f64) * 100.0
        );

        // 크기 먼저 전송
        send.write_all(&(zip_size as u64).to_le_bytes()).await?;

        // 데이터 청크 단위로 전송
        for chunk in zip_data.chunks(self.config.chunk_size) {
            send.write_all(chunk).await?;
            total_sent += chunk.len() as u64;

            // 진행률 보고
            if last_progress.elapsed().as_millis() >= self.config.progress_interval_ms as u128 {
                last_progress = Instant::now();
                let progress = (total_sent as f64 / zip_size as f64) * 100.0;
                self.report_progress_direct(job_id, total_sent, zip_size as u64, progress, &start_time).await;
            }
        }

        // 스트림 종료
        send.finish()?;

        // Receiver의 완료 응답 대기 (타임아웃 적용)
        let mut done_buf = [0u8; 4];
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            recv.read_exact(&mut done_buf)
        ).await {
            Ok(Ok(_)) if &done_buf == b"DONE" => {
                info!("✅ Receiver 완료 확인");
            }
            _ => {
                warn!("⚠️ Receiver 응답 타임아웃 (데이터는 전송됨)");
            }
        }

        // 최종 진행률 100%
        self.report_progress_direct(job_id, zip_size as u64, zip_size as u64, 100.0, &start_time).await;

        info!("✅ Zip 스트리밍 완료: {} bytes 전송", total_sent);
        Ok(total_sent)
    }

    async fn report_progress(&self, job_id: &str, bytes: u64, total: u64, start: &Instant) {
        let progress = if total > 0 { (bytes as f64 / total as f64) * 100.0 } else { 0.0 };
        self.report_progress_direct(job_id, bytes, total, progress, start).await;
    }

    async fn report_progress_direct(&self, job_id: &str, bytes: u64, total: u64, progress: f64, start: &Instant) {
        if let Some(tx) = &self.progress_tx {
            let elapsed = start.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 { (bytes as f64 / elapsed) as u64 } else { 0 };

            let _ = tx.send(TransferProgress {
                job_id: job_id.to_string(),
                bytes_transferred: bytes,
                total_bytes: total,
                progress_percent: progress,
                speed_bps: speed,
                state: super::TransferState::Transferring,
            }).await;
        }
    }
}

/// Zip 스트리밍 수신기 (Receiver)
pub struct ZipStreamReceiver {
    config: ZipStreamConfig,
    progress_tx: Option<mpsc::Sender<TransferProgress>>,
}

impl ZipStreamReceiver {
    pub fn new(config: ZipStreamConfig) -> Self {
        Self {
            config,
            progress_tx: None,
        }
    }

    pub fn with_progress_channel(mut self, tx: mpsc::Sender<TransferProgress>) -> Self {
        self.progress_tx = Some(tx);
        self
    }

    /// QUIC 스트림에서 Zip 데이터를 수신하여 파일로 저장
    pub async fn receive_zip_stream(
        &self,
        conn: &quinn::Connection,
        save_path: PathBuf,
        job_id: &str,
    ) -> Result<PathBuf> {
        info!("📥 Zip 스트리밍 수신 대기: {:?}", save_path);

        // QUIC 스트림 수락
        let (mut send, mut recv) = conn.accept_bi().await?;

        // 헤더 수신
        let mut marker = [0u8; 4];
        recv.read_exact(&mut marker).await?;
        if &marker != b"ZIPS" {
            return Err(anyhow::anyhow!("Invalid zip stream marker"));
        }

        // Job ID 수신
        let mut job_id_len_buf = [0u8; 4];
        recv.read_exact(&mut job_id_len_buf).await?;
        let job_id_len = u32::from_le_bytes(job_id_len_buf) as usize;
        let mut job_id_buf = vec![0u8; job_id_len];
        recv.read_exact(&mut job_id_buf).await?;
        let received_job_id = String::from_utf8_lossy(&job_id_buf);
        
        // 파일 정보 수신
        let mut file_count_buf = [0u8; 4];
        recv.read_exact(&mut file_count_buf).await?;
        let file_count = u32::from_le_bytes(file_count_buf);

        let mut total_size_buf = [0u8; 8];
        recv.read_exact(&mut total_size_buf).await?;
        let total_size = u64::from_le_bytes(total_size_buf);

        info!("📥 Zip 스트림 헤더: job={}, files={}, size={}", received_job_id, file_count, total_size);

        // READY 응답 전송
        send.write_all(b"READY").await?;

        // Zip 크기 수신
        let mut zip_size_buf = [0u8; 8];
        recv.read_exact(&mut zip_size_buf).await?;
        let zip_size = u64::from_le_bytes(zip_size_buf);

        info!("📥 Zip 데이터 수신 시작: {} bytes", zip_size);

        // 저장 경로 생성
        let final_save_path = if save_path.is_dir() {
            save_path.join(format!("{}.zip", job_id))
        } else {
            save_path.clone()
        };

        if let Some(parent) = final_save_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // 파일에 직접 쓰기
        let mut file = tokio::fs::File::create(&final_save_path).await?;
        let mut bytes_received: u64 = 0;
        let start_time = Instant::now();
        let mut last_progress = Instant::now();

        let mut buffer = vec![0u8; self.config.chunk_size];

        while bytes_received < zip_size {
            let remaining = (zip_size - bytes_received) as usize;
            let to_read = remaining.min(buffer.len());

            let bytes_read = recv.read(&mut buffer[..to_read]).await?
                .ok_or_else(|| anyhow::anyhow!("Unexpected end of stream"))?;

            if bytes_read == 0 {
                break;
            }

            tokio::io::AsyncWriteExt::write_all(&mut file, &buffer[..bytes_read]).await?;
            bytes_received += bytes_read as u64;

            // 진행률 보고
            if last_progress.elapsed().as_millis() >= self.config.progress_interval_ms as u128 {
                last_progress = Instant::now();
                self.report_progress(job_id, bytes_received, zip_size, &start_time).await;
            }
        }

        tokio::io::AsyncWriteExt::flush(&mut file).await?;
        drop(file);

        // 완료 응답 전송
        send.write_all(b"DONE").await?;
        let _ = send.finish();

        // 최종 진행률
        self.report_progress(job_id, zip_size, zip_size, &start_time).await;

        info!("✅ Zip 파일 저장 완료: {:?} ({} bytes)", final_save_path, bytes_received);
        Ok(final_save_path)
    }

    async fn report_progress(&self, job_id: &str, bytes: u64, total: u64, start: &Instant) {
        if let Some(tx) = &self.progress_tx {
            let progress = if total > 0 { (bytes as f64 / total as f64) * 100.0 } else { 0.0 };
            let elapsed = start.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 { (bytes as f64 / elapsed) as u64 } else { 0 };

            let _ = tx.send(TransferProgress {
                job_id: job_id.to_string(),
                bytes_transferred: bytes,
                total_bytes: total,
                progress_percent: progress,
                speed_bps: speed,
                state: super::TransferState::Transferring,
            }).await;
        }
    }
}

/// Zip 파일 압축 해제 유틸리티
pub fn extract_zip_to_directory(zip_path: &Path, output_dir: &Path) -> Result<Vec<PathBuf>> {
    use std::fs;
    
    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut extracted_files = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = match file.enclosed_name() {
            Some(path) => output_dir.join(path),
            None => continue,
        };

        if file.is_dir() {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent)?;
                }
            }
            let mut outfile = File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
            extracted_files.push(outpath.clone());
        }

        // Unix 권한 설정
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                fs::set_permissions(&outpath, fs::Permissions::from_mode(mode))?;
            }
        }
    }

    info!("📂 Zip 압축 해제 완료: {} 파일", extracted_files.len());
    Ok(extracted_files)
}
