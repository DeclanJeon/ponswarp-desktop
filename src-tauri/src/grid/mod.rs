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
pub mod bootstrap_discovery;
pub mod piece_manager;

// NOTE: Grid 내부 구현 타입들은 현재 외부로 re-export 하지 않습니다.
// (사용 시 `grid::bitfield::Bitfield` 처럼 모듈 경로로 접근)

// Phase 2 (WIP) - 아직 앱의 기본 플로우에서 사용하지 않으므로, 기본 빌드 경고/크기/컴파일 시간을 줄이기 위해 feature로 분리
// 필요 시 `--features grid-experimental` 로 활성화
#[cfg(feature = "grid-experimental")]
pub mod dht;
#[cfg(feature = "grid-experimental")]
pub mod hybrid_discovery;
#[cfg(feature = "grid-experimental")]
pub mod peer;
#[cfg(feature = "grid-experimental")]
pub mod protocol;
#[cfg(feature = "grid-experimental")]
pub mod scheduler;
#[cfg(feature = "grid-experimental")]
pub mod swarm;

#[cfg(feature = "grid-experimental")]
pub use dht::{DhtCommand, DhtEvent, DhtService};
#[cfg(feature = "grid-experimental")]
pub use peer::{Peer, PeerCommand, PeerEvent};
#[cfg(feature = "grid-experimental")]
pub use protocol::GridMessage;
#[cfg(feature = "grid-experimental")]
pub use scheduler::Scheduler;
#[cfg(feature = "grid-experimental")]
pub use swarm::{GridSwarm, SwarmCommand, SwarmEvent};

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
