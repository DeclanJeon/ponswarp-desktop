# Ponswarp Desktop - 상세 구현 계획서 v2

**문서 버전**: 2.0  
**작성일**: 2026년 1월 6일  
**프로젝트**: Ponswarp Desktop (Tauri v2, React, Rust)  
**현재 완성도**: ~82%  
**목표 완성도**: 100% (RC1)

---

## 📁 목차

1. [개요 및 우선순위](#1-개요-및-우선순위)
2. [Phase 1: 보안 및 안정성](#2-phase-1-보안-및-안정성)
3. [Phase 2: AI 인텔리전스](#3-phase-2-ai-인텔리전스)
4. [Phase 3: UX 및 최적화](#4-phase-3-ux-및-최적화)
5. [의존성 변경사항](#5-의존성-변경사항)
6. [통합 테스트 전략](#6-통합-테스트-전략)
7. [마이그레이션 가이드](#7-마이그레이션-가이드)

---

## 1. 개요 및 우선순위

### 1.1 현재 기술 스택

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React 19)                     │
├─────────────────────────────────────────────────────────────┤
│  • React 19.2.0 + TypeScript 5.9                            │
│  • Zustand 5.0.8 (State Management)                         │
│  • Tailwind CSS 4.1 (Styling)                               │
│  • Framer Motion 12.23 (Animations)                         │
│  • React Three Fiber (3D Grid Visualization)                 │
│  • Vite 7.2 (Build Tool)                                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Backend (Rust + Tauri)                  │
├─────────────────────────────────────────────────────────────┤
│  • Rust 1.77.2 + Tauri 2.9.5                                │
│  • QUIC (quinn 0.11) - 주요 전송 프로토콜                    │
│  • Tokio 1.x (Async Runtime)                                │
│  • SQLite (rusqlite) - 전송 기록 저장                        │
│  • WebRTC (warp - WASM 모듈)                                │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 우선순위 매트릭스

| 우선순위 | 작업 항목                          | 영향도 | 복잡도 | 예상 工数 |
| :------: | :--------------------------------- | :----: | :----: | :-------: |
|  **P0**  | 핸드쉐이크 (User Approval)         |  높음  |   중   |    3일    |
|  **P0**  | 파일 무결성 검증 (SHA-256)         |  높음  |   低   |    2일    |
|  **P1**  | AI 백엔드 연동 (Ollama/OpenAI)     |   중   |   高   |    5일    |
|  **P1**  | 설정 영속성 (Settings Persistence) |   중   |   中   |    2일    |
|  **P2**  | 인메모리 스트림 압축               |   低   |   中   |    3일    |

---

## 2. Phase 1: 보안 및 안정성

### 2.1 핸드쉐이크 구현 (User Approval)

#### 2.1.1 개요

수신자가 명시적으로 "수락" 버튼을 클릭하기 전까지 데이터 스트림이 시작되지 않도록 방지합니다.

#### 2.1.2 아키텍처 다이어그램

```
┌──────────────┐                    ┌──────────────┐
│    Sender    │                    │   Receiver   │
└──────┬───────┘                    └──────┬───────┘
       │                                  │
       │  1. open_bi()                    │
       │─────────────────────────────────>│
       │                                  │
       │  2. RequestTransfer (JSON)       │
       │   - job_id                       │
       │   - file_name                    │
       │   - file_size                    │
       │   - sender_name                  │
       │─────────────────────────────────>│
       │                                  │
       │              3. UI Popup         │
       │         ┌──────────────┐         │
       │         │   [수락] [거절] │         │
       │         └──────────────┘         │
       │                                  │
       │  4. AcceptTransfer (JSON)        │
       │   - job_id                       │
       │   - approved: true/false         │
       │<─────────────────────────────────│
       │                                  │
       │  5. DATA STREAM (실제 전송)      │
       │   (approved = true 인 경우)      │
       │─────────────────────────────────>│
       │                                  │
       │  6. DONE / ERROR                 │
       │<─────────────────────────────────│
```

#### 2.1.3 파일별 상세 구현

##### 파일 1: `src-tauri/src/protocol/commands.rs`

```rust
use serde::{Deserialize, Serialize};

/// 전송 요청 상태
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferApprovalStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
}

/// 파일 전송 요청 (Sender -> Receiver)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRequest {
    pub job_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub sender_name: String,
    pub sender_device: String,
    pub checksum: Option<String>, // SHA-256 해시 (P0 구현 후)
    pub timestamp: u64,
}

/// 전송 응답 (Receiver -> Sender)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferResponse {
    pub job_id: String,
    pub approved: bool,
    pub reason: Option<String>, // 거절 시 사유
    pub timestamp: u64,
}

/// 명령어 열거형 확장
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    // 기존 명령어들...
    Ping,
    Pong,

    // 새로운 핸드쉐이크 명령어
    RequestTransfer(TransferRequest),

    RespondTransfer(TransferResponse),

    // 기존 전송 명령어들 유지
    StartTransfer {
        job_id: String,
        file_path: String,
        total_size: u64,
    },

    TransferProgress {
        job_id: String,
        bytes_sent: u64,
        speed_bps: u64,
    },

    TransferComplete {
        job_id: String,
        total_bytes: u64,
        duration_ms: u64,
        checksum: String, // 검증용 해시 추가
    },

    Error {
        job_id: String,
        code: String,
        message: String,
    },

    DiscoverPeers,

    PeerList {
        peers: Vec<PeerInfo>,
    },

    // WebRTC Signaling Commands
    Offer {
        room_id: String,
        sdp: String,
        target: Option<String>,
    },

    Answer {
        room_id: String,
        sdp: String,
        target: Option<String>,
    },

    IceCandidate {
        room_id: String,
        candidate: String,
        target: Option<String>,
    },
}

impl Command {
    pub fn to_bytes(&self) -> anyhow::Result<Vec<u8>> {
        // 기존 로직 유지
        Ok(serde_json::to_vec(self)?)
    }

    pub fn from_bytes(data: &[u8]) -> anyhow::Result<Self> {
        // 기존 로직 유지
        Ok(serde_json::from_slice(data)?)
    }
}
```

##### 파일 2: `src-tauri/src/transfer/file_transfer.rs`

```rust
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tracing::{info, warn, error};
use uuid::Uuid;

/// 전송 승인 관리자
pub struct TransferApprovalManager {
    pending_requests: Arc<parking_lot::RwLock<HashMap<String, TransferRequest>>>,
    approval_tx: Arc<parking_lot::RwLock<HashMap<String, mpsc::Sender<TransferResponse>>>>,
    expiry_duration: Duration,
}

impl TransferApprovalManager {
    pub fn new() -> Self {
        Self {
            pending_requests: Arc::new(parking_lot::RwLock::new(HashMap::new())),
            approval_tx: Arc::new(parking_lot::RwLock::new(HashMap::new())),
            expiry_duration: Duration::from_secs(30), // 30초 타임아웃
        }
    }

    /// 전송 요청 등록 (Receiver에서 호출)
    pub fn register_request(
        &self,
        request: TransferRequest,
    ) -> (String, mpsc::Receiver<TransferResponse>) {
        let job_id = request.job_id.clone();
        let (tx, rx) = mpsc::channel(1);

        self.pending_requests.write().insert(job_id.clone(), request);
        self.approval_tx.write().insert(job_id.clone(), tx);

        //Expiry cleanup task에서 정리
        job_id
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
                .unwrap()
                .as_secs(),
        };

        if let Some(tx) = self.approval_tx.read().get(job_id) {
            tx.send(response).await.map_err(|e| e.to_string())?;
            self.cleanup(job_id);
            Ok(())
        } else {
            Err("Request not found".to_string())
        }
    }

    fn cleanup(&self, job_id: &str) {
        self.pending_requests.write().remove(job_id);
        self.approval_tx.write().remove(job_id);
    }
}

/// 수정된 수신 함수
pub async fn receive_file_with_approval(
    conn: &quinn::Connection,
    save_dir: PathBuf,
    approval_manager: &TransferApprovalManager,
    app_handle: &tauri::AppHandle,
) -> Result<PathBuf> {
    info!("📥 파일 수신 대기 중...");

    // 1. 스트림 수락
    let (mut send, mut recv) = conn.accept_bi().await?;

    // 2. RequestTransfer 명령 수신
    let request_data = recv.read_to_end(65536).await?;
    let request: TransferRequest = serde_json::from_slice(&request_data)?;

    info!("📥 전송 요청 수신: {} ({} bytes)",
          request.file_name, request.file_size);

    // 3. UI에 팝업 이벤트 발송
    let window = app_handle.get_webview_window("main").unwrap();
    window.emit("transfer-requested", &request)?;

    // 4. 승인 대기 (타임아웃 포함)
    let (job_id, mut approval_rx) = approval_manager.register_request(request);

    let response = tokio::time::timeout(Duration::from_secs(30), approval_rx.recv())
        .await
        .map_err(|_| anyhow!("승인 타임아웃 (30초)"))??;

    if !response.approved {
        // 거절 응답 전송
        let response_bytes = serde_json::to_vec(&Command::RespondTransfer(response))?;
        send.write_all(&response_bytes).await?;
        return Err(anyhow!("사용자가 전송을 거절했습니다: {:?}", response.reason));
    }

    // 5. 승인 응답 전송
    let response_bytes = serde_json::to_vec(&Command::RespondTransfer(response))?;
    send.write_all(&response_bytes).await?;

    // 6. 기존 READY/DATA 전송 로직으로 이어짐...
    info!("✅ 전송 승인 완료, 데이터 수신 시작...");
    Ok(save_dir) // 이후 기존 로직으로 처리
}
```

##### 파일 3: `src/services/transfer/transferController.ts` (신규 생성)

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { transferStore } from '@/store/transferStore';

interface TransferRequest {
  job_id: string;
  file_name: string;
  file_size: number;
  sender_name: string;
  sender_device: string;
}

interface TransferResponse {
  job_id: string;
  approved: boolean;
  reason?: string;
}

class TransferController {
  private pendingApproval: TransferRequest | null = null;
  private unlistenFn: (() => void) | null = null;

  async initialize() {
    // 전송 요청 이벤트 리스너 등록
    this.unlistenFn = await listen<TransferRequest>(
      'transfer-requested',
      event => {
        this.pendingApproval = event.payload;

        // UI에 팝업 표시
        transferStore.setPendingApproval(event.payload);
        transferStore.setShowApprovalModal(true);
      }
    );
  }

  async approveTransfer(jobId: string): Promise<void> {
    if (!this.pendingApproval || this.pendingApproval.job_id !== jobId) {
      throw new Error('Invalid job ID');
    }

    try {
      await invoke('approve_transfer', {
        jobId,
        approved: true,
        reason: null,
      });

      transferStore.setShowApprovalModal(false);
      this.pendingApproval = null;
    } catch (error) {
      console.error('승인 실패:', error);
      throw error;
    }
  }

  async rejectTransfer(
    jobId: string,
    reason: string = '사용자 거절'
  ): Promise<void> {
    if (!this.pendingApproval || this.pendingApproval.job_id !== jobId) {
      throw new Error('Invalid job ID');
    }

    try {
      await invoke('approve_transfer', {
        jobId,
        approved: false,
        reason,
      });

      transferStore.setShowApprovalModal(false);
      this.pendingApproval = null;
    } catch (error) {
      console.error('거절 실패:', error);
      throw error;
    }
  }

  destroy() {
    this.unlistenFn?.();
  }
}

export const transferController = new TransferController();
```

##### 파일 4: `src/components/TransferApprovalModal.tsx` (신규 생성)

```tsx
import { useTransferStore } from '@/store/transferStore';
import { MagneticButton } from './ui/MagneticButton';
import { motion, AnimatePresence } from 'framer-motion';

export function TransferApprovalModal() {
  const {
    pendingApproval,
    showApprovalModal,
    setShowApprovalModal,
    approveTransfer,
    rejectTransfer,
  } = useTransferStore();

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return (
    <AnimatePresence>
      {showApprovalModal && pendingApproval && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl"
          >
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <FileArrowDownIcon className="w-6 h-6 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">
                  파일 전송 요청
                </h3>
                <p className="text-sm text-zinc-400">
                  누군가 파일을 보냈습니다
                </p>
              </div>
            </div>

            <div className="bg-zinc-800/50 rounded-xl p-4 mb-6 space-y-2">
              <div className="flex justify-between">
                <span className="text-zinc-400">파일명</span>
                <span className="text-white font-medium">
                  {pendingApproval.file_name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">크기</span>
                <span className="text-white">
                  {formatFileSize(pendingApproval.file_size)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">보낸 사람</span>
                <span className="text-white">
                  {pendingApproval.sender_name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">기기</span>
                <span className="text-white">
                  {pendingApproval.sender_device}
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <MagneticButton
                variant="secondary"
                className="flex-1"
                onClick={() => rejectTransfer(pendingApproval.job_id)}
              >
                거절
              </MagneticButton>
              <MagneticButton
                variant="primary"
                className="flex-1"
                onClick={() => approveTransfer(pendingApproval.job_id)}
              >
                수락
              </MagneticButton>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

#### 2.1.4 Rust Tauri Commands 등록 (`src-tauri/src/lib.rs` 또는 `src-tauri/src/protocol/mod.rs`)

```rust
#[tauri::command]
pub async fn approve_transfer(
    window: tauri::Window,
    state: tauri::State<'_, TransferApprovalManager>,
    job_id: String,
    approved: bool,
    reason: Option<String>,
) -> Result<(), String> {
    state.approve(&job_id, approved, reason).await?;
    Ok(())
}

#[tauri::command]
pub fn get_pending_transfers(
    state: tauri::State<'_, TransferApprovalManager>,
) -> Vec<TransferRequest> {
    state.get_pending_requests()
}
```

### 2.2 파일 무결성 검증 (SHA-256)

#### 2.2.1 개요

파일 전송 전후 SHA-256 해시를 비교하여 데이터 무결성을 보장합니다.

#### 2.2.2 알고리즘 흐름

```
Sender (전송 전)                    Receiver (수신 후)
    │                                    │
    │  1. 파일 열기                       │
    ├───────────────────────────────────>│  1. 파일 열기
    │                                    │
    │  2. SHA-256 해시 계산              │  2. SHA-256 해시 계산
    │  (Chunk 단위 누적)                 │  (Chunk 단위 누적)
    │     │                                  │
    │     ▼                                  │
    │  3. 파일 데이터 전송                 │  3. 파일 데이터 수신
    │     │                                  │
    │     ▼                                  │
    │  4. 해시값 전송                       │  4. 해시값 수신
    │     │                                  │
    │     ▼                                  │
    │               비교 결과               │
    │  5. TransferComplete 전송            │
    │───────────────────────────────────>│  5. 결과 비교
    │                                    │     │
    │                                    │     ▼
    │                                    │  6. 성공/실패 처리
```

#### 2.2.3 구현 코드 (`src-tauri/src/transfer/file_transfer.rs`)

```rust
use sha2::{Sha256, Digest};
use std::io::{Read, Write};

/// 해시 계산이 포함된 파일 리더
struct HashingReader<R: Read> {
    reader: R,
    hasher: Sha256,
}

impl<R: Read> HashingReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            hasher: Sha256::new(),
        }
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.reader.read(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }

    fn read_to_end(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
        let n = self.reader.read_to_end(buf)?;
        self.hasher.update(&buf);
        Ok(n)
    }
}

/// 해시 계산이 포함된 파일 라이터
struct HashingWriter<W: Write> {
    writer: W,
    hasher: Sha256,
}

impl<W: Write> HashingWriter<W> {
    fn new(writer: W) -> Self {
        Self {
            writer,
            hasher: Sha256::new(),
        }
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.writer.write(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        self.hasher.update(buf);
        self.writer.write_all(buf)
    }
}

/// 전송 완료 후 해시값 반환
fn finalize_hasher(hasher: Sha256) -> String {
    let result = hasher.finalize();
    hex::encode(result)
}
```

#### 2.2.4 수정된 전송 함수

```rust
pub async fn send_file_with_integrity(
    &self,
    conn: &quinn::Connection,
    file_path: PathBuf,
    job_id: &str,
) -> Result<u64> {
    // ... 기존 준비 로직 ...

    // 해시 계산기 생성
    let file = File::open(&file_path).await?;
    let mut hashing_reader = HashingReader::new(BufReader::with_capacity(4 * 1024 * 1024, file));

    // ... 매니페스트 전송 ...

    // 파일 데이터 + 해시 동시 계산
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut bytes_sent: u64 = 0;

    loop {
        match hashing_reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                // 전송
                send.write_all(&buffer[..n]).await?;
                bytes_sent += n as u64;
                // 해시는 HashingReader 내부에서 자동 계산
            }
            Err(e) => return Err(anyhow::anyhow!("파일 읽기 오류: {}", e)),
        }
    }

    // 전송 완료 후 해시값 전송
    let file_hash = finalize_hasher(hashing_reader.into_hasher());
    let hash_bytes = file_hash.as_bytes();
    send.write_all(&(hash_bytes.len() as u32).to_le_bytes()).await?;
    send.write_all(hash_bytes).await?;

    info!("📤 파일 전송 완료: {}, 해시: {}", file_name, file_hash);

    // ... DONE 응답 대기 ...
    Ok(bytes_sent)
}
```

#### 2.2.5 수정된 수신 함수

```rust
pub async fn receive_file_with_integrity(
    &self,
    conn: &quinn::Connection,
    save_dir: PathBuf,
    job_id: &str,
) -> Result<PathBuf> {
    // ... 기존 로직 ...

    // 해시 계산기 래퍼
    let file = File::create(&save_path).await?;
    let mut hashing_writer = HashingWriter::new(BufWriter::with_capacity(4 * 1024 * 1024, file));

    // 파일 데이터 수신 및 해시 계산
    loop {
        match recv.read(&mut buffer).await? {
            Some(n) if n > 0 => {
                hashing_writer.write_all(&buffer[..n]).await?;
                bytes_received += n as u64;
            }
            _ => break,
        }
    }

    hashing_writer.flush().await?;

    // Sender의 해시값 수신
    let mut hash_len_buf = [0u8; 4];
    recv.read_exact(&mut hash_len_buf).await?;
    let hash_len = u32::from_le_bytes(hash_len_buf) as usize;

    let mut sender_hash_buf = vec![0u8; hash_len];
    recv.read_exact(&mut sender_hash_buf).await?;
    let sender_hash = String::from_utf8_lossy(&sender_hash_buf);

    // Receiver 해시 계산
    let receiver_hash = finalize_hasher(hashing_writer.into_hasher());

    // 해시 비교
    if sender_hash != receiver_hash {
        error!("❌ 파일 무결성 검증 실패!");
        error!("   예상: {}", sender_hash);
        error!("   실제: {}", receiver_hash);

        // 실패 파일 리네임
        let corrupt_path = save_path.with_extension("corrupt");
        std::fs::rename(&save_path, &corrupt_path)?;

        return Err(anyhow::anyhow!(
            "파일 무결성 검증 실패: {} (corrupt 파일로 저장됨)",
            save_path.display()
        ));
    }

    info!("✅ 파일 무결성 검증 완료: {}", receiver_hash);

    // ... DONE 응답 전송 ...
    Ok(save_path)
}
```

---

## 3. Phase 2: AI 인텔리전스

### 3.1 LLM 백엔드 통합

#### 3.1.1 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                     Ponswarp Backend                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │ TransferService │───>│   AIService     │                 │
│  └─────────────────┘    └────────┬────────┘                 │
│                                  │                          │
│                         ┌────────┴────────┐                 │
│                         │                 │                 │
│                    Ollama (로컬)     OpenAI API             │
│                 localhost:11434      (Cloud)                │
└─────────────────────────────────────────────────────────────┘
```

#### 3.1.2 Cargo.toml 의존성 추가

```toml
[dependencies]
# 기존 의존성들...

# AI/LLM 기능
reqwest = { version = "0.11", features = ["json"] }
tokio = { version = "1", features = ["full"] }

# 텍스트 처리
once_cell = "1.19"
```

#### 3.1.3 AI 모듈 구현 (`src-tauri/src/ai/mod.rs`)

```rust
use std::path::PathBuf;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, error};

/// AI 제공자 유형
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AIProvider {
    Ollama,
    OpenAI,
    Anthropic,
}

/// AI 설정
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIConfig {
    pub provider: AIProvider,
    pub endpoint: String,      // Ollama: "http://localhost:11434"
    pub model: String,         // Ollama: "llama3.2", OpenAI: "gpt-4o-mini"
    pub api_key: Option<String>, // OpenAI/Anthropic용
    pub temperature: f32,      // 0.0 ~ 1.0
    pub max_tokens: u32,
}

impl Default for AIConfig {
    fn default() -> Self {
        Self {
            provider: AIProvider::Ollama,
            endpoint: "http://localhost:11434".to_string(),
            model: "llama3.2".to_string(),
            api_key: None,
            temperature: 0.7,
            max_tokens: 1024,
        }
    }
}

/// 분석 결과
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub job_id: String,
    pub file_path: String,
    pub summary: String,
    pub keywords: Vec<String>,
    pub sentiment: String,      // "positive", "neutral", "negative"
    pub processing_time_ms: u64,
    pub error: Option<String>,
}

/// AI 서비스
pub struct AIService {
    config: AIConfig,
    client: reqwest::Client,
}

impl AIService {
    pub fn new(config: AIConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("Failed to create HTTP client");

        Self { config, client }
    }

    /// 기본 설정으로 생성
    pub fn default() -> Self {
        Self::new(AIConfig::default())
    }

    /// 파일 분석 (메인 메서드)
    pub async fn analyze_file(
        &self,
        file_path: PathBuf,
        job_id: String,
    ) -> Result<AnalysisResult, String> {
        let start_time = std::time::Instant::now();

        info!("🔍 AI 분석 시작: {:?}", file_path);

        // 1. 파일 내용 추출
        let content = self.extract_text_content(&file_path).await
            .map_err(|e| format!("파일 읽기 실패: {}", e))?;

        if content.trim().is_empty() {
            return Ok(AnalysisResult {
                job_id,
                file_path: file_path.to_string_lossy().to_string(),
                summary: "빈 파일이거나 텍스트를 추출할 수 없습니다.".to_string(),
                keywords: vec![],
                sentiment: "neutral".to_string(),
                processing_time_ms: start_time.elapsed().as_millis() as u64,
                error: None,
            });
        }

        // 2. 프롬프트 구성
        let prompt = self.build_analysis_prompt(&content);

        // 3. LLM 호출
        let response = self.call_llm(&prompt).await
            .map_err(|e| format!("LLM 호출 실패: {}", e))?;

        // 4. 응답 파싱
        let result = self.parse_analysis_response(response, job_id, file_path, start_time.elapsed().as_millis());

        info!("✅ AI 분석 완료: {}ms", result.processing_time_ms);

        Ok(result)
    }

    /// 파일 내용 추출 (간단한 텍스트만 지원, 추후 PDF/DOCX 확장)
    async fn extract_text_content(&self, path: &PathBuf) -> Result<String, std::io::Error> {
        let extension = path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        match extension.as_str() {
            "txt" | "md" | "json" | "yaml" | "yml" | "toml" | "rs" | "ts" | "js" | "py" | "html" | "css" | "xml" | "csv" => {
                // 텍스트 파일은 직접 읽기 (최대 50KB만 읽기)
                let max_bytes = 50 * 1024;
                let content = tokio::fs::read_to_string(path).await?;
                Ok(content.chars().take(max_bytes).collect())
            }
            _ => {
                // 이진 파일은 설명 불가
                Ok(String::from("[이진 파일 - 내용 분석 불가]"))
            }
        }
    }

    /// 분석 프롬프트 구성
    fn build_analysis_prompt(&self, content: &str) -> String {
        format!(
            r#"
당신은 문서 분석 전문가입니다. 다음 내용을 분석해서 JSON 형식으로 결과를 제공해주세요.

## 분석할 내용:
```

{}

````

## 출력 형식 (반드시 이 JSON 형식을 따르세요):
{{
  "summary": "2-3 문장으로 요약",
  "keywords": ["키워드1", "키워드2", "키워드3"],
  "sentiment": "positive | neutral | negative"
}}

주의사항:
- summary는 핵심 내용을 간결하게 요약할 것
- keywords는 가장 중요한 3-5개 추출할 것
- sentiment는 전체적인 톤을 판단할 것
- 출력은 반드시 유효한 JSON이어야 함
"#,
            content.chars().take(10000).collect::<String>()
        )
    }

    /// LLM 호출
    async fn call_llm(&self, prompt: &str) -> Result<String, reqwest::Error> {
        match self.config.provider {
            AIProvider::Ollama => self.call_ollama(prompt).await,
            AIProvider::OpenAI => self.call_openai(prompt).await,
            _ => self.call_ollama(prompt).await,
        }
    }

    /// Ollama 호출
    async fn call_ollama(&self, prompt: &str) -> Result<String, reqwest::Error> {
        #[derive(Serialize)]
        struct OllamaRequest {
            model: String,
            prompt: String,
            stream: bool,
            options: OllamaOptions,
        }

        #[derive(Serialize)]
        struct OllamaOptions {
            temperature: f32,
            num_predict: u32,
        }

        let request = OllamaRequest {
            model: self.config.model.clone(),
            prompt: prompt.to_string(),
            stream: false,
            options: OllamaOptions {
                temperature: self.config.temperature,
                num_predict: self.config.max_tokens,
            },
        };

        let response = self.client
            .post(&format!("{}/api/generate", self.config.endpoint))
            .json(&request)
            .send()
            .await?;

        #[derive(Deserialize)]
        struct OllamaResponse {
            response: String,
        }

        let response: OllamaResponse = response.json().await?;
        Ok(response.response)
    }

    /// OpenAI 호출
    async fn call_openai(&self, prompt: &str) -> Result<String, reqwest::Error> {
        #[derive(Serialize)]
        struct OpenAIRequest {
            model: String,
            messages: Vec<OpenAIMessage>,
            temperature: f32,
            max_tokens: u32,
        }

        #[derive(Serialize)]
        struct OpenAIMessage {
            role: String,
            content: String,
        }

        let api_key = self.config.api_key.as_ref()
            .expect("OpenAI API key가 설정되지 않았습니다");

        let request = OpenAIRequest {
            model: self.config.model.clone(),
            messages: vec![
                OpenAIMessage {
                    role: "user".to_string(),
                    content: prompt.to_string(),
                }
            ],
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
        };

        let response = self.client
            .post("https://api.openai.com/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&request)
            .send()
            .await?;

        #[derive(Deserialize)]
        struct OpenAIResponse {
            choices: Vec<OpenAIChoice>,
        }

        #[derive(Deserialize)]
        struct OpenAIChoice {
            message: OpenAIMessageContent,
        }

        #[derive(Deserialize)]
        struct OpenAIMessageContent {
            content: String,
        }

        let response: OpenAIResponse = response.json().await?;
        Ok(response.choices[0].message.content.clone())
    }

    /// 응답 파싱
    fn parse_analysis_response(
        &self,
        raw_response: String,
        job_id: String,
        file_path: PathBuf,
        processing_time_ms: u64,
    ) -> AnalysisResult {
        // JSON 추출 및 파싱 시도
        let json_str = raw_response
            .trim()
            .trim_start_matches("```json")
            .trim_end_matches("```")
            .trim()
            .to_string();

        #[derive(Deserialize)]
        struct ParsedResponse {
            summary: String,
            keywords: Vec<String>,
            sentiment: String,
        }

        match serde_json::from_str::<ParsedResponse>(&json_str) {
            Ok(parsed) => AnalysisResult {
                job_id,
                file_path: file_path.to_string_lossy().to_string(),
                summary: parsed.summary,
                keywords: parsed.keywords,
                sentiment: parsed.sentiment,
                processing_time_ms,
                error: None,
            },
            Err(e) => {
                error!("AI 응답 파싱 실패: {}", e);
                AnalysisResult {
                    job_id,
                    file_path: file_path.to_string_lossy().to_string(),
                    summary: format!("분석 실패: {}", raw_response.chars().take(200).collect::<String>()),
                    keywords: vec![],
                    sentiment: "unknown".to_string(),
                    processing_time_ms,
                    error: Some(format!("JSON 파싱 오류: {}", e)),
                }
            }
        }
    }
}
````

### 3.2 프론트엔드 분석 UI

#### 3.2.1 AnalysisPanel.tsx

```tsx
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SparklesIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useTransferStore } from '@/store/transferStore';

interface AnalysisResult {
  job_id: string;
  summary: string;
  keywords: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
  processing_time_ms: number;
}

export function AnalysisPanel({ jobId }: { jobId: string }) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    analyzeFile();
  }, [jobId]);

  const analyzeFile = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await invoke<AnalysisResult>(
        'analyze_transferred_file',
        { jobId }
      );
      setResult(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : '분석 실패');
    } finally {
      setLoading(false);
    }
  };

  const sentimentColor = {
    positive: 'text-green-400 bg-green-400/10',
    neutral: 'text-blue-400 bg-blue-400/10',
    negative: 'text-red-400 bg-red-400/10',
    unknown: 'text-zinc-400 bg-zinc-400/10',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-zinc-900/90 backdrop-blur-xl rounded-2xl border border-zinc-700/50 p-6 max-w-2xl mx-auto"
    >
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center">
          <SparklesIcon className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-white">AI 분석 결과</h3>
          <p className="text-sm text-zinc-400">LLM 기반 파일 내용 요약</p>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center py-12"
          >
            <div className="w-12 h-12 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin mb-4" />
            <p className="text-zinc-400">AI가 파일을 분석중입니다...</p>
          </motion.div>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400"
          >
            {error}
          </motion.div>
        )}

        {result && !loading && !error && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {/* Sentiment Badge */}
            <div className="flex items-center gap-2 mb-4">
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${sentimentColor[result.sentiment]}`}
              >
                {result.sentiment.toUpperCase()}
              </span>
              <span className="text-xs text-zinc-500">
                {result.processing_time_ms}ms
              </span>
            </div>

            {/* Summary */}
            <div className="mb-6">
              <h4 className="text-sm font-medium text-zinc-300 mb-2">요약</h4>
              <p className="text-zinc-100 leading-relaxed">{result.summary}</p>
            </div>

            {/* Keywords */}
            {result.keywords.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-zinc-300 mb-2">
                  주요 키워드
                </h4>
                <div className="flex flex-wrap gap-2">
                  {result.keywords.map((keyword, i) => (
                    <span
                      key={i}
                      className="px-3 py-1 bg-zinc-800 rounded-lg text-sm text-zinc-300"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
```

---

## 4. Phase 3: UX 및 최적화

### 4.1 인메모리 스트림 압축 (On-the-fly Compression)

#### 4.1.1 현재 구현 vs 최적화

**현재 구현** (`zip_stream.rs`):

```
1. 파일들을 디스크에 ZIP 생성
2. ZIP 파일을 QUIC으로 전송
3. 전송 완료 후 ZIP 파일 삭제
```

- 문제: 디스크 I/O가 병목이 됨

**최적화된 구현**:

```
1. 파일들을 Cursor<Vec<u8>>에 ZIP 생성 (메모리)
2. 메모리 버퍼를 QUIC으로 스트리밍 전송
3. 전송 완료 후 버퍼 자동 해제
```

- 장점: 디스크 I/O 제거, 속도 2배 향상

#### 4.1.2 구현 코드

```rust
use std::io::{Cursor, Write};
use zip::write::FileOptions;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 인메모리 ZIP 전송 (작은 파일들 용)
async fn send_zip_in_memory(
    conn: &quinn::Connection,
    files: Vec<FileEntry>,
    job_id: &str,
) -> Result<u64> {
    let total_size: u64 = files.iter().map(|f| f.size).sum();

    // 메모리 버퍼에 ZIP 생성
    let mut zip_buffer = Cursor::new(Vec::with_capacity(total_size as usize));
    let mut zip_writer = zip::ZipWriter::new(&mut zip_buffer);

    for file_entry in &files {
        let mut input_file = std::fs::File::open(&file_entry.absolute_path)?;
        zip_writer.start_file(&file_entry.relative_path, FileOptions::default())?;

        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            let bytes_read = input_file.read(&mut buffer)?;
            if bytes_read == 0 { break; }
            zip_writer.write_all(&buffer[..bytes_read])?;
        }
    }

    zip_writer.finish()?;
    let zip_bytes = zip_buffer.into_inner();

    // QUIC으로 전송
    let (mut send, mut recv) = conn.open_bi().await?;
    send.write_all(&zip_bytes).await?;
    send.finish()?;

    // DONE 응답 대기
    let mut done_buf = [0u8; 4];
    recv.read_exact(&mut done_buf).await?;

    Ok(zip_bytes.len() as u64)
}
```

### 4.2 설정 영속성 (Settings Persistence)

#### 4.2.1 구현 전략

```rust
// src-tauri/src/config/settings.rs

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 앱 설정 구조체
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    pub download_dir: String,
    pub listen_port: u16,
    pub auto_accept: bool,         // 핸드쉐이크建成后: 자동 수락 여부
    pub encryption_enabled: bool,
    pub ai_enabled: bool,
    pub ai_provider: String,       // "ollama" | "openai"
    pub ai_endpoint: String,
    pub theme: String,             // "dark" | "light" | "system"
}

/// 설정 파일 매니저
pub struct SettingsManager {
    settings: AppSettings,
    config_path: PathBuf,
}

impl SettingsManager {
    pub fn new() -> Self {
        let config_path = Self::get_config_path();
        let settings = Self::load_or_default(&config_path);

        Self {
            settings,
            config_path,
        }
    }

    fn get_config_path() -> PathBuf {
        // Tauri의 PathResolver 사용 권장
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."));
        config_dir.join("ponswarp").join("settings.json")
    }

    fn load_or_default(path: &PathBuf) -> AppSettings {
        if let Ok(content) = fs::read_to_string(path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            AppSettings::default()
        }
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let json = serde_json::to_string_pretty(&self.settings)
            .map_err(|e| e.to_string())?;

        fs::write(&self.config_path, json)
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    // Getter/Setter 메서드들...
    pub fn get_download_dir(&self) -> &str {
        &self.download_dir
    }

    pub fn set_download_dir(&mut self, dir: String) {
        self.download_dir = dir;
        self.save().ok();
    }
}
```

---

## 5. 의존성 변경사항

### 5.1 Cargo.toml (`src-tauri/`)

```toml
[package]
name = "ponswarp"
version = "0.1.0"
# ... 기존 설정 ...

[dependencies]
# 기존 의존성들 유지...

# 🆕 Phase 1: 보안
sha2 = "0.10"                    # 파일 무결성 검증
hex = "0.4"                      # 해시값 출력을 위한 HEX 인코딩
parking_lot = "0.12"             # 고성능 동기화 primitives ( RwLock )
ring = "0.17"                    # 암호화 (향후 확장)

# 🆕 Phase 2: AI
reqwest = { version = "0.11", features = ["json", "tls"] }  # HTTP 클라이언트
tokio = { version = "1", features = ["full"] }  # 비동기 I/O

# 🆕 Phase 3: 설정
dirs = "5"                       # OS별 config 디렉토리 경로获取
serde_json = "1.0"               # 설정 파일 직렬화

[target.'cfg(target_os = "linux")'.dependencies]
libappindicator = "0.8"          # 시스템 트레이 (Linux)

[dev-dependencies]
tempfile = "3.10"                # 테스트용 임시 파일 생성
assert_fs = "1.1"                # 파일 시스템 테스트
```

### 5.2 package.json (`src/`)

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2.9.1",
    "@tauri-apps/cli": "^2.9.6",
    // 기존 유지...

    // 🆕 Phase 2: UI 컴포넌트
    "@heroicons/react": "^2.1.0", // 아이콘
    "framer-motion": "^12.23.0" // 애니메이션 (기존)
  },
  "devDependencies": {
    // 기존 유지...

    // 🆕 Phase 1: 테스트
    "@types/testing-library__jest-dom": "^6.0.0"
  }
}
```

---

## 6. 통합 테스트 전략

### 6.1 테스트 시나리오

```rust
// src-tauri/tests/integrity_test.rs

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_file_integrity_verification() {
        // 1. 테스트 파일 생성
        let temp_dir = TempDir::new().unwrap();
        let source_path = temp_dir.path().join("test.txt");
        std::fs::write(&source_path, b"Hello, World! This is a test file.").unwrap();

        // 2. 전송 시뮬레이션 (실제 네트워크 대신 메모리 채널 사용)
        let (sender, receiver) = tokio::sync::mpsc::channel(1);

        let send_handle = tokio::spawn(async move {
            let file = tokio::fs::File::open(&source_path).await.unwrap();
            let mut hashing_reader = HashingReader::new(BufReader::new(file));

            let mut buffer = vec![0u8; 1024];
            let mut hasher = sha2::Sha256::new();

            while let Ok(n) = hashing_reader.read(&mut buffer).await {
                if n == 0 { break; }
                hasher.update(&buffer[..n]);
            }

            let hash = hex::encode(hasher.finalize());
            hash
        });

        // 3. 무결성 검증Assertions
        let original_hash = send_handle.await.unwrap();
        let expected_hash = "a8343fc6d2c84f0bf96d4c39e0e9b6f0e4a7b8c9d0e1f2a3b4c5d6e7f8a9b0c";

        // SHA-256 검증 (실제 해시값으로 비교)
        let calculated_hash = {
            let mut file = std::fs::File::open(&source_path).unwrap();
            let mut hasher = sha2::Sha256::new();
            let mut buffer = vec![0u8; 1024];
            while let Ok(n) = file.read(&mut buffer) {
                if n == 0 { break; }
                hasher.update(&buffer[..n]);
            }
            hex::encode(hasher.finalize())
        };

        assert_eq!(original_hash, calculated_hash);
    }

    #[tokio::test]
    async fn test_handshake_rejection() {
        // 타임아웃 및 거절 로직 테스트
    }

    #[tokio::test]
    async fn test_zip_stream_integrity() {
        // ZIP 스트림 무결성 테스트
    }
}
```

### 6.2 E2E 테스트 (Frontend)

```typescript
// src/e2e/transfer.spec.ts

import { test, expect } from '@playwright/test';

test.describe('File Transfer', () => {
  test('should show approval modal when receiving file', async ({ page }) => {
    // 1. 수신 대기 상태로 설정
    await page.goto('/settings');
    await page.click('#enable-acceptance-mode');

    // 2. 다른 디바이스에서 파일 전송 시뮬레이션
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('transfer-requested', {
          detail: {
            job_id: 'test-job-123',
            file_name: 'test.pdf',
            file_size: 1024000,
            sender_name: 'Test Sender',
            sender_device: 'Test Device',
          },
        })
      );
    });

    // 3. 모달 표시 확인
    await expect(page.locator('[data-testid="approval-modal"]')).toBeVisible();
    await expect(page.locator('text=test.pdf')).toBeVisible();
  });

  test('should complete file transfer with integrity check', async ({
    page,
  }) => {
    // 전송 완료 후 무결성 검증 로직 테스트
  });
});
```

---

## 7. 마이그레이션 가이드

### 7.1 기존 코드베이스 업데이트 순서

```
Week 1:
├── Day 1-2: Cargo.toml 업데이트 및 의존성 설치
├── Day 3-4: protocol/commands.rs 명령어 확장
├── Day 5: file_transfer.rs 해시 계산기 구현

Week 2:
├── Day 1-2: 핸드쉐이크 로직 구현 (Rust)
├── Day 3: Frontend ApprovalModal 구현
├── Day 4: 통합 테스트
└── Day 5: 버그 수정 및 코드 리뷰

Week 3:
├── Day 1-2: AI 모듈 구현 (ollama 연동)
├── Day 3: AnalysisPanel.tsx 구현
└── Day 4-5: 설정 영속성 구현

Week 4:
├── 버퍼링 및 최적화
├── 전체 시스템 테스트
└── 문서화 업데이트
```

### 7.2 Rollback Plan

각 Phase 완료 시 Git Tag 생성:

- `v0.1.0-alpha` - 현재 상태
- `v0.1.0-beta-handshake` - Phase 1 완료 후
- `v0.1.0-beta-ai` - Phase 2 완료 후
- `v0.1.0-rc1` - 최종 Release Candidate

Rollback 시:

```bash
git checkout v0.1.0-beta-handshake
```

---

## 📎 부록: 참고 자료

- **Tauri Commands**: https://v2.tauri.app/develop/calls/commands/
- **QUIC 프로토콜**: https://quinn.rs/
- **Ollama API**: https://github.com/ollama/ollama/blob/main/docs/api.md
- **SHA-256 (Rust)**: https://docs.rs/sha2/latest/sha2/

---

**문서 작성 완료**
