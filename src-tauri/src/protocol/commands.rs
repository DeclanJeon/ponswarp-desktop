use serde::{Deserialize, Serialize};

/// 피어 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub peer_id: String,
    pub device_name: String,
    pub ip_address: String,
    pub port: u16,
}

/// 피어 기능 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerCapabilities {
    pub max_bandwidth_mbps: u32,
    pub available_bandwidth_mbps: u32,
    pub cpu_cores: u32,
    pub can_relay: bool,
}

/// 파일 전송 요청 (Sender -> Receiver)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRequest {
    pub job_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub sender_name: String,
    pub sender_device: String,
    pub timestamp: u64,
}

/// 전송 응답 (Receiver -> Sender)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferResponse {
    pub job_id: String,
    pub approved: bool,
    pub reason: Option<String>,
    pub timestamp: u64,
}

/// 전송 유형 (폴더 전송 vs ZIP 파일 전송)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferType {
    /// ZIP 파일 전송: 압축 해제하지 않고 ZIP 그대로 저장
    ZipFile,
    /// 폴더 전송: ZIP 패키징 후 수신 측에서 자동 압축 해제
    Folder,
}

/// 명령어 열거형 확장
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
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
        checksum: String,
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
        Ok(serde_json::to_vec(self)?)
    }

    pub fn from_bytes(data: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(data)?)
    }
}
