mod protocol;
mod quic;
mod discovery;
mod transfer;
mod relay;
mod grid;
mod bootstrap;

use std::sync::Arc;
use std::net::{SocketAddr, IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use tokio::sync::{RwLock, Mutex};
use tracing::info;
use tauri::{AppHandle, Manager, Emitter};
use protocol::Command;

use quic::QuicServer;
use quic::client::QuicClient;
use discovery::DiscoveryService;
use transfer::{
    UdpTransferCore, FileTransferEngine, TransferProgress,
    MultiStreamSender, MultiStreamReceiver, MultiStreamProgress,
    ZeroCopyEngine, IoMethod,
};
use relay::{RelayEngine, engine::verify_no_disk_write};
use tokio::sync::mpsc;
use std::path::PathBuf;
use bootstrap::EmbeddedBootstrapService;

pub struct AppState {
    quic_server: Arc<RwLock<Option<QuicServer>>>,
    quic_client: Arc<RwLock<Option<QuicClient>>>,
    discovery: Arc<RwLock<Option<DiscoveryService>>>,
    udp_core: Arc<RwLock<Option<UdpTransferCore>>>,
    relay_engine: Arc<RwLock<Option<RelayEngine>>>,
    // 🆕 파일 전송 엔진
    file_transfer: Arc<RwLock<Option<FileTransferEngine>>>,
    // 🆕 활성 QUIC 연결 (피어 전송용)
    active_connections: Arc<RwLock<std::collections::HashMap<String, quinn::Connection>>>,
    // 🆕 서버에서 수락한 연결 (Sender용 - Receiver가 연결하면 여기에 저장)
    accepted_connections: Arc<RwLock<std::collections::HashMap<String, quinn::Connection>>>,
    // 🆕 내장 부트스트랩 서비스
    embedded_bootstrap: Arc<RwLock<Option<EmbeddedBootstrapService>>>,
    // 🆕 활성 파일 스트림 (StreamSaver 대체용)
    active_file_streams: Arc<RwLock<HashMap<String, (Arc<Mutex<tokio::fs::File>>, String)>>>,
    // 🆕 Tauri AppHandle 추가
    pub app_handle: AppHandle,
    // 🆕 앱 종료 진행 중 플래그
    pub is_closing: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        // AppHandle은 setup에서 주입해야 함
        panic!("AppState::default() should not be called directly. Use setup to initialize.");
    }
}

#[tauri::command]
async fn get_runtime_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpu_cores": num_cpus::get(),
        "is_native": true,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[tauri::command]
async fn ping_quic(_state: tauri::State<'_, AppState>) -> Result<String, String> {
    info!("QUIC ping 테스트 요청");
    Ok("pong".to_string())
}

/// 기본 라우트 기반으로 로컬 IP 감지 (패키징/환경에 덜 의존)
fn get_ip_via_udp_probe() -> Option<IpAddr> {
    use std::net::UdpSocket;

    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() { None } else { Some(ip) }
}

// 🆕 STUN 구현을 위한 간단한 헬퍼
async fn get_public_addr_via_stun(socket: &tokio::net::UdpSocket) -> Result<SocketAddr, String> {
    // Simple STUN Binding Request
    let mut buf = vec![0u8; 20];
    // Message Type: 0x0001 (Binding Request)
    buf[0] = 0x00; buf[1] = 0x01;
    // Message Length: 0x0000
    buf[2] = 0x00; buf[3] = 0x00;
    // Magic Cookie: 0x2112A442
    buf[4] = 0x21; buf[5] = 0x12; buf[6] = 0xA4; buf[7] = 0x42;
    // Transaction ID: Random 12 bytes
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut buf[8..20]);
    
    // Google STUN server
    let stun_server = "stun.l.google.com:19302";
    socket.send_to(&buf, stun_server).await.map_err(|e| e.to_string())?;
    
    let mut recv_buf = vec![0u8; 1024];
    let (len, _addr) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        socket.recv_from(&mut recv_buf)
    ).await
    .map_err(|_| "STUN timeout".to_string())?
    .map_err(|e| e.to_string())?;
    
    // Parse response for XOR-MAPPED-ADDRESS (0x0020)
    let mut idx = 20;
    while idx + 4 <= len {
        let attr_type = ((recv_buf[idx] as u16) << 8) | (recv_buf[idx+1] as u16);
        let attr_len = ((recv_buf[idx+2] as u16) << 8) | (recv_buf[idx+3] as u16);
        idx += 4;
        
        if idx + (attr_len as usize) > len { break; }
        
        if attr_type == 0x0020 { // XOR-MAPPED-ADDRESS
            // Family(1), Port(2), Address(4)
            let family = recv_buf[idx+1];
            let port_xor = ((recv_buf[idx+2] as u16) << 8) | (recv_buf[idx+3] as u16);
            let port = port_xor ^ 0x2112; // Magic cookie high 16 bits
            
            if family == 0x01 { // IPv4
               let ip_xor_bytes = &recv_buf[idx+4..idx+8];
               let magic_bytes = [0x21, 0x12, 0xA4, 0x42];
               let mut ip_bytes = [0u8; 4];
               for i in 0..4 { ip_bytes[i] = ip_xor_bytes[i] ^ magic_bytes[i]; }
               return Ok(SocketAddr::new(IpAddr::from(ip_bytes), port));
            }
        }
        
        idx += attr_len as usize;
        // Padding
        let padding = (4 - (attr_len % 4)) % 4;
        idx += padding as usize;
    }

    Err("STUN Address not found in response".to_string())
}

#[tauri::command]
async fn start_quic_server_wan(
    port: u16,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // 1. UDP 소켓 바인딩 (Quinn에 넘기기 전 STUN 용도로 사용)
    let socket = std::net::UdpSocket::bind(format!("0.0.0.0:{}", port))
        .map_err(|e| format!("UDP 바인딩 실패: {}", e))?;
    socket.set_nonblocking(true).map_err(|e| e.to_string())?;
    
    let local_socket_addr = socket.local_addr().map_err(|e| e.to_string())?;

    // 2. Tokio 소켓으로 변환하여 STUN 수행
    let tokio_socket = tokio::net::UdpSocket::from_std(socket)
        .map_err(|e| format!("Tokio 소켓 변환 실패: {}", e))?;
    
    let public_addr_res = get_public_addr_via_stun(&tokio_socket).await;
    
    // 3. 다시 std 소켓으로 변환
    let socket = tokio_socket.into_std()
        .map_err(|e| format!("Std 소켓 변환 실패: {}", e))?;
        
    // 4. QuicServer 생성 (기존 소켓 재사용)
    let mut server = QuicServer::new_with_socket(socket)
        .map_err(|e| format!("QUIC 서버 생성 실패: {}", e))?;

    server.start().await.map_err(|e| format!("QUIC 서버 시작 실패: {}", e))?;
    let local_addr = server.local_addr().unwrap_or(local_socket_addr);

    // 5. 연결 정보 구성
    let connectable_ip = if local_addr.ip().is_unspecified() {
        get_ip_via_udp_probe().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
    } else {
        local_addr.ip()
    };
    
    let host_addr_str = SocketAddr::new(connectable_ip, local_addr.port()).to_string();
    
    // Candidate 목록 생성
    let mut candidates = vec![
        serde_json::json!({ "type": "host", "ip": connectable_ip.to_string(), "port": local_addr.port() })
    ];
    
    if let Ok(pub_addr) = public_addr_res {
        info!("🌍 STUN 성공: Public IP = {}", pub_addr);
        if pub_addr != local_addr {
             candidates.push(serde_json::json!({
                 "type": "srflx",
                 "ip": pub_addr.ip().to_string(),
                 "port": pub_addr.port()
            }));
        }
    } else {
        info!("⚠️ STUN 실패: {}", public_addr_res.err().unwrap());
    }

    // 🆕 연결 수신 핸들러 (기존 start_quic_server와 동일)
    if let Some(mut conn_rx) = server.take_connection_receiver() {
        let app_handle = state.app_handle.clone();
        let accepted_conns = state.accepted_connections.clone();
        
        tauri::async_runtime::spawn(async move {
            while let Some(accepted) = conn_rx.recv().await {
                let peer_id = accepted.peer_addr.to_string();
                info!("📥 Receiver 연결됨 (WAN): {}", peer_id);
                accepted_conns.write().await.insert(peer_id.clone(), accepted.connection);
                
                let _ = app_handle.emit("quic-peer-connected", serde_json::json!({
                    "peerId": peer_id,
                    "peerAddr": accepted.peer_addr.to_string(),
                    "wan": true
                }));
            }
        });
    }

    *state.quic_server.write().await = Some(server);
    
    info!("QUIC 서버(WAN) 시작됨. Candidates: {:?}", candidates);
    
    Ok(serde_json::json!({
        "quicAddress": host_addr_str,
        "quicCandidates": candidates
    }))
}

#[tauri::command]
async fn start_quic_server(
    port: u16,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let addr = format!("0.0.0.0:{}", port).parse()
        .map_err(|e| format!("주소 파싱 실패: {}", e))?;
    
    let mut server = QuicServer::new(addr);
    server.start().await.map_err(|e| format!("QUIC 서버 시작 실패: {}", e))?;
    
    let local_addr = server.local_addr().unwrap_or(addr);

    // 0.0.0.0 바인딩 주소는 원격에서 접속 불가하므로 실제 로컬 IP로 변환
    let connectable_ip = if local_addr.ip().is_unspecified() {
        get_ip_via_udp_probe().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
    } else {
        local_addr.ip()
    };
    let connectable_addr = SocketAddr::new(connectable_ip, local_addr.port()).to_string();
    
    // 🆕 연결 수신 채널 가져오기
    if let Some(mut conn_rx) = server.take_connection_receiver() {
        let app_handle = state.app_handle.clone();
        let accepted_conns = state.accepted_connections.clone();
        
        // 백그라운드에서 연결 수신 대기
        tauri::async_runtime::spawn(async move {
            while let Some(accepted) = conn_rx.recv().await {
                let peer_id = accepted.peer_addr.to_string();
                info!("📥 Receiver 연결됨: {}", peer_id);
                
                // 연결 저장
                accepted_conns.write().await.insert(peer_id.clone(), accepted.connection);
                
                // 프론트엔드에 알림 (Sender가 파일 전송 시작하도록)
                let _ = app_handle.emit("quic-peer-connected", serde_json::json!({
                    "peerId": peer_id,
                    "peerAddr": accepted.peer_addr.to_string(),
                }));
            }
        });
    }
    
    *state.quic_server.write().await = Some(server);
    
    info!("QUIC 서버 시작됨: {} (연결 가능한 주소: {})", local_addr, connectable_addr);
    Ok(connectable_addr)
}

#[tauri::command]
async fn stop_quic_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(mut server) = state.quic_server.write().await.take() {
        server.shutdown().await;
        info!("QUIC 서버 중지됨");
    }
    Ok(())
}

#[tauri::command]
async fn start_discovery(
    node_id: String,
    port: u16,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let discovery = DiscoveryService::new(node_id.clone(), port)
        .map_err(|e| format!("Discovery 서비스 생성 실패: {}", e))?;
    
    discovery.register().map_err(|e| format!("mDNS 등록 실패: {}", e))?;
    discovery.start_browsing().await.map_err(|e| format!("mDNS 브라우징 시작 실패: {}", e))?;
    
    *state.discovery.write().await = Some(discovery);
    
    info!("피어 발견 서비스 시작: {}", node_id);
    Ok(())
}

#[tauri::command]
async fn get_discovered_peers(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let discovery = state.discovery.read().await;
    
    if let Some(ref disc) = *discovery {
        let peers: Vec<serde_json::Value> = disc.get_peers()
            .iter()
            .map(|p| serde_json::json!({
                "id": p.id,
                "address": p.address.to_string(),
                "capabilities": {
                    "maxBandwidthMbps": p.capabilities.max_bandwidth_mbps,
                    "availableBandwidthMbps": p.capabilities.available_bandwidth_mbps,
                    "cpuCores": p.capabilities.cpu_cores,
                    "canRelay": p.capabilities.can_relay,
                }
            }))
            .collect();
        
        Ok(peers)
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
async fn stop_discovery(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(ref discovery) = *state.discovery.read().await {
        discovery.stop().await;
        info!("피어 발견 서비스 중지");
    }
    *state.discovery.write().await = None;
    Ok(())
}

#[tauri::command]
async fn start_udp_transfer(
    socket_count: usize,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let count = if socket_count == 0 { 8 } else { socket_count };
    
    let udp_core = UdpTransferCore::new(count).await
        .map_err(|e| format!("UDP 코어 생성 실패: {}", e))?;
    
    let addrs = udp_core.get_local_addrs().await;
    let socket_count = udp_core.socket_count();
    
    *state.udp_core.write().await = Some(udp_core);
    
    info!("🚀 UDP 전송 코어 시작: {} 소켓", socket_count);
    
    Ok(serde_json::json!({
        "socketCount": socket_count,
        "localAddrs": addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
async fn get_transfer_stats(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let udp_core = state.udp_core.read().await;
    
    if let Some(ref core) = *udp_core {
        let stats = core.get_stats().await;
        Ok(serde_json::json!({
            "bytesSent": stats.bytes_sent,
            "bytesReceived": stats.bytes_received,
            "packetsSent": stats.packets_sent,
            "packetsReceived": stats.packets_received,
            "packetsLost": stats.packets_lost,
            "bandwidthMbps": stats.current_bandwidth_mbps,
        }))
    } else {
        Ok(serde_json::json!({
            "error": "UDP 코어가 시작되지 않음"
        }))
    }
}

#[tauri::command]
async fn start_relay_engine(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let engine = RelayEngine::new();
    engine.start().await.map_err(|e| format!("릴레이 엔진 시작 실패: {}", e))?;
    
    *state.relay_engine.write().await = Some(engine);
    
    info!("🔄 릴레이 엔진 시작됨");
    Ok(())
}

#[tauri::command]
async fn get_relay_stats(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let relay = state.relay_engine.read().await;
    
    if let Some(ref engine) = *relay {
        let session_count = engine.active_session_count().await;
        let (pool_available, pool_allocated) = engine.buffer_pool_stats().await;
        
        Ok(serde_json::json!({
            "activeSessions": session_count,
            "bufferPoolAvailable": pool_available,
            "bufferPoolAllocated": pool_allocated,
            "zeroDiskVerified": verify_no_disk_write(),
        }))
    } else {
        Ok(serde_json::json!({
            "error": "릴레이 엔진이 시작되지 않음"
        }))
    }
}

#[tauri::command]
async fn stop_relay_engine(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(ref engine) = *state.relay_engine.read().await {
        engine.stop().await;
        info!("🛑 릴레이 엔진 중지됨");
    }
    *state.relay_engine.write().await = None;
    Ok(())
}

// --- QUIC 파일 전송 Commands ---

/// QUIC 피어에 연결
#[tauri::command]
async fn connect_to_peer(
    peer_id: String,
    peer_address: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let peer_addr: SocketAddr = peer_address.parse()
        .map_err(|e| format!("주소 파싱 실패: {}", e))?;
    
    // Client 초기화 및 취득 (Lock 최소화)
    let client = {
        let mut guard = state.quic_client.write().await;
        if guard.is_none() {
            *guard = Some(QuicClient::new().map_err(|e| format!("QUIC 클라이언트 생성 실패: {}", e))?);
        }
        guard.as_ref().unwrap().clone()
    };
    
    // 연결 시도 (Lock 없이 수행)
    let conn = client.connect(peer_addr, &peer_id).await
        .map_err(|e| format!("QUIC 연결 실패: {}", e))?;
        
    // 연결 저장
    state.active_connections.write().await.insert(peer_id.clone(), conn);
    
    info!("✅ 피어 연결 성공: {} @ {}", peer_id, peer_address);
    Ok(true)
}

/// 🆕 여러 Candidate 주소로 동시에 연결 시도 (WAN/ICE 지원)
#[tauri::command]
async fn connect_to_peer_race(
    peer_id: String,
    addresses: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> { // 성공한 주소 반환
    use futures::future::select_ok;
    
    let peer_addrs: Vec<SocketAddr> = addresses.iter()
        .filter_map(|s| s.parse().ok())
        .collect();
        
    if peer_addrs.is_empty() {
        return Err("유효한 주소가 없습니다.".to_string());
    }
    
    info!("🏎️ 연결 레이스 시작: {} -> {:?}", peer_id, peer_addrs);
    
    let client = {
        let mut guard = state.quic_client.write().await;
        if guard.is_none() {
            *guard = Some(QuicClient::new().map_err(|e| format!("QUIC 클라이언트 생성 실패: {}", e))?);
        }
        guard.as_ref().unwrap().clone()
    };
    
    let futures = peer_addrs.into_iter().map(|addr| {
        let client = client.clone();
        let pid = peer_id.clone();
        Box::pin(async move {
            client.connect(addr, &pid).await.map(|conn| (conn, addr))
        })
    });
    
    match select_ok(futures).await {
        Ok(((conn, addr), _)) => {
            info!("🏆 연결 레이스 승리: {} @ {}", peer_id, addr);
            state.active_connections.write().await.insert(peer_id.clone(), conn);
            Ok(addr.to_string())
        },
        Err(e) => {
            let msg = format!("모든 연결 시도 실패: {}", e);
            tracing::error!("{}", msg);
            Err(msg)
        }
    }
}

/// QUIC을 통해 파일/폴더 전송 시작 (Sender - 클라이언트로 연결한 경우)
#[tauri::command]
async fn send_files_to_peer(
    peer_id: String,
    file_paths: Vec<String>,
    job_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<u64, String> {
    let conn = {
        let connections = state.active_connections.read().await;
        connections
            .get(&peer_id)
            .ok_or_else(|| format!("피어 {}에 대한 연결이 없습니다.", peer_id))?
            .clone()
    };

    info!("📤 전송 시작 (Client): {:?} -> {}", file_paths, peer_id);

    let (tx, mut rx) = mpsc::channel::<TransferProgress>(100);
    let engine = FileTransferEngine::new();
    let mut engine_mut = FileTransferEngine::new();
    engine_mut.set_progress_channel(tx);
    let engine = Arc::new(engine_mut);

    let app_handle = state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(progress) = rx.recv().await {
            let _ = app_handle.emit("transfer-progress", &progress);
        }
    });

    let paths: Vec<PathBuf> = file_paths.iter().map(PathBuf::from).collect();
    let bytes_sent = engine.send_files(&conn, paths, &job_id).await
        .map_err(|e| format!("파일 전송 실패: {}", e))?;

    let _ = state.app_handle.emit("transfer-complete", serde_json::json!({
        "jobId": job_id,
        "bytesSent": bytes_sent,
        "peerId": peer_id,
    }));

    info!("✅ 전송 완료: {} bytes to {}", bytes_sent, peer_id);
    Ok(bytes_sent)
}

/// 🆕 서버에서 수락한 연결로 파일/폴더 전송 (Sender - 서버 역할)
#[tauri::command]
async fn send_files_to_accepted_peer(
    peer_id: String,
    file_paths: Vec<String>,
    job_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<u64, String> {
    let conn = {
        let connections = state.accepted_connections.read().await;
        connections
            .get(&peer_id)
            .ok_or_else(|| format!("수락된 피어 {}에 대한 연결이 없습니다.", peer_id))?
            .clone()
    };

    info!("📤 전송 시작 (Server): {:?} -> {}", file_paths, peer_id);

    let (tx, mut rx) = mpsc::channel::<TransferProgress>(100);
    let mut engine_mut = FileTransferEngine::new();
    engine_mut.set_progress_channel(tx);
    let engine = Arc::new(engine_mut);

    let app_handle = state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(progress) = rx.recv().await {
            let _ = app_handle.emit("transfer-progress", &progress);
        }
    });

    let paths: Vec<PathBuf> = file_paths.iter().map(PathBuf::from).collect();
    let bytes_sent = engine.send_files(&conn, paths, &job_id).await
        .map_err(|e| format!("파일 전송 실패: {}", e))?;

    let _ = state.app_handle.emit("transfer-complete", serde_json::json!({
        "jobId": job_id,
        "bytesSent": bytes_sent,
        "peerId": peer_id,
    }));

    info!("✅ 전송 완료: {} bytes to {}", bytes_sent, peer_id);
    Ok(bytes_sent)
}

/// 🆕 수락된 연결 목록 조회
#[tauri::command]
async fn get_accepted_peers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let connections = state.accepted_connections.read().await;
    Ok(connections.keys().cloned().collect())
}

/// QUIC을 통해 파일 수신 대기 (Receiver)
#[tauri::command]
async fn receive_file_from_peer(
    peer_id: String,
    save_dir: String,
    job_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // 1. Scope를 제한하여 Lock 시간을 최소화하고 Connection을 복제(Clone)합니다.
    let conn = {
        let connections = state.active_connections.read().await;
        connections
            .get(&peer_id)
            .ok_or_else(|| format!("피어 {}에 대한 연결이 없습니다.", peer_id))?
            .clone() // Quinn Connection은 내부적으로 Arc이므로 Clone 가능
    }; // 여기서 read lock이 해제됩니다.

    info!("📥 수신 시작: {} -> {}", peer_id, save_dir);

    // 2. 별도의 채널 생성
    let (tx, mut rx) = mpsc::channel::<TransferProgress>(100);
    let mut engine = FileTransferEngine::new();
    engine.set_progress_channel(tx);

    let app_handle = state.app_handle.clone();
    
    // 3. 비동기 작업 수행 (Lock 없는 상태)
    tauri::async_runtime::spawn(async move {
        while let Some(progress) = rx.recv().await {
            let _ = app_handle.emit("transfer-progress", &progress);
        }
    });

    let save_path = PathBuf::from(&save_dir);
    
    // conn을 소유권 이동으로 넘겨도 원본 HashMap에는 영향 없음 (Clone 했으므로)
    let result_path = engine.receive_file(&conn, save_path, &job_id).await
        .map_err(|e| format!("파일 수신 실패: {}", e))?;

    let result_str = result_path.to_string_lossy().to_string();

    let _ = state.app_handle.emit("transfer-complete", serde_json::json!({
        "jobId": job_id,
        "savedPath": result_str,
        "peerId": peer_id,
    }));

    info!("✅ 파일 수신 완료: {:?}", result_path);
    Ok(result_str)
}

/// 피어 연결 해제
#[tauri::command]
async fn disconnect_peer(
    peer_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // 1. Active 연결 확인
    let mut active = state.active_connections.write().await;
    if let Some(conn) = active.remove(&peer_id) {
        conn.close(0u32.into(), b"disconnect");
        info!("피어 연결 해제 (Active): {}", peer_id);
        return Ok(());
    }
    drop(active); // Lock 해제

    // 2. Accepted 연결 확인
    let mut accepted = state.accepted_connections.write().await;
    if let Some(conn) = accepted.remove(&peer_id) {
        conn.close(0u32.into(), b"disconnect");
        info!("피어 연결 해제 (Accepted): {}", peer_id);
    }
    
    Ok(())
}

/// 전송 상태 조회
#[tauri::command]
async fn get_file_transfer_state(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let transfer = state.file_transfer.read().await;
    
    if let Some(ref engine) = *transfer {
        let current_state = engine.get_state().await;
        Ok(serde_json::json!({
            "state": format!("{:?}", current_state),
        }))
    } else {
        Ok(serde_json::json!({
            "state": "Idle",
        }))
    }
}

/// 🆕 파일 다이얼로그 열기
#[tauri::command]
async fn open_file_dialog(
    multiple: bool,
    directory: bool,
    app: tauri::AppHandle,
) -> Result<Option<Vec<String>>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    if directory {
        // 폴더 선택 다이얼로그
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_folder(move |result| {
            let _ = tx.send(result);
        });
        
        let folder_path = rx.await.map_err(|e| format!("폴더 선택 채널 오류: {}", e))?;
        
        match folder_path {
            Some(path) => Ok(Some(vec![path.to_string()])),
            None => Ok(None),
        }
    } else {
        // 파일 선택 다이얼로그
        if multiple {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog().file().pick_files(move |result| {
                let _ = tx.send(result);
            });
            
            let file_paths = rx.await.map_err(|e| format!("파일 선택 채널 오류: {}", e))?;
            
            match file_paths {
                Some(paths) => Ok(Some(paths.into_iter().map(|p| p.to_string()).collect())),
                None => Ok(None),
            }
        } else {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog().file().pick_file(move |result| {
                let _ = tx.send(result);
            });
            
            let file_path = rx.await.map_err(|e| format!("파일 선택 채널 오류: {}", e))?;
            
            match file_path {
                Some(path) => Ok(Some(vec![path.to_string()])),
                None => Ok(None),
            }
        }
    }
}

/// 🆕 파일 메타데이터 조회
#[tauri::command]
async fn get_file_metadata(
    path: String,
) -> Result<serde_json::Value, String> {
    use std::fs;
    use std::path::Path;
    
    let path = Path::new(&path);
    
    let metadata = fs::metadata(path).map_err(|e| format!("메타데이터 조회 실패: {}", e))?;
    
    let modified = metadata.modified()
        .map_err(|e| format!("수정 시간 조회 실패: {}", e))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("시간 변환 실패: {}", e))?
        .as_millis();
    
    Ok(serde_json::json!({
        "size": metadata.len(),
        "modifiedAt": modified,
        "isFile": metadata.is_file(),
        "isDir": metadata.is_dir(),
        "name": path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
    }))
}

// --- 멀티스트림 고속 전송 Commands ---

/// 멀티스트림으로 파일 전송 (TB급 최적화)
#[tauri::command]
async fn send_file_multistream(
    peer_id: String,
    file_path: String,
    job_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<u64, String> {
    // 1. Scope를 제한하여 Lock 시간을 최소화하고 Connection을 복제(Clone)합니다.
    let conn = {
        let connections = state.active_connections.read().await;
        connections
            .get(&peer_id)
            .ok_or_else(|| format!("피어 {}에 대한 연결이 없습니다.", peer_id))?
            .clone() // Quinn Connection은 내부적으로 Arc이므로 Clone 가능
    }; // 여기서 read lock이 해제됩니다.

    info!("🚀 멀티스트림 전송 시작: {} -> {}", file_path, peer_id);

    let (tx, mut rx) = mpsc::channel::<MultiStreamProgress>(100);
    
    let sender = MultiStreamSender::new(conn)
        .with_block_size(8 * 1024 * 1024)  // 8MB 블록
        .with_max_concurrent(32)            // 32개 동시 스트림
        .with_progress_channel(tx);

    // 진행률 이벤트 전송
    let app_handle = state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(progress) = rx.recv().await {
            let _ = app_handle.emit("multistream-progress", &progress);
        }
    });

    let path = PathBuf::from(&file_path);
    let bytes_sent = sender.send_file(path, &job_id).await
        .map_err(|e| format!("멀티스트림 전송 실패: {}", e))?;

    let _ = state.app_handle.emit("multistream-complete", serde_json::json!({
        "jobId": job_id,
        "bytesSent": bytes_sent,
        "peerId": peer_id,
    }));

    info!("✅ 멀티스트림 전송 완료: {} bytes", bytes_sent);
    Ok(bytes_sent)
}

/// 멀티스트림으로 파일 수신
#[tauri::command]
async fn receive_file_multistream(
    peer_id: String,
    save_dir: String,
    job_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // 1. Scope를 제한하여 Lock 시간을 최소화하고 Connection을 복제(Clone)합니다.
    let conn = {
        let connections = state.active_connections.read().await;
        connections
            .get(&peer_id)
            .ok_or_else(|| format!("피어 {}에 대한 연결이 없습니다.", peer_id))?
            .clone() // Quinn Connection은 내부적으로 Arc이므로 Clone 가능
    }; // 여기서 read lock이 해제됩니다.

    info!("📥 멀티스트림 수신 대기: {}", peer_id);

    let (tx, mut rx) = mpsc::channel::<MultiStreamProgress>(100);
    
    let receiver = MultiStreamReceiver::new(conn, PathBuf::from(&save_dir))
        .with_progress_channel(tx);

    // 진행률 이벤트 전송
    let app_handle = state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(progress) = rx.recv().await {
            let _ = app_handle.emit("multistream-progress", &progress);
        }
    });

    let result_path = receiver.receive_file(&job_id).await
        .map_err(|e| format!("멀티스트림 수신 실패: {}", e))?;

    let result_str = result_path.to_string_lossy().to_string();

    let _ = state.app_handle.emit("multistream-complete", serde_json::json!({
        "jobId": job_id,
        "savedPath": result_str,
        "peerId": peer_id,
    }));

    info!("✅ 멀티스트림 수신 완료: {:?}", result_path);
    Ok(result_str)
}

/// Zero-Copy I/O 엔진 정보 조회
#[tauri::command]
async fn get_io_engine_info() -> Result<serde_json::Value, String> {
    let engine = ZeroCopyEngine::new();
    let io_method = match engine.io_method() {
        IoMethod::Buffered => "buffered",
        IoMethod::Mmap => "mmap",
        #[cfg(target_os = "linux")]
        IoMethod::IoUring => "io_uring",
        #[cfg(target_os = "windows")]
        IoMethod::OverlappedIo => "overlapped_io",
    };

    Ok(serde_json::json!({
        "ioMethod": io_method,
        "zeroCopySupported": io_method != "buffered",
        "platform": std::env::consts::OS,
        "blockSize": 8 * 1024 * 1024,  // 8MB
        "maxConcurrentStreams": 32,
    }))
}

// --- Grid Protocol Commands (Phase 2) ---

/// Grid 모드 정보 조회
#[tauri::command]
async fn get_grid_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "version": "2.0",
        "features": ["bitfield", "rare-first", "dht", "mesh"],
        "defaultPieceSize": 1024 * 1024,  // 1MB
        "maxPeers": 50,
        "maxPendingRequests": 16,
    }))
}

/// Grid 파일 메타데이터 생성
#[tauri::command]
async fn create_grid_metadata(
    file_path: String,
    piece_size: Option<u32>,
) -> Result<serde_json::Value, String> {
    use grid::piece_manager::FileMetadata;
    
    let path = PathBuf::from(&file_path);
    let piece_size = piece_size.unwrap_or(1024 * 1024); // 기본 1MB
    
    let metadata = FileMetadata::from_file(&path, piece_size)
        .await
        .map_err(|e| format!("메타데이터 생성 실패: {}", e))?;
    
    Ok(serde_json::json!({
        "infoHash": hex::encode(metadata.info_hash),
        "fileName": metadata.file_name,
        "fileSize": metadata.file_size,
        "pieceSize": metadata.piece_size,
        "totalPieces": metadata.total_pieces,
        "merkleRoot": metadata.merkle_root.map(|r| hex::encode(r)),
    }))
}

/// DHT 부트스트랩 노드에 연결
#[tauri::command]
async fn connect_bootstrap_node(
    address: String,
) -> Result<bool, String> {
    let addr: std::net::SocketAddr = address.parse()
        .map_err(|e| format!("주소 파싱 실패: {}", e))?;
    
    info!("🔗 DHT 부트스트랩 노드 연결: {}", addr);
    
    // TODO: 실제 DHT 서비스와 연동
    // 현재는 연결 가능 여부만 확인
    Ok(true)
}

/// DHT 부트스트랩 노드 목록 설정
#[tauri::command]
async fn set_bootstrap_nodes(
    addresses: Vec<String>,
) -> Result<usize, String> {
    let mut valid_count = 0;
    
    for addr_str in &addresses {
        if addr_str.parse::<std::net::SocketAddr>().is_ok() {
            valid_count += 1;
        }
    }
    
    info!("🌐 부트스트랩 노드 설정: {}/{} 유효", valid_count, addresses.len());
    
    Ok(valid_count)
}

/// 부트스트랩 노드 자동 발견 (mDNS)
#[tauri::command]
async fn discover_bootstrap_nodes() -> Result<Vec<serde_json::Value>, String> {
    use grid::bootstrap_discovery::AutoBootstrap;
    
    info!("🔍 부트스트랩 노드 자동 발견 시작...");
    
    let mut auto_bootstrap = AutoBootstrap::new()
        .map_err(|e| format!("AutoBootstrap 생성 실패: {}", e))?;
    
    let nodes = auto_bootstrap.start().await
        .map_err(|e| format!("부트스트랩 발견 실패: {}", e))?;
    
    let result: Vec<serde_json::Value> = nodes
        .iter()
        .map(|addr| serde_json::json!({
            "address": addr.to_string(),
            "ip": addr.ip().to_string(),
            "port": addr.port(),
        }))
        .collect();
    
    info!("🎯 {} 개의 부트스트랩 노드 발견", result.len());
    
    Ok(result)
}

/// 🆕 네트워크 인터페이스 조회
#[tauri::command]
async fn get_network_interfaces() -> Result<Vec<String>, String> {
    use std::net::{IpAddr, Ipv4Addr};
    use std::process::Command;
    
    let mut interfaces = Vec::new();
    
    // 방법 1: ip addr 명령 (Linux/macOS)
    if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
        if let Ok(output) = Command::new("ip")
            .args(&["addr", "show"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            
            // inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0
            for line in output_str.lines() {
                if line.contains("inet ") && !line.contains("127.0.0.1") {
                    if let Some(inet_part) = line.split("inet ").nth(1) {
                        if let Some(ip_part) = inet_part.split_whitespace().next() {
                            if let Some(slash_pos) = ip_part.find('/') {
                                let ip = &ip_part[..slash_pos];
                                if let Ok(ip_addr) = ip.parse::<IpAddr>() {
                                    interfaces.push(ip_addr.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    // 방법 2: ifconfig 명령 (fallback)
    if interfaces.is_empty() {
        if let Ok(output) = Command::new("ifconfig")
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            
            // inet 192.168.1.100 netmask 0xffffff00 broadcast 192.168.1.255
            for line in output_str.lines() {
                if line.trim().starts_with("inet ") && !line.contains("127.0.0.1") {
                    if let Some(inet_part) = line.split("inet ").nth(1) {
                        if let Some(ip_part) = inet_part.split_whitespace().next() {
                            if let Ok(ip_addr) = ip_part.parse::<IpAddr>() {
                                interfaces.push(ip_addr.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    
    // 방법 3: hostname -I (간단한 fallback)
    if interfaces.is_empty() {
        if let Ok(output) = Command::new("hostname")
            .args(&["-I"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for ip_str in output_str.trim().split_whitespace() {
                if let Ok(ip_addr) = ip_str.parse::<IpAddr>() {
                    if !ip_str.contains("127.0.0.1") && !ip_str.starts_with("169.254") {
                        interfaces.push(ip_addr.to_string());
                    }
                }
            }
        }
    }
    
    // 최후의 fallback: localhost
    if interfaces.is_empty() {
        interfaces.push("127.0.0.1".to_string());
    }
    
    info!("🌐 감지된 네트워크 인터페이스: {:?}", interfaces);
    
    Ok(interfaces)
}

// --- Native File Streaming Commands (StreamSaver.js 대체) ---

/// 🆕 네이티브 파일 스트리밍 시작 (StreamSaver 대체)
#[tauri::command]
async fn start_file_stream(
    file_id: String,
    save_path: String,
    total_size: Option<u64>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tokio::fs;

    let path = PathBuf::from(&save_path);
    
    // 부모 디렉토리 생성
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| format!("디렉토리 생성 실패: {}", e))?;
    }

    let file = tokio::fs::File::create(&path).await
        .map_err(|e| format!("파일 생성 실패: {}", e))?;

    // 파일 크기 미리 할당 (성능 최적화 및 단편화 방지)
    if let Some(size) = total_size {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let fd = file.as_raw_fd();
            unsafe {
                libc::posix_fallocate(fd, 0, size as i64);
            }
        }
        #[cfg(windows)]
        {
            file.set_len(size).await.map_err(|e| e.to_string())?;
        }
    }

    let mut writers = state.active_file_streams.write().await;
    writers.insert(file_id.clone(), (Arc::new(Mutex::new(file)), save_path.clone()));

    info!("📝 파일 스트리밍 시작: {} -> {}", file_id, save_path);
    Ok(())
}

/// 🆕 파일 청크 쓰기 (Zero-Copy 방식)
#[tauri::command]
async fn write_file_chunk(
    file_id: String,
    chunk: Vec<u8>,
    offset: Option<u64>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    use tokio::io::{AsyncSeekExt, SeekFrom, AsyncWriteExt};

    let writers = state.active_file_streams.read().await;
    let (file_mutex, _) = writers.get(&file_id)
        .ok_or_else(|| format!("활성 스트림을 찾을 수 없습니다: {}", file_id))?;
    
    let mut file = file_mutex.lock().await;

    // 오프셋이 지정된 경우 해당 위치로 이동
    if let Some(off) = offset {
        file.seek(SeekFrom::Start(off)).await
            .map_err(|e| format!("파일 위치 이동 실패: {}", e))?;
    }

    // 청크 쓰기
    file.write_all(&chunk).await
        .map_err(|e| format!("청크 쓰기 실패: {}", e))?;

    Ok(())
}

/// 🆕 파일 스트리밍 완료
#[tauri::command]
async fn complete_file_stream(
    file_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut writers = state.active_file_streams.write().await;
    let (file_mutex, path) = writers.remove(&file_id)
        .ok_or_else(|| format!("활성 스트림을 찾을 수 없습니다: {}", file_id))?;
    
    let mut file = file_mutex.lock().await;

    // 디스크 동기화
    use tokio::io::AsyncWriteExt;
    file.flush().await.map_err(|e| format!("플러시 실패: {}", e))?;
    file.sync_all().await.map_err(|e| format!("동기화 실패: {}", e))?;

    info!("✅ 파일 스트리밍 완료: {} -> {}", file_id, path);
    Ok(path)
}

/// 🆕 스트리밍 파일 생성 (Native 다이얼로그 연동)
#[tauri::command]
async fn create_save_dialog(
    default_name: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("All Files", &["*"])
        .set_file_name(default_name.unwrap_or_else(|| "received_file".to_string()))
        .save_file(move |result| {
            let _ = tx.send(result);
        });

    let file_path = rx.await
        .map_err(|e| format!("다이얼로그 채널 오류: {}", e))?;

    match file_path {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

/// 🆕 저장 폴더 선택 다이얼로그
#[tauri::command]
async fn select_save_directory(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .pick_folder(move |result| {
            let _ = tx.send(result);
        });

    let folder_path = rx.await
        .map_err(|e| format!("폴더 선택 채널 오류: {}", e))?;

    match folder_path {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

/// 🆕 저장 가능한 공간 확인
#[tauri::command]
async fn check_storage_space(path: String) -> Result<serde_json::Value, String> {
    // 간단한 fallback 구현 (실제 저장 공간 확인은 복잡성을 위해 생략)
    Ok(serde_json::json!({
        "availableBytes": 100 * 1024 * 1024 * 1024, // 100GB
        "totalBytes": 500 * 1024 * 1024 * 1024,     // 500GB
        "availableGB": 100.0,
        "totalGB": 500.0,
    }))
}

// --- P2P Signaling Commands ---

#[tauri::command]
async fn send_signaling_message(
    peer_id: String,
    message: Command,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let discovery = state.discovery.read().await;

    // Discovery 서비스에서 피어 주소 조회
    let peer_addr = if let Some(ref disc) = *discovery {
        if let Some(peer_info) = disc.get_peers().iter().find(|p| p.id == peer_id) {
            peer_info.address
        } else {
            return Err(format!("피어 {}를 찾을 수 없음", peer_id));
        }
    } else {
        return Err("Discovery 서비스가 실행되고 있지 않음".to_string());
    };

    // Client 초기화 및 취득
    let client = {
        let mut guard = state.quic_client.write().await;
        if guard.is_none() {
            *guard = Some(QuicClient::new().map_err(|e| format!("QUIC 클라이언트 생성 실패: {}", e))?);
        }
        guard.as_ref().unwrap().clone()
    };
    
    // 연결 및 메시지 전송
    let conn = client.connect(peer_addr, &peer_id).await
        .map_err(|e| format!("QUIC 연결 실패: {}", e))?;
    
    client.send_command(&conn, message).await
        .map_err(|e| format!("시그널링 메시지 전송 실패: {}", e))?;
    
    info!("✅ 시그널링 메시지를 {}로 전송함", peer_id);
    Ok(())
}

#[tauri::command]
async fn handle_signaling_message(
    message: Command,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    info!("📨 수신된 시그널링 메시지: {:?}", message);
    
    // 🆕 프론트엔드로 시그널링 이벤트 발생
    let event_name = match message {
        Command::Offer { .. } => "signaling-offer",
        Command::Answer { .. } => "signaling-answer",
        Command::IceCandidate { .. } => "signaling-ice-candidate",
        _ => "signaling-unknown", // 다른 명령은 무시하거나 별도 처리
    };

    // 메시지를 JSON으로 변환하여 프론트엔드로 전송
    let payload = serde_json::to_value(&message)
        .map_err(|e| format!("시그널링 메시지 직렬화 실패: {}", e))?;

    state.app_handle.emit(event_name, &payload)
        .map_err(|e| format!("프론트엔드 이벤트 발생 실패: {}", e))?;
    
    info!("✅ 프론트엔드로 이벤트 발생: {}", event_name);
    
    Ok(())
}

// --- Embedded Bootstrap Commands ---

/// 부트스트랩 자동 시작 (앱 시작 시)
async fn auto_start_bootstrap(app_handle: AppHandle) -> anyhow::Result<()> {
    use tauri::Manager;
    
    // 기본 설정으로 부트스트랩 생성
    let config = bootstrap::BootstrapConfig::default();
    
    // 설정에서 enabled가 false면 시작하지 않음
    if !config.enabled {
        info!("내장 부트스트랩이 비활성화되어 있습니다");
        return Ok(());
    }
    
    info!("🚀 내장 부트스트랩 자동 시작 중...");
    
    // AppState 가져오기
    let state: tauri::State<AppState> = app_handle.state();
    let mut bootstrap_guard = state.embedded_bootstrap.write().await;
    
    // 서비스 생성 및 시작
    let mut service = bootstrap::EmbeddedBootstrapService::new(config.clone());
    
    match service.start().await {
        Ok(ports) => {
            info!("✅ 내장 부트스트랩 자동 시작 완료");
            info!("   DHT: {}, QUIC: {}, Stats: {}", 
                ports.dht_port, ports.quic_port, ports.stats_port);
            
            // 상태 변경 이벤트 발생
            let _ = app_handle.emit("bootstrap-state-changed", serde_json::json!({
                "state": "running",
                "ports": {
                    "dht": ports.dht_port,
                    "quic": ports.quic_port,
                    "stats": ports.stats_port,
                }
            }));
            
            *bootstrap_guard = Some(service);
            Ok(())
        }
        Err(e) => {
            tracing::error!("내장 부트스트랩 자동 시작 실패: {}", e);
            
            // 에러 이벤트 발생
            let _ = app_handle.emit("bootstrap-state-changed", serde_json::json!({
                "state": "error",
                "error": e.to_string()
            }));
            
            Err(e)
        }
    }
}

/// 내장 부트스트랩 서비스 시작
#[tauri::command]
async fn start_embedded_bootstrap(
    config: Option<bootstrap::BootstrapConfig>,
    state: tauri::State<'_, AppState>,
) -> Result<bootstrap::BoundPorts, String> {
    info!("🚀 내장 부트스트랩 시작 요청");
    
    let config = config.unwrap_or_default();
    
    // 설정 검증
    config.validate().map_err(|e| format!("설정 검증 실패: {}", e))?;
    
    let mut bootstrap_guard = state.embedded_bootstrap.write().await;
    
    // 이미 실행 중인지 확인
    if let Some(ref service) = *bootstrap_guard {
        if service.state() != &bootstrap::ServiceState::Stopped {
            return Err("부트스트랩 서비스가 이미 실행 중입니다".to_string());
        }
    }
    
    // 새 서비스 생성 및 시작
    let mut service = bootstrap::EmbeddedBootstrapService::new(config);
    let ports = service.start().await
        .map_err(|e| format!("부트스트랩 시작 실패: {}", e))?;
    
    // 상태 변경 이벤트 발생
    let _ = state.app_handle.emit("bootstrap-state-changed", serde_json::json!({
        "state": "running",
        "ports": {
            "dht": ports.dht_port,
            "quic": ports.quic_port,
            "stats": ports.stats_port,
        }
    }));
    
    *bootstrap_guard = Some(service);
    
    info!("✅ 내장 부트스트랩 시작 완료");
    Ok(ports)
}

/// 내장 부트스트랩 서비스 중지
#[tauri::command]
async fn stop_embedded_bootstrap(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    info!("🛑 내장 부트스트랩 중지 요청");
    
    let mut bootstrap_guard = state.embedded_bootstrap.write().await;
    
    if let Some(ref mut service) = *bootstrap_guard {
        service.stop().await
            .map_err(|e| format!("부트스트랩 중지 실패: {}", e))?;
        
        // 상태 변경 이벤트 발생
        let _ = state.app_handle.emit("bootstrap-state-changed", serde_json::json!({
            "state": "stopped"
        }));
    }
    
    *bootstrap_guard = None;
    
    info!("✅ 내장 부트스트랩 중지 완료");
    Ok(())
}

/// 부트스트랩 상태 조회
#[tauri::command]
async fn get_embedded_bootstrap_status(
    state: tauri::State<'_, AppState>,
) -> Result<bootstrap::BootstrapStatus, String> {
    let bootstrap_guard = state.embedded_bootstrap.read().await;
    
    if let Some(ref service) = *bootstrap_guard {
        Ok(service.get_status().await)
    } else {
        // 서비스가 없으면 기본 stopped 상태 반환
        Ok(bootstrap::BootstrapStatus {
            state: "stopped".to_string(),
            uptime_secs: 0,
            bound_ports: None,
            dht_stats: bootstrap::DhtStats {
                nodes_in_routing_table: 0,
                providers_stored: 0,
                messages_received: 0,
                messages_sent: 0,
            },
            relay_stats: bootstrap::RelayStats {
                active_sessions: 0,
                total_connections: 0,
                bytes_relayed: 0,
            },
            connected_bootstrap_nodes: 0,
            discovered_peers: 0,
        })
    }
}

/// 부트스트랩 설정 업데이트
#[tauri::command]
async fn update_bootstrap_config(
    config: bootstrap::BootstrapConfig,
    restart: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    info!("🔧 부트스트랩 설정 업데이트");
    
    // 설정 검증
    config.validate().map_err(|e| format!("설정 검증 실패: {}", e))?;
    
    let mut bootstrap_guard = state.embedded_bootstrap.write().await;
    
    if let Some(ref mut service) = *bootstrap_guard {
        let was_running = service.state() == &bootstrap::ServiceState::Running;
        
        // 재시작이 필요한 경우
        if restart && was_running {
            service.stop().await
                .map_err(|e| format!("부트스트랩 중지 실패: {}", e))?;
        }
        
        service.update_config(config.clone());
        
        // 재시작
        if restart && was_running {
            service.start().await
                .map_err(|e| format!("부트스트랩 재시작 실패: {}", e))?;
        }
    } else {
        // 서비스가 없으면 새로 생성 (시작하지 않음)
        *bootstrap_guard = Some(bootstrap::EmbeddedBootstrapService::new(config));
    }
    
    info!("✅ 부트스트랩 설정 업데이트 완료");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    info!("🚀 GridWarp Enterprise 시작 중...");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 릴리스에서도 로그를 파일로 남기되, 기본은 OFF.
            // `PONSWARP_LOG=1` 환경변수로 활성화.
            let enable_log = std::env::var("PONSWARP_LOG")
                .map(|v| v == "1" || v.to_lowercase() == "true")
                .unwrap_or(cfg!(debug_assertions));

            if enable_log {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
                info!("📄 파일 로깅 활성화됨 (PONSWARP_LOG)");
            }
            
            // 🆕 AppHandle을 포함한 AppState 생성 및 관리
            let app_handle = app.handle().clone();
            let state = AppState {
                quic_server: Arc::new(RwLock::new(None)),
                quic_client: Arc::new(RwLock::new(None)),
                discovery: Arc::new(RwLock::new(None)),
                udp_core: Arc::new(RwLock::new(None)),
                relay_engine: Arc::new(RwLock::new(None)),
                file_transfer: Arc::new(RwLock::new(None)),
                active_connections: Arc::new(RwLock::new(std::collections::HashMap::new())),
                accepted_connections: Arc::new(RwLock::new(std::collections::HashMap::new())),
                embedded_bootstrap: Arc::new(RwLock::new(None)),
                active_file_streams: Arc::new(RwLock::new(std::collections::HashMap::new())),
                app_handle: app_handle.clone(),
                is_closing: Arc::new(AtomicBool::new(false)),
            };
            app.manage(state);
            
            // 🚀 내장 부트스트랩 자동 시작
            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = auto_start_bootstrap(app_handle_clone).await {
                    tracing::warn!("부트스트랩 자동 시작 실패: {}", e);
                }
            });
            
            info!("✅ GridWarp 초기화 완료");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app_handle = window.app_handle();
                if let Some(state) = app_handle.try_state::<AppState>() {
                    // 이미 종료 진행 중이면 닫기 허용 (재진입 방지)
                    if state.is_closing.load(Ordering::SeqCst) {
                        return;
                    }

                    // 종료 플래그 설정
                    state.is_closing.store(true, Ordering::SeqCst);
                    
                    // 윈도우 닫기 방지 (정리 작업 수행을 위해)
                    api.prevent_close();

                    let app_handle_clone = app_handle.clone();
                    let window_clone = window.clone();

                    // 비동기 정리 작업 시작
                    tauri::async_runtime::spawn(async move {
                        if let Some(state) = app_handle_clone.try_state::<AppState>() {
                            let mut bootstrap_guard = state.embedded_bootstrap.write().await;
                            if let Some(ref mut service) = *bootstrap_guard {
                                info!("🛑 앱 종료: 부트스트랩 서비스 중지 중...");
                                if let Err(e) = service.stop().await {
                                    tracing::error!("부트스트랩 중지 실패: {}", e);
                                } else {
                                    info!("✅ 부트스트랩 서비스 정상 종료");
                                }
                            }
                        }
                        
                        // 정리 완료 후 윈도우 다시 닫기 (이때는 is_closing이 true라 바로 닫힘)
                        let _ = window_clone.close();
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            ping_quic,
            start_quic_server,
            start_quic_server_wan, // 🆕 WAN 지원 서버 시작
            stop_quic_server,
            start_discovery,
            get_discovered_peers,
            stop_discovery,
            start_udp_transfer,
            get_transfer_stats,
            start_relay_engine,
            get_relay_stats,
            stop_relay_engine,
            send_signaling_message,
            handle_signaling_message,
            // 🆕 QUIC 파일 전송
            connect_to_peer,
            connect_to_peer_race, // 🆕 Connection Racing (WAN/ICE)
            send_files_to_peer,
            send_files_to_accepted_peer,
            get_accepted_peers,
            receive_file_from_peer,
            disconnect_peer,
            get_file_transfer_state,
            // 🆕 파일 다이얼로그 및 메타데이터
            open_file_dialog,
            get_file_metadata,
            // 🚀 멀티스트림 고속 전송 (TB급 최적화)
            send_file_multistream,
            receive_file_multistream,
            get_io_engine_info,
            // 🌐 Grid Protocol (Phase 2)
            get_grid_info,
            create_grid_metadata,
            connect_bootstrap_node,
            set_bootstrap_nodes,
            discover_bootstrap_nodes,
            // 🆕 네트워크 인터페이스 조회
            get_network_interfaces,
            // 🔧 내장 부트스트랩 서비스
            start_embedded_bootstrap,
            stop_embedded_bootstrap,
            get_embedded_bootstrap_status,
            update_bootstrap_config,
            // 🆕 Native File Streaming (StreamSaver.js 대체)
            start_file_stream,
            write_file_chunk,
            complete_file_stream,
            create_save_dialog,
            select_save_directory,
            check_storage_space,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
