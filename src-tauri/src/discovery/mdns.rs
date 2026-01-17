use anyhow::Result;
use dashmap::DashMap;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::protocol::PeerCapabilities;

const SERVICE_TYPE: &str = "_ponswarp._tcp.local.";

#[derive(Debug, Clone)]
pub struct PeerNode {
    pub id: String,
    pub address: SocketAddr,
    pub capabilities: PeerCapabilities,
    pub last_seen: Instant,
}

pub struct DiscoveryService {
    daemon: ServiceDaemon,
    node_id: String,
    port: u16,
    peers: Arc<DashMap<String, PeerNode>>,
    running: Arc<RwLock<bool>>,
}

impl DiscoveryService {
    pub fn new(node_id: String, port: u16) -> Result<Self> {
        let daemon =
            ServiceDaemon::new().map_err(|e| anyhow::anyhow!("mDNS 데몬 생성 실패: {}", e))?;

        Ok(Self {
            daemon,
            node_id,
            port,
            peers: Arc::new(DashMap::new()),
            running: Arc::new(RwLock::new(false)),
        })
    }

    pub fn register(&self) -> Result<()> {
        use std::net::IpAddr;

        // 로컬 IP 주소 자동 감지 (루프백은 광고하지 않음)
        let mut local_ips: Vec<IpAddr> = Vec::new();

        if let Some(ip) = Self::get_ip_via_udp_probe() {
            local_ips.push(ip);
        }

        if local_ips.is_empty() {
            if let Some(ip_str) = self.get_local_ip() {
                if let Ok(ip) = ip_str.parse::<IpAddr>() {
                    if !ip.is_loopback() {
                        local_ips.push(ip);
                    }
                }
            }
        }

        // host_name은 IP를 넣지 말고 고정된 로컬 호스트명을 사용
        let host_name = "ponswarp.local.";

        // mDNS 인스턴스 이름은 15바이트로 제한됨
        // node_id가 긴 경우, 처음 15바이트만 사용하거나 해시값의 일부를 사용
        let instance_name = if self.node_id.len() <= 15 {
            self.node_id.clone()
        } else {
            // node_id가 15바이트를 초과하는 경우, SHA256 해시의 처음 4바이트를 hex 인코딩하여 사용
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(self.node_id.as_bytes());
            let hash = hasher.finalize();
            let hash_short = hex::encode(&hash[..2]); // 2바이트 = 4자리 hex
            format!("pswp-{}", hash_short) // "pswp-" (5바이트) + hash_short (4바이트) = 9바이트
        };

        // 🆕 [수정] TXT 레코드에 추가 정보 포함
        let mut txt_record = std::collections::HashMap::new();
        txt_record.insert("node_id".to_string(), self.node_id.clone());
        txt_record.insert("port".to_string(), self.port.to_string());
        txt_record.insert("version".to_string(), "1.0".to_string());

        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &instance_name,
            host_name,
            local_ips.as_slice(),
            self.port,
            Some(txt_record),
        )
        .map_err(|e| anyhow::anyhow!("서비스 정보 생성 실패: {}", e))?;

        self.daemon
            .register(service)
            .map_err(|e| anyhow::anyhow!("mDNS 등록 실패: {}", e))?;

        info!(
            "📡 mDNS 등록: {} (원본: {}) @ {}:{}, IPs: {:?}",
            instance_name, self.node_id, host_name, self.port, local_ips
        );

        Ok(())
    }

    /// UDP 프로브로 기본 로컬 IP 감지 (플랫폼/패키징에 덜 의존)
    fn get_ip_via_udp_probe() -> Option<std::net::IpAddr> {
        use std::net::UdpSocket;

        let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect("1.1.1.1:80").ok()?;
        let ip = socket.local_addr().ok()?.ip();
        if ip.is_loopback() {
            None
        } else {
            Some(ip)
        }
    }

    /// 로컬 IP 주소 자동 감지 (커맨드 기반 fallback)
    fn get_local_ip(&self) -> Option<String> {
        use std::net::IpAddr;
        use std::process::Command;

        // 여러 방법으로 로컬 IP 주소 시도
        // 1. hostname -I 시도
        if let Ok(output) = Command::new("hostname").args(&["-I"]).output() {
            if let Ok(ip_str) = String::from_utf8(output.stdout) {
                if let Some(first_ip) = ip_str.trim().split_whitespace().next() {
                    if first_ip.parse::<IpAddr>().is_ok() {
                        info!("🔍 [DEBUG] hostname -I 결과: {}", first_ip);
                        return Some(first_ip.to_string());
                    }
                }
            }
        }

        // 2. ip route get 1.1.1.1 시도 (더 정확한 로컬 IP)
        if let Ok(output) = Command::new("ip")
            .args(&["route", "get", "1.1.1.1"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                if line.contains("src") {
                    if let Some(ip_part) = line.split("src").nth(1) {
                        if let Some(ip_str) = ip_part.trim().split_whitespace().next() {
                            if ip_str.parse::<IpAddr>().is_ok() {
                                info!("🔍 [DEBUG] ip route 결과: {}", ip_str);
                                return Some(ip_str.to_string());
                            }
                        }
                    }
                }
            }
        }

        // 3. ifconfig 시도 (fallback)
        if let Ok(output) = Command::new("ifconfig").output() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                if line.contains("inet ") && !line.contains("127.0.0.1") {
                    if let Some(inet_part) = line.split("inet ").nth(1) {
                        if let Some(ip_str) = inet_part.split_whitespace().next() {
                            if let Some(clean_ip) = ip_str.split(':').last() {
                                if clean_ip.parse::<IpAddr>().is_ok() {
                                    info!("🔍 [DEBUG] ifconfig 결과: {}", clean_ip);
                                    return Some(clean_ip.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        warn!("⚠️ [DEBUG] 로컬 IP 감지 실패");
        None
    }

    pub async fn start_browsing(&self) -> Result<()> {
        let receiver = self
            .daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| anyhow::anyhow!("mDNS 브라우징 시작 실패: {}", e))?;

        *self.running.write().await = true;

        let peers = self.peers.clone();
        let running = self.running.clone();
        let node_id = self.node_id.clone();

        tauri::async_runtime::spawn(async move {
            info!("🔍 mDNS 피어 발견 시작...");

            while *running.read().await {
                match receiver.recv_timeout(std::time::Duration::from_secs(1)) {
                    Ok(event) => match event {
                        ServiceEvent::ServiceResolved(info) => {
                            let peer_id = info.get_fullname().to_string();
                            info!("🔍 [DEBUG] mDNS ServiceResolved event for: {}", peer_id);

                            if peer_id.contains(&node_id) {
                                info!("🔍 [DEBUG] Skipping self peer: {}", peer_id);
                                continue;
                            }

                            let addrs = info.get_addresses();
                            info!("🔍 [DEBUG] Resolved addresses for {}: {:?}", peer_id, addrs);

                            // 🆕 [수정] 여러 주소 중에서 로컬 네트워크 주소 우선 선택
                            let selected_addr =
                                Self::select_best_address_static(&addrs, info.get_port());

                            if let Some(socket_addr) = selected_addr {
                                info!(
                                    "🔍 [DEBUG] Selected address: {} for peer {}",
                                    socket_addr, peer_id
                                );

                                // TXT 레코드 처리
                                let mut capabilities = PeerCapabilities {
                                    max_bandwidth_mbps: 10000,
                                    available_bandwidth_mbps: 8000,
                                    cpu_cores: num_cpus::get() as u32,
                                    can_relay: true,
                                };

                                let txt = info.get_properties();
                                if let Some(version) = txt.get("version") {
                                    info!("🔍 [DEBUG] Peer version: {}", version);
                                }

                                let peer = PeerNode {
                                    id: peer_id.clone(),
                                    address: socket_addr,
                                    capabilities,
                                    last_seen: Instant::now(),
                                };

                                info!("🔗 [SUCCESS] 피어 발견: {} @ {}", peer_id, socket_addr);
                                peers.insert(peer_id, peer);
                            } else {
                                warn!("⚠️ [DEBUG] No valid addresses found for peer: {} (addrs: {:?})", peer_id, addrs);
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, name) => {
                            info!("👋 피어 제거: {}", name);
                            peers.remove(&name);
                        }
                        _ => {}
                    },
                    Err(flume::RecvTimeoutError::Timeout) => {
                        continue;
                    }
                    Err(e) => {
                        warn!("mDNS 수신 오류: {}", e);
                        break;
                    }
                }
            }

            info!("mDNS 브라우징 종료");
        });

        Ok(())
    }

    pub fn get_peers(&self) -> Vec<PeerNode> {
        self.peers
            .iter()
            .map(|entry| entry.value().clone())
            .collect()
    }

    pub fn get_peer_count(&self) -> usize {
        self.peers.len()
    }

    pub async fn stop(&self) {
        *self.running.write().await = false;
        info!("mDNS 서비스 중지");
    }

    /// 🆕 여러 주소 중에서 최적의 주소 선택
    fn select_best_address_static(
        addrs: &std::collections::HashSet<std::net::IpAddr>,
        port: u16,
    ) -> Option<SocketAddr> {
        use std::net::IpAddr;

        // 우선순위: 사설 IP > 공인 IP > 로컬호스트
        let mut best_addr: Option<IpAddr> = None;
        let mut best_score = -1;

        for &addr in addrs {
            let score = match addr {
                IpAddr::V4(ipv4) => {
                    if ipv4.is_loopback() {
                        0 // 로컬호스트 (가장 낮은 우선순위)
                    } else if ipv4.is_private() {
                        100 // 사설 IP (가장 높은 우선순위)
                    } else {
                        50 // 공인 IP (중간 우선순위)
                    }
                }
                IpAddr::V6(_) => {
                    if addr.is_loopback() {
                        0
                    } else {
                        25 // IPv6은 낮은 우선순위
                    }
                }
            };

            if score > best_score {
                best_score = score;
                best_addr = Some(addr);
            }
        }

        best_addr.map(|addr| SocketAddr::new(addr, port))
    }
}
