use anyhow::Result;
use quinn::{Endpoint, ServerConfig};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::protocol::Command;

/// 서버에서 수락한 연결 정보
#[derive(Debug, Clone)]
pub struct AcceptedConnection {
    pub peer_addr: SocketAddr,
    pub connection: quinn::Connection,
}

pub struct QuicServer {
    endpoint: Option<Endpoint>,
    bind_addr: SocketAddr,
    /// 수락된 연결을 외부로 전달하는 채널
    connection_tx: Option<mpsc::Sender<AcceptedConnection>>,
    connection_rx: Option<mpsc::Receiver<AcceptedConnection>>,
}

impl QuicServer {
    pub fn new(bind_addr: SocketAddr) -> Self {
        let (tx, rx) = mpsc::channel(16);
        Self {
            endpoint: None,
            bind_addr,
            connection_tx: Some(tx),
            connection_rx: Some(rx),
        }
    }
    
    /// 수락된 연결을 받는 채널 (Sender가 파일 전송에 사용)
    pub fn take_connection_receiver(&mut self) -> Option<mpsc::Receiver<AcceptedConnection>> {
        self.connection_rx.take()
    }
    
    pub async fn start(&mut self) -> Result<()> {
        let server_config = self.configure_server()?;
        let endpoint = Endpoint::server(server_config, self.bind_addr)?;
        
        info!("🚀 QUIC 서버 시작: {}", self.bind_addr);
        
        self.endpoint = Some(endpoint.clone());
        
        let conn_tx = self.connection_tx.clone();
        tauri::async_runtime::spawn(async move {
            Self::accept_connections(endpoint, conn_tx).await;
        });
        
        Ok(())
    }
    
    async fn accept_connections(endpoint: Endpoint, conn_tx: Option<mpsc::Sender<AcceptedConnection>>) {
        while let Some(incoming) = endpoint.accept().await {
            let conn_tx = conn_tx.clone();
            tauri::async_runtime::spawn(async move {
                match incoming.await {
                    Ok(conn) => {
                        let peer_addr = conn.remote_address();
                        info!("✅ 새 QUIC 연결 수락: {}", peer_addr);
                        
                        // 연결을 외부로 전달 (파일 전송용)
                        if let Some(tx) = conn_tx {
                            let accepted = AcceptedConnection {
                                peer_addr,
                                connection: conn.clone(),
                            };
                            if let Err(e) = tx.send(accepted).await {
                                warn!("연결 전달 실패: {}", e);
                            }
                        }
                        
                        // 기본 명령 처리 (Ping/Pong 등)
                        Self::handle_connection(conn).await;
                    }
                    Err(e) => {
                        warn!("연결 실패: {}", e);
                    }
                }
            });
        }
    }
    
    async fn handle_connection(conn: quinn::Connection) {
        loop {
            match conn.accept_bi().await {
                Ok((mut send, mut recv)) => {
                    let data = match recv.read_to_end(65536).await {
                        Ok(d) => d,
                        Err(e) => {
                            warn!("읽기 오류: {}", e);
                            break;
                        }
                    };
                    
                    // 빈 데이터면 파일 전송 스트림일 수 있음 - 무시
                    if data.is_empty() {
                        continue;
                    }
                    
                    match Command::from_bytes(&data) {
                        Ok(cmd) => {
                            info!("수신: {:?}", cmd);
                            
                            let response = match cmd {
                                Command::Ping => Command::Pong,
                                Command::DiscoverPeers => Command::PeerList { peers: vec![] },
                                _ => Command::Error {
                                    job_id: String::new(),
                                    code: "NOT_IMPLEMENTED".to_string(),
                                    message: "Not yet implemented".to_string(),
                                },
                            };
                            
                            if let Ok(resp_bytes) = response.to_bytes() {
                                let _ = send.write_all(&resp_bytes).await;
                                let _ = send.finish();
                            }
                        }
                        Err(e) => {
                            warn!("명령 파싱 오류: {}", e);
                        }
                    }
                }
                Err(quinn::ConnectionError::ApplicationClosed(_)) => {
                    info!("연결 종료 (정상)");
                    break;
                }
                Err(e) => {
                    warn!("스트림 수락 오류: {}", e);
                    break;
                }
            }
        }
    }
    
    fn configure_server(&self) -> Result<ServerConfig> {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into(), "ponswarp.local".into()])?;
        let cert_der = cert.cert.der().to_vec();
        let priv_key = cert.key_pair.serialize_der();
        
        let cert_chain = vec![rustls::pki_types::CertificateDer::from(cert_der)];
        let priv_key = rustls::pki_types::PrivatePkcs8KeyDer::from(priv_key).into();
        
        let mut server_crypto = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(cert_chain, priv_key)?;
        
        server_crypto.alpn_protocols = vec![b"ponswarp".to_vec()];
        
        let mut server_config = ServerConfig::with_crypto(Arc::new(
            quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto)?
        ));
        
        let transport_config = Arc::get_mut(&mut server_config.transport).unwrap();
        
        // 🚀 [고속 전송] TB급 전송을 위한 멀티스트림 최적화
        // - 32개 동시 블록 전송 지원 (8MB 블록 × 32 = 256MB 동시 전송)
        transport_config.max_concurrent_bidi_streams(128u32.into());
        transport_config.max_concurrent_uni_streams(64u32.into());
        transport_config.max_idle_timeout(Some(std::time::Duration::from_secs(120).try_into()?));
        
        // 윈도우 크기 대폭 증가 - Head-of-Line Blocking 방지
        // - receive_window: 연결당 최대 수신 버퍼 (512MB)
        // - stream_receive_window: 스트림당 최대 수신 버퍼 (64MB)
        // - send_window: 송신 윈도우 (256MB)
        transport_config.receive_window((512 * 1024 * 1024u32).into());  // 512MB
        transport_config.stream_receive_window((64 * 1024 * 1024u32).into());  // 64MB per stream
        transport_config.send_window(256 * 1024 * 1024);  // 256MB
        
        // 데이터그램 버퍼 크기
        transport_config.datagram_receive_buffer_size(Some(32 * 1024 * 1024));  // 32MB
        
        Ok(server_config)
    }
    
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.endpoint.as_ref().map(|e| e.local_addr().ok()).flatten()
    }
    
    pub async fn shutdown(&mut self) {
        if let Some(endpoint) = self.endpoint.take() {
            endpoint.close(0u32.into(), b"shutdown");
            info!("QUIC 서버 종료");
        }
    }
}
