//! DHT 노드 구현 (ponswarp-bootstrap에서 포팅)
//!
//! Kademlia DHT 프로토콜을 구현하여 피어 발견 서비스를 제공합니다.

use super::stats::StatsCollector;
use dashmap::DashMap;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info, warn};

/// mDNS 서비스 타입 (부트스트랩 노드 자동 발견용)
const BOOTSTRAP_SERVICE_TYPE: &str = "_pswp._udp.local.";

pub type NodeId = [u8; 32];
pub type InfoHash = [u8; 32];

/// DHT 메시지
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DhtMessage {
    Ping {
        sender_id: NodeId,
    },
    Pong {
        sender_id: NodeId,
    },
    FindNode {
        sender_id: NodeId,
        target: NodeId,
    },
    FindNodeResponse {
        sender_id: NodeId,
        nodes: Vec<(NodeId, SocketAddr)>,
    },
    GetProviders {
        sender_id: NodeId,
        info_hash: InfoHash,
    },
    GetProvidersResponse {
        sender_id: NodeId,
        info_hash: InfoHash,
        providers: Vec<(NodeId, SocketAddr)>,
        nodes: Vec<(NodeId, SocketAddr)>,
    },
    Announce {
        sender_id: NodeId,
        info_hash: InfoHash,
        port: u16,
    },
    AnnounceResponse {
        sender_id: NodeId,
        success: bool,
    },
}

impl DhtMessage {
    fn serialize(&self) -> Vec<u8> {
        bincode::serialize(self).unwrap_or_default()
    }

    fn deserialize(data: &[u8]) -> Option<Self> {
        bincode::deserialize(data).ok()
    }
}

/// 라우팅 테이블 엔트리
#[derive(Debug, Clone)]
struct RoutingEntry {
    node_id: NodeId,
    addr: SocketAddr,
    last_seen: Instant,
}

/// 제공자 정보
#[derive(Debug, Clone)]
struct ProviderInfo {
    node_id: NodeId,
    addr: SocketAddr,
    announced_at: Instant,
}

/// DHT 노드
pub struct DhtNode {
    node_id: NodeId,
    socket: Arc<UdpSocket>,
    routing_table: Vec<RwLock<Vec<RoutingEntry>>>,
    providers: DashMap<InfoHash, Vec<ProviderInfo>>,
    stats: Arc<RwLock<StatsCollector>>,
    command_rx: mpsc::Receiver<DhtCommand>,
    command_tx: mpsc::Sender<DhtCommand>,
    /// 🆕 Tauri 이벤트 발생용 (피어 발견 알림)
    peer_discovered_tx: Option<mpsc::Sender<PeerDiscoveredEvent>>,
}

/// 피어 발견 이벤트
#[derive(Debug, Clone, Serialize)]
pub struct PeerDiscoveredEvent {
    pub node_id: String,
    pub address: String,
    pub source: String,
}

pub enum DhtCommand {
    AddBootstrapNode(SocketAddr),
    Shutdown,
}

#[derive(Clone)]
pub struct DhtHandle {
    command_tx: mpsc::Sender<DhtCommand>,
}

impl DhtHandle {
    pub async fn add_bootstrap_node(&self, addr: SocketAddr) -> anyhow::Result<()> {
        self.command_tx
            .send(DhtCommand::AddBootstrapNode(addr))
            .await?;
        Ok(())
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.command_tx.send(DhtCommand::Shutdown).await?;
        Ok(())
    }
}

impl DhtNode {
    pub async fn new(
        port: u16,
        stats: Arc<RwLock<StatsCollector>>,
        peer_discovered_tx: Option<mpsc::Sender<PeerDiscoveredEvent>>,
    ) -> anyhow::Result<Self> {
        let mut node_id = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut node_id);

        let socket = UdpSocket::bind(format!("0.0.0.0:{}", port)).await?;
        let local_addr = socket.local_addr()?;
        info!(
            "🌐 DHT 노드 시작: {} (ID: {})",
            local_addr,
            hex::encode(&node_id[..8])
        );

        let routing_table: Vec<RwLock<Vec<RoutingEntry>>> = (0..256)
            .map(|_| RwLock::new(Vec::with_capacity(20)))
            .collect();

        let (command_tx, command_rx) = mpsc::channel(100);

        // mDNS로 부트스트랩 노드 광고 (자동 발견용)
        Self::register_mdns_service(local_addr.port(), &node_id);

        Ok(Self {
            node_id,
            socket: Arc::new(socket),
            routing_table,
            providers: DashMap::new(),
            stats,
            command_rx,
            command_tx,
            peer_discovered_tx,
        })
    }

    /// mDNS 서비스 등록 (부트스트랩 노드 자동 발견)
    fn register_mdns_service(port: u16, node_id: &[u8; 32]) {
        let node_id_short = hex::encode(&node_id[..1]);

        match ServiceDaemon::new() {
            Ok(daemon) => {
                let host_name = "ponswarp.local.";
                let instance_name = format!("pswp-{}", node_id_short);

                match ServiceInfo::new(
                    BOOTSTRAP_SERVICE_TYPE,
                    &instance_name,
                    host_name,
                    (),
                    port,
                    None,
                ) {
                    Ok(service) => {
                        if let Err(e) = daemon.register(service) {
                            warn!("mDNS 등록 실패: {}", e);
                        } else {
                            info!(
                                "📡 mDNS 부트스트랩 광고 시작: {} @ port {}",
                                instance_name, port
                            );
                        }
                    }
                    Err(e) => warn!("mDNS 서비스 정보 생성 실패: {}", e),
                }
            }
            Err(e) => warn!("mDNS 데몬 생성 실패: {}", e),
        }
    }

    pub fn handle(&self) -> DhtHandle {
        DhtHandle {
            command_tx: self.command_tx.clone(),
        }
    }

    pub fn local_addr(&self) -> anyhow::Result<SocketAddr> {
        Ok(self.socket.local_addr()?)
    }

    pub async fn run(mut self) {
        let mut buf = vec![0u8; 65535];
        let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));

        loop {
            tokio::select! {
                // 명령 처리
                cmd = self.command_rx.recv() => {
                    match cmd {
                        Some(DhtCommand::AddBootstrapNode(addr)) => {
                            self.bootstrap(addr).await;
                        }
                        Some(DhtCommand::Shutdown) | None => {
                            info!("DHT 노드 종료");
                            break;
                        }
                    }
                }

                // UDP 메시지 수신
                result = self.socket.recv_from(&mut buf) => {
                    match result {
                        Ok((len, addr)) => {
                            if let Some(msg) = DhtMessage::deserialize(&buf[..len]) {
                                self.handle_message(msg, addr).await;
                            }
                        }
                        Err(e) => error!("UDP 수신 에러: {}", e),
                    }
                }

                // 주기적 정리
                _ = cleanup_interval.tick() => {
                    self.cleanup_stale_data().await;
                }
            }
        }
    }

    async fn bootstrap(&self, addr: SocketAddr) {
        let msg = DhtMessage::FindNode {
            sender_id: self.node_id,
            target: self.node_id,
        };
        self.send_message(&msg, addr).await;
    }

    async fn handle_message(&self, msg: DhtMessage, from: SocketAddr) {
        let mut stats = self.stats.write().await;
        stats.dht_messages_received += 1;
        drop(stats);

        match msg {
            DhtMessage::Ping { sender_id } => {
                self.add_node(sender_id, from).await;
                let response = DhtMessage::Pong {
                    sender_id: self.node_id,
                };
                self.send_message(&response, from).await;
            }

            DhtMessage::Pong { sender_id } => {
                self.add_node(sender_id, from).await;
            }

            DhtMessage::FindNode { sender_id, target } => {
                self.add_node(sender_id, from).await;
                let nodes = self.find_closest_nodes(&target, 8).await;
                let response = DhtMessage::FindNodeResponse {
                    sender_id: self.node_id,
                    nodes,
                };
                self.send_message(&response, from).await;
            }

            DhtMessage::FindNodeResponse { sender_id, nodes } => {
                self.add_node(sender_id, from).await;
                for (node_id, addr) in nodes {
                    self.add_node(node_id, addr).await;
                }
            }

            DhtMessage::GetProviders {
                sender_id,
                info_hash,
            } => {
                self.add_node(sender_id, from).await;

                let providers = self.get_providers(&info_hash);
                let nodes = self.find_closest_nodes(&info_hash, 8).await;

                let response = DhtMessage::GetProvidersResponse {
                    sender_id: self.node_id,
                    info_hash,
                    providers,
                    nodes,
                };
                self.send_message(&response, from).await;
            }

            DhtMessage::GetProvidersResponse {
                sender_id, nodes, ..
            } => {
                self.add_node(sender_id, from).await;
                for (node_id, addr) in nodes {
                    self.add_node(node_id, addr).await;
                }
            }

            DhtMessage::Announce {
                sender_id,
                info_hash,
                port,
            } => {
                self.add_node(sender_id, from).await;

                let provider_addr = SocketAddr::new(from.ip(), port);
                self.add_provider(info_hash, sender_id, provider_addr);

                let mut stats = self.stats.write().await;
                stats.providers_stored += 1;
                drop(stats);

                info!(
                    "📢 Announce: {} provides {}",
                    hex::encode(&sender_id[..8]),
                    hex::encode(&info_hash[..8])
                );

                let response = DhtMessage::AnnounceResponse {
                    sender_id: self.node_id,
                    success: true,
                };
                self.send_message(&response, from).await;
            }

            DhtMessage::AnnounceResponse { .. } => {}
        }
    }

    async fn add_node(&self, node_id: NodeId, addr: SocketAddr) {
        let bucket_idx = self.bucket_index(&node_id);
        if bucket_idx >= self.routing_table.len() {
            return;
        }

        let mut bucket = self.routing_table[bucket_idx].write().await;

        if let Some(entry) = bucket.iter_mut().find(|e| e.node_id == node_id) {
            entry.last_seen = Instant::now();
            entry.addr = addr;
            return;
        }

        if bucket.len() < 20 {
            bucket.push(RoutingEntry {
                node_id,
                addr,
                last_seen: Instant::now(),
            });

            let mut stats = self.stats.write().await;
            stats.nodes_in_routing_table += 1;
            drop(stats);

            // 🆕 피어 발견 이벤트 발생
            if let Some(ref tx) = self.peer_discovered_tx {
                let event = PeerDiscoveredEvent {
                    node_id: hex::encode(&node_id[..8]),
                    address: addr.to_string(),
                    source: "dht".to_string(),
                };
                let _ = tx.send(event).await;
            }
        }
    }

    fn bucket_index(&self, node_id: &NodeId) -> usize {
        let mut distance = [0u8; 32];
        for i in 0..32 {
            distance[i] = self.node_id[i] ^ node_id[i];
        }

        for (i, byte) in distance.iter().enumerate() {
            if *byte != 0 {
                return i * 8 + byte.leading_zeros() as usize;
            }
        }
        255
    }

    async fn find_closest_nodes(&self, target: &NodeId, count: usize) -> Vec<(NodeId, SocketAddr)> {
        let mut all_nodes = Vec::new();

        for bucket in &self.routing_table {
            let bucket = bucket.read().await;
            for entry in bucket.iter() {
                let mut distance = [0u8; 32];
                for i in 0..32 {
                    distance[i] = entry.node_id[i] ^ target[i];
                }
                all_nodes.push((entry.node_id, entry.addr, distance));
            }
        }

        all_nodes.sort_by(|a, b| a.2.cmp(&b.2));
        all_nodes
            .into_iter()
            .take(count)
            .map(|(id, addr, _)| (id, addr))
            .collect()
    }

    fn add_provider(&self, info_hash: InfoHash, node_id: NodeId, addr: SocketAddr) {
        let mut providers = self.providers.entry(info_hash).or_insert_with(Vec::new);

        providers.retain(|p| p.node_id != node_id);

        providers.push(ProviderInfo {
            node_id,
            addr,
            announced_at: Instant::now(),
        });

        if providers.len() > 100 {
            providers.sort_by_key(|p| std::cmp::Reverse(p.announced_at));
            providers.truncate(100);
        }
    }

    fn get_providers(&self, info_hash: &InfoHash) -> Vec<(NodeId, SocketAddr)> {
        self.providers
            .get(info_hash)
            .map(|providers| {
                providers
                    .iter()
                    .filter(|p| p.announced_at.elapsed() < Duration::from_secs(3600))
                    .map(|p| (p.node_id, p.addr))
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn send_message(&self, msg: &DhtMessage, to: SocketAddr) {
        let data = msg.serialize();
        if let Err(e) = self.socket.send_to(&data, to).await {
            warn!("메시지 전송 실패: {} - {}", to, e);
        } else {
            let mut stats = self.stats.write().await;
            stats.dht_messages_sent += 1;
        }
    }

    async fn cleanup_stale_data(&self) {
        // 오래된 라우팅 엔트리 제거
        let mut removed_count = 0;
        for bucket in &self.routing_table {
            let mut bucket = bucket.write().await;
            let before = bucket.len();
            bucket.retain(|e| e.last_seen.elapsed() < Duration::from_secs(900));
            removed_count += before - bucket.len();
        }

        if removed_count > 0 {
            let mut stats = self.stats.write().await;
            stats.nodes_in_routing_table = stats
                .nodes_in_routing_table
                .saturating_sub(removed_count as u64);
        }

        // 오래된 제공자 제거
        self.providers.retain(|_, providers| {
            providers.retain(|p| p.announced_at.elapsed() < Duration::from_secs(3600));
            !providers.is_empty()
        });

        debug!("🧹 DHT 정리 완료");
    }
}
