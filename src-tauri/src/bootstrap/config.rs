//! Bootstrap 설정 관리

use serde::{Deserialize, Serialize};

/// 내장 부트스트랩 노드 설정
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapConfig {
    /// 내장 부트스트랩 활성화 여부
    pub enabled: bool,
    
    /// DHT 포트 (0 = 자동 선택)
    pub dht_port: u16,
    
    /// QUIC 릴레이 포트 (0 = 자동 선택)
    pub quic_port: u16,
    
    /// Stats API 포트 (0 = 자동 선택)
    pub stats_port: u16,
    
    /// 외부 부트스트랩 노드 주소 목록
    pub external_bootstrap_nodes: Vec<String>,
    
    /// mDNS 자동 발견 활성화
    pub enable_mdns_discovery: bool,
    
    /// 릴레이 서비스 활성화
    pub enable_relay: bool,
    
    /// 최대 릴레이 세션 수
    pub max_relay_sessions: usize,
}

impl Default for BootstrapConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            dht_port: 6881,
            quic_port: 6882,
            stats_port: 6883,
            external_bootstrap_nodes: vec![],
            enable_mdns_discovery: true,
            enable_relay: true,
            max_relay_sessions: 50,
        }
    }
}

impl BootstrapConfig {
    /// 설정 유효성 검증
    pub fn validate(&self) -> Result<(), String> {
        // 포트는 u16 타입이므로 자동으로 0-65535 범위 보장됨
        // 0은 자동 선택을 의미함
        
        // 릴레이 세션 수 검증
        if self.max_relay_sessions == 0 {
            return Err("max_relay_sessions must be > 0".to_string());
        }
        if self.max_relay_sessions > 1000 {
            return Err("max_relay_sessions must be <= 1000".to_string());
        }
        
        Ok(())
    }
}
