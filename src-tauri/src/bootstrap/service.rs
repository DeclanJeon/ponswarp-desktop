use crate::turn::{ConnectionStats, IceConnectionManager, StunClient, TurnAuthMethod, TurnClient, TurnConfig};
use crate::quic::client_enhanced::QuicClientEnhanced;
use crate::grid::bootstrap_discovery::{BootstrapDiscovery, BootstrapDiscoveryEvent};
use crate::bootstrap::{BootstrapConfig, DhtStats, RelayStats, StatsCollector, StatsServer, RelayServer, DhtHandle, PeerDiscoveredEvent, DhtNode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

/// 서비스 실행 상태
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error(String),
}

impl std::fmt::Display for ServiceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceState::Stopped => write!(f, "stopped"),
            ServiceState::Starting => write!(f, "starting"),
            ServiceState::Running => write!(f, "running"),
            ServiceState::Stopping => write!(f, "stopping"),
            ServiceState::Error(e) => write!(f, "error: {}", e),
        }
    }
}

/// 실제 바인딩된 포트 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundPorts {
    pub dht_port: u16,
    pub quic_port: u16,
    pub stats_port: u16,
}

/// 부트스트랩 상태 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapStatus {
    pub state: String,
    pub uptime_secs: u64,
    pub bound_ports: Option<BoundPorts>,
    pub dht_stats: DhtStats,
    pub relay_stats: RelayStats,
    pub connected_bootstrap_nodes: usize,
    pub discovered_peers: usize,
    pub turn_enabled: bool,
    pub turn_connection_stats: Option<ConnectionStats>,
}

/// 내장 부트스트랩 서비스
pub struct EmbeddedBootstrapService {
    /// DHT 노드 핸들
    dht_handle: Option<DhtHandle>,

    /// 통계 수집기
    stats: Arc<RwLock<StatsCollector>>,

    /// 설정
    config: Arc<RwLock<BootstrapConfig>>,

    /// 실행 상태
    state: Arc<RwLock<ServiceState>>,

    /// 실제 바인딩된 포트들
    bound_ports: Option<BoundPorts>,

    /// 시작 시간
    started_at: Option<Instant>,

    /// 백그라운드 태스크 핸들들
    dht_task: Option<JoinHandle<()>>,
    relay_task: Option<JoinHandle<()>>,
    stats_task: Option<JoinHandle<()>>,
    mdns_task: Option<JoinHandle<()>>,

    /// 피어 발견 이벤트 수신 채널
    peer_discovered_rx: Option<mpsc::Receiver<PeerDiscoveredEvent>>,

    /// 연결된 부트스트랩 노드 수
    connected_bootstrap_nodes: usize,

    /// 발견된 피어 수
    discovered_peers: usize,

    /// ICE/TURN 연결 관리자
    ice_manager: Option<IceConnectionManager>,

    /// TURN 클라이언트
    turn_client: Option<TurnClient>,

    /// STUN 클라이언트
    stun_client: Option<StunClient>,

    /// 고성능 QUIC 클라이언트 (TURN 지원)
    quic_client: Option<QuicClientEnhanced>,
}

impl EmbeddedBootstrapService {
    /// 새 서비스 인스턴스 생성
    pub fn new(config: BootstrapConfig) -> Self {
        Self {
            dht_handle: None,
            stats: Arc::new(RwLock::new(StatsCollector::new())),
            config: Arc::new(RwLock::new(config)),
            state: Arc::new(RwLock::new(ServiceState::Stopped)),
            bound_ports: None,
            started_at: None,
            dht_task: None,
            relay_task: None,
            stats_task: None,
            mdns_task: None,
            peer_discovered_rx: None,
            connected_bootstrap_nodes: 0,
            discovered_peers: 0,
            ice_manager: None,
            turn_client: None,
            stun_client: None,
            quic_client: None,
        }
    }

    /// 현재 상태 조회
    pub async fn state(&self) -> ServiceState {
        self.state.read().await.clone()
    }

    /// 상태 변경
    async fn set_state(&self, new_state: ServiceState) {
        info!("부트스트랩 상태 변경: {} -> {}", *self.state.read().await, new_state);
        *self.state.write().await = new_state;
    }

    /// 바인딩된 포트 조회
    pub fn bound_ports(&self) -> Option<&BoundPorts> {
        self.bound_ports.as_ref()
    }

    /// 설정 조회
    pub fn config(&self) -> Arc<RwLock<BootstrapConfig>> {
        Arc::clone(&self.config)
    }

    /// 설정 업데이트
    pub async fn update_config(&self, new_config: BootstrapConfig) {
        info!("부트스트랩 설정 업데이트");
        *self.config.write().await = new_config;
    }

    /// 통계 수집기 조회
    pub fn stats(&self) -> Arc<RwLock<StatsCollector>> {
        Arc::clone(&self.stats)
    }

    /// 상태 정보 조회
    pub async fn get_status(&self) -> BootstrapStatus {
        let stats_guard = self.stats.read().await;
        let config_guard = self.config.read().await;
        let ice_stats = self.ice_manager.as_ref().map(|m| m.get_connection_stats());

        BootstrapStatus {
            state: self.state().await.to_string(),
            uptime_secs: self.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
            bound_ports: self.bound_ports.clone(),
            dht_stats: DhtStats {
                nodes_in_routing_table: stats_guard.nodes_in_routing_table,
                providers_stored: stats_guard.providers_stored,
                messages_received: stats_guard.dht_messages_received,
                messages_sent: stats_guard.dht_messages_sent,
            },
            relay_stats: RelayStats {
                active_sessions: stats_guard.active_relay_sessions,
                total_connections: stats_guard.relay_connections,
                bytes_relayed: stats_guard.bytes_relayed,
            },
            connected_bootstrap_nodes: self.connected_bootstrap_nodes,
            discovered_peers: self.discovered_peers,
            turn_enabled: config_guard.enable_turn,
            turn_connection_stats: ice_stats,
        }
    }

    /// 피어 발견 이벤트 폴링
    pub async fn poll_peer_discovered(&mut self) -> Option<PeerDiscoveredEvent> {
        if let Some(ref mut rx) = self.peer_discovered_rx {
            rx.try_recv().ok()
        } else {
            None
        }
    }
}

// 포트 바인딩 유틸리티
impl EmbeddedBootstrapService {
        /// 사용 가능한 포트 찾기 (자동 fallback)
        async fn find_available_port(preferred_port: u16, service_name: &str) -> anyhow::Result<u16> {
            use tokio::net::TcpListener;

            // 0이면 OS가 자동 선택
            if preferred_port == 0 {
                let listener = TcpListener::bind("0.0.0.0:0").await?;
                let port = listener.local_addr()?.port();
                info!("{} 포트 자동 선택: {}", service_name, port);
                return Ok(port);
            }

            // 선호 포트 시도
            match TcpListener::bind(format!("0.0.0.0:{}", preferred_port)).await {
                Ok(_) => {
                    info!("{} 포트 사용: {}", service_name, preferred_port);
                    Ok(preferred_port)
                }
                Err(_) => {
                    warn!(
                        "{} 포트 {} 사용 중, 대체 포트 검색...",
                        service_name, preferred_port
                    );

                    // 근처 포트 범위에서 검색 (±10)
                    for offset in 1..=10 {
                        let try_port = preferred_port.saturating_add(offset);
                        if try_port > 0 {
                            if let Ok(_) = TcpListener::bind(format!("0.0.0.0:{}", try_port)).await {
                                info!("{} 대체 포트 사용: {}", service_name, try_port);
                                return Ok(try_port);
                            }
                        }
                    }

                    // 모두 실패하면 OS가 자동 선택
                    let listener = TcpListener::bind("0.0.0.0:0").await?;
                    let port = listener.local_addr()?.port();
                    warn!(
                        "{} 모든 선호 포트 사용 중, OS 자동 선택: {}",
                        service_name, port
                    );
                    Ok(port)
                }
            }
        }

    /// 모든 서비스의 포트 결정
    pub async fn determine_ports(&self) -> anyhow::Result<BoundPorts> {
        let config_guard = self.config.read().await;

        let dht_port = Self::find_available_port(config_guard.dht_port, "DHT").await?;
        let quic_port = Self::find_available_port(config_guard.quic_port, "QUIC Relay").await?;
        let stats_port = Self::find_available_port(config_guard.stats_port, "Stats API").await?;

        Ok(BoundPorts {
            dht_port,
            quic_port,
            stats_port,
        })
    }
}

// 서비스 시작/중지
impl EmbeddedBootstrapService {
        /// 서비스 시작 (5초 타임아웃)
        pub async fn start(&mut self) -> anyhow::Result<BoundPorts> {
            if self.state().await != ServiceState::Stopped {
                return Err(anyhow::anyhow!("서비스가 이미 실행 중이거나 시작 중입니다"));
            }

            self.set_state(ServiceState::Starting).await;

            // 타임아웃 설정
            let start_result =
                tokio::time::timeout(std::time::Duration::from_secs(5), self.start_internal()).await;

            match start_result {
                Ok(Ok(ports)) => {
                    self.set_state(ServiceState::Running).await;
                    self.started_at = Some(Instant::now());
                    Ok(ports)
                }
                Ok(Err(e)) => {
                    let error_msg = format!("서비스 시작 실패: {}", e);
                    error!("{}", error_msg);
                    self.set_state(ServiceState::Error(error_msg.clone())).await;
                    self.cleanup().await;
                    Err(anyhow::anyhow!(error_msg))
                }
                Err(_) => {
                    let error_msg = "서비스 시작 타임아웃 (5초 초과)".to_string();
                    error!("{}", error_msg);
                    self.set_state(ServiceState::Error(error_msg.clone())).await;
                    self.cleanup().await;
                    Err(anyhow::anyhow!(error_msg))
                }
            }
        }

        /// 내부 시작 로직
        async fn start_internal(&mut self) -> anyhow::Result<BoundPorts> {
            info!("🚀 내장 부트스트랩 서비스 시작 중...");

            // 포트 결정
            let ports = self.determine_ports().await?;
            self.bound_ports = Some(ports.clone());

            // 통계 초기화
            self.stats.write().await.reset();

            // TURN/ICE 초기화
            self.initialize_turn_ice(&ports, self.config.clone()).await?;

            // 피어 발견 이벤트 채널
            let (peer_tx, peer_rx) = mpsc::channel(100);
            self.peer_discovered_rx = Some(peer_rx);

            // DHT 노드 시작
            let dht_node = DhtNode::new(ports.dht_port, self.stats.clone(), Some(peer_tx)).await?;
            self.dht_handle = Some(dht_node.handle());

            self.dht_task = Some(tokio::spawn(async move {
                dht_node.run().await;
            }));

            info!("✅ DHT 노드 시작됨: 포트 {}", ports.dht_port);

            // QUIC 릴레이 서버 시작 (설정에서 활성화된 경우)
            let (enable_relay, max_relay_sessions, enable_mdns_discovery, has_external_bootstrap) = {
                let config_guard = self.config.read().await;
                (
                    config_guard.enable_relay,
                    config_guard.max_relay_sessions,
                    config_guard.enable_mdns_discovery,
                    !config_guard.external_bootstrap_nodes.is_empty(),
                )
            };

            if enable_relay {
                let relay_server = RelayServer::new(
                    ports.quic_port,
                    self.stats.clone(),
                    max_relay_sessions,
                )
                .await?;

                self.relay_task = Some(tokio::spawn(async move {
                    relay_server.run().await;
                }));

                info!("✅ QUIC 릴레이 서버 시작됨: 포트 {}", ports.quic_port);
            }

            // Stats HTTP 서버 시작
            let stats_server = StatsServer::new(ports.stats_port, self.stats.clone()).await?;

            self.stats_task = Some(tokio::spawn(async move {
                stats_server.run().await;
            }));

            info!("✅ Stats API 서버 시작됨: 포트 {}", ports.stats_port);

            // mDNS 탐색 시작 및 DHT 연동
            if enable_mdns_discovery {
                let (tx, mut rx) = mpsc::channel(32);
                match BootstrapDiscovery::new(tx) {
                    Ok(discovery) => {
                        if let Err(e) = discovery.start().await {
                            warn!("mDNS 탐색 시작 실패: {}", e);
                        } else {
                            info!("🔍 mDNS 부트스트랩 노드 탐색 시작됨");

                            if let Some(dht_handle) = self.dht_handle.clone() {
                                let mdns_task = tokio::spawn(async move {
                                    // 초기 발견된 노드 주소 가져오기
                                    let initial_nodes = discovery.get_addresses().await;
                                    for addr in initial_nodes {
                                        info!("🔗 mDNS 초기 발견 노드 추가: {}", addr);
                                        let _ = dht_handle.add_bootstrap_node(addr).await;
                                    }

                                    // 실시간 발견 이벤트 처리
                                    while let Some(event) = rx.recv().await {
                                        if let BootstrapDiscoveryEvent::NodeDiscovered(node) = event {
                                            info!("🔗 mDNS 실시간 발견 노드 추가: {}", node.address);
                                            let _ = dht_handle.add_bootstrap_node(node.address).await;
                                        }
                                    }

                                    // 태스크 종료 시 탐색 중지
                                    discovery.stop().await;
                                });

                                self.mdns_task = Some(mdns_task);
                            } else {
                                warn!("mDNS 탐색 시작 스킵: DHT handle 없음");
                            }
                        }
                    }
                    Err(e) => {
                        warn!("mDNS BootstrapDiscovery 생성 실패: {}", e);
                    }
                }
            }

            // 외부 부트스트랩 노드 연결
            if has_external_bootstrap {
                self.connect_to_bootstrap_nodes().await;
            }

            info!("🎉 내장 부트스트랩 서비스 시작 완료!");

            Ok(ports)
        }

    /// TURN/ICE 초기화
    async fn initialize_turn_ice(
        &mut self,
        _ports: &BoundPorts,
        config: Arc<RwLock<BootstrapConfig>>,
    ) -> anyhow::Result<()> {
        let cfg = config.read().await.clone();

        if !cfg.enable_turn {
            info!("TURN 기능 비활성화");
            return Ok(());
        }

        let server_url = cfg
            .turn_server_url
            .clone()
            .unwrap_or_else(|| "turn.ponslink.online:3478".to_string());

        let turn_config = TurnConfig {
            server_url,
            realm: cfg
                .turn_realm
                .clone()
                .unwrap_or_else(|| "ponslink.online".to_string()),
            enable_tls: true,
            auth_method: if cfg.turn_secret.is_some() {
                TurnAuthMethod::LongTerm
            } else {
                TurnAuthMethod::ShortTerm
            },
            username: cfg.turn_username.clone(),
            password: cfg.turn_password.clone(),
            secret: cfg.turn_secret.clone(),
            timeout_sec: 30,
            refresh_ratio: 0.8,
        };

        let turn_client = TurnClient::new(turn_config.clone()).map_err(anyhow::Error::msg)?;
        self.turn_client = Some(turn_client);

        let stun_addr = "stun.l.google.com:19302"
            .parse()
            .map_err(|e| anyhow::anyhow!("STUN address parse failed: {}", e))?;
        self.stun_client = Some(StunClient::new(stun_addr));

        let mut quic_client = QuicClientEnhanced::new();
        if let Err(e) = quic_client.configure_turn(turn_config).await {
            warn!("TURN-aware QUIC 구성 실패, direct 모드로 진행: {}", e);
        }
        self.quic_client = Some(quic_client);

        info!("TURN/ICE 초기화 완료");
        Ok(())
    }

    /// 외부 부트스트랩 노드에 연결
    async fn connect_to_bootstrap_nodes(&mut self) {
        if let Some(ref dht_handle) = self.dht_handle {
            for addr_str in &self.config.read().await.external_bootstrap_nodes {
                if let Ok(addr) = addr_str.parse() {
                    info!("🔗 외부 부트스트랩 노드 연결 시도: {}", addr);
                    if let Err(e) = dht_handle.add_bootstrap_node(addr).await {
                        warn!("부트스트랩 노드 연결 실패 {}: {}", addr, e);
                    } else {
                        self.connected_bootstrap_nodes += 1;
                    }
                }
            }
        }
    }

    /// 정리 작업
    async fn cleanup(&mut self) {
        info!("🛑 내장 부트스트랩 서비스 중지 중...");

        // 태스크 정리
        if let Some(task) = self.dht_task.take() {
            task.abort();
        }
        if let Some(task) = self.relay_task.take() {
            task.abort();
        }
        if let Some(task) = self.stats_task.take() {
            task.abort();
        }
        if let Some(task) = self.mdns_task.take() {
            task.abort();
        }

        self.dht_handle = None;
        self.bound_ports = None;
        self.peer_discovered_rx = None;
        self.connected_bootstrap_nodes = 0;
        self.discovered_peers = 0;

        // TURN/ICE 클린업
        if let Some(manager) = self.ice_manager.take() {
            manager.close().await;
        }
        if let Some(client) = self.turn_client.take() {
            client.close().await;
        }
        if let Some(client) = self.stun_client.take() {
            // STUN client cleanup
        }

        self.quic_client = None;

        info!("✅ 내장 부트스트랩 서비스 중지 완료");
    }

    /// 낮제 중지 로직
    async fn stop_internal(&mut self) -> anyhow::Result<()> {
        info!("🛑 내장 부트스트랩 서비스 중지 중...");

        // DHT 노드에 종료 신호 전송
        if let Some(ref dht_handle) = self.dht_handle {
            let _ = dht_handle.shutdown().await;
        }

        // 정리 작업
        self.cleanup().await;

        Ok(())
    }

    /// 서비스 중지 (3초 타임아웃)
    pub async fn stop(&mut self) -> anyhow::Result<()> {
        if self.state().await == ServiceState::Stopped {
            return Ok(());
        }

        self.set_state(ServiceState::Stopping).await;

        // 타임아웃 설정
        let stop_result =
            tokio::time::timeout(std::time::Duration::from_secs(3), self.stop_internal()).await;

        match stop_result {
            Ok(Ok(())) => {
                self.set_state(ServiceState::Stopped).await;
                info!("✅ 내장 부트스트랩 서비스 중지 완료");
                Ok(())
            }
            Ok(Err(e)) => {
                let error_msg = format!("서비스 중지 실패: {}", e);
                error!("{}", error_msg);
                self.set_state(ServiceState::Error(error_msg.clone())).await;
                self.cleanup().await;
                Err(anyhow::anyhow!(error_msg))
            }
            Err(_) => {
                warn!("서비스 중지 타임아웃 (3초 초과), 강제 종료");
                self.cleanup().await;
                self.set_state(ServiceState::Stopped).await;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_available_port_zero() {
        tokio_test::block_on(async {
            // Test for port 0 (auto-select)
            let result = EmbeddedBootstrapService::find_available_port(0, "TestService").await;

            assert!(result.is_ok());
            let port = result.unwrap();
            assert!(port > 0);
        });
    }

    #[test]
    fn test_find_available_port_specific() {
        tokio_test::block_on(async {
            // Test for specific port (should work if available)
            let result = EmbeddedBootstrapService::find_available_port(8080, "TestService").await;

            assert!(result.is_ok());
            let port = result.unwrap();
            assert_eq!(port, 8080);
        });
    }

    #[test]
    fn test_find_available_port_unavailable() {
        tokio_test::block_on(async {
            // Test for port in use (should try alternatives)
            let result = EmbeddedBootstrapService::find_available_port(80, "TestService").await;

            assert!(result.is_ok());
            let port = result.unwrap();
            // Should return a different port since 80 is in use
            assert_ne!(port, 80);
        });
    }
}
