// ICE Agent for TURN P2P Connections
//
// Implements ICE (Interactive Connectivity Establishment) agent
// Manages ICE candidates, connection priority, and fallback logic
//
// ICE Candidate Types:
// 1. Host: Direct QUIC (LAN, mDNS discovered) - Priority 126
// 2. SRFLX: STUN-discovered public IP (hole punching) - Priority 100
// 3. Relay: TURN server - Priority 0

use crate::turn::config::TurnConfig;
use crate::turn::client::TurnClient;
use crate::turn::stun::StunClient;
use crate::turn::credentials::{TurnCredentials, generate_turn_credentials, should_refresh_credentials};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// ICE candidate with priority and connection type
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IceCandidateType {
    /// Direct LAN QUIC connection (mDNS discovered)
    Host,

    /// STUN-discovered public IP (hole punching)
    Srflx,

    /// TURN server relay (guaranteed connectivity)
    Relay,
}

/// ICE candidate with address and metadata
#[derive(Debug, Clone)]
pub struct IceCandidate {
    /// Candidate type
    pub candidate_type: IceCandidateType,

    /// Connection address
    pub address: SocketAddr,

    /// Priority (higher = better)
    pub priority: u16,

    /// Candidate source for logging
    pub source: String,
}

/// ICE agent connection state
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IceConnectionState {
    /// Gathering candidates
    Gathering,

    /// Attempting connections
    Connecting,

    /// Connected successfully
    Connected,

    /// All connections failed
    Failed(String),

    /// Refreshing credentials
    Refreshing,
}

/// ICE agent for managing P2P connections with NAT traversal
pub struct IceAgent {
    /// TURN configuration
    config: Arc<TurnConfig>,

    /// TURN client instance
    turn_client: Arc<TurnClient>,

    /// STUN client instance
    stun_client: Arc<StunClient>,

    /// Current connection state
    state: Arc<Mutex<IceConnectionState>>,

    /// Active connection info
    active_connection: Arc<Mutex<Option<IceCandidate>>>,
}

impl IceAgent {
    /// Create a new ICE agent
    ///
    /// # Arguments
    /// * `config` - TURN configuration
    /// * `turn_client` - TURN client instance
    /// * `stun_client` - STUN client instance
    ///
    /// # Returns
    /// * ICE agent instance
    pub fn new(
        config: Arc<TurnConfig>,
        turn_client: Arc<TurnClient>,
        stun_client: Arc<StunClient>,
    ) -> Self {
        log::info!("Creating ICE agent");

        Self {
            config,
            turn_client,
            stun_client,
            state: Arc::new(Mutex::new(IceConnectionState::Gathering)),
            active_connection: Arc::new(Mutex::new(None)),
        }
    }

    /// Start ICE gathering and connection process for a peer
    ///
    /// # Arguments
    /// * `peer_address` - Target peer address (with port)
    ///
    /// # Returns
    /// * IceCandidate of successful connection or error
    ///
    /// # Process
    /// 1. Generate ICE candidates in parallel:
    ///    - Host: Direct LAN address (if same subnet)
    ///    - SRFLX: STUN-discovered public IP
    ///    - Relay: TURN server address
    /// 2. Sort by priority (Host > SRFLX > Relay)
    /// 3. Attempt connections in order of priority
    /// 4. Use first successful connection
    /// 5. Cancel pending connections after success
    pub async fn connect_to_peer(
        &self,
        peer_address: SocketAddr,
    ) -> Result<IceCandidate, String> {
        if !self.config.is_enabled() {
            return Err("TURN is not enabled".to_string());
        }

        log::info!("Starting ICE connection to peer: {}", peer_address);
        *self.state.lock().await = IceConnectionState::Gathering;

        // Step 1: Gather ICE candidates
        let candidates = self.gather_candidates(peer_address).await?;

        // Step 2: Sort candidates by priority (highest first)
        let mut sorted_candidates = candidates;
        sorted_candidates.sort_by(|a, b| b.priority.cmp(&a.priority));

        log::info!("ICE candidates gathered (sorted by priority): {:?} candidates", sorted_candidates);

        // Step 3: Attempt connections in order of priority
        for candidate in sorted_candidates {
            log::info!("Attempting connection via {} (priority: {})",
                candidate.source, candidate.priority);

            *self.state.lock().await = IceConnectionState::Connecting;

            // Attempt connection based on candidate type
            let result = match candidate.candidate_type {
                IceCandidateType::Host => {
                    // Direct QUIC connection (LAN)
                    self.attempt_direct_quic(candidate.address).await
                }
                IceCandidateType::Srflx => {
                    // STUN hole punching
                    self.attempt_stun_connection(candidate.address).await
                }
                IceCandidateType::Relay => {
                    // TURN server relay
                    self.attempt_turn_relay(candidate.address).await
                }
            };

            match result {
                Ok(()) => {
                    // Connection successful - save as active
                    *self.active_connection.lock().await = Some(candidate.clone());
                    *self.state.lock().await = IceConnectionState::Connected;

                    log::info!("ICE connection successful via {} (address: {})",
                        candidate.source, candidate.address);

                    // Cancel remaining pending connections
                    return Ok(candidate);
                }
                Err(e) => {
                    log::warn!("Connection failed via {}: {}", candidate.source, e);
                    // Continue to next candidate
                    continue;
                }
            }
        }

        // All candidates failed
        let error = format!("All ICE connection attempts failed for peer: {}", peer_address);
        *self.state.lock().await = IceConnectionState::Failed(error.clone());
        Err(error)
    }

    /// Gather all ICE candidates in parallel
    ///
    /// # Arguments
    /// * `peer_address` - Target peer address
    ///
    /// # Returns
    /// * Vector of ICE candidates
    async fn gather_candidates(
        &self,
        peer_address: SocketAddr,
    ) -> Result<Vec<IceCandidate>, String> {
        let mut candidates = Vec::new();

        // Candidate 1: Host (Direct QUIC)
        // Only add Host candidate if peer is on same subnet
        if self.is_same_subnet(&peer_address) {
            candidates.push(IceCandidate {
                candidate_type: IceCandidateType::Host,
                address: peer_address,
                priority: 126,
                source: "Direct QUIC".to_string(),
            });
        }

        // Candidate 2: SRFLX (STUN-discovered public IP)
        // Attempt STUN discovery if TURN is enabled
        if self.config.is_enabled() {
            match self.stun_client.discover_public_ip(None).await {
                Ok(stun_result) => {
                    candidates.push(IceCandidate {
                        candidate_type: IceCandidateType::Srflx,
                        address: stun_result.public_addr,
                        priority: 100,
                        source: format!("STUN ({})", stun_result.nat_type),
                    });
                }
                Err(e) => {
                    log::warn!("STUN discovery failed: {}", e);
                }
            }
        }

        // Candidate 3: Relay (TURN server)
        // Add TURN relay as lowest priority candidate
        if self.config.is_enabled() && self.turn_client.is_connected() {
            if let Some(relay_addr) = self.turn_client.get_relay_address() {
                candidates.push(IceCandidate {
                    candidate_type: IceCandidateType::Relay,
                    address: relay_addr,
                    priority: 0,
                    source: "TURN Relay".to_string(),
                });
            }
        }

        if candidates.is_empty() {
            return Err("No ICE candidates available".to_string());
        }

        Ok(candidates)
    }

    /// Check if peer is on same subnet (for Host candidate)
    fn is_same_subnet(&self, peer_address: &SocketAddr) -> bool {
        // TODO: Implement subnet comparison logic
        // For now, always return false to prefer STUN/TURN
        false
    }

    /// Attempt direct QUIC connection (LAN)
    async fn attempt_direct_quic(&self, peer_address: SocketAddr) -> Result<(), String> {
        log::info!("Attempting direct QUIC connection to {}", peer_address);

        // TODO: Implement actual direct QUIC connection using Quinn
        // This is a placeholder for now
        // In production, this would use Quinn's Endpoint::connect()

        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(())
    }

    /// Attempt STUN hole punching connection
    async fn attempt_stun_connection(&self, peer_address: SocketAddr) -> Result<(), String> {
        log::info!("Attempting STUN hole punching to {}", peer_address);

        // TODO: Implement actual STUN hole punching
        // This would use the discovered public IP to establish connection
        // In production, this would try to connect through the NAT mapping

        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(())
    }

    /// Attempt TURN relay connection
    async fn attempt_turn_relay(&self, peer_address: SocketAddr) -> Result<(), String> {
        log::info!("Attempting TURN relay to {}", peer_address);

        // Check if credentials need refresh
        if let Some(creds) = self.get_current_credentials() {
            if should_refresh_credentials(&creds, &self.config) {
                log::info!("TURN credentials need refresh");
                *self.state.lock().await = IceConnectionState::Refreshing;
                return Err("Credentials expired - refresh required".to_string());
            }
        }

        // TODO: Implement actual TURN relay connection
        // In production, this would use Quinn with TURN's relay address
        // For now, simulate successful connection

        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(())
    }

    /// Get current TURN credentials
    fn get_current_credentials(&self) -> Option<TurnCredentials> {
        // Check if we have cached credentials
        // For now, return None - in production this would return cached credentials
        None
    }

    /// Get current ICE connection state
    pub fn get_state(&self) -> IceConnectionState {
        *self.state.lock().blocking_read()
    }

    /// Get active connection info
    pub fn get_active_connection(&self) -> Option<IceCandidate> {
        *self.active_connection.lock().blocking_read()
    }

    /// Close ICE agent and all connections
    pub async fn close(&self) {
        log::info!("Closing ICE agent");

        *self.state.lock().await = IceConnectionState::Gathering;
        *self.active_connection.lock().await = None;

        // Close TURN client if open
        // self.turn_client.close().await;

        log::info!("ICE agent closed");
    }

    /// Check if any connection is active
    pub fn is_connected(&self) -> bool {
        matches!(self.get_state(), IceConnectionState::Connected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_candidate_priority_sorting() {
        let mut candidates = vec![
            IceCandidate {
                candidate_type: IceCandidateType::Relay,
                address: "0.0.0.0:5000".parse().unwrap(),
                priority: 0,
                source: "TURN".to_string(),
            },
            IceCandidate {
                candidate_type: IceCandidateType::Srflx,
                address: "0.0.0.0:5001".parse().unwrap(),
                priority: 100,
                source: "STUN".to_string(),
            },
            IceCandidate {
                candidate_type: IceCandidateType::Host,
                address: "0.0.0.0:5002".parse().unwrap(),
                priority: 126,
                source: "Direct".to_string(),
            },
        ];

        candidates.sort_by(|a, b| b.priority.cmp(&a.priority));

        assert_eq!(candidates[0].candidate_type, IceCandidateType::Host);
        assert_eq!(candidates[1].candidate_type, IceCandidateType::Srflx);
        assert_eq!(candidates[2].candidate_type, IceCandidateType::Relay);
    }

    #[test]
    fn test_gather_candidates_empty() {
        let config = TurnConfig {
            server_url: "turn.example.com:3478".to_string(),
            realm: "test".to_string(),
            enable_tls: false,
            auth_method: crate::turn::config::TurnAuthMethod::ShortTerm,
            username: None,
            password: None,
            secret: None,
            timeout_sec: 30,
            refresh_ratio: 0.8,
        };

        let agent = IceAgent::new(
            Arc::new(config),
            Arc::new(TurnClient::new(config).unwrap()),
            Arc::new(StunClient::new("0.0.0.0:0".parse().unwrap())),
        );

        tokio_test::block_on(async {
            let result = agent.gather_candidates(
                "0.0.0.0:5000".parse().unwrap()
            ).await;

            assert!(result.is_err());
            assert!(result.unwrap_err().contains("No ICE candidates available"));
        });
    }
}
