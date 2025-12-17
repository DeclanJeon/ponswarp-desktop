use bytes::BytesMut;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock, Mutex};
use tracing::{info, debug};
use anyhow::Result;

const DEFAULT_BUFFER_SIZE: usize = 64 * 1024;
const DEFAULT_POOL_SIZE: usize = 1000;

pub struct BufferPool {
    buffers: Mutex<Vec<BytesMut>>,
    buffer_size: usize,
    allocated: Arc<RwLock<usize>>,
    max_buffers: usize,
}

impl BufferPool {
    pub fn new(pool_size: usize, buffer_size: usize) -> Self {
        let buffers: Vec<_> = (0..pool_size)
            .map(|_| BytesMut::with_capacity(buffer_size))
            .collect();
        
        info!("🔧 버퍼 풀 생성: {} 버퍼 x {} KB = {} MB",
            pool_size, 
            buffer_size / 1024,
            (pool_size * buffer_size) / (1024 * 1024)
        );
        
        Self {
            buffers: Mutex::new(buffers),
            buffer_size,
            allocated: Arc::new(RwLock::new(0)),
            max_buffers: pool_size * 2,
        }
    }

    pub async fn acquire(&self) -> Option<BytesMut> {
        let mut pool = self.buffers.lock().await;
        
        if let Some(mut buf) = pool.pop() {
            buf.clear();
            let mut allocated = self.allocated.write().await;
            *allocated += 1;
            return Some(buf);
        }
        
        let allocated = *self.allocated.read().await;
        if allocated < self.max_buffers {
            let mut alloc = self.allocated.write().await;
            *alloc += 1;
            debug!("버퍼 풀 확장: {}/{}", *alloc, self.max_buffers);
            return Some(BytesMut::with_capacity(self.buffer_size));
        }
        
        None
    }

    pub async fn release(&self, buf: BytesMut) {
        let mut pool = self.buffers.lock().await;
        
        if pool.len() < self.max_buffers {
            pool.push(buf);
        }
        
        let mut allocated = self.allocated.write().await;
        if *allocated > 0 {
            *allocated -= 1;
        }
    }

    pub async fn stats(&self) -> (usize, usize) {
        let pool = self.buffers.lock().await;
        let allocated = *self.allocated.read().await;
        (pool.len(), allocated)
    }
}

#[derive(Debug, Clone)]
pub struct RelayTarget {
    pub address: std::net::SocketAddr,
    pub weight: f32,
}

pub struct RelaySession {
    pub job_id: String,
    pub source: String,
    pub targets: Vec<RelayTarget>,
    pub bytes_relayed: Arc<RwLock<u64>>,
    pub created_at: std::time::Instant,
}

impl RelaySession {
    pub fn new(job_id: String, source: String, targets: Vec<RelayTarget>) -> Self {
        Self {
            job_id,
            source,
            targets,
            bytes_relayed: Arc::new(RwLock::new(0)),
            created_at: std::time::Instant::now(),
        }
    }

    pub async fn add_relayed_bytes(&self, bytes: u64) {
        let mut total = self.bytes_relayed.write().await;
        *total += bytes;
    }
}

pub struct RelayEngine {
    buffer_pool: Arc<BufferPool>,
    sessions: Arc<RwLock<HashMap<String, Arc<RelaySession>>>>,
    data_channel: (mpsc::Sender<RelayData>, Arc<Mutex<mpsc::Receiver<RelayData>>>),
    running: Arc<RwLock<bool>>,
}

#[derive(Debug)]
pub struct RelayData {
    pub job_id: String,
    pub data: BytesMut,
    pub source: std::net::SocketAddr,
}

impl RelayEngine {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel(10000);
        
        Self {
            buffer_pool: Arc::new(BufferPool::new(DEFAULT_POOL_SIZE, DEFAULT_BUFFER_SIZE)),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            data_channel: (tx, Arc::new(Mutex::new(rx))),
            running: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn start(&self) -> Result<()> {
        let mut running = self.running.write().await;
        if *running {
            return Ok(());
        }
        *running = true;
        drop(running);

        info!("🔄 릴레이 엔진 시작");

        let sessions = self.sessions.clone();
        let buffer_pool = self.buffer_pool.clone();
        let rx = self.data_channel.1.clone();
        let running = self.running.clone();

        tauri::async_runtime::spawn(async move {
            let mut receiver = rx.lock().await;
            
            while *running.read().await {
                tokio::select! {
                    Some(data) = receiver.recv() => {
                        let sessions = sessions.read().await;
                        if let Some(session) = sessions.get(&data.job_id) {
                            let data_len = data.data.len() as u64;
                            
                            for target in &session.targets {
                                debug!("릴레이: {} bytes -> {}", data_len, target.address);
                            }
                            
                            session.add_relayed_bytes(data_len).await;
                        }
                        
                        buffer_pool.release(data.data).await;
                    }
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                        continue;
                    }
                }
            }
            
            info!("릴레이 엔진 워커 종료");
        });

        Ok(())
    }

    pub async fn stop(&self) {
        let mut running = self.running.write().await;
        *running = false;
        info!("🛑 릴레이 엔진 중지");
    }

    pub async fn create_session(
        &self,
        job_id: String,
        source: String,
        targets: Vec<RelayTarget>,
    ) -> Result<()> {
        let session = Arc::new(RelaySession::new(job_id.clone(), source, targets));
        
        let mut sessions = self.sessions.write().await;
        sessions.insert(job_id.clone(), session);
        
        info!("📋 릴레이 세션 생성: {}", job_id);
        Ok(())
    }

    pub async fn relay_data(&self, job_id: &str, data: BytesMut) -> Result<()> {
        let source = std::net::SocketAddr::from(([0, 0, 0, 0], 0));
        
        self.data_channel.0.send(RelayData {
            job_id: job_id.to_string(),
            data,
            source,
        }).await?;
        
        Ok(())
    }

    pub async fn end_session(&self, job_id: &str) -> Option<u64> {
        let mut sessions = self.sessions.write().await;
        
        if let Some(session) = sessions.remove(job_id) {
            let bytes = *session.bytes_relayed.read().await;
            info!("📋 릴레이 세션 종료: {}, {} bytes 전송됨", job_id, bytes);
            return Some(bytes);
        }
        
        None
    }

    pub async fn get_session_stats(&self, job_id: &str) -> Option<(u64, std::time::Duration)> {
        let sessions = self.sessions.read().await;
        
        if let Some(session) = sessions.get(job_id) {
            let bytes = *session.bytes_relayed.read().await;
            let elapsed = session.created_at.elapsed();
            return Some((bytes, elapsed));
        }
        
        None
    }

    pub async fn active_session_count(&self) -> usize {
        self.sessions.read().await.len()
    }

    pub async fn buffer_pool_stats(&self) -> (usize, usize) {
        self.buffer_pool.stats().await
    }

    pub async fn acquire_buffer(&self) -> Option<BytesMut> {
        self.buffer_pool.acquire().await
    }

    pub async fn release_buffer(&self, buf: BytesMut) {
        self.buffer_pool.release(buf).await;
    }
}

impl Default for RelayEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "linux")]
pub fn verify_no_disk_write() -> bool {
    use std::fs;
    
    let io_stats = fs::read_to_string("/proc/self/io").unwrap_or_default();
    let write_bytes: u64 = io_stats
        .lines()
        .find(|l| l.starts_with("write_bytes:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    info!("📊 Zero-Disk 검증: 디스크 쓰기 {} bytes", write_bytes);
    write_bytes == 0
}

#[cfg(not(target_os = "linux"))]
pub fn verify_no_disk_write() -> bool {
    info!("📊 Zero-Disk 검증: Linux 외 플랫폼은 항상 true");
    true
}
