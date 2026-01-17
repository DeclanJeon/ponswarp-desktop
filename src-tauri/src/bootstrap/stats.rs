//! 통계 수집 및 HTTP API 서버

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

/// 통계 수집기
#[derive(Debug)]
pub struct StatsCollector {
    /// 시작 시간
    started_at: Option<Instant>,

    /// DHT 메시지 수신 수
    pub dht_messages_received: u64,

    /// DHT 메시지 전송 수
    pub dht_messages_sent: u64,

    /// 라우팅 테이블 노드 수
    pub nodes_in_routing_table: u64,

    /// 저장된 제공자 수
    pub providers_stored: u64,

    /// 릴레이 연결 수
    pub relay_connections: u64,

    /// 릴레이된 바이트 수
    pub bytes_relayed: u64,

    /// 활성 릴레이 세션 수
    pub active_relay_sessions: u64,
}

impl StatsCollector {
    pub fn new() -> Self {
        Self {
            started_at: Some(Instant::now()),
            dht_messages_received: 0,
            dht_messages_sent: 0,
            nodes_in_routing_table: 0,
            providers_stored: 0,
            relay_connections: 0,
            bytes_relayed: 0,
            active_relay_sessions: 0,
        }
    }

    pub fn uptime_secs(&self) -> u64 {
        self.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0)
    }

    pub fn reset(&mut self) {
        self.started_at = Some(Instant::now());
        self.dht_messages_received = 0;
        self.dht_messages_sent = 0;
        self.nodes_in_routing_table = 0;
        self.providers_stored = 0;
        self.relay_connections = 0;
        self.bytes_relayed = 0;
        self.active_relay_sessions = 0;
    }
}

impl Default for StatsCollector {
    fn default() -> Self {
        Self::new()
    }
}

/// DHT 통계
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DhtStats {
    pub nodes_in_routing_table: u64,
    pub providers_stored: u64,
    pub messages_received: u64,
    pub messages_sent: u64,
}

/// 릴레이 통계
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayStats {
    pub active_sessions: u64,
    pub total_connections: u64,
    pub bytes_relayed: u64,
}

/// HTTP 통계 API 응답 (standalone bootstrap과 호환)
#[derive(Serialize)]
struct StatsResponse {
    status: &'static str,
    uptime_secs: u64,
    dht: DhtStats,
    relay: RelayStats,
}

/// HTTP 통계 API 서버
pub struct StatsServer {
    listener: TcpListener,
    stats: Arc<RwLock<StatsCollector>>,
}

impl StatsServer {
    pub async fn new(port: u16, stats: Arc<RwLock<StatsCollector>>) -> anyhow::Result<Self> {
        // 여러 주소에 바인딩 시도 (localhost 연결 문제 해결)
        let addrs = [format!("127.0.0.1:{}", port), format!("0.0.0.0:{}", port)];

        let mut listener = None;
        let mut local_addr = None;

        for addr in &addrs {
            match TcpListener::bind(addr).await {
                Ok(l) => {
                    local_addr = Some(l.local_addr()?);
                    listener = Some(l);
                    info!(
                        "📊 통계 API 서버 시작: {} (바인딩 주소: {})",
                        local_addr.unwrap(),
                        addr
                    );
                    break;
                }
                Err(e) => {
                    warn!("{} 바인딩 실패: {}", addr, e);
                }
            }
        }

        let listener = listener.ok_or_else(|| anyhow::anyhow!("모든 주소에 바인딩 실패"))?;
        let local_addr = local_addr.unwrap();

        Ok(Self { listener, stats })
    }

    #[allow(dead_code)]
    pub fn local_addr(&self) -> anyhow::Result<std::net::SocketAddr> {
        Ok(self.listener.local_addr()?)
    }

    pub async fn run(self) {
        loop {
            match self.listener.accept().await {
                Ok((mut socket, _addr)) => {
                    let stats = self.stats.clone();

                    tauri::async_runtime::spawn(async move {
                        let mut buf = [0u8; 1024];

                        // HTTP 요청 읽기
                        if let Ok(n) = socket.read(&mut buf).await {
                            let request = String::from_utf8_lossy(&buf[..n]);

                            // 간단한 라우팅
                            let response = if request.contains("GET /stats")
                                || request.contains("GET / ")
                            {
                                let stats_guard = stats.read().await;

                                let response_body = StatsResponse {
                                    status: "ok",
                                    uptime_secs: stats_guard.uptime_secs(),
                                    dht: DhtStats {
                                        messages_received: stats_guard.dht_messages_received,
                                        messages_sent: stats_guard.dht_messages_sent,
                                        nodes_in_routing_table: stats_guard.nodes_in_routing_table,
                                        providers_stored: stats_guard.providers_stored,
                                    },
                                    relay: RelayStats {
                                        total_connections: stats_guard.relay_connections,
                                        active_sessions: stats_guard.active_relay_sessions,
                                        bytes_relayed: stats_guard.bytes_relayed,
                                    },
                                };

                                let body = serde_json::to_string_pretty(&response_body)
                                    .unwrap_or_default();

                                format!(
                                    "HTTP/1.1 200 OK\r\n\
                                    Content-Type: application/json\r\n\
                                    Content-Length: {}\r\n\
                                    Access-Control-Allow-Origin: *\r\n\
                                    \r\n\
                                    {}",
                                    body.len(),
                                    body
                                )
                            } else if request.contains("GET /health") {
                                "HTTP/1.1 200 OK\r\n\
                                Content-Type: text/plain\r\n\
                                Content-Length: 2\r\n\
                                \r\n\
                                OK"
                                .to_string()
                            } else {
                                "HTTP/1.1 404 Not Found\r\n\
                                Content-Type: text/plain\r\n\
                                Content-Length: 9\r\n\
                                \r\n\
                                Not Found"
                                    .to_string()
                            };

                            let _ = socket.write_all(response.as_bytes()).await;
                        }
                    });
                }
                Err(e) => {
                    error!("연결 수락 실패: {}", e);
                }
            }
        }
    }
}
