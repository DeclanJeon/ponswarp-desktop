//! Hybrid Discovery - mDNS + DHT 통합 피어 발견
//!
//! 로컬 서브넷(mDNS)과 원격 서브넷(DHT)을 결합하여
//! 사내망 전체에서 피어를 효율적으로 발견합니다.

use crate::discovery::DiscoveryService;
use crate::grid::dht::{DhtCommand, DhtEvent, DhtHandle, InfoHash};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};

/// 발견된 피어 정보
#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    pub peer_id: String,
    pub address: SocketAddr,
    pub source: DiscoverySource,
    pub discovered_at: Instant,
    pub last_seen: Instant,
}

/// 피어 발견 소스
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoverySource {
    /// 로컬 서브넷 (mDNS)
    Mdns,
    /// 원격 서브넷 (DHT)
    Dht,
    /// 수동 추가
    Manual,
}

/// 하이브리드 디스커버리 이벤트
#[derive(Debug, Clone)]
pub enum HybridDiscoveryEvent {
    /// 새 피어 발견
    PeerDiscovered(DiscoveredPeer),
    /// 피어 사라짐
    PeerLost(String),
    /// 제공자 발견 (특정 파일을 가진 피어)
    ProvidersFound {
        info_hash: InfoHash,
        providers: Vec<DiscoveredPeer>,
    },
}

/// 하이브리드 디스커버리 서비스
pub struct HybridDiscovery {
    /// mDNS 서비스
    mdns: Option<Arc<RwLock<DiscoveryService>>>,
    /// DHT 핸들
    dht_handle: Option<DhtHandle>,
    /// DHT 이벤트 수신
    dht_event_rx: Option<mpsc::Receiver<DhtEvent>>,
    /// 발견된 피어 캐시
    peers: Arc<RwLock<HashMap<String, DiscoveredPeer>>>,
    /// 이벤트 발송
    event_tx: mpsc::Sender<HybridDiscoveryEvent>,
    /// 부트스트랩 노드 목록
    bootstrap_nodes: Vec<SocketAddr>,
}

impl HybridDiscovery {
    pub fn new(event_tx: mpsc::Sender<HybridDiscoveryEvent>) -> Self {
        Self {
            mdns: None,
            dht_handle: None,
            dht_event_rx: None,
            peers: Arc::new(RwLock::new(HashMap::new())),
            event_tx,
            bootstrap_nodes: Vec::new(),
        }
    }

    /// mDNS 서비스 설정
    pub fn with_mdns(mut self, mdns: Arc<RwLock<DiscoveryService>>) -> Self {
        self.mdns = Some(mdns);
        self
    }

    /// DHT 핸들 설정
    pub fn with_dht(mut self, handle: DhtHandle, event_rx: mpsc::Receiver<DhtEvent>) -> Self {
        self.dht_handle = Some(handle);
        self.dht_event_rx = Some(event_rx);
        self
    }

    /// 부트스트랩 노드 추가
    pub fn add_bootstrap_node(&mut self, addr: SocketAddr) {
        self.bootstrap_nodes.push(addr);
    }

    /// 부트스트랩 노드 목록 설정
    pub fn set_bootstrap_nodes(&mut self, nodes: Vec<SocketAddr>) {
        self.bootstrap_nodes = nodes;
    }

    /// 서비스 시작
    pub async fn start(&mut self) -> anyhow::Result<()> {
        info!("🔍 하이브리드 디스커버리 시작");

        // DHT 부트스트랩
        if let Some(ref handle) = self.dht_handle {
            for addr in &self.bootstrap_nodes {
                if let Err(e) = handle.add_bootstrap_node(*addr).await {
                    warn!("부트스트랩 노드 연결 실패: {} - {}", addr, e);
                }
            }
        }

        Ok(())
    }

    /// 메인 실행 루프
    pub async fn run(mut self) {
        let mut mdns_poll_interval = tokio::time::interval(Duration::from_secs(5));
        let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));

        loop {
            tokio::select! {
                // mDNS 폴링
                _ = mdns_poll_interval.tick() => {
                    self.poll_mdns().await;
                }

                // DHT 이벤트 처리
                event = async {
                    if let Some(ref mut rx) = self.dht_event_rx {
                        rx.recv().await
                    } else {
                        std::future::pending::<Option<DhtEvent>>().await
                    }
                } => {
                    if let Some(event) = event {
                        self.handle_dht_event(event).await;
                    }
                }

                // 오래된 피어 정리
                _ = cleanup_interval.tick() => {
                    self.cleanup_stale_peers().await;
                }
            }
        }
    }

    /// mDNS에서 피어 폴링
    async fn poll_mdns(&mut self) {
        if let Some(ref mdns) = self.mdns {
            let mdns_guard = mdns.read().await;
            let mdns_peers = mdns_guard.get_peers();
            drop(mdns_guard);

            let mut peers = self.peers.write().await;
            let now = Instant::now();

            for peer in mdns_peers {
                let peer_id = peer.id.clone();

                if let Some(existing) = peers.get_mut(&peer_id) {
                    existing.last_seen = now;
                    existing.address = peer.address;
                } else {
                    let discovered = DiscoveredPeer {
                        peer_id: peer_id.clone(),
                        address: peer.address,
                        source: DiscoverySource::Mdns,
                        discovered_at: now,
                        last_seen: now,
                    };

                    peers.insert(peer_id.clone(), discovered.clone());

                    let _ = self
                        .event_tx
                        .send(HybridDiscoveryEvent::PeerDiscovered(discovered))
                        .await;

                    info!("🔍 [mDNS] 피어 발견: {} @ {}", peer_id, peer.address);
                }
            }
        }
    }

    /// DHT 이벤트 처리
    async fn handle_dht_event(&mut self, event: DhtEvent) {
        match event {
            DhtEvent::PeerFound {
                info_hash,
                peer_id,
                addr,
            } => {
                let peer_id_str = hex::encode(&peer_id[..8]);
                let now = Instant::now();

                let mut peers = self.peers.write().await;

                if !peers.contains_key(&peer_id_str) {
                    let discovered = DiscoveredPeer {
                        peer_id: peer_id_str.clone(),
                        address: addr,
                        source: DiscoverySource::Dht,
                        discovered_at: now,
                        last_seen: now,
                    };

                    peers.insert(peer_id_str.clone(), discovered.clone());

                    let _ = self
                        .event_tx
                        .send(HybridDiscoveryEvent::PeerDiscovered(discovered))
                        .await;

                    info!(
                        "🔍 [DHT] 피어 발견: {} @ {} (file: {})",
                        peer_id_str,
                        addr,
                        hex::encode(&info_hash[..8])
                    );
                }
            }

            DhtEvent::ProvidersFound {
                info_hash,
                providers,
            } => {
                let now = Instant::now();
                let discovered_providers: Vec<DiscoveredPeer> = providers
                    .into_iter()
                    .map(|(peer_id, addr)| DiscoveredPeer {
                        peer_id: hex::encode(&peer_id[..8]),
                        address: addr,
                        source: DiscoverySource::Dht,
                        discovered_at: now,
                        last_seen: now,
                    })
                    .collect();

                let _ = self
                    .event_tx
                    .send(HybridDiscoveryEvent::ProvidersFound {
                        info_hash,
                        providers: discovered_providers,
                    })
                    .await;
            }

            DhtEvent::Ready => {
                info!("✅ DHT 준비 완료");
            }

            DhtEvent::Error { message } => {
                warn!("⚠️ DHT 에러: {}", message);
            }
        }
    }

    /// 오래된 피어 정리
    async fn cleanup_stale_peers(&mut self) {
        let mut peers = self.peers.write().await;
        let timeout = Duration::from_secs(300); // 5분

        let stale: Vec<String> = peers
            .iter()
            .filter(|(_, p)| p.last_seen.elapsed() > timeout)
            .map(|(id, _)| id.clone())
            .collect();

        for peer_id in stale {
            peers.remove(&peer_id);
            let _ = self
                .event_tx
                .send(HybridDiscoveryEvent::PeerLost(peer_id.clone()))
                .await;
            debug!("🧹 오래된 피어 제거: {}", peer_id);
        }
    }

    /// 특정 파일의 제공자 검색
    pub async fn find_providers(&self, info_hash: InfoHash) -> anyhow::Result<()> {
        if let Some(ref handle) = self.dht_handle {
            handle.find_providers(info_hash).await?;
        }
        Ok(())
    }

    /// 파일 제공 시작 (내가 이 파일을 가지고 있음을 알림)
    pub async fn start_providing(&self, info_hash: InfoHash) -> anyhow::Result<()> {
        if let Some(ref handle) = self.dht_handle {
            handle.start_providing(info_hash).await?;
        }
        Ok(())
    }

    /// 현재 발견된 피어 목록
    pub async fn get_peers(&self) -> Vec<DiscoveredPeer> {
        self.peers.read().await.values().cloned().collect()
    }

    /// 피어 수
    pub async fn peer_count(&self) -> usize {
        self.peers.read().await.len()
    }
}
