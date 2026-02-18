//! QUIC 릴레이 서버 (ponswarp-bootstrap에서 포팅)
//!
//! NAT 환경에서 직접 연결이 불가능한 피어들을 위한 릴레이 서비스를 제공합니다.

use super::stats::StatsCollector;
use dashmap::DashMap;
use quinn::{Endpoint, ServerConfig};
use rcgen::generate_simple_self_signed;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// 릴레이 세션 정보
#[derive(Debug, Clone)]
struct RelaySession {
    peer_a: SocketAddr,
    peer_b: Option<SocketAddr>,
    created_at: Instant,
    bytes_relayed: u64,
}

/// QUIC 릴레이 서버
pub struct RelayServer {
    endpoint: Endpoint,
    sessions: DashMap<String, RelaySession>,
    stats: Arc<RwLock<StatsCollector>>,
    max_sessions: usize,
}

impl RelayServer {
    pub async fn new(
        port: u16,
        stats: Arc<RwLock<StatsCollector>>,
        max_sessions: usize,
    ) -> anyhow::Result<Self> {
        let (server_config, _cert) = Self::generate_server_config()?;

        let endpoint = Endpoint::server(server_config, format!("0.0.0.0:{}", port).parse()?)?;
        let local_addr = endpoint.local_addr()?;

        info!("🔄 QUIC 릴레이 서버 시작: {}", local_addr);

        Ok(Self {
            endpoint,
            sessions: DashMap::new(),
            stats,
            max_sessions,
        })
    }

    fn generate_server_config() -> anyhow::Result<(ServerConfig, Vec<u8>)> {
        let subject_alt_names = vec!["localhost".to_string(), "ponswarp-relay".to_string()];
        let cert = generate_simple_self_signed(subject_alt_names)?;

        let cert_der = cert.cert.der().to_vec();
        let key_der = cert.key_pair.serialize_der();

        let cert_chain = vec![CertificateDer::from(cert_der.clone())];
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der));

        let mut server_crypto = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(cert_chain, key)?;

        server_crypto.alpn_protocols = vec![b"ponswarp-relay".to_vec()];

        let mut server_config = ServerConfig::with_crypto(Arc::new(
            quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto)?,
        ));

        let transport_config = Arc::get_mut(&mut server_config.transport)
            .ok_or_else(|| anyhow::anyhow!("failed to get mutable transport config"))?;
        transport_config.max_idle_timeout(Some(Duration::from_secs(300).try_into()?));

        Ok((server_config, cert_der))
    }

    pub fn local_addr(&self) -> anyhow::Result<SocketAddr> {
        Ok(self.endpoint.local_addr()?)
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_at_capacity(&self) -> bool {
        self.sessions.len() >= self.max_sessions
    }

    pub async fn run(self) {
        let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));

        loop {
            tokio::select! {
                // 새 연결 수락
                Some(incoming) = self.endpoint.accept() => {
                    // 용량 체크
                    if self.is_at_capacity() {
                        warn!("최대 세션 수 초과 ({}), 연결 거부", self.max_sessions);
                        continue;
                    }

                    let sessions = self.sessions.clone();
                    let stats = self.stats.clone();

                    tauri::async_runtime::spawn(async move {
                        match incoming.await {
                            Ok(connection) => {
                                let addr = connection.remote_address();
                                info!("📥 릴레이 연결: {}", addr);

                                let mut stats_guard = stats.write().await;
                                stats_guard.relay_connections += 1;
                                stats_guard.active_relay_sessions += 1;
                                drop(stats_guard);

                                Self::handle_connection(connection, sessions, stats).await;
                            }
                            Err(e) => {
                                error!("연결 수락 실패: {}", e);
                            }
                        }
                    });
                }

                // 주기적 세션 정리
                _ = cleanup_interval.tick() => {
                    self.cleanup_stale_sessions().await;
                }
            }
        }
    }

    async fn handle_connection(
        connection: quinn::Connection,
        sessions: DashMap<String, RelaySession>,
        stats: Arc<RwLock<StatsCollector>>,
    ) {
        let addr = connection.remote_address();

        loop {
            match connection.accept_bi().await {
                Ok((mut send, mut recv)) => {
                    let sessions = sessions.clone();
                    let stats = stats.clone();

                    tauri::async_runtime::spawn(async move {
                        let mut buf = vec![0u8; 65536];

                        // 첫 메시지: 릴레이 요청 (대상 세션 ID)
                        match recv.read(&mut buf).await {
                            Ok(Some(n)) => {
                                let session_id = String::from_utf8_lossy(&buf[..n]).to_string();
                                debug!("릴레이 요청: {} -> {}", addr, session_id);

                                // 세션 처리 로직
                                // 실제 구현에서는 두 피어를 연결하여 데이터 릴레이
                                // 현재는 기본 구조만 구현
                            }
                            Ok(None) => {}
                            Err(e) => {
                                error!("스트림 읽기 실패: {}", e);
                            }
                        }
                    });
                }
                Err(quinn::ConnectionError::ApplicationClosed(_)) => {
                    info!("📴 릴레이 연결 종료: {}", addr);

                    // 세션 카운트 감소
                    let mut stats_guard = stats.write().await;
                    stats_guard.active_relay_sessions =
                        stats_guard.active_relay_sessions.saturating_sub(1);

                    break;
                }
                Err(e) => {
                    error!("스트림 수락 실패: {}", e);
                    break;
                }
            }
        }
    }

    async fn cleanup_stale_sessions(&self) {
        let timeout = Duration::from_secs(300);
        let before_count = self.sessions.len();

        self.sessions
            .retain(|_, session| session.created_at.elapsed() < timeout);

        let removed = before_count - self.sessions.len();
        if removed > 0 {
            debug!(
                "🧹 릴레이 세션 정리: {} 제거, {} 활성",
                removed,
                self.sessions.len()
            );
        }
    }
}
