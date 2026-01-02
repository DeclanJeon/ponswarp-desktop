# PonsWarp 차세대 전송 엔진 아키텍처 설계서 (Master Design Document)

**Status:** Draft
**Version:** 2.0.0-PROPOSAL
**Author:** PonsWarp Architecture Team
**Date:** 2026-01-02
**Target System:** PonsWarp Desktop v0.2.x Core Patch

---

## 📋 목차 (Table of Contents)

1.  **서론 (Introduction)**
    1.1 배경 및 목적
    1.2 현재 시스템의 한계점 심층 분석
    1.3 설계 철학 및 목표

2.  **시스템 아키텍처 개요 (System Architecture Overview)**
    2.1 High-Level Architecture
    2.2 데이터 흐름도 (Data Flow Diagram)
    2.3 스레드 모델링 및 동시성 전략

3.  **Patch 1: True Streaming Zip Architecture (심층 설계)**
    3.1 개념적 모델: Producer-Consumer 파이프라인
    3.2 핵심 컴포넌트: `ChannelWriter` 상세 명세
    3.3 메모리 파이프라인 제어 (Backpressure)
    3.4 Zip Entry 상태 머신 및 스트리밍 규격
    3.5 에러 전파 및 리소스 정리 전략
    3.6 구현 의사코드 (Detailed Pseudocode)

4.  **Patch 2: 정밀 속도 측정 및 동기화 (Precision Sync)**
    4.1 속도 측정의 원리적 한계와 해결책
    4.2 ACK 기반 2-Phase 측정 모델
    4.3 프로토콜 확장: `VerifiedBytes` 패킷
    4.4 Sliding Window 평균화 알고리즘
    4.5 UI 연동 및 업데이트 주기 최적화

5.  **Patch 3: 적응형 블록 전송 (Adaptive Transport)**
    5.1 네트워크 대역폭과 블록 크기의 상관관계 분석
    5.2 동적 블록 크기 산출 알고리즘 (Heuristic Formula)
    5.3 Small-File 최적화 전략 (Batching vs Streaming)
    5.4 Zero-Copy I/O 파이프라인 개선

6.  **안전성 및 에러 핸들링 (Safety & Robustness)**
    6.1 Rust Memory Safety 모델 적용
    6.2 Panic 방지 및 Graceful Shutdown
    6.3 네트워크 연결 끊김 및 재시도 전략

7.  **성능 예측 모델링 (Performance Modeling)**
    7.1 이론적 최대 처리량 계산
    7.2 메모리 점유율 예측
    7.3 I/O 병목 분석

8.  **구현 로드맵 (Implementation Roadmap)**
    8.1 단계별 마일스톤
    8.2 테스트 계획 (Unit & Integration)

---

## 1. 서론 (Introduction)

### 1.1 배경 및 목적

PonsWarp는 로컬 네트워크 기반의 고속 P2P 파일 전송 도구로서, 데스크톱 환경(Tauri/Rust)에서의 최고의 성능과 사용자 경험을 목표로 한다. 초기 버전(v0.1)은 기능 구현에 초점을 맞추었으나, 대용량 파일(10GB+) 및 다중 파일 전송 시나리오에서 구조적 한계가 드러났다. 특히 **OOM(Out of Memory)** 현상과 **전송 속도 표시의 부정확성**은 사용자 신뢰도를 저하시키는 핵심 요인이다.

본 문서는 이러한 문제를 근본적으로 해결하기 위해 코어 전송 엔진을 재설계하는 청사진이다. 단순한 "버그 수정"이 아닌, **엔터프라이즈급 안정성**을 갖춘 전송 엔진으로의 도약을 목적으로 한다.

### 1.2 현재 시스템의 한계점 심층 분석

#### 1.2.1 메모리 아키텍처의 결함 (Zip 전송)

현재 구현체 `file_transfer.rs` 및 `zip_stream.rs`는 "전체 파일 압축 후 전송"이라는 단순한 모델을 따르고 있다.

- **현상:** 10GB 폴더를 전송하려 하면 `Cursor<Vec<u8>>`에 10GB를 모두 쓴 뒤, 이를 `quinn` 스트림으로 보낸다.
- **원인:** `zip` crate의 `ZipWriter`가 `Seek` 트레이트를 요구한다고 가정하여, 메모리 버퍼(Cursor)를 사용했기 때문이다.
- **영향:**
  - RAM 16GB 머신에서 8GB 이상의 파일 전송 시 시스템 스왑 발생 후 크래시.
  - 전송 시작까지의 대기 시간(TTFB)이 매우 김 (압축이 끝날 때까지 0% 진행).

#### 1.2.2 비동기(Async)와 동기(Blocking)의 혼재

- **현상:** `spawn_blocking`을 일부 사용하고 있으나, 파일 읽기 작업과 네트워크 쓰기 작업이 긴밀하게 결합되어 있어, 디스크 I/O 병목이 네트워크 스루풋을 저하시킨다.
- **원인:** 파이프라인 구조가 아닌, 순차적 실행 구조(`read` -> `compress` -> `send`)를 가지고 있다.

#### 1.2.3 속도 측정의 괴리

- **현상:** Sender는 "500MB/s"로 표시되는데, Receiver는 "80MB/s"로 표시된다.
- **원인:** Sender는 QUIC 송신 버퍼(User-Space to Kernel-Space)에 데이터를 밀어넣는 속도를 측정하고, Receiver는 디스크에 완전히 쓴(Flush) 속도를 측정한다. 중간에 있는 네트워크 버퍼와 혼잡 제어(Congestion Control) 큐의 존재를 무시했다.

### 1.3 설계 철학 및 목표

1.  **Memory-Bounded Processing:** 어떤 크기의 파일(1TB+)을 전송하더라도, 애플리케이션의 메모리 사용량은 고정된 상한선(예: 64MB)을 넘지 않아야 한다.
2.  **Backpressure Propagation:** 수신측 디스크가 느리면 송신측 읽기 속도도 자동으로 조절되어야 하며, 메모리에 데이터를 무한정 쌓지 않아야 한다.
3.  **Observability:** 사용자가 보는 속도는 "실제 전송된 유효 데이터"여야 하며, 송수신 양측이 1초 이내의 오차로 동기화되어야 한다.

---

## 2. 시스템 아키텍처 개요 (System Architecture Overview)

### 2.1 High-Level Architecture

새로운 아키텍처는 **3-Stage Pipeline** 모델을 따른다.

```mermaid
graph LR
    subgraph Sender [Sender Node]
        FS[Disk / File System]
        Stage1[Stage 1: Reader & Compressor]
        Channel[Bounded Channel (Ring Buffer)]
        Stage2[Stage 2: Network Tranpsort (QUIC)]
    end

    subgraph Network [Local Network]
        UDP[QUIC / UDP Packets]
    end

    subgraph Receiver [Receiver Node]
        Stage3[Stage 3: Network Receiver]
        DiskBuffer[Write Buffer]
        TargetFS[Disk / File System]
    end

    FS --> Stage1
    Stage1 --> Channel
    Channel --> Stage2
    Stage2 --> UDP
    UDP --> Stage3
    Stage3 --> DiskBuffer
    DiskBuffer --> TargetFS
```

### 2.2 핵심 변경 사항 요약

|     컴포넌트     | 변경 전 (AS-IS)                     | 변경 후 (TO-BE)                        | 기대 효과                             |
| :--------------: | :---------------------------------- | :------------------------------------- | :------------------------------------ |
|  **Zip Engine**  | Memory Buffer (`Vec<u8>`) 전체 생성 | **Stream Pipeline** (`mpsc` Channel)   | 메모리 사용량 99% 감소 (OOM 해결)     |
|  **I/O Model**   | Sync IO mixed with Async            | **Dedicated Blocking Threads** for I/O | 네트워크 응답성 향상, CPU 활용 최적화 |
| **Flow Control** | TCP/QUIC 기본 제어 의존             | **App-Level Backpressure** (Channel)   | 시스템 안정성 확보                    |
|   **Progress**   | Send Buffer 기준 측정               | **ACK-based Verification**             | 정확한 전송 속도 제공                 |

---

## 3. Patch 1: True Streaming Zip Architecture (심층 설계)

이 섹션은 이번 패치의 가장 중요한 부분인 "스트리밍 압축 전송"의 상세 설계를 다룬다.

### 3.1 개념적 모델: Producer-Consumer 파이프라인

메모리 부족 문제를 해결하기 위해, 데이터를 생성하는 속도와 전송하는 속도를 분리하고 그 사이를 고정 크기의 채널로 연결한다.

- **Producer (생산자):** 파일 시스템에서 파일을 읽고, Zip 포맷으로 압축(Deflate/Stored)하여 청크(Chunk) 단위로 배출한다. 이 작업은 CPU 연산과 디스크 I/O가 주를 이루므로 별도의 `OS Thread` (via `spawn_blocking`)에서 실행된다.
- **Buffer (채널):** 생산된 청크를 일시 저장하는 큐(Queue). 메모리 폭발을 막기 위해 반드시 **Bounded(유한)** 크기를 가져야 한다.
- **Consumer (소비자):** 채널에서 청크를 꺼내 QUIC 스트림으로 전송한다. 이 작업은 네트워크 I/O 대기가 주를 이루므로 `Tokio Async Task`에서 실행된다.

### 3.2 핵심 컴포넌트: `ChannelWriter` 상세 명세

`zip` crate는 `Write + Seek` 트레이트를 요구한다. 스트리밍을 위해서는 `Seek`을 흉내내고, 실제 데이터는 채널로 흘려보내는 어댑터가 필요하다.

#### 3.2.1 Struct Definition

```rust
/// Zip 라이브러리의 출력을 mpsc 채널로 브릿징하는 Writer
///
/// 이 구조체는 `Write` 트레이트를 구현하여, ZipWriter가 데이터를 쓸 때마다
/// 이를 청크 단위로 모아서 채널로 전송한다.
pub struct ChannelWriter {
    /// 데이터를 전송할 채널의 송신자.
    /// SyncSender를 사용하여 수신측이 느릴 때 블로킹(Backpressure)을 유발한다.
    sender: std::sync::mpsc::SyncSender<Vec<u8>>,

    /// 현재까지 쓰여진 총 바이트 수 (Seek::stream_position 지원용)
    position: u64,

    /// 내부 임시 버퍼. 너무 작은 쓰기 요청을 모아서 보내기 위함.
    buffer: Vec<u8>,

    /// 버퍼 플러시 임계값 (예: 64KB)
    buffer_threshold: usize,
}
```

#### 3.2.2 Trait Implementation Strategy

**`impl Write for ChannelWriter`**

1.  입력받은 `buf`를 내부 `buffer`에 append 한다.
2.  `buffer` 크기가 `buffer_threshold`를 넘으면, `sender.send()`를 호출하여 Consumer에게 전달한다.
3.  `send()` 과정에서 채널이 가득 찼다면, Receiver가 데이터를 가져갈 때까지 현재 스레드는 블로킹된다 (Backpressure 동작).
4.  `position`을 업데이트한다.

**`impl Seek for ChannelWriter`**
`zip` crate는 헤더 수정을 위해 되감기(Seek)를 시도할 수 있다. 스트리밍 모드에서는 이것이 불가능하므로 전략적인 구현이 필요하다.

1.  **Read-Only Seek:** `SeekFrom::Current(0)` 요청은 현재 `position`을 반환하여 허용한다. (Zip 라이브러리가 현재 위치 확인용으로 자주 사용)
2.  **Unsupported Seek:** 그 외의 모든 뒤로 가기(`Start`, `End`, 음수 `Current`) 요청은 `IoError`를 반환하지 않고, **패닉하거나 에러를 내야 한다**.
    - _중요:_ `ZipWriter` 생성 시 스트리밍 옵션을 켜면 Seek을 시도하지 않으므로, 이 메서드는 방어적으로 구현한다.

### 3.3 쓰레딩 모델 및 동기화 (Thread Model)

```rust
pub async fn send_zip_streaming(files: Vec<PathBuf>, conn: Connection) -> Result<()> {
    // 1. 통신 채널 생성 (Buffer Size: 4 = 4MB if chunk is 1MB)
    // 메모리 사용량 상한 = 4 * 1024 * 1024 bytes
    let (tx, rx) = std::sync::mpsc::sync_channel(4);

    // 2. Producer 스레드 시작 (CPU & Disk Intensive)
    let producer_handle = tokio::task::spawn_blocking(move || {
        let writer = ChannelWriter::new(tx);
        let mut zip = zip::ZipWriter::new(writer);

        // 중요: 스트리밍 모드를 위해 파일 옵션 설정
        let options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o755);
            // .large_file(true) -> Zip64 자동 처리

        for file in files {
            // ZipWriter는 여기서 Header를 쓰고 데이터를 쓴 뒤 Data Descriptor를 쓴다.
            zip.start_file(name, options)?;
            std::io::copy(&mut fs::File::open(file)?, &mut zip)?;
        }

        zip.finish()?; // Central Directory 기록
        Ok(())
    });

    // 3. Consumer 태스크 (Network I/O)
    let mut quic_stream = conn.open_uni().await?;

    // 채널을 Async Stream으로 변환하거나 loop로 수신
    // sync_channel의 Receiver는 blocking이므로, 여기서 바로 쓰면 안됨.
    // 방법 A: rx도 blocking 스레드에서 처리? -> QUIC은 async임.
    // 방법 B: tokio::sync::mpsc 사용 (권장)

    // [설계 변경] std::sync::mpsc 대신 tokio::sync::mpsc 사용
    // Producer가 spawn_blocking 내에서 `blocking_send`를 사용해야 함.

    while let Some(chunk) = rx.recv().await {
        quic_stream.write_all(&chunk).await?;
        // 진행률 업데이트
    }

    // 4. 종료 대기
    producer_handle.await??;
    quic_stream.finish().await?;
}
```

**수정된 채널 전략:**
`std::sync::mpsc`는 Async 컨텍스트에서 `recv()`를 `await`할 수 없다. 따라서 **`tokio::sync::mpsc`**를 사용한다.

- **Producer (Blocking context):** `tx.blocking_send(chunk)`를 사용하여 Async 채널에 동기적으로 데이터를 넣는다.
- **Consumer (Async context):** `rx.recv().await`를 사용하여 비동기적으로 데이터를 꺼낸다.
  이 방식이 Rust 비동기 생태계에서 가장 우아한 Producer-Consumer 패턴이다.

### 3.4 Zip Entry 상태 머신 및 스트리밍 규격

Zip 파일 구조는 스트리밍에 친화적이지 않다(헤더에 크기가 미리 들어가야 함). 이를 해결하기 위해 **Data Descriptor** 기능을 활용해야 한다.

- **Local File Header:** 파일 크기(Compressed/Uncompressed Size)를 0으로 기록하고, Bit 3 플래그를 세팅하여 "크기 정보는 데이터 뒤에 옴"을 명시한다.
- **File Data:** 압축된 데이터 스트림.
- **Data Descriptor:** 데이터가 끝난 직후 `CRC-32`, `Compressed Size`, `Uncompressed Size`를 기록한다.

**설계 시 고려사항:**
`zip` crate는 `FileOptions` 설정을 통해 이를 자동으로 처리해준다. 다만, `ZipWriter`가 `Seek` 시도를 하지 않도록 확실히 제어해야 한다.

### 3.5 상세 구현 의사코드 (Detailed Implementation Plan)

#### 3.5.1 `src-tauri/src/transfer/zip_stream.rs` - New Implementation

```rust
use tokio::sync::mpsc;
use std::io::{Write, Result as IoResult, Error as IoError, ErrorKind};

// --- ChannelWriter ---
struct ChannelWriter {
    // Tokio 채널 sender. blocking_send를 사용하기 위해 보관
    tx: mpsc::Sender<Vec<u8>>,
    buffer: Vec<u8>,
    position: u64,
    limit: usize, // e.g., 64KB
}

impl ChannelWriter {
    fn new(tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self { tx, buffer: Vec::with_capacity(65536), position: 0, limit: 65536 }
    }

    fn flush_buffer(&mut self) -> IoResult<()> {
        if self.buffer.is_empty() { return Ok(()); }

        let chunk = std::mem::replace(&mut self.buffer, Vec::with_capacity(self.limit));
        // Blocking send: 채널이 꽉 차면 여기서 대기함 (Backpressure)
        self.tx.blocking_send(chunk)
            .map_err(|_| IoError::new(ErrorKind::BrokenPipe, "Receiver dropped"))?;
        Ok(())
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
        self.buffer.extend_from_slice(buf);
        self.position += buf.len() as u64;

        if self.buffer.len() >= self.limit {
            self.flush_buffer()?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> IoResult<()> {
        self.flush_buffer()
    }
}

impl std::io::Seek for ChannelWriter {
    fn seek(&mut self, pos: std::io::SeekFrom) -> IoResult<u64> {
        match pos {
            std::io::SeekFrom::Current(0) => Ok(self.position),
            _ => Err(IoError::new(ErrorKind::Other, "StreamingZip: Random seek not supported")),
        }
    }
}
```

---

## 4. Patch 2: 정밀 속도 측정 및 동기화 (Precision Sync)

### 4.1 속도 측정의 딜레마 (The Measurement Dilemma)

네트워크 전송에는 세 가지 관점의 "속도"가 존재한다.

1.  **Application Write Speed:** 앱이 소켓 API `write()`를 호출하는 속도 (가장 빠름, 실제 전송 아님).
2.  **Network Throughput:** 실제 케이블/와이파이를 타고 흐르는 속도 (중간, 물리적 한계).
3.  **Application Read Speed:** 수신 앱이 소켓에서 `read()`하여 디스크에 쓰는 속도 (가장 느림, 최종 완료 기준).

현재 PonsWarp는 1번(Sender)과 3번(Receiver)을 표시하므로 사용자에게 혼란을 준다.

### 4.2 ACK 기반 2-Phase 측정 모델

우리는 3번, 즉 "수신자가 실제로 처리를 완료한 속도"를 **진실의 원천(Source of Truth)**으로 정의한다. 이를 위해 송신자는 자신이 보낸 데이터가 아닌, 수신자가 "받았다"고 응답한 데이터를 기준으로 진행률을 표시해야 한다.

#### 4.2.1 Protocol Logic

- **기존:** `BLCK` (Data) -> `...wait...` -> `BACK` (Ack)
- **변경:** UI 업데이트 시 `BACK`을 받은 바이트 수만 카운팅한다.

### 4.3 Data Structure Update

`MultiStreamProgress` 구조체를 확장하여 UI에 더 많은 맥락을 제공한다.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferStatus {
    pub job_id: String,

    /// 네트워크로 내보낸 바이트 (Wire Bytes)
    pub bytes_sent: u64,

    /// 수신측이 확인한 바이트 (Verified / Acked Bytes) - UI 메인 표시용
    pub bytes_acked: u64,

    /// 전체 바이트
    pub total_bytes: u64,

    /// 현재 유효 속도 (ACK 기준)
    pub speed_bps: u64,

    /// 예상 남은 시간 (ETA) - 초 단위
    pub eta_seconds: Option<u64>,
}
```

### 4.4 Sliding Window 평균화 알고리즘

순간 속도(`Instant Speed`)는 변동성이 매우 크다. 부드러운 UI를 위해 **이동 평균(Moving Average)** 필터를 적용한다.

```rust
struct SpeedCalculator {
    window: VecDeque<(Instant, u64)>, // (Time, AckedBytes)
    window_duration: Duration, // e.g., 2 seconds
}

impl SpeedCalculator {
    fn update(&mut self, now: Instant, acked: u64) {
        self.window.push_back((now, acked));
        // 2초 지난 데이터 제거
        while let Some(front) = self.window.front() {
            if now.duration_since(front.0) > self.window_duration {
                self.window.pop_front();
            } else {
                break;
            }
        }
    }

    fn get_speed(&self) -> u64 {
        if self.window.len() < 2 { return 0; }
        let (start_time, start_bytes) = self.window.front().unwrap();
        let (end_time, end_bytes) = self.window.back().unwrap();

        let duration = end_time.duration_since(*start_time).as_secs_f64();
        if duration == 0.0 { return 0; }

        ((end_bytes - start_bytes) as f64 / duration) as u64
    }
}
```

---

## 5. Patch 3: 적응형 블록 전송 (Adaptive Transport)

### 5.1 네트워크 대역폭과 블록 크기 분석

- **Small Block (e.g., 64KB):**
  - 장점: 반응성 좋음, 패킷 손실 시 재전송 부담 적음.
  - 단점: 시스템 콜(Syscall) 오버헤드 증가, ACK 트래픽 증가, 32개 스트림 제한 시 대역폭 포화 못 시킴.
- **Large Block (e.g., 16MB):**
  - 장점: Syscall 최소화, Zero-Copy 효율 극대화.
  - 단점: "Head-of-Line Blocking" 유사 현상 (한 블록 실패 시 16MB 재전송 부담), 진행률 업데이트가 뚝뚝 끊김(Choppy UI).

### 5.2 동적 블록 크기 산출 알고리즘

파일 크기에 따라 최적의 블록 크기를 결정하는 휴리스틱 함수를 도입한다.

$$ BlockSize = \text{Clamp} \left ( \frac{FileSize}{TargetChunkCount}, MinBlock, MaxBlock \right ) $$

- **TargetChunkCount:** 64 ~ 128 (적절한 병렬성 및 진행률 부드러움을 위해)
- **MinBlock:** 256KB
- **MaxBlock:** 16MB

#### 5.2.1 Rust Implementation

```rust
fn calculate_optimal_block_size(file_size: u64) -> usize {
    const MIN_BLOCK: u64 = 256 * 1024;       // 256KB
    const MAX_BLOCK: u64 = 16 * 1024 * 1024; // 16MB
    const TARGET_PARTS: u64 = 100;           // 파일을 100조각 내는 것을 목표

    let ideal_size = file_size / TARGET_PARTS;
    ideal_size.clamp(MIN_BLOCK, MAX_BLOCK) as usize
}
```

### 5.3 Small-File Strategy

수천 개의 1KB 파일을 전송할 때 멀티스트림 오버헤드(스트림 생성/핸드쉐이크 등)는 배보다 배꼽이 더 크다. 이를 위해 **"Batch Mode"**를 도입한다.

- **Adaptive Mode:** 파일 크기가 `1MB` 미만인 경우, 별도의 멀티스트림을 열지 않고 **제어 스트림(Control Stream)**을 통해 직렬로 빠르게 전송하거나, `Tar` 등으로 묶어서(On-the-fly) 전송하는 전략을 고려한다. (이번 Patch에서는 우선 Block Size 조절만 적용하고, 추후 고도화)

---

## 6. 안전성 및 에러 핸들링 (Safety & Robustness)

### 6.1 Resource Cleanup (RAII)

Rust의 Ownership 모델을 활용하여, 전송 중단(Cancel)이나 에러 발생 시 파일 핸들과 네트워크 스트림이 즉시 해제되도록 보장한다.

- `AbortHandle`을 사용하여 `tokio::spawn`된 태스크들을 강제 종료한다.
- `tempfile` crate 등을 활용하여 수신 중 실패한 임시 파일은 자동 삭제되도록 한다.

### 6.2 Graceful Cancellation Implementation

사용자가 "취소" 버튼을 눌렀을 때:

1.  Frontend -> Backend: `cancel_job(job_id)` 호출.
2.  Backend: 해당 `job_id`에 매핑된 `CancellationToken`을 트리거.
3.  Tasks: `select!` 문에서 취소 시그널을 감지하고 즉시 루프 탈출.
4.  Cleanup: 부분 저장된 파일 삭제(`fs::remove_file`) 후 UI에 "취소됨" 알림.

---

## 7. 성능 예측 모델링 (Performance Modeling)

### 7.1 수식적 예측

가정:

- Network Bandwidth: 1Gbps (125MB/s)
- Disk Write Speed: 500MB/s (NVMe SSD)
- RTT: 1ms (Local LAN)

**기존 방식 (Zip In-Memory):**

- $Mem = FileSize$
- $Time = T*{compress} + T*{network} $ (Sequential)
- 10GB 파일: 메모리 10GB 소요(OOM Crash), 압축 시간 약 1분 지연.

**패치 후 방식 (Streaming):**

- $Mem = ChannelCapacity \times ChunkSize = 4 \times 1MB = 4MB$ (Constant)
- $Time = \max(T_{compress}, T_{network})$ (Pipelined)
- 압축과 전송이 병렬 처리되므로, 둘 중 느린 쪽 속도에 수렴.
- Deflate Level 1 사용 시 CPU가 충분하면 네트워크 속도(1Gbps)에 근접 가능.

---

## 8. 구현 로드맵 (Implementation Roadmap)

### Phase 1: Core Patch (우선순위 높음, 즉시)

- `zip_stream.rs` 재작성: `ChannelWriter` 구현 및 스트리밍 파이프라인 구축.
- `MultiStreamSender` 수정: Block Size 계산 로직 추가.
- `Cargo.toml` 의존성 확인: `tokio`, `zip` 버전 호환성 체크.

### Phase 2: UX Sync (중간)

- `MultiStreamProgress` 구조체 필드 추가.
- `multistream.rs` 내부 ACK 카운팅 로직 개선.
- Frontend: 새로운 Progress 필드(`bytes_acked`) 연동.

### Phase 3: Stabilization (마무리)

- 10GB 더미 파일 생성 후 전송 테스트 (메모리 프로파일링).
- Wi-Fi 환경(고지연) 시뮬레이션 테스트.
- 통합 테스트 시나리오 작성.

---

**End of Document**
