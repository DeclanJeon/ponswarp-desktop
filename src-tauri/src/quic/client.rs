use anyhow::Result;
use quinn::{ClientConfig, Endpoint};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::info;

use crate::protocol::Command;

pub struct QuicClient {
    endpoint: Option<Endpoint>,
}

impl QuicClient {
    pub fn new() -> Self {
        Self { endpoint: None }
    }
    
    pub async fn connect(&mut self, server_addr: SocketAddr, server_name: &str) -> Result<quinn::Connection> {
        let client_config = self.configure_client()?;
        
        let mut endpoint = Endpoint::client("0.0.0.0:0".parse()?)?;
        endpoint.set_default_client_config(client_config);
        
        info!("QUIC 연결 시도: {}", server_addr);
        
        let conn = endpoint.connect(server_addr, server_name)?.await?;
        
        info!("✅ QUIC 연결 성공: {}", server_addr);
        
        self.endpoint = Some(endpoint);
        
        Ok(conn)
    }
    
    pub async fn send_command(&self, conn: &quinn::Connection, cmd: Command) -> Result<Command> {
        let (mut send, mut recv) = conn.open_bi().await?;
        
        let cmd_bytes = cmd.to_bytes()?;
        send.write_all(&cmd_bytes).await?;
        send.finish()?;
        
        let response_bytes = recv.read_to_end(65536).await?;
        let response = Command::from_bytes(&response_bytes)?;
        
        Ok(response)
    }
    
    pub async fn ping(&self, conn: &quinn::Connection) -> Result<bool> {
        match self.send_command(conn, Command::Ping).await? {
            Command::Pong => Ok(true),
            _ => Ok(false),
        }
    }
    
    fn configure_client(&self) -> Result<ClientConfig> {
        let mut client_crypto = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipServerVerification))
            .with_no_client_auth();
        
        client_crypto.alpn_protocols = vec![b"ponswarp".to_vec()];
        
        let mut client_config = ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto)?
        ));
        
        // 🚀 [고속 전송] 클라이언트 transport 설정 - TB급 전송 최적화
        let mut transport_config = quinn::TransportConfig::default();
        
        // 멀티스트림 동시 전송을 위한 스트림 수 증가 (32개 동시 블록 전송)
        transport_config.max_concurrent_bidi_streams(128u32.into());
        transport_config.max_concurrent_uni_streams(64u32.into());
        transport_config.max_idle_timeout(Some(std::time::Duration::from_secs(120).try_into()?));
        
        // 윈도우 크기 대폭 증가 - 대역폭 포화를 위한 설정
        transport_config.receive_window((512 * 1024 * 1024u32).into());  // 512MB 연결당
        transport_config.stream_receive_window((64 * 1024 * 1024u32).into());  // 64MB per stream
        transport_config.send_window(256 * 1024 * 1024);  // 256MB 송신 윈도우
        
        // 데이터그램 크기 최적화
        transport_config.datagram_receive_buffer_size(Some(32 * 1024 * 1024));  // 32MB
        
        client_config.transport_config(Arc::new(transport_config));
        
        Ok(client_config)
    }
    
    pub fn disconnect(&mut self) {
        if let Some(endpoint) = self.endpoint.take() {
            endpoint.close(0u32.into(), b"disconnect");
            info!("QUIC 클라이언트 연결 해제");
        }
    }
}

impl Default for QuicClient {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
struct SkipServerVerification;

impl rustls::client::danger::ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
            rustls::SignatureScheme::ED25519,
        ]
    }
}
