use crate::turn::config::TurnConfig;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IceCandidateType {
    Host,
    Srflx,
    Relay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStats {
    pub is_connected: bool,
    pub connection_type: IceCandidateType,
    pub remote_addr: String,
    pub rtt_ms: u64,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone)]
pub struct IceConnectionManager {
    _config: Arc<TurnConfig>,
    stats: Arc<Mutex<Option<ConnectionStats>>>,
}

impl IceConnectionManager {
    pub fn new(config: Arc<TurnConfig>) -> Self {
        Self {
            _config: config,
            stats: Arc::new(Mutex::new(None)),
        }
    }

    pub fn get_connection_stats(&self) -> ConnectionStats {
        self.stats
            .lock()
            .ok()
            .and_then(|s| (*s).clone())
            .unwrap_or(ConnectionStats {
                is_connected: false,
                connection_type: IceCandidateType::Host,
                remote_addr: "Not connected".to_string(),
                rtt_ms: 0,
                uptime_secs: 0,
            })
    }

    pub fn set_connection_stats(&self, stats: ConnectionStats) {
        if let Ok(mut guard) = self.stats.lock() {
            *guard = Some(stats);
        }
    }

    pub async fn close(&self) {
        if let Ok(mut guard) = self.stats.lock() {
            *guard = None;
        }
    }
}
