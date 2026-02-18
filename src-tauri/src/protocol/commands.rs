use anyhow::anyhow;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub peer_id: String,
    pub device_name: String,
    pub ip_address: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerCapabilities {
    pub max_bandwidth_mbps: u32,
    pub available_bandwidth_mbps: u32,
    pub cpu_cores: u32,
    pub can_relay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRequest {
    pub job_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub sender_name: String,
    pub sender_device: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferResponse {
    pub job_id: String,
    pub approved: bool,
    pub reason: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferType {
    ZipFile,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Ping,
    Pong,
    RequestTransfer(TransferRequest),
    RespondTransfer(TransferResponse),
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
    GetTurnStatus {
        room_id: String,
    },
    UpdateTurnConfig {
        turn_enabled: bool,
        turn_server_url: Option<String>,
        turn_realm: Option<String>,
        turn_username: Option<String>,
        turn_password: Option<String>,
        turn_secret: Option<String>,
    },
    IceCandidate {
        room_id: String,
        candidate: String,
    },
}

impl Command {
    pub fn to_bytes(&self) -> anyhow::Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|e| anyhow!("Failed to serialize command: {}", e))
    }

    pub fn from_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        serde_json::from_slice(bytes)
            .map_err(|e| anyhow!("Failed to deserialize command: {}", e))
    }
}
