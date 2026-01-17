//! Kademlia DHT - Trackerless Peer Discovery
//!
//! 중앙 서버 없이 사내망 전체에서 파일을 가진 피어를 찾습니다.
//! mDNS(로컬 서브넷)와 DHT(원격 서브넷)를 하이브리드로 사용합니다.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info, warn};

/// DHT 노드 ID (256-bit)
pub type NodeId = [u8; 32];

/// Info Hash (파일 식별자)
pub type InfoHash = [u8; 32];

/// DHT 명령
#[derive(Debug)]
pub enum DhtCommand {
    /// 파일 제공 시작 (내가 이 파일을 가지고 있음을 알림)
    StartProviding { info_hash: InfoHash },
    /// 파일 제공 중지
    StopProviding { info_hash: InfoHash },
    /// 파일을 가진 피어 찾기
    FindProviders { info_hash: InfoHash },
    /// 부트스트랩 노드 추가
    AddBootstrapNode { addr: SocketAddr },
    /// 피어 주소 추가 (수동)
    AddPeer { node_id: NodeId, addr: SocketAddr },
}

/// DHT 이벤트
#[derive(Debug, Clone)]
pub enum DhtEvent {
    /// 피어 발견
    PeerFound {
        info_hash: InfoHash,
        peer_id: NodeId,
        addr: SocketAddr,
    },
    /// 피어 목록 업데이트
    ProvidersFound {
        info_hash: InfoHash,
        providers: Vec<(NodeId, SocketAddr)>,
    },
    /// DHT 준비 완료
    Ready,
    /// 에러
    Error { message: String },
}

/// Kademlia 라우팅 테이블 엔트리
#[derive(Debug, Clone)]
struct RoutingEntry {
    node_id: NodeId,
    addr: SocketAddr,
    last_seen: Instant,
    rtt_ms: Option<u32>,
}

/// K-Bucket (Kademlia 라우팅 테이블의 버킷)
struct KBucket {
    entries: Vec<RoutingEntry>,
    capacity: usize,
}

impl KBucket {
    fn new(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
            capacity,
        }
    }

    fn add(&mut self, entry: RoutingEntry) -> bool {
        // 이미 존재하면 업데이트
        if let Some(existing) = self.entries.iter_mut().find(|e| e.node_id == entry.node_id) {
            existing.last_seen = entry.last_seen;
            existing.addr = entry.addr;
            return true;
        }

        // 공간이 있으면 추가
        if self.entries.len() < self.capacity {
            self.entries.push(entry);
            return true;
        }

        // 가장 오래된 노드 교체 (LRU)
        if let Some(oldest) = self.entries.iter_mut().min_by_key(|e| e.last_seen) {
            if oldest.last_seen.elapsed() > Duration::from_secs(300) {
                *oldest = entry;
                return true;
            }
        }

        false
    }

    fn get_closest(&self, target: &NodeId, count: usize) -> Vec<&RoutingEntry> {
        let mut sorted: Vec<_> = self.entries.iter().collect();
        sorted.sort_by_key(|e| xor_distance(&e.node_id, target));
        sorted.truncate(count);
        sorted
    }
}

/// XOR 거리 계산 (Kademlia 거리 메트릭)
fn xor_distance(a: &NodeId, b: &NodeId) -> [u8; 32] {
    let mut result = [0u8; 32];
    for i in 0..32 {
        result[i] = a[i] ^ b[i];
    }
    result
}

/// 버킷 인덱스 계산 (공통 prefix 길이)
fn bucket_index(local: &NodeId, remote: &NodeId) -> usize {
    let distance = xor_distance(local, remote);
    for (i, byte) in distance.iter().enumerate() {
        if *byte != 0 {
            return i * 8 + byte.leading_zeros() as usize;
        }
    }
    255 // 동일한 노드
}

/// DHT 메시지 타입
#[derive(Debug, Clone, Serialize, Deserialize)]
enum DhtMessage {
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
        nodes: Vec<(NodeId, SocketAddr)>, // 더 가까운 노드들
    },
    Announce {
        sender_id: NodeId,
        info_hash: InfoHash,
        port: u16,
    },
}

impl DhtMessage {
    fn serialize(&self) -> Vec<u8> {
        // 간단한 직렬화 (실제로는 bencode 또는 protobuf 사용)
        bincode::serialize(self).unwrap_or_default()
    }

    fn deserialize(data: &[u8]) -> Option<Self> {
        bincode::deserialize(data).ok()
    }
}

/// DHT 서비스
pub struct DhtService {
    /// 내 노드 ID
    node_id: NodeId,
    /// UDP 소켓
    socket: Arc<UdpSocket>,
    /// 라우팅 테이블 (256개 버킷)
    routing_table: Vec<KBucket>,
    /// 제공 중인 파일 목록
    providing: HashSet<InfoHash>,
    /// 알려진 제공자 캐시
    providers_cache: HashMap<InfoHash, Vec<(NodeId, SocketAddr, Instant)>>,
    /// 명령 수신
    command_rx: mpsc::Receiver<DhtCommand>,
    /// 이벤트 발송
    event_tx: mpsc::Sender<DhtEvent>,
    /// 실행 중 플래그
    running: Arc<RwLock<bool>>,
}

impl DhtService {
    pub async fn new(
        port: u16,
        command_rx: mpsc::Receiver<DhtCommand>,
        event_tx: mpsc::Sender<DhtEvent>,
    ) -> anyhow::Result<Self> {
        // 랜덤 노드 ID 생성
        let mut node_id = [0u8; 32];
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut node_id);

        // UDP 소켓 바인딩
        let socket = UdpSocket::bind(format!("0.0.0.0:{}", port)).await?;
        info!(
            "🌐 DHT 서비스 시작: {} (NodeID: {})",
            socket.local_addr()?,
            hex::encode(&node_id[..8])
        );

        // 라우팅 테이블 초기화 (256개 버킷, 각 버킷 최대 20개 노드)
        let routing_table: Vec<KBucket> = (0..256).map(|_| KBucket::new(20)).collect();

        Ok(Self {
            node_id,
            socket: Arc::new(socket),
            routing_table,
            providing: HashSet::new(),
            providers_cache: HashMap::new(),
            command_rx,
            event_tx,
            running: Arc::new(RwLock::new(true)),
        })
    }

    /// 메인 실행 루프
    pub async fn run(mut self) {
        info!("🌐 DHT 이벤트 루프 시작");

        let mut buf = vec![0u8; 65535];
        let mut refresh_interval = tokio::time::interval(Duration::from_secs(60));

        // Ready 이벤트 발송
        let _ = self.event_tx.send(DhtEvent::Ready).await;

        loop {
            tokio::select! {
                // 1. 외부 명령 처리
                cmd = self.command_rx.recv() => {
                    match cmd {
                        Some(DhtCommand::StartProviding { info_hash }) => {
                            self.start_providing(info_hash).await;
                        }
                        Some(DhtCommand::StopProviding { info_hash }) => {
                            self.providing.remove(&info_hash);
                        }
                        Some(DhtCommand::FindProviders { info_hash }) => {
                            self.find_providers(info_hash).await;
                        }
                        Some(DhtCommand::AddBootstrapNode { addr }) => {
                            self.bootstrap(addr).await;
                        }
                        Some(DhtCommand::AddPeer { node_id, addr }) => {
                            self.add_node(node_id, addr);
                        }
                        None => break,
                    }
                }

                // 2. UDP 메시지 수신
                result = self.socket.recv_from(&mut buf) => {
                    match result {
                        Ok((len, addr)) => {
                            if let Some(msg) = DhtMessage::deserialize(&buf[..len]) {
                                self.handle_message(msg, addr).await;
                            }
                        }
                        Err(e) => {
                            error!("❌ UDP 수신 에러: {}", e);
                        }
                    }
                }

                // 3. 주기적 라우팅 테이블 갱신
                _ = refresh_interval.tick() => {
                    self.refresh_routing_table().await;
                }
            }

            if !*self.running.read().await {
                break;
            }
        }

        info!("🌐 DHT 서비스 종료");
    }

    /// 부트스트랩 노드에 연결
    async fn bootstrap(&mut self, addr: SocketAddr) {
        info!("🔗 DHT 부트스트랩: {}", addr);

        // FindNode 요청 (자기 자신을 찾아서 가까운 노드들 수집)
        let msg = DhtMessage::FindNode {
            sender_id: self.node_id,
            target: self.node_id,
        };

        self.send_message(&msg, addr).await;
    }

    /// 노드 추가
    fn add_node(&mut self, node_id: NodeId, addr: SocketAddr) {
        let bucket_idx = bucket_index(&self.node_id, &node_id);
        if bucket_idx < self.routing_table.len() {
            let entry = RoutingEntry {
                node_id,
                addr,
                last_seen: Instant::now(),
                rtt_ms: None,
            };
            self.routing_table[bucket_idx].add(entry);
            debug!("➕ 노드 추가: {} @ {}", hex::encode(&node_id[..8]), addr);
        }
    }

    /// 파일 제공 시작
    async fn start_providing(&mut self, info_hash: InfoHash) {
        self.providing.insert(info_hash);
        info!("📢 파일 제공 시작: {}", hex::encode(&info_hash[..8]));

        // 가장 가까운 노드들에게 Announce
        let closest = self.find_closest_nodes(&info_hash, 8);
        let port = self.socket.local_addr().map(|a| a.port()).unwrap_or(0);

        for (_, addr) in closest {
            let msg = DhtMessage::Announce {
                sender_id: self.node_id,
                info_hash,
                port,
            };
            self.send_message(&msg, addr).await;
        }
    }

    /// 파일 제공자 찾기
    async fn find_providers(&mut self, info_hash: InfoHash) {
        info!("🔍 제공자 검색: {}", hex::encode(&info_hash[..8]));

        // 캐시 확인
        if let Some(providers) = self.providers_cache.get(&info_hash) {
            let valid: Vec<_> = providers
                .iter()
                .filter(|(_, _, t)| t.elapsed() < Duration::from_secs(300))
                .map(|(id, addr, _)| (*id, *addr))
                .collect();

            if !valid.is_empty() {
                let _ = self
                    .event_tx
                    .send(DhtEvent::ProvidersFound {
                        info_hash,
                        providers: valid,
                    })
                    .await;
                return;
            }
        }

        // 가장 가까운 노드들에게 GetProviders 요청
        let closest = self.find_closest_nodes(&info_hash, 8);

        for (_, addr) in closest {
            let msg = DhtMessage::GetProviders {
                sender_id: self.node_id,
                info_hash,
            };
            self.send_message(&msg, addr).await;
        }
    }

    /// 가장 가까운 노드 찾기
    fn find_closest_nodes(&self, target: &NodeId, count: usize) -> Vec<(NodeId, SocketAddr)> {
        let mut all_nodes: Vec<_> = self
            .routing_table
            .iter()
            .flat_map(|bucket| bucket.entries.iter())
            .map(|e| (e.node_id, e.addr, xor_distance(&e.node_id, target)))
            .collect();

        all_nodes.sort_by(|a, b| a.2.cmp(&b.2));
        all_nodes
            .into_iter()
            .take(count)
            .map(|(id, addr, _)| (id, addr))
            .collect()
    }

    /// 메시지 처리
    async fn handle_message(&mut self, msg: DhtMessage, from: SocketAddr) {
        match msg {
            DhtMessage::Ping { sender_id } => {
                self.add_node(sender_id, from);
                let response = DhtMessage::Pong {
                    sender_id: self.node_id,
                };
                self.send_message(&response, from).await;
            }

            DhtMessage::Pong { sender_id } => {
                self.add_node(sender_id, from);
            }

            DhtMessage::FindNode { sender_id, target } => {
                self.add_node(sender_id, from);
                let nodes = self.find_closest_nodes(&target, 8);
                let response = DhtMessage::FindNodeResponse {
                    sender_id: self.node_id,
                    nodes,
                };
                self.send_message(&response, from).await;
            }

            DhtMessage::FindNodeResponse { sender_id, nodes } => {
                self.add_node(sender_id, from);
                for (node_id, addr) in nodes {
                    self.add_node(node_id, addr);
                }
            }

            DhtMessage::GetProviders {
                sender_id,
                info_hash,
            } => {
                self.add_node(sender_id, from);

                // 내가 제공 중인지 확인
                let mut providers = Vec::new();
                if self.providing.contains(&info_hash) {
                    let port = self.socket.local_addr().map(|a| a.port()).unwrap_or(0);
                    providers.push((self.node_id, SocketAddr::new(from.ip(), port)));
                }

                // 캐시된 제공자 추가
                if let Some(cached) = self.providers_cache.get(&info_hash) {
                    for (id, addr, _) in cached {
                        providers.push((*id, *addr));
                    }
                }

                let nodes = self.find_closest_nodes(&info_hash, 8);

                let response = DhtMessage::GetProvidersResponse {
                    sender_id: self.node_id,
                    info_hash,
                    providers,
                    nodes,
                };
                self.send_message(&response, from).await;
            }

            DhtMessage::GetProvidersResponse {
                sender_id,
                info_hash,
                providers,
                nodes,
            } => {
                self.add_node(sender_id, from);

                // 노드 추가
                for (node_id, addr) in nodes {
                    self.add_node(node_id, addr);
                }

                // 제공자 캐시 및 이벤트 발송
                if !providers.is_empty() {
                    let now = Instant::now();
                    let cache_entry: Vec<_> = providers
                        .iter()
                        .map(|(id, addr)| (*id, *addr, now))
                        .collect();

                    self.providers_cache.insert(info_hash, cache_entry);

                    // 이벤트 발송
                    for (peer_id, addr) in &providers {
                        let _ = self
                            .event_tx
                            .send(DhtEvent::PeerFound {
                                info_hash,
                                peer_id: *peer_id,
                                addr: *addr,
                            })
                            .await;
                    }

                    let _ = self
                        .event_tx
                        .send(DhtEvent::ProvidersFound {
                            info_hash,
                            providers,
                        })
                        .await;
                }
            }

            DhtMessage::Announce {
                sender_id,
                info_hash,
                port,
            } => {
                self.add_node(sender_id, from);

                // 제공자 캐시에 추가
                let provider_addr = SocketAddr::new(from.ip(), port);
                let entry = self
                    .providers_cache
                    .entry(info_hash)
                    .or_insert_with(Vec::new);

                // 중복 제거
                entry.retain(|(id, _, _)| *id != sender_id);
                entry.push((sender_id, provider_addr, Instant::now()));

                debug!(
                    "📥 Announce 수신: {} provides {}",
                    hex::encode(&sender_id[..8]),
                    hex::encode(&info_hash[..8])
                );
            }
        }
    }

    /// 메시지 전송
    async fn send_message(&self, msg: &DhtMessage, to: SocketAddr) {
        let data = msg.serialize();
        if let Err(e) = self.socket.send_to(&data, to).await {
            warn!("❌ DHT 메시지 전송 실패: {} - {}", to, e);
        }
    }

    /// 라우팅 테이블 갱신
    async fn refresh_routing_table(&mut self) {
        debug!("🔄 라우팅 테이블 갱신");

        // 각 버킷에서 랜덤 노드에 Ping
        for bucket in &self.routing_table {
            if let Some(entry) = bucket.entries.first() {
                let msg = DhtMessage::Ping {
                    sender_id: self.node_id,
                };
                self.send_message(&msg, entry.addr).await;
            }
        }
    }

    /// 서비스 중지
    pub async fn stop(&self) {
        *self.running.write().await = false;
    }
}

/// DHT 서비스 핸들 (외부에서 명령 전송용)
pub struct DhtHandle {
    command_tx: mpsc::Sender<DhtCommand>,
}

impl DhtHandle {
    pub fn new(command_tx: mpsc::Sender<DhtCommand>) -> Self {
        Self { command_tx }
    }

    pub async fn start_providing(&self, info_hash: InfoHash) -> anyhow::Result<()> {
        self.command_tx
            .send(DhtCommand::StartProviding { info_hash })
            .await?;
        Ok(())
    }

    pub async fn find_providers(&self, info_hash: InfoHash) -> anyhow::Result<()> {
        self.command_tx
            .send(DhtCommand::FindProviders { info_hash })
            .await?;
        Ok(())
    }

    pub async fn add_bootstrap_node(&self, addr: SocketAddr) -> anyhow::Result<()> {
        self.command_tx
            .send(DhtCommand::AddBootstrapNode { addr })
            .await?;
        Ok(())
    }
}
