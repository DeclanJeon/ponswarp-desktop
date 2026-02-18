use std::net::{Ipv4Addr, SocketAddr};

#[derive(Debug, Clone)]
pub struct StunClient {
    server_addr: SocketAddr,
}

#[derive(Debug, Clone)]
pub struct StunDiscoveryResult {
    pub public_addr: Ipv4Addr,
    pub public_port: u16,
    pub nat_type: NatType,
    pub local_addr: SocketAddr,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NatType {
    Open,
    FullCone,
    RestrictedCone,
    Symmetric,
    Unknown,
}

impl StunClient {
    pub fn new(server_addr: SocketAddr) -> Self {
        Self { server_addr }
    }

    pub fn get_server_addr(&self) -> SocketAddr {
        self.server_addr
    }

    pub async fn discover_public_ip(
        &self,
        _turn_socket: Option<std::sync::Arc<tokio::net::UdpSocket>>,
    ) -> Result<StunDiscoveryResult, String> {
        Ok(StunDiscoveryResult {
            public_addr: Ipv4Addr::new(127, 0, 0, 1),
            public_port: self.server_addr.port(),
            nat_type: NatType::Unknown,
            local_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
        })
    }
}
