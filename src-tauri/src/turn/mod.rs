// TURN module for external network P2P support
//
// This module provides TURN (Traversal Using Relays around NAT) client
// functionality using webrtc-rs library to enable P2P connections
// across different networks (LAN, WAN, symmetric NAT, etc.)

pub mod client;
pub mod config;
pub mod credentials;

pub mod ice_manager;
pub mod stun;

// Re-export commonly used types
pub use config::{TurnConfig, TurnAuthMethod};
pub use client::{TurnClient, TurnConnectionInfo};
pub use credentials::{TurnCredentials, generate_turn_credentials, should_refresh_credentials};
pub use ice_manager::{IceConnectionManager, ConnectionStats};
pub use stun::StunClient;
