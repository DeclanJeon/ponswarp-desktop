use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use serde::{Serialize, Deserialize};
use tracing::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeCapabilities {
    pub max_bandwidth_mbps: u64,
    pub available_bandwidth_mbps: u64,
    pub cpu_cores: u32,
    pub can_relay: bool,
}

impl Default for NodeCapabilities {
    fn default() -> Self {
        Self {
            max_bandwidth_mbps: 10000,
            available_bandwidth_mbps: 8000,
            cpu_cores: num_cpus::get() as u32,
            can_relay: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PeerNode {
    pub id: String,
    pub address: SocketAddr,
    pub capabilities: NodeCapabilities,
    pub last_seen: Instant,
    pub latency_ms: u32,
    pub active_streams: u32,
}

impl PeerNode {
    pub fn new(id: String, address: SocketAddr) -> Self {
        Self {
            id,
            address,
            capabilities: NodeCapabilities::default(),
            last_seen: Instant::now(),
            latency_ms: 0,
            active_streams: 0,
        }
    }

    pub fn score(&self) -> i64 {
        let bandwidth_score = self.capabilities.available_bandwidth_mbps as i64;
        let latency_penalty = self.latency_ms as i64;
        let load_penalty = self.active_streams as i64 * 100;
        
        bandwidth_score - latency_penalty - load_penalty
    }

    pub fn is_stale(&self, timeout_secs: u64) -> bool {
        self.last_seen.elapsed().as_secs() > timeout_secs
    }
}

#[derive(Clone)]
pub struct NodeRegistry {
    nodes: Arc<RwLock<HashMap<String, PeerNode>>>,
    local_id: Arc<RwLock<Option<String>>>,
}

impl NodeRegistry {
    pub fn new() -> Self {
        Self {
            nodes: Arc::new(RwLock::new(HashMap::new())),
            local_id: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_local_id(&self, id: String) {
        let mut local_id = self.local_id.write().await;
        *local_id = Some(id);
    }

    pub async fn get_local_id(&self) -> Option<String> {
        self.local_id.read().await.clone()
    }

    pub async fn add_node(&self, node: PeerNode) {
        let local_id = self.local_id.read().await;
        if local_id.as_ref() == Some(&node.id) {
            return;
        }
        
        let mut nodes = self.nodes.write().await;
        info!("📡 노드 추가: {} @ {}", node.id, node.address);
        nodes.insert(node.id.clone(), node);
    }

    pub async fn update_node(&self, node_id: &str, update_fn: impl FnOnce(&mut PeerNode)) {
        let mut nodes = self.nodes.write().await;
        if let Some(node) = nodes.get_mut(node_id) {
            update_fn(node);
        }
    }

    pub async fn remove_node(&self, node_id: &str) {
        let mut nodes = self.nodes.write().await;
        if nodes.remove(node_id).is_some() {
            info!("👋 노드 제거: {}", node_id);
        }
    }

    pub async fn get_node(&self, node_id: &str) -> Option<PeerNode> {
        let nodes = self.nodes.read().await;
        nodes.get(node_id).cloned()
    }

    pub async fn get_all_nodes(&self) -> Vec<PeerNode> {
        let nodes = self.nodes.read().await;
        nodes.values().cloned().collect()
    }

    pub async fn get_relay_candidates(&self) -> Vec<PeerNode> {
        let nodes = self.nodes.read().await;
        let mut candidates: Vec<_> = nodes.values()
            .filter(|n| n.capabilities.can_relay && n.capabilities.available_bandwidth_mbps > 1000)
            .filter(|n| !n.is_stale(30))
            .cloned()
            .collect();
        
        candidates.sort_by(|a, b| b.score().cmp(&a.score()));
        candidates
    }

    pub async fn get_best_paths(&self, count: usize) -> Vec<PeerNode> {
        let mut candidates = self.get_relay_candidates().await;
        candidates.truncate(count);
        candidates
    }

    pub async fn cleanup_stale_nodes(&self, timeout_secs: u64) {
        let mut nodes = self.nodes.write().await;
        let stale_ids: Vec<_> = nodes.iter()
            .filter(|(_, n)| n.is_stale(timeout_secs))
            .map(|(id, _)| id.clone())
            .collect();
        
        for id in stale_ids {
            info!("🗑️ 오래된 노드 정리: {}", id);
            nodes.remove(&id);
        }
    }

    pub async fn node_count(&self) -> usize {
        self.nodes.read().await.len()
    }
}

impl Default for NodeRegistry {
    fn default() -> Self {
        Self::new()
    }
}
