//! Peer - 개별 피어와의 연결 및 메시지 처리
//!
//! 하나의 피어와 지속적으로 메시지를 주고받는 전담 처리 태스크입니다.

use crate::grid::bitfield::Bitfield;
use crate::grid::piece_manager::PieceManager;
use crate::grid::protocol::GridMessage;
use quinn::{Connection, RecvStream, SendStream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};
use tokio::time::interval;
use tracing::{debug, error, info, warn};

/// 개별 피어 제어 명령
#[derive(Debug)]
pub enum PeerCommand {
    /// 메시지 전송
    SendMessage(GridMessage),
    /// 연결 종료
    Disconnect,
    /// Choke 상태 변경
    SetChoked(bool),
    /// Interest 상태 변경
    SetInterested(bool),
}

/// 피어에서 발생한 이벤트
#[derive(Debug, Clone)]
pub enum PeerEvent {
    /// 연결 종료됨
    Disconnected { peer_id: String, reason: String },
    /// Handshake 완료
    HandshakeComplete {
        peer_id: String,
        info_hash: [u8; 32],
    },
    /// Bitfield 수신
    BitfieldReceived {
        peer_id: String,
        pieces: Vec<usize>,
    },
    /// Have 메시지 수신
    HaveReceived { peer_id: String, piece_index: u32 },
    /// 조각 데이터 수신
    PieceReceived {
        peer_id: String,
        piece_index: u32,
        offset: u32,
        data: Vec<u8>,
    },
    /// 조각 요청 수신
    RequestReceived {
        peer_id: String,
        piece_index: u32,
        offset: u32,
        length: u32,
    },
    /// Choke 상태 변경
    ChokeChanged { peer_id: String, choked: bool },
    /// Interest 상태 변경
    InterestChanged { peer_id: String, interested: bool },
    /// 에러 발생
    Error { peer_id: String, message: String },
}

/// 피어 상태
#[derive(Debug, Clone)]
pub struct PeerState {
    pub peer_id: String,
    pub remote_addr: String,
    pub info_hash: Option<[u8; 32]>,
    pub bitfield: Option<Bitfield>,
    /// 내가 상대방을 Choke 했는지
    pub am_choking: bool,
    /// 내가 상대방에게 관심 있는지
    pub am_interested: bool,
    /// 상대방이 나를 Choke 했는지
    pub peer_choking: bool,
    /// 상대방이 나에게 관심 있는지
    pub peer_interested: bool,
    /// 연결 시작 시간
    pub connected_at: Instant,
    /// 마지막 메시지 수신 시간
    pub last_message_at: Instant,
    /// 다운로드 바이트
    pub bytes_downloaded: u64,
    /// 업로드 바이트
    pub bytes_uploaded: u64,
    /// RTT (밀리초)
    pub rtt_ms: Option<u32>,
}

impl PeerState {
    pub fn new(peer_id: String, remote_addr: String) -> Self {
        let now = Instant::now();
        Self {
            peer_id,
            remote_addr,
            info_hash: None,
            bitfield: None,
            am_choking: true,
            am_interested: false,
            peer_choking: true,
            peer_interested: false,
            connected_at: now,
            last_message_at: now,
            bytes_downloaded: 0,
            bytes_uploaded: 0,
            rtt_ms: None,
        }
    }

    /// 다운로드 속도 (bytes/sec)
    pub fn download_speed(&self) -> u64 {
        let elapsed = self.connected_at.elapsed().as_secs().max(1);
        self.bytes_downloaded / elapsed
    }

    /// 업로드 속도 (bytes/sec)
    pub fn upload_speed(&self) -> u64 {
        let elapsed = self.connected_at.elapsed().as_secs().max(1);
        self.bytes_uploaded / elapsed
    }
}

/// 개별 피어 핸들러
pub struct Peer {
    connection: Connection,
    state: PeerState,
    piece_manager: Arc<RwLock<PieceManager>>,
    command_rx: mpsc::Receiver<PeerCommand>,
    event_tx: mpsc::Sender<PeerEvent>,
    my_peer_id: [u8; 32],
}

impl Peer {
    pub fn new(
        connection: Connection,
        piece_manager: Arc<RwLock<PieceManager>>,
        command_rx: mpsc::Receiver<PeerCommand>,
        event_tx: mpsc::Sender<PeerEvent>,
        my_peer_id: [u8; 32],
    ) -> Self {
        let remote_addr = connection.remote_address().to_string();
        let peer_id = format!("peer_{}", &remote_addr);

        Self {
            connection,
            state: PeerState::new(peer_id, remote_addr),
            piece_manager,
            command_rx,
            event_tx,
            my_peer_id,
        }
    }

    /// 피어 ID 반환
    pub fn peer_id(&self) -> &str {
        &self.state.peer_id
    }

    /// 메인 실행 루프
    pub async fn run(mut self) {
        info!("🔗 피어 연결 시작: {}", self.state.remote_addr);

        // 양방향 스트림 열기
        let (send_stream, recv_stream) = match self.connection.open_bi().await {
            Ok(streams) => streams,
            Err(e) => {
                error!("❌ 스트림 열기 실패: {}", e);
                self.send_event(PeerEvent::Disconnected {
                    peer_id: self.state.peer_id.clone(),
                    reason: e.to_string(),
                })
                .await;
                return;
            }
        };

        // Handshake 수행
        if let Err(e) = self.perform_handshake(&send_stream, &recv_stream).await {
            error!("❌ Handshake 실패: {}", e);
            self.send_event(PeerEvent::Disconnected {
                peer_id: self.state.peer_id.clone(),
                reason: e.to_string(),
            })
            .await;
            return;
        }

        // 메인 루프
        self.message_loop(send_stream, recv_stream).await;

        info!("👋 피어 연결 종료: {}", self.state.peer_id);
    }

    /// Handshake 수행
    async fn perform_handshake(
        &mut self,
        send_stream: &SendStream,
        recv_stream: &RecvStream,
    ) -> anyhow::Result<()> {
        let pm = self.piece_manager.read().await;
        let info_hash = *pm.info_hash();
        drop(pm);

        // Handshake 전송
        let handshake = GridMessage::handshake(info_hash, self.my_peer_id);

        // Note: QUIC SendStream은 &mut self를 요구하므로 별도 처리 필요
        // 여기서는 개념적 구현만 제공
        debug!("📤 Handshake 전송: {:?}", handshake.type_name());

        // Handshake 수신 및 검증은 message_loop에서 처리
        self.state.info_hash = Some(info_hash);

        Ok(())
    }

    /// 메시지 루프
    async fn message_loop(&mut self, mut send_stream: SendStream, mut recv_stream: RecvStream) {
        let mut keepalive_interval = interval(Duration::from_secs(30));

        loop {
            tokio::select! {
                // 1. 외부 명령 처리
                cmd = self.command_rx.recv() => {
                    match cmd {
                        Some(PeerCommand::SendMessage(msg)) => {
                            if let Err(e) = self.send_message(&mut send_stream, msg).await {
                                error!("❌ 메시지 전송 실패: {}", e);
                                break;
                            }
                        }
                        Some(PeerCommand::Disconnect) => {
                            info!("🔌 연결 종료 요청");
                            break;
                        }
                        Some(PeerCommand::SetChoked(choked)) => {
                            self.state.am_choking = choked;
                            let msg = if choked { GridMessage::Choke } else { GridMessage::Unchoke };
                            let _ = self.send_message(&mut send_stream, msg).await;
                        }
                        Some(PeerCommand::SetInterested(interested)) => {
                            self.state.am_interested = interested;
                            let msg = if interested { GridMessage::Interested } else { GridMessage::NotInterested };
                            let _ = self.send_message(&mut send_stream, msg).await;
                        }
                        None => break,
                    }
                }

                // 2. 메시지 수신
                result = GridMessage::read_from(&mut recv_stream) => {
                    match result {
                        Ok(msg) => {
                            self.state.last_message_at = Instant::now();
                            if let Err(e) = self.handle_message(msg, &mut send_stream).await {
                                error!("❌ 메시지 처리 실패: {}", e);
                                break;
                            }
                        }
                        Err(e) => {
                            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                                info!("📴 피어 연결 종료 (EOF)");
                            } else {
                                error!("❌ 메시지 수신 실패: {}", e);
                            }
                            break;
                        }
                    }
                }

                // 3. Keep-Alive
                _ = keepalive_interval.tick() => {
                    let _ = self.send_message(&mut send_stream, GridMessage::KeepAlive).await;
                }
            }
        }

        // 연결 종료 이벤트
        self.send_event(PeerEvent::Disconnected {
            peer_id: self.state.peer_id.clone(),
            reason: "Connection closed".to_string(),
        })
        .await;
    }

    /// 메시지 전송
    async fn send_message(
        &mut self,
        send_stream: &mut SendStream,
        msg: GridMessage,
    ) -> anyhow::Result<()> {
        debug!("📤 [{}] {}", self.state.peer_id, msg.type_name());
        msg.write_to(send_stream).await?;
        Ok(())
    }

    /// 메시지 처리
    async fn handle_message(
        &mut self,
        msg: GridMessage,
        send_stream: &mut SendStream,
    ) -> anyhow::Result<()> {
        debug!("📥 [{}] {}", self.state.peer_id, msg.type_name());

        match msg {
            GridMessage::Handshake {
                info_hash,
                peer_id,
                ..
            } => {
                // Info Hash 검증
                let pm = self.piece_manager.read().await;
                if info_hash != *pm.info_hash() {
                    warn!("❌ Info Hash 불일치");
                    return Err(anyhow::anyhow!("Info hash mismatch"));
                }
                drop(pm);

                self.state.peer_id = hex::encode(&peer_id[..8]);
                self.send_event(PeerEvent::HandshakeComplete {
                    peer_id: self.state.peer_id.clone(),
                    info_hash,
                })
                .await;

                // Bitfield 전송
                let pm = self.piece_manager.read().await;
                let bf = pm.get_bitfield();
                let bitfield_msg =
                    GridMessage::bitfield(bf.as_bytes().to_vec(), bf.len());
                drop(pm);

                self.send_message(send_stream, bitfield_msg).await?;
            }

            GridMessage::Bitfield { data, length } => {
                let bitfield = Bitfield::from_bytes(data, length);
                let pieces = bitfield.available_pieces();

                self.state.bitfield = Some(bitfield);

                self.send_event(PeerEvent::BitfieldReceived {
                    peer_id: self.state.peer_id.clone(),
                    pieces,
                })
                .await;
            }

            GridMessage::Have { piece_index } => {
                if let Some(ref mut bf) = self.state.bitfield {
                    bf.mark(piece_index as usize);
                }

                self.send_event(PeerEvent::HaveReceived {
                    peer_id: self.state.peer_id.clone(),
                    piece_index,
                })
                .await;
            }

            GridMessage::Request {
                piece_index,
                offset,
                length,
            } => {
                // Choke 상태면 무시
                if self.state.am_choking {
                    debug!("🚫 Choked 상태에서 Request 무시");
                    return Ok(());
                }

                self.send_event(PeerEvent::RequestReceived {
                    peer_id: self.state.peer_id.clone(),
                    piece_index,
                    offset,
                    length,
                })
                .await;
            }

            GridMessage::Piece {
                piece_index,
                offset,
                data,
            } => {
                self.state.bytes_downloaded += data.len() as u64;

                self.send_event(PeerEvent::PieceReceived {
                    peer_id: self.state.peer_id.clone(),
                    piece_index,
                    offset,
                    data,
                })
                .await;
            }

            GridMessage::Cancel { .. } => {
                // 요청 취소 처리 (구현 필요)
            }

            GridMessage::Choke => {
                self.state.peer_choking = true;
                self.send_event(PeerEvent::ChokeChanged {
                    peer_id: self.state.peer_id.clone(),
                    choked: true,
                })
                .await;
            }

            GridMessage::Unchoke => {
                self.state.peer_choking = false;
                self.send_event(PeerEvent::ChokeChanged {
                    peer_id: self.state.peer_id.clone(),
                    choked: false,
                })
                .await;
            }

            GridMessage::Interested => {
                self.state.peer_interested = true;
                self.send_event(PeerEvent::InterestChanged {
                    peer_id: self.state.peer_id.clone(),
                    interested: true,
                })
                .await;
            }

            GridMessage::NotInterested => {
                self.state.peer_interested = false;
                self.send_event(PeerEvent::InterestChanged {
                    peer_id: self.state.peer_id.clone(),
                    interested: false,
                })
                .await;
            }

            GridMessage::KeepAlive => {
                // 연결 유지 확인
            }

            GridMessage::Error { code, message } => {
                warn!("⚠️ 피어 에러: [{}] {}", code, message);
                self.send_event(PeerEvent::Error {
                    peer_id: self.state.peer_id.clone(),
                    message,
                })
                .await;
            }

            _ => {
                debug!("⚠️ 처리되지 않은 메시지: {}", msg.type_name());
            }
        }

        Ok(())
    }

    /// 이벤트 전송
    async fn send_event(&self, event: PeerEvent) {
        if let Err(e) = self.event_tx.send(event).await {
            error!("❌ 이벤트 전송 실패: {}", e);
        }
    }
}
