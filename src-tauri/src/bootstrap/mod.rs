//! Embedded Bootstrap Node
//!
//! Tauri 앱에 내장된 DHT 부트스트랩 및 릴레이 노드 서비스

pub mod config;
pub mod dht;
pub mod relay;
pub mod service;
pub mod stats;

pub use config::BootstrapConfig;
pub use service::{BootstrapStatus, BoundPorts, EmbeddedBootstrapService, ServiceState};
pub use stats::{DhtStats, RelayStats, StatsCollector, StatsServer};
pub use dht::{DhtHandle, PeerDiscoveredEvent, DhtNode};
pub use relay::RelayServer;
