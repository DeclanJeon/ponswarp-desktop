//! Grid Protocol - BitTorrent-style Mesh Network for Enterprise P2P Transfer
//!
//! Phase 2 구현: Swarm State, Bitfield, DHT, Rare-First Scheduling
//!
//! ## 모듈 구조
//! - `bitfield`: 조각 보유 현황 비트맵
//! - `piece_manager`: 파일 조각 및 검증 관리
//! - `protocol`: Grid 메시지 프로토콜 (Handshake, Request, Piece 등)
//! - `scheduler`: Rare-First 스케줄링 알고리즘
//! - `swarm`: Multi-Peer Connection Manager
//! - `dht`: Kademlia DHT (Trackerless Discovery)

pub mod bitfield;
pub mod piece_manager;
pub mod protocol;
pub mod scheduler;
pub mod swarm;
pub mod dht;
pub mod peer;
pub mod hybrid_discovery;
pub mod bootstrap_discovery;

pub use bitfield::Bitfield;
pub use piece_manager::{PieceManager, PieceInfo};
pub use protocol::GridMessage;
pub use scheduler::Scheduler;
pub use swarm::{GridSwarm, SwarmCommand, SwarmEvent};
pub use dht::{DhtService, DhtCommand, DhtEvent};
pub use peer::{Peer, PeerCommand, PeerEvent};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Grid 상태 업데이트 (프론트엔드 전송용)
#[derive(Clone, Serialize, Debug)]
pub struct GridStateUpdate {
    pub job_id: String,
    pub total_pieces: usize,
    pub completed_pieces: Vec<usize>,
    pub peers: Vec<PeerStatus>,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub progress: f32,
}

/// 피어 상태 정보
#[derive(Clone, Serialize, Debug)]
pub struct PeerStatus {
    pub address: String,
    pub peer_id: String,
    pub rtt_ms: Option<u32>,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub pieces_have: usize,
    pub is_choked: bool,
    pub is_interested: bool,
}

/// Grid 이벤트를 프론트엔드로 전송
pub fn emit_grid_update(app: &AppHandle, update: GridStateUpdate) {
    let _ = app.emit("grid-update", update);
}

/// Grid 피어 발견 이벤트
#[derive(Clone, Serialize, Debug)]
pub struct GridPeerDiscovered {
    pub peer_id: String,
    pub address: String,
    pub source: String, // "mdns" or "dht"
}

pub fn emit_peer_discovered(app: &AppHandle, event: GridPeerDiscovered) {
    let _ = app.emit("grid-peer-discovered", event);
}

/// 기본 설정값
pub mod config {
    /// 기본 조각 크기 (1MB - Grid 모드에서는 작은 조각이 유리)
    pub const DEFAULT_PIECE_SIZE: u32 = 1024 * 1024;
    
    /// 최대 동시 연결 수
    pub const MAX_PEERS: usize = 50;
    
    /// 최대 동시 요청 수 (피어당)
    pub const MAX_PENDING_REQUESTS: usize = 16;
    
    /// Keep-Alive 간격 (초)
    pub const KEEPALIVE_INTERVAL_SECS: u64 = 30;
    
    /// 연결 타임아웃 (초)
    pub const CONNECTION_TIMEOUT_SECS: u64 = 30;
    
    /// DHT 부트스트랩 노드 (사내망 고정 노드)
    pub const DHT_BOOTSTRAP_NODES: &[&str] = &[];
}
