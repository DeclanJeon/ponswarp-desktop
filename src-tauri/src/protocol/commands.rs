use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Ping,
    Pong,
    
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub address: String,
    pub capabilities: PeerCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerCapabilities {
    pub max_bandwidth_mbps: u64,
    pub available_bandwidth_mbps: u64,
    pub cpu_cores: u32,
    pub can_relay: bool,
}

impl Command {
    pub fn to_bytes(&self) -> anyhow::Result<Vec<u8>> {
        Ok(serde_json::to_vec(self)?)
    }
    
    pub fn from_bytes(data: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(data)?)
    }
}
