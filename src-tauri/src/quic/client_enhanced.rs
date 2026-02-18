use crate::turn::{TurnClient, TurnConfig};
use quinn::Connection;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use tracing::info;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ConnectionMode {
    Direct,
    TurnRelay,
    StunHolePunch,
}

#[derive(Debug, Clone)]
pub struct PingResult {
    pub rtt_ms: u128,
    pub timestamp: i64,
}

pub struct QuicClientEnhanced {
    turn_client: Option<Arc<TurnClient>>,
    connection_mode: Arc<RwLock<ConnectionMode>>,
    server_name: String,
}

impl QuicClientEnhanced {
    pub fn new() -> Self {
        Self {
            turn_client: None,
            connection_mode: Arc::new(RwLock::new(ConnectionMode::Direct)),
            server_name: "localhost".to_string(),
        }
    }

    pub async fn configure_turn(&mut self, config: TurnConfig) -> Result<(), String> {
        if !config.is_enabled() {
            return Ok(());
        }

        let turn_client = TurnClient::new(config)?;
        self.turn_client = Some(Arc::new(turn_client));
        if let Ok(mut mode) = self.connection_mode.write() {
            *mode = ConnectionMode::TurnRelay;
        }
        Ok(())
    }

    pub async fn connect(
        &mut self,
        server_addr: SocketAddr,
        _use_turn: bool,
    ) -> Result<Connection, String> {
        Err(format!(
            "Enhanced QUIC connection is not yet implemented for {}",
            server_addr
        ))
    }

    pub fn get_connection_mode(&self) -> ConnectionMode {
        self.connection_mode
            .read()
            .map(|m| *m)
            .unwrap_or(ConnectionMode::Direct)
    }

    pub fn get_server_name(&self) -> String {
        self.server_name.clone()
    }

    pub async fn disconnect(&mut self, conn: Connection) {
        info!("Disconnecting from QUIC server: {}", conn.remote_address());
        conn.close(0u32.into(), b"disconnect");
        if let Ok(mut mode) = self.connection_mode.write() {
            *mode = ConnectionMode::Direct;
        }
    }

    pub async fn ping(&self, _conn: &Connection) -> Result<PingResult, String> {
        Ok(PingResult {
            rtt_ms: 0,
            timestamp: chrono::Utc::now().timestamp_millis(),
        })
    }
}
