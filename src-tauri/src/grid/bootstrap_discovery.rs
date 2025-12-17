//! Bootstrap Discovery - 부트스트랩 노드 자동 발견
//!
//! mDNS를 사용하여 사내망의 부트스트랩 노드를 자동으로 발견합니다.
//! 수동 설정 없이도 Grid 네트워크에 참여할 수 있습니다.

use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};

/// 부트스트랩 노드 mDNS 서비스 타입
const BOOTSTRAP_SERVICE_TYPE: &str = "_pswp._udp.local.";

/// 발견된 부트스트랩 노드 정보
#[derive(Debug, Clone)]
pub struct BootstrapNode {
    pub id: String,
    pub address: SocketAddr,
    pub discovered_at: Instant,
    pub last_seen: Instant,
}

/// 부트스트랩 발견 이벤트
#[derive(Debug, Clone)]
pub enum BootstrapDiscoveryEvent {
    /// 새 부트스트랩 노드 발견
    NodeDiscovered(BootstrapNode),
    /// 부트스트랩 노드 사라짐
    NodeLost(String),
}

/// 부트스트랩 노드 자동 발견 서비스
pub struct BootstrapDiscovery {
    daemon: ServiceDaemon,
    nodes: Arc<RwLock<HashMap<String, BootstrapNode>>>,
    event_tx: mpsc::Sender<BootstrapDiscoveryEvent>,
    running: Arc<RwLock<bool>>,
}

impl BootstrapDiscovery {
    pub fn new(event_tx: mpsc::Sender<BootstrapDiscoveryEvent>) -> anyhow::Result<Self> {
        let daemon = ServiceDaemon::new()
            .map_err(|e| anyhow::anyhow!("mDNS 데몬 생성 실패: {}", e))?;

        Ok(Self {
            daemon,
            nodes: Arc::new(RwLock::new(HashMap::new())),
            event_tx,
            running: Arc::new(RwLock::new(false)),
        })
    }

    /// 부트스트랩 노드 검색 시작
    pub async fn start(&self) -> anyhow::Result<()> {
        let receiver = self
            .daemon
            .browse(BOOTSTRAP_SERVICE_TYPE)
            .map_err(|e| anyhow::anyhow!("mDNS 브라우징 시작 실패: {}", e))?;

        *self.running.write().await = true;

        let nodes = self.nodes.clone();
        let running = self.running.clone();
        let event_tx = self.event_tx.clone();

        tauri::async_runtime::spawn(async move {
            info!("🔍 부트스트랩 노드 자동 발견 시작...");

            while *running.read().await {
                match receiver.recv_timeout(Duration::from_secs(1)) {
                    Ok(event) => match event {
                        ServiceEvent::ServiceResolved(info) => {
                            let node_id = info.get_fullname().to_string();

                            if let Some(addr) = info.get_addresses().iter().next() {
                                let socket_addr = SocketAddr::new(*addr, info.get_port());
                                let now = Instant::now();

                                let node = BootstrapNode {
                                    id: node_id.clone(),
                                    address: socket_addr,
                                    discovered_at: now,
                                    last_seen: now,
                                };

                                let mut nodes_guard = nodes.write().await;
                                let is_new = !nodes_guard.contains_key(&node_id);
                                nodes_guard.insert(node_id.clone(), node.clone());
                                drop(nodes_guard);

                                if is_new {
                                    info!(
                                        "🎯 부트스트랩 노드 발견: {} @ {}",
                                        node_id, socket_addr
                                    );
                                    let _ = event_tx
                                        .send(BootstrapDiscoveryEvent::NodeDiscovered(node))
                                        .await;
                                }
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, name) => {
                            let mut nodes_guard = nodes.write().await;
                            if nodes_guard.remove(&name).is_some() {
                                info!("👋 부트스트랩 노드 사라짐: {}", name);
                                let _ = event_tx
                                    .send(BootstrapDiscoveryEvent::NodeLost(name))
                                    .await;
                            }
                        }
                        _ => {}
                    },
                    Err(flume::RecvTimeoutError::Timeout) => continue,
                    Err(e) => {
                        warn!("mDNS 수신 오류: {}", e);
                        break;
                    }
                }
            }

            info!("🔍 부트스트랩 노드 발견 종료");
        });

        Ok(())
    }

    /// 발견된 부트스트랩 노드 목록
    pub async fn get_nodes(&self) -> Vec<BootstrapNode> {
        self.nodes.read().await.values().cloned().collect()
    }

    /// 발견된 부트스트랩 노드 주소 목록
    pub async fn get_addresses(&self) -> Vec<SocketAddr> {
        self.nodes
            .read()
            .await
            .values()
            .map(|n| n.address)
            .collect()
    }

    /// 발견된 노드 수
    pub async fn node_count(&self) -> usize {
        self.nodes.read().await.len()
    }

    /// 검색 중지
    pub async fn stop(&self) {
        *self.running.write().await = false;
        info!("부트스트랩 노드 발견 중지");
    }
}

/// 부트스트랩 노드 자동 연결 헬퍼
pub struct AutoBootstrap {
    discovery: BootstrapDiscovery,
    event_rx: mpsc::Receiver<BootstrapDiscoveryEvent>,
    connected_nodes: Arc<RwLock<Vec<SocketAddr>>>,
}

impl AutoBootstrap {
    pub fn new() -> anyhow::Result<Self> {
        let (event_tx, event_rx) = mpsc::channel(32);
        let discovery = BootstrapDiscovery::new(event_tx)?;

        Ok(Self {
            discovery,
            event_rx,
            connected_nodes: Arc::new(RwLock::new(Vec::new())),
        })
    }

    /// 자동 발견 및 연결 시작
    pub async fn start(&mut self) -> anyhow::Result<Vec<SocketAddr>> {
        self.discovery.start().await?;

        // 잠시 대기하여 부트스트랩 노드 발견
        tokio::time::sleep(Duration::from_secs(2)).await;

        let nodes = self.discovery.get_addresses().await;
        info!("🎯 {} 개의 부트스트랩 노드 발견", nodes.len());

        Ok(nodes)
    }

    /// 발견된 노드 목록 반환
    pub async fn get_discovered_nodes(&self) -> Vec<SocketAddr> {
        self.discovery.get_addresses().await
    }

    /// 이벤트 수신 (새 노드 발견 시 알림)
    pub async fn recv_event(&mut self) -> Option<BootstrapDiscoveryEvent> {
        self.event_rx.recv().await
    }

    /// 중지
    pub async fn stop(&self) {
        self.discovery.stop().await;
    }
}

impl Default for AutoBootstrap {
    fn default() -> Self {
        Self::new().expect("AutoBootstrap 생성 실패")
    }
}
