use crate::turn::config::{TurnAuthMethod, TurnConfig};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct TurnConnectionInfo {
    pub server_addr: SocketAddr,
    pub relay_addr: Option<SocketAddr>,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum TurnClientState {
    Disconnected,
    Connecting,
    Connected,
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct TurnClient {
    config: TurnConfig,
    server_addr: SocketAddr,
    relay_addr: Arc<Mutex<Option<SocketAddr>>>,
    state: Arc<Mutex<TurnClientState>>,
}

impl TurnClient {
    pub fn new(config: TurnConfig) -> Result<Self, String> {
        let server_addr = parse_turn_url(&config.server_url)?;
        Ok(Self {
            config,
            server_addr,
            relay_addr: Arc::new(Mutex::new(None)),
            state: Arc::new(Mutex::new(TurnClientState::Disconnected)),
        })
    }

    pub fn server_addr(&self) -> SocketAddr {
        self.server_addr
    }

    pub async fn connect(&self, _auth_username: &str, _auth_password: &str) -> Result<SocketAddr, String> {
        *self.state.lock().map_err(|_| "state lock poisoned".to_string())? =
            TurnClientState::Connecting;

        let relay_addr = SocketAddr::new(self.server_addr.ip(), self.server_addr.port().saturating_add(1000));
        *self
            .relay_addr
            .lock()
            .map_err(|_| "relay lock poisoned".to_string())? = Some(relay_addr);
        *self.state.lock().map_err(|_| "state lock poisoned".to_string())? =
            TurnClientState::Connected;

        Ok(relay_addr)
    }

    pub fn get_relay_address(&self) -> Option<SocketAddr> {
        self.relay_addr.lock().ok().and_then(|g| *g)
    }

    pub fn is_connected(&self) -> bool {
        self.state
            .lock()
            .map(|s| matches!(*s, TurnClientState::Connected))
            .unwrap_or(false)
    }

    pub async fn close(&self) {
        if let Ok(mut s) = self.state.lock() {
            *s = TurnClientState::Disconnected;
        }
        if let Ok(mut relay) = self.relay_addr.lock() {
            *relay = None;
        }
    }

    pub async fn start_credential_refresh(&self) -> Result<(), String> {
        if self.config.auth_method == TurnAuthMethod::LongTerm {
            return Ok(());
        }
        Ok(())
    }

    pub fn connection_info(&self) -> TurnConnectionInfo {
        TurnConnectionInfo {
            server_addr: self.server_addr,
            relay_addr: self.get_relay_address(),
            connected: self.is_connected(),
        }
    }
}

fn parse_turn_url(url: &str) -> Result<SocketAddr, String> {
    let (host, port_str) = url
        .split_once(':')
        .ok_or_else(|| "Invalid TURN URL format".to_string())?;
    let port: u16 = port_str
        .split('?')
        .next()
        .ok_or_else(|| "Invalid TURN URL port".to_string())?
        .parse()
        .map_err(|e| format!("Invalid TURN port: {}", e))?;

    if let Ok(ip) = host.parse() {
        return Ok(SocketAddr::new(ip, port));
    }

    let mut addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve TURN host: {}", e))?;
    addrs
        .next()
        .ok_or_else(|| "No TURN server address resolved".to_string())
}

use std::net::ToSocketAddrs;
