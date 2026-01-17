//! Zero-Copy I/O 파이프라인
//!
//! TB급 파일 전송 시 커널-유저 공간 데이터 복사를 최소화합니다.
//! - Linux: io_uring 또는 sendfile 시스템 콜
//! - Windows: Overlapped I/O / TransmitFile
//! - 공통: Memory-mapped I/O (mmap)

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use tracing::{info, warn};

/// Zero-Copy I/O 엔진
pub struct ZeroCopyEngine {
    /// 사용 가능한 I/O 방식
    io_method: IoMethod,
}

/// I/O 방식
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IoMethod {
    /// Memory-mapped I/O
    Mmap,
    /// Linux io_uring (커널 5.1+)
    #[cfg(target_os = "linux")]
    IoUring,
    /// Windows Overlapped I/O
    #[cfg(target_os = "windows")]
    OverlappedIo,
}

impl ZeroCopyEngine {
    /// 시스템에 맞는 최적의 I/O 방식 선택
    pub fn new() -> Self {
        let io_method = Self::detect_best_io_method();
        info!("🚀 Zero-Copy I/O 엔진 초기화: {:?}", io_method);
        Self { io_method }
    }

    /// 시스템에서 사용 가능한 최적의 I/O 방식 감지
    fn detect_best_io_method() -> IoMethod {
        #[cfg(target_os = "linux")]
        {
            // io_uring 지원 여부 확인 (커널 5.1+)
            if Self::check_io_uring_support() {
                return IoMethod::IoUring;
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Windows는 항상 Overlapped I/O 지원
            return IoMethod::OverlappedIo;
        }

        // 기본: mmap 사용 (대부분의 시스템에서 지원)
        IoMethod::Mmap
    }

    #[cfg(target_os = "linux")]
    fn check_io_uring_support() -> bool {
        // /proc/version에서 커널 버전 확인
        if let Ok(version) = std::fs::read_to_string("/proc/version") {
            // 간단한 버전 파싱 (예: "Linux version 5.15.0")
            if let Some(ver_str) = version.split_whitespace().nth(2) {
                let parts: Vec<&str> = ver_str.split('.').collect();
                if parts.len() >= 2 {
                    if let (Ok(major), Ok(minor)) =
                        (parts[0].parse::<u32>(), parts[1].parse::<u32>())
                    {
                        // 커널 5.1 이상이면 io_uring 지원
                        return major > 5 || (major == 5 && minor >= 1);
                    }
                }
            }
        }
        false
    }

    /// 현재 I/O 방식 반환
    pub fn io_method(&self) -> IoMethod {
        self.io_method
    }
}

/// 블록 정보 (멀티스트림 전송용)
#[derive(Debug, Clone)]
pub struct BlockInfo {
    /// 블록 인덱스
    pub index: u32,
    /// 파일 내 오프셋
    pub offset: u64,
    /// 블록 크기
    pub size: u32,
    /// 전체 블록 수
    pub total_blocks: u32,
}

/// 파일을 논리적 블록으로 분할
pub fn split_file_into_blocks(file_size: u64, block_size: usize) -> Vec<BlockInfo> {
    let block_size = block_size as u64;
    let total_blocks = ((file_size + block_size - 1) / block_size) as u32;

    (0..total_blocks)
        .map(|i| {
            let offset = i as u64 * block_size;
            let size = std::cmp::min(block_size, file_size - offset) as u32;

            BlockInfo {
                index: i,
                offset,
                size,
                total_blocks,
            }
        })
        .collect()
}

// ============================================================================
// Linux io_uring 지원 (고성능 비동기 I/O)
// ============================================================================

#[allow(dead_code)]
#[cfg(target_os = "linux")]
pub mod linux_io {
    // Content removed as it was unused and contained unused imports
}

#[allow(dead_code)]
#[cfg(target_os = "windows")]
pub mod windows_io {
    // Content removed as it was unused
}

// ============================================================================
// 고성능 파일 전송 엔진 (QUIC 멀티스트림 지원)
// ============================================================================

/// 고성능 파일 전송기
///
/// - Zero-Copy mmap 읽기
/// - 멀티스트림 병렬 전송
/// - 프리페치 최적화
pub struct HighPerformanceFileSender {
    file_path: PathBuf,
    file_size: u64,
    #[cfg(unix)]
    mmap: Option<Arc<memmap2::Mmap>>,
}

impl HighPerformanceFileSender {
    /// 파일 열기 및 전송 준비
    pub fn open<P: AsRef<Path>>(path: P, _block_size: usize) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let file = File::open(&path)?;
        let metadata = file.metadata()?;
        let file_size = metadata.len();

        #[cfg(unix)]
        let mmap = unsafe {
            // 대용량 파일의 경우 전체를 매핑해도 OS가 페이징 처리하므로 괜찮음
            // 하지만 32비트 시스템 등 주소 공간 부족 시 실패할 수 있음 -> Buffered로 폴백
            match memmap2::Mmap::map(&file) {
                Ok(m) => {
                    // 순차 접근 힌트 제공 (Linux)
                    #[cfg(target_os = "linux")]
                    libc::madvise(m.as_ptr() as *mut _, m.len(), libc::MADV_SEQUENTIAL);
                    Some(Arc::new(m))
                }
                Err(e) => {
                    warn!("mmap 실패 (Buffered I/O 사용): {}", e);
                    None
                }
            }
        };

        info!("📂 파일 열기 완료 (Zero-Copy 준비): {} bytes", file_size);

        Ok(Self {
            file_path: path,
            file_size,
            #[cfg(unix)]
            mmap,
        })
    }

    /// 파일 크기
    pub fn file_size(&self) -> u64 {
        self.file_size
    }

    /// 블록 정보 목록 생성
    pub fn get_blocks(&self, block_size: usize) -> Vec<BlockInfo> {
        split_file_into_blocks(self.file_size, block_size)
    }

    /// Zero-Copy 읽기 (Unix Mmap)
    /// 반환값: 메모리 슬라이스 (복사 없음)
    #[cfg(unix)]
    pub fn read_block_mmap(&self, block: &BlockInfo) -> Option<&[u8]> {
        if let Some(mmap) = &self.mmap {
            let start = block.offset as usize;
            let end = start + block.size as usize;
            if end <= mmap.len() {
                return Some(&mmap[start..end]);
            }
        }
        None
    }

    /// Fallback 읽기 (Buffered I/O)
    pub fn read_block_buffered(&self, block: &BlockInfo) -> Result<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = File::open(&self.file_path)?;
        file.seek(SeekFrom::Start(block.offset))?;

        let mut buffer = vec![0u8; block.size as usize];
        // read_exact 대신 read를 사용하여 EOF 처리 유연성 확보
        let mut bytes_read = 0;
        while bytes_read < block.size as usize {
            let n = file.read(&mut buffer[bytes_read..])?;
            if n == 0 {
                break;
            }
            bytes_read += n;
        }
        buffer.truncate(bytes_read);
        Ok(buffer)
    }

    /// Mmap에서 데이터를 복사해오되, OS 캐시를 활용하여 고속으로 읽음
    pub fn read_block_mmap_copy(&self, block: &BlockInfo) -> Result<Vec<u8>> {
        #[cfg(unix)]
        if let Some(mmap) = &self.mmap {
            let start = block.offset as usize;
            let end = start + block.size as usize;
            if end <= mmap.len() {
                // 여기서 Page Fault 발생 가능 -> 따라서 spawn_blocking 필수
                let slice = &mmap[start..end];
                return Ok(slice.to_vec()); // 메모리 복사 1회 발생 (필수 불가결)
            }
        }
        // Fallback
        self.read_block_buffered(block)
    }

    /// 🚀 [추가] 스레드 풀에서 안전하게 읽기 위한 Owned Reader
    /// mmap에서 데이터를 복사하지만, 이는 별도 스레드에서 수행되므로
    /// 네트워크 스레드를 차단하지 않습니다.
    ///
    /// 반환값: Vec<u8> (소유권 있는 데이터)
    pub fn read_block_owned(&self, block: &BlockInfo) -> Result<Vec<u8>> {
        #[cfg(unix)]
        if let Some(mmap) = &self.mmap {
            let start = block.offset as usize;
            let end = start + block.size as usize;
            if end <= mmap.len() {
                // 🚀 [핵심] 여기서 Page Fault가 발생해도 Worker 스레드만 멈춤 (메인 전송 스레드는 안전)
                let slice = &mmap[start..end];

                // 🚀 [성능] OS 캐시를 활용한 고속 복사 (실제 디스크 접근은 최소화)
                // madvise(MADV_SEQUENTIAL) 설정으로 순차 접근 패턴 힌트 제공됨
                return Ok(slice.to_vec()); // 메모리 복사 1회 발생 (필수 불가결)
            }
        }
        // Fallback: Mmap 실패 시 기존 Buffered I/O 사용
        self.read_block_buffered(block)
    }
}

/// 고성능 파일 수신기
pub struct HighPerformanceFileReceiver {
    file: std::fs::File,
    file_size: u64,
    bytes_written: u64,
}

impl HighPerformanceFileReceiver {
    /// 파일 생성 및 수신 준비
    pub fn create<P: AsRef<Path>>(path: P, expected_size: u64) -> Result<Self> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path.as_ref())?;

        // 파일 크기 미리 할당 (단편화 방지 및 공간 확보)
        // set_len은 대부분의 플랫폼에서 truncate/ftruncate/SetEndOfFile을 호출합니다.
        // posix_fallocate가 성능상 이점이 있을 수 있으나, 호환성을 위해 set_len을 우선 사용합니다.
        if let Err(e) = file.set_len(expected_size) {
            warn!("파일 크기 사전 할당 실패 (디스크 공간 부족 가능성): {}", e);
            // 여기서 에러를 리턴하지 않고 진행하면, 쓰는 도중 에러가 날 수 있음.
            // 하지만 Rust의 set_len은 에러를 잘 반환하므로 전파하는 것이 안전함.
            return Err(anyhow::Error::from(e));
        }

        info!("📂 수신 파일 생성: {} bytes 예약", expected_size);

        Ok(Self {
            file,
            file_size: expected_size,
            bytes_written: 0,
        })
    }

    /// 특정 오프셋에 블록 쓰기
    pub fn write_block_at(&mut self, offset: u64, data: &[u8]) -> Result<()> {
        use std::io::{Seek, SeekFrom, Write};

        self.file.seek(SeekFrom::Start(offset))?;
        self.file.write_all(data)?;
        self.bytes_written += data.len() as u64;

        Ok(())
    }

    /// 파일 동기화 (디스크에 플러시)
    pub fn sync(&self) -> Result<()> {
        self.file.sync_all()?;
        Ok(())
    }

    /// 수신 완료 여부
    pub fn is_complete(&self) -> bool {
        self.bytes_written >= self.file_size
    }

    /// 수신된 바이트 수
    pub fn bytes_written(&self) -> u64 {
        self.bytes_written
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_file_into_blocks() {
        let blocks = split_file_into_blocks(100 * 1024 * 1024, 16 * 1024 * 1024);

        assert_eq!(blocks.len(), 7); // 100MB / 16MB = 6.25 -> 7 blocks
        assert_eq!(blocks[0].offset, 0);
        assert_eq!(blocks[0].size, 16 * 1024 * 1024);
        assert_eq!(blocks[6].size, 4 * 1024 * 1024); // 마지막 블록은 4MB
    }

    #[test]
    fn test_zero_copy_engine_detection() {
        let engine = ZeroCopyEngine::new();
        // 시스템에 따라 다른 I/O 방식이 선택됨
        println!("Detected I/O method: {:?}", engine.io_method());
    }
}
