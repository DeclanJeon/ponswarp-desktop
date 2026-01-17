//! GridSwarm - Multi-Peer Connection Manager
//!
//! 여러 피어와의 연결을 관리하고, 스케줄러와 협력하여 데이터를 효율적으로 전송합니다.

use crate::grid::peer::{Peer, PeerCommand, PeerEvent, PeerState};
use crate::grid::piece_manager::{FileMetadata, PieceManager};
use crate::grid::protocol::GridMessage;
use crate::grid::scheduler::{PieceRequest, Scheduler};
use crate::grid::{GridStateUpdate, PeerStatus};
use quinn::Endpoint;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, RwLock, Semaphore};
use tokio::time::interval;
use tracing::{debug, error, info, warn};

/// Swarm 외부 명령
#[derive(Debug)]
pub enum SwarmCommand {
    /// 피어에 연결
    ConnectPeer(SocketAddr),
    /// 피어 연결 해제
    DisconnectPeer(String),
    /// Have 브로드캐스트
    BroadcastHave(u32),
    /// 특정 피어에게 조각 요청
    RequestPiece { peer_id: String, piece_index: u32 },
    /// 전송 시작 (Seeder)
    StartSeeding {
        file_path: PathBuf,
        metadata: FileMetadata,
    },
    /// 다운로드 시작 (Leecher)
    StartDownload {
        metadata: FileMetadata,
        save_path: PathBuf,
    },
    /// 전송 중지
    Stop,
}

/// Swarm 외부 이벤트
#[derive(Debug, Clone)]
pub enum SwarmEvent {
    /// 피어 연결됨
    PeerConnected(String),
    /// 피어 연결 해제됨
    PeerDisconnected(String),
    /// 조각 완료
    PieceCompleted(u32),
    /// 전송 완료
    TransferComplete,
    /// 에러 발생
    Error(String),
    /// 상태 업데이트
    StateUpdate(GridStateUpdate),
}

/// 피어 연결 정보
struct PeerConnection {
    command_tx: mpsc::Sender<PeerCommand>,
    state: PeerState,
}

/// Grid Swarm Manager
pub struct GridSwarm {
    /// QUIC 엔드포인트
    endpoint: Endpoint,
    /// 연결된 피어 목록
    peers: HashMap<String, PeerConnection>,
    /// 파일 상태 관리자
    piece_manager: Arc<RwLock<PieceManager>>,
    /// 스케줄러
    scheduler: Scheduler,
    /// 외부 명령 수신
    command_rx: mpsc::Receiver<SwarmCommand>,
    /// 외부 이벤트 발송
    event_tx: mpsc::Sender<SwarmEvent>,
    /// 피어 이벤트 수신
    peer_event_rx: mpsc::Receiver<PeerEvent>,
    /// 피어 이벤트 발송 (새 피어에게 전달)
    peer_event_tx: mpsc::Sender<PeerEvent>,
    /// 동시 연결 제한
    connection_semaphore: Arc<Semaphore>,
    /// 내 피어 ID
    my_peer_id: [u8; 32],
    /// Tauri AppHandle (UI 이벤트용)
    app_handle: Option<AppHandle>,
    /// Job ID
    job_id: String,
    /// 시작 시간
    started_at: Instant,
    /// 총 다운로드 바이트
    total_downloaded: u64,
    /// 총 업로드 바이트
    total_uploaded: u64,
}

impl GridSwarm {
    pub fn new(
        endpoint: Endpoint,
        piece_manager: Arc<RwLock<PieceManager>>,
        command_rx: mpsc::Receiver<SwarmCommand>,
        event_tx: mpsc::Sender<SwarmEvent>,
    ) -> Self {
        let (peer_event_tx, peer_event_rx) = mpsc::channel(256);
        let total_pieces = {
            // 동기적으로 접근할 수 없으므로 기본값 사용
            1000 // 나중에 초기화 시 업데이트
        };

        // 랜덤 피어 ID 생성
        let mut my_peer_id = [0u8; 32];
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut my_peer_id);

        Self {
            endpoint,
            peers: HashMap::new(),
            piece_manager,
            scheduler: Scheduler::new(total_pieces),
            command_rx,
            event_tx,
            peer_event_rx,
            peer_event_tx,
            connection_semaphore: Arc::new(Semaphore::new(50)), // 최대 50개 연결
            my_peer_id,
            app_handle: None,
            job_id: String::new(),
            started_at: Instant::now(),
            total_downloaded: 0,
            total_uploaded: 0,
        }
    }

    /// AppHandle 설정
    pub fn set_app_handle(&mut self, app_handle: AppHandle) {
        self.app_handle = Some(app_handle);
    }

    /// Job ID 설정
    pub fn set_job_id(&mut self, job_id: String) {
        self.job_id = job_id;
    }

    /// 메인 실행 루프
    pub async fn run(mut self) {
        info!("🐝 Grid Swarm 시작");
        self.started_at = Instant::now();

        let mut status_interval = interval(Duration::from_secs(1));
        let mut schedule_interval = interval(Duration::from_millis(100));

        loop {
            tokio::select! {
                // 1. 외부 명령 처리
                cmd = self.command_rx.recv() => {
                    match cmd {
                        Some(SwarmCommand::ConnectPeer(addr)) => {
                            self.connect_to_peer(addr).await;
                        }
                        Some(SwarmCommand::DisconnectPeer(peer_id)) => {
                            self.disconnect_peer(&peer_id).await;
                        }
                        Some(SwarmCommand::BroadcastHave(index)) => {
                            self.broadcast_have(index).await;
                        }
                        Some(SwarmCommand::RequestPiece { peer_id, piece_index }) => {
                            self.request_piece(&peer_id, piece_index).await;
                        }
                        Some(SwarmCommand::StartSeeding { file_path, metadata }) => {
                            self.start_seeding(file_path, metadata).await;
                        }
                        Some(SwarmCommand::StartDownload { metadata, save_path }) => {
                            self.start_download(metadata, save_path).await;
                        }
                        Some(SwarmCommand::Stop) => {
                            info!("🛑 Swarm 중지 요청");
                            break;
                        }
                        None => break,
                    }
                }

                // 2. 피어 이벤트 처리
                event = self.peer_event_rx.recv() => {
                    if let Some(event) = event {
                        self.handle_peer_event(event).await;
                    }
                }

                // 3. 들어오는 연결 수락
                Some(incoming) = self.endpoint.accept() => {
                    self.handle_incoming_connection(incoming).await;
                }

                // 4. 주기적 스케줄링
                _ = schedule_interval.tick() => {
                    self.schedule_requests().await;
                }

                // 5. 상태 업데이트 브로드캐스트
                _ = status_interval.tick() => {
                    self.broadcast_status().await;
                }
            }
        }

        info!("🐝 Grid Swarm 종료");
    }

    /// 피어에 연결
    async fn connect_to_peer(&mut self, addr: SocketAddr) {
        // 이미 연결된 피어인지 확인
        let peer_key = addr.to_string();
        if self.peers.contains_key(&peer_key) {
            debug!("이미 연결된 피어: {}", addr);
            return;
        }

        // 연결 제한 확인
        let permit = match self.connection_semaphore.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                warn!("최대 연결 수 초과, 연결 거부: {}", addr);
                return;
            }
        };

        info!("🔗 피어 연결 시도: {}", addr);

        match self.endpoint.connect(addr, "localhost") {
            Ok(connecting) => match connecting.await {
                Ok(connection) => {
                    info!("✅ 피어 연결 성공: {}", addr);

                    // 피어 태스크 생성
                    let (cmd_tx, cmd_rx) = mpsc::channel(32);
                    let peer = Peer::new(
                        connection,
                        self.piece_manager.clone(),
                        cmd_rx,
                        self.peer_event_tx.clone(),
                        self.my_peer_id,
                    );

                    let peer_id = peer.peer_id().to_string();

                    // 피어 상태 저장
                    self.peers.insert(
                        peer_id.clone(),
                        PeerConnection {
                            command_tx: cmd_tx,
                            state: PeerState::new(peer_id.clone(), addr.to_string()),
                        },
                    );

                    // 피어 태스크 실행
                    tauri::async_runtime::spawn(async move {
                        peer.run().await;
                        drop(permit); // 연결 종료 시 세마포어 해제
                    });

                    let _ = self.event_tx.send(SwarmEvent::PeerConnected(peer_id)).await;
                }
                Err(e) => {
                    warn!("❌ 연결 실패 (Handshake): {} - {}", addr, e);
                }
            },
            Err(e) => {
                warn!("❌ 연결 시도 실패: {} - {}", addr, e);
            }
        }
    }

    /// 피어 연결 해제
    async fn disconnect_peer(&mut self, peer_id: &str) {
        if let Some(peer) = self.peers.remove(peer_id) {
            let _ = peer.command_tx.send(PeerCommand::Disconnect).await;
            self.scheduler.remove_peer(peer_id);
            info!("🔌 피어 연결 해제: {}", peer_id);
            let _ = self
                .event_tx
                .send(SwarmEvent::PeerDisconnected(peer_id.to_string()))
                .await;
        }
    }

    /// 들어오는 연결 처리
    async fn handle_incoming_connection(&mut self, incoming: quinn::Incoming) {
        let permit = match self.connection_semaphore.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                warn!("최대 연결 수 초과, 들어오는 연결 거부");
                return;
            }
        };

        match incoming.await {
            Ok(connection) => {
                let addr = connection.remote_address();
                info!("📥 들어오는 연결 수락: {}", addr);

                let (cmd_tx, cmd_rx) = mpsc::channel(32);
                let peer = Peer::new(
                    connection,
                    self.piece_manager.clone(),
                    cmd_rx,
                    self.peer_event_tx.clone(),
                    self.my_peer_id,
                );

                let peer_id = peer.peer_id().to_string();

                self.peers.insert(
                    peer_id.clone(),
                    PeerConnection {
                        command_tx: cmd_tx,
                        state: PeerState::new(peer_id.clone(), addr.to_string()),
                    },
                );

                tauri::async_runtime::spawn(async move {
                    peer.run().await;
                    drop(permit);
                });

                let _ = self.event_tx.send(SwarmEvent::PeerConnected(peer_id)).await;
            }
            Err(e) => {
                error!("❌ 들어오는 연결 실패: {}", e);
            }
        }
    }

    /// 피어 이벤트 처리
    async fn handle_peer_event(&mut self, event: PeerEvent) {
        match event {
            PeerEvent::Disconnected { peer_id, reason } => {
                info!("📴 피어 연결 종료: {} - {}", peer_id, reason);
                self.peers.remove(&peer_id);
                self.scheduler.remove_peer(&peer_id);
                let _ = self
                    .event_tx
                    .send(SwarmEvent::PeerDisconnected(peer_id))
                    .await;
            }

            PeerEvent::HandshakeComplete { peer_id, .. } => {
                info!("🤝 Handshake 완료: {}", peer_id);
            }

            PeerEvent::BitfieldReceived { peer_id, pieces } => {
                debug!("📊 Bitfield 수신: {} ({} pieces)", peer_id, pieces.len());
                self.scheduler.set_peer_bitfield(&peer_id, pieces);
            }

            PeerEvent::HaveReceived {
                peer_id,
                piece_index,
            } => {
                debug!("📢 Have 수신: {} has piece {}", peer_id, piece_index);
                self.scheduler
                    .peer_has_piece(&peer_id, piece_index as usize);
            }

            PeerEvent::PieceReceived {
                peer_id,
                piece_index,
                data,
                ..
            } => {
                self.total_downloaded += data.len() as u64;

                // 조각 검증 및 파일에 저장
                let mut pm = self.piece_manager.write().await;

                match pm.write_piece(piece_index as usize, &data).await {
                    Ok(()) => {
                        drop(pm);

                        self.scheduler.mark_completed(piece_index as usize);

                        // Have 브로드캐스트
                        self.broadcast_have(piece_index).await;

                        let _ = self
                            .event_tx
                            .send(SwarmEvent::PieceCompleted(piece_index))
                            .await;

                        // 완료 확인
                        if self.scheduler.is_complete() {
                            info!("🎉 전송 완료!");
                            let _ = self.event_tx.send(SwarmEvent::TransferComplete).await;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "❌ 조각 저장 실패: {} from {} - {}",
                            piece_index, peer_id, e
                        );
                    }
                }
            }

            PeerEvent::RequestReceived {
                peer_id,
                piece_index,
                offset,
                length,
            } => {
                // 조각 데이터 전송 (Seeder 역할)
                self.send_piece(&peer_id, piece_index, offset, length).await;
            }

            PeerEvent::ChokeChanged { peer_id, choked } => {
                if let Some(peer) = self.peers.get_mut(&peer_id) {
                    peer.state.peer_choking = choked;
                }
            }

            PeerEvent::InterestChanged {
                peer_id,
                interested,
            } => {
                if let Some(peer) = self.peers.get_mut(&peer_id) {
                    peer.state.peer_interested = interested;
                }
            }

            PeerEvent::Error { peer_id, message } => {
                warn!("⚠️ 피어 에러: {} - {}", peer_id, message);
            }
        }
    }

    /// Have 브로드캐스트
    async fn broadcast_have(&self, piece_index: u32) {
        let msg = GridMessage::Have { piece_index };
        for (_, peer) in &self.peers {
            let _ = peer
                .command_tx
                .send(PeerCommand::SendMessage(msg.clone()))
                .await;
        }
    }

    /// 조각 요청
    async fn request_piece(&mut self, peer_id: &str, piece_index: u32) {
        if let Some(peer) = self.peers.get(peer_id) {
            let pm = self.piece_manager.read().await;
            if let Some(piece_info) = pm.get_piece_info(piece_index as usize) {
                let msg = GridMessage::request(piece_index, 0, piece_info.length);
                let _ = peer.command_tx.send(PeerCommand::SendMessage(msg)).await;
                self.scheduler.mark_pending(piece_index as usize);
            }
        }
    }

    /// 조각 데이터 전송
    async fn send_piece(&mut self, peer_id: &str, piece_index: u32, _offset: u32, _length: u32) {
        if let Some(peer) = self.peers.get(peer_id) {
            // PieceManager에서 조각 정보 확인
            let pm = self.piece_manager.read().await;

            if !pm.get_bitfield().has(piece_index as usize) {
                warn!("요청된 조각 {}을 보유하지 않음", piece_index);
                return;
            }

            // 실제 파일에서 데이터 읽기
            let data = match pm.read_piece(piece_index as usize).await {
                Ok(d) => d,
                Err(e) => {
                    warn!("조각 {} 읽기 실패: {}", piece_index, e);
                    return;
                }
            };
            drop(pm);

            let msg = GridMessage::piece(piece_index, 0, data.clone());
            if let Err(e) = peer.command_tx.send(PeerCommand::SendMessage(msg)).await {
                warn!("조각 전송 실패: {}", e);
                return;
            }
            self.total_uploaded += data.len() as u64;
            debug!("📤 조각 {} 전송 완료 -> {}", piece_index, peer_id);
        }
    }

    /// 주기적 스케줄링
    async fn schedule_requests(&mut self) {
        let requests = self.scheduler.generate_requests(16);

        for req in requests {
            self.request_piece(&req.target_peer, req.piece_index as u32)
                .await;
        }
    }

    /// 상태 업데이트 브로드캐스트
    async fn broadcast_status(&self) {
        let pm = self.piece_manager.read().await;
        let elapsed = self.started_at.elapsed().as_secs().max(1);

        let update = GridStateUpdate {
            job_id: self.job_id.clone(),
            total_pieces: pm.total_pieces(),
            completed_pieces: pm.get_bitfield().available_pieces(),
            peers: self
                .peers
                .iter()
                .map(|(id, p)| PeerStatus {
                    address: p.state.remote_addr.clone(),
                    peer_id: id.clone(),
                    rtt_ms: p.state.rtt_ms,
                    download_speed: p.state.download_speed(),
                    upload_speed: p.state.upload_speed(),
                    pieces_have: p
                        .state
                        .bitfield
                        .as_ref()
                        .map(|b| b.count_ones())
                        .unwrap_or(0),
                    is_choked: p.state.peer_choking,
                    is_interested: p.state.peer_interested,
                })
                .collect(),
            download_speed: self.total_downloaded / elapsed,
            upload_speed: self.total_uploaded / elapsed,
            progress: pm.progress(),
        };

        // Tauri 이벤트 발송
        if let Some(ref app) = self.app_handle {
            let _ = app.emit("grid-update", &update);
        }

        let _ = self.event_tx.send(SwarmEvent::StateUpdate(update)).await;
    }

    /// Seeding 시작
    async fn start_seeding(&mut self, _file_path: PathBuf, metadata: FileMetadata) {
        info!("🌱 Seeding 시작: {}", metadata.file_name);
        let total_pieces = metadata.total_pieces;

        *self.piece_manager.write().await = PieceManager::new_seeder(metadata);
        self.scheduler = Scheduler::new(total_pieces);

        // 모든 조각 완료 표시
        for i in 0..total_pieces {
            self.scheduler.mark_completed(i);
        }
    }

    /// Download 시작
    async fn start_download(&mut self, metadata: FileMetadata, save_path: PathBuf) {
        info!("📥 Download 시작: {}", metadata.file_name);
        let total_pieces = metadata.total_pieces;

        let mut pm = PieceManager::new(metadata);
        pm.set_save_path(save_path);
        *self.piece_manager.write().await = pm;

        self.scheduler = Scheduler::new(total_pieces);
    }
}
