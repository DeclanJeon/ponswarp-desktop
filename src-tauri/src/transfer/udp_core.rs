use anyhow::Result;
use bytes::{Bytes, BytesMut};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, RwLock, Semaphore};
use tracing::{debug, info, warn};

const UDP_PAYLOAD_SIZE: usize = 65507;
const CHUNK_HEADER_SIZE: usize = 24;
const MAX_CHUNK_DATA: usize = UDP_PAYLOAD_SIZE - CHUNK_HEADER_SIZE;
const DEFAULT_SOCKET_COUNT: usize = 8;

#[derive(Debug, Clone)]
pub struct TransferStats {
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub packets_sent: u64,
    pub packets_received: u64,
    pub packets_lost: u64,
    pub start_time: Instant,
    pub current_bandwidth_mbps: f64,
}

impl TransferStats {
    pub fn new() -> Self {
        Self {
            bytes_sent: 0,
            bytes_received: 0,
            packets_sent: 0,
            packets_received: 0,
            packets_lost: 0,
            start_time: Instant::now(),
            current_bandwidth_mbps: 0.0,
        }
    }

    pub fn calculate_bandwidth(&mut self) {
        let elapsed = self.start_time.elapsed().as_secs_f64();
        if elapsed > 0.0 {
            self.current_bandwidth_mbps = (self.bytes_sent as f64 * 8.0) / (elapsed * 1_000_000.0);
        }
    }
}

impl Default for TransferStats {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct ChunkHeader {
    pub job_id: u32,
    pub file_index: u16,
    pub chunk_index: u32,
    pub offset: u64,
    pub data_len: u16,
    pub checksum: u32,
}

impl ChunkHeader {
    pub fn encode(&self) -> [u8; CHUNK_HEADER_SIZE] {
        let mut buf = [0u8; CHUNK_HEADER_SIZE];
        buf[0..4].copy_from_slice(&self.job_id.to_le_bytes());
        buf[4..6].copy_from_slice(&self.file_index.to_le_bytes());
        buf[6..10].copy_from_slice(&self.chunk_index.to_le_bytes());
        buf[10..18].copy_from_slice(&self.offset.to_le_bytes());
        buf[18..20].copy_from_slice(&self.data_len.to_le_bytes());
        buf[20..24].copy_from_slice(&self.checksum.to_le_bytes());
        buf
    }

    pub fn decode(buf: &[u8]) -> Option<Self> {
        if buf.len() < CHUNK_HEADER_SIZE {
            return None;
        }

        Some(Self {
            job_id: u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]),
            file_index: u16::from_le_bytes([buf[4], buf[5]]),
            chunk_index: u32::from_le_bytes([buf[6], buf[7], buf[8], buf[9]]),
            offset: u64::from_le_bytes([
                buf[10], buf[11], buf[12], buf[13], buf[14], buf[15], buf[16], buf[17],
            ]),
            data_len: u16::from_le_bytes([buf[18], buf[19]]),
            checksum: u32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]),
        })
    }
}

pub struct UdpTransferCore {
    sockets: Vec<Arc<UdpSocket>>,
    stats: Arc<RwLock<TransferStats>>,
    send_semaphore: Arc<Semaphore>,
}

impl UdpTransferCore {
    pub async fn new(socket_count: usize) -> Result<Self> {
        let count = socket_count.max(1).min(64);
        let mut sockets = Vec::with_capacity(count);

        for i in 0..count {
            let socket = UdpSocket::bind("0.0.0.0:0").await?;

            #[cfg(target_os = "linux")]
            {
                use std::os::unix::io::AsRawFd;
                let fd = socket.as_raw_fd();
                unsafe {
                    let optval: libc::c_int = 1;
                    libc::setsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_REUSEPORT,
                        &optval as *const _ as *const libc::c_void,
                        std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                    );

                    let sndbuf: libc::c_int = 16 * 1024 * 1024;
                    libc::setsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_SNDBUF,
                        &sndbuf as *const _ as *const libc::c_void,
                        std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                    );

                    let rcvbuf: libc::c_int = 16 * 1024 * 1024;
                    libc::setsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_RCVBUF,
                        &rcvbuf as *const _ as *const libc::c_void,
                        std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                    );
                }
            }

            debug!("UDP 소켓 {} 생성: {}", i, socket.local_addr()?);
            sockets.push(Arc::new(socket));
        }

        info!("🚀 UDP 전송 코어 초기화: {} 소켓", count);

        Ok(Self {
            sockets,
            stats: Arc::new(RwLock::new(TransferStats::new())),
            send_semaphore: Arc::new(Semaphore::new(1000)),
        })
    }

    pub async fn send_chunk(
        &self,
        target: SocketAddr,
        header: ChunkHeader,
        data: &[u8],
    ) -> Result<()> {
        let socket_idx = (header.chunk_index as usize) % self.sockets.len();
        let socket = &self.sockets[socket_idx];

        let mut packet = BytesMut::with_capacity(CHUNK_HEADER_SIZE + data.len());
        packet.extend_from_slice(&header.encode());
        packet.extend_from_slice(data);

        let _permit = self.send_semaphore.acquire().await?;
        socket.send_to(&packet, target).await?;

        let mut stats = self.stats.write().await;
        stats.bytes_sent += packet.len() as u64;
        stats.packets_sent += 1;

        Ok(())
    }

    pub async fn send_data_parallel(
        &self,
        target: SocketAddr,
        job_id: u32,
        file_index: u16,
        data: Bytes,
    ) -> Result<u64> {
        let chunks: Vec<_> = data
            .chunks(MAX_CHUNK_DATA)
            .enumerate()
            .map(|(i, chunk)| {
                let header = ChunkHeader {
                    job_id,
                    file_index,
                    chunk_index: i as u32,
                    offset: (i * MAX_CHUNK_DATA) as u64,
                    data_len: chunk.len() as u16,
                    checksum: crc32fast::hash(chunk),
                };
                (header, chunk.to_vec())
            })
            .collect();

        let total_chunks = chunks.len();
        let mut handles = Vec::with_capacity(total_chunks);

        for (header, chunk_data) in chunks {
            let socket = self.sockets[header.chunk_index as usize % self.sockets.len()].clone();
            let stats = self.stats.clone();
            let semaphore = self.send_semaphore.clone();

            let handle = tauri::async_runtime::spawn(async move {
                let mut packet = BytesMut::with_capacity(CHUNK_HEADER_SIZE + chunk_data.len());
                packet.extend_from_slice(&header.encode());
                packet.extend_from_slice(&chunk_data);

                let _permit = semaphore.acquire().await.unwrap();
                if let Err(e) = socket.send_to(&packet, target).await {
                    warn!("청크 전송 실패: {}", e);
                    return 0u64;
                }

                let mut s = stats.write().await;
                s.bytes_sent += packet.len() as u64;
                s.packets_sent += 1;

                packet.len() as u64
            });

            handles.push(handle);
        }

        let mut total_sent = 0u64;
        for handle in handles {
            total_sent += handle.await.unwrap_or(0);
        }

        info!(
            "📤 병렬 전송 완료: {} 청크, {} bytes",
            total_chunks, total_sent
        );
        Ok(total_sent)
    }

    pub fn start_receiver(
        &self,
        socket_idx: usize,
    ) -> mpsc::Receiver<(ChunkHeader, Bytes, SocketAddr)> {
        let (tx, rx) = mpsc::channel(10000);
        let socket = self.sockets[socket_idx % self.sockets.len()].clone();
        let stats = self.stats.clone();

        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; UDP_PAYLOAD_SIZE];

            loop {
                match socket.recv_from(&mut buf).await {
                    Ok((len, addr)) => {
                        if len < CHUNK_HEADER_SIZE {
                            continue;
                        }

                        if let Some(header) = ChunkHeader::decode(&buf[..CHUNK_HEADER_SIZE]) {
                            let data = Bytes::copy_from_slice(&buf[CHUNK_HEADER_SIZE..len]);

                            let mut s = stats.write().await;
                            s.bytes_received += len as u64;
                            s.packets_received += 1;

                            if tx.send((header, data, addr)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        warn!("UDP 수신 오류: {}", e);
                    }
                }
            }
        });

        rx
    }

    pub async fn get_stats(&self) -> TransferStats {
        let mut stats = self.stats.write().await;
        stats.calculate_bandwidth();
        stats.clone()
    }

    pub fn socket_count(&self) -> usize {
        self.sockets.len()
    }

    pub async fn get_local_addrs(&self) -> Vec<SocketAddr> {
        let mut addrs = Vec::new();
        for socket in &self.sockets {
            if let Ok(addr) = socket.local_addr() {
                addrs.push(addr);
            }
        }
        addrs
    }
}
