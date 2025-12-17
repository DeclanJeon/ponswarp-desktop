//! Grid Wire Protocol - 피어 간 메시지 프로토콜
//!
//! BitTorrent Wire Protocol을 현대적으로 재해석하여 QUIC 스트림 위에서 동작하도록 설계.
//! Length-Prefixed Framing + Bincode 직렬화 사용.

use serde::{Deserialize, Serialize};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 프로토콜 버전
pub const PROTOCOL_VERSION: u32 = 1;

/// 최대 메시지 크기 (10MB)
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// Grid 프로토콜 메시지 타입
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GridMessage {
    /// 연결 초기화 (InfoHash 검증 포함)
    Handshake {
        protocol_version: u32,
        info_hash: [u8; 32],
        peer_id: [u8; 32],
        /// 피어 기능 플래그
        extensions: u64,
    },

    /// 전체 조각 보유 현황 (비트맵)
    Bitfield { data: Vec<u8>, length: usize },

    /// 단일 조각 보유 알림 (새로 다운로드 완료 시)
    Have { piece_index: u32 },

    /// 데이터 요청
    Request {
        piece_index: u32,
        offset: u32,
        length: u32,
    },

    /// 데이터 전송 (Payload)
    Piece {
        piece_index: u32,
        offset: u32,
        data: Vec<u8>,
    },

    /// 요청 취소 (다른 피어에게 받았을 때)
    Cancel {
        piece_index: u32,
        offset: u32,
        length: u32,
    },

    /// 연결 유지 (Keep-Alive)
    KeepAlive,

    /// Choke - 더 이상 데이터를 보내지 않겠다
    Choke,

    /// Unchoke - 데이터를 보낼 준비가 됨
    Unchoke,

    /// Interested - 상대방의 데이터에 관심 있음
    Interested,

    /// NotInterested - 상대방의 데이터에 관심 없음
    NotInterested,

    /// 파일 메타데이터 요청
    MetadataRequest { info_hash: [u8; 32] },

    /// 파일 메타데이터 응답
    MetadataResponse {
        info_hash: [u8; 32],
        file_name: String,
        file_size: u64,
        piece_size: u32,
        total_pieces: usize,
        piece_hashes: Vec<[u8; 32]>,
    },

    /// 에러 메시지
    Error { code: u32, message: String },
}

/// 확장 기능 플래그
pub mod extensions {
    pub const FAST_EXTENSION: u64 = 1 << 0;
    pub const DHT: u64 = 1 << 1;
    pub const ENCRYPTION: u64 = 1 << 2;
    pub const METADATA_EXCHANGE: u64 = 1 << 3;
}

impl GridMessage {
    /// 메시지 직렬화 및 전송
    pub async fn write_to<W>(&self, writer: &mut W) -> io::Result<()>
    where
        W: AsyncWrite + Unpin,
    {
        // 1. bincode로 직렬화
        let encoded = bincode::serialize(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        // 2. 길이 프리픽스 (Length-Prefixed) 방식 전송
        // [Length(4bytes LE)][Payload...]
        let len = encoded.len() as u32;
        writer.write_all(&len.to_le_bytes()).await?;
        writer.write_all(&encoded).await?;

        Ok(())
    }

    /// 메시지 수신 및 역직렬화
    pub async fn read_from<R>(reader: &mut R) -> io::Result<Self>
    where
        R: AsyncRead + Unpin,
    {
        // 1. 길이 읽기 (4 bytes)
        let mut len_buf = [0u8; 4];
        reader.read_exact(&mut len_buf).await?;
        let len = u32::from_le_bytes(len_buf) as usize;

        // 메시지 크기 제한 (보안: 너무 큰 패킷 거부)
        if len > MAX_MESSAGE_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Message too large: {} bytes (max: {})", len, MAX_MESSAGE_SIZE),
            ));
        }

        // 2. 페이로드 읽기
        let mut buf = vec![0u8; len];
        reader.read_exact(&mut buf).await?;

        // 3. 역직렬화
        let message = bincode::deserialize(&buf)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        Ok(message)
    }

    /// 메시지 타입 이름 반환 (로깅용)
    pub fn type_name(&self) -> &'static str {
        match self {
            GridMessage::Handshake { .. } => "Handshake",
            GridMessage::Bitfield { .. } => "Bitfield",
            GridMessage::Have { .. } => "Have",
            GridMessage::Request { .. } => "Request",
            GridMessage::Piece { .. } => "Piece",
            GridMessage::Cancel { .. } => "Cancel",
            GridMessage::KeepAlive => "KeepAlive",
            GridMessage::Choke => "Choke",
            GridMessage::Unchoke => "Unchoke",
            GridMessage::Interested => "Interested",
            GridMessage::NotInterested => "NotInterested",
            GridMessage::MetadataRequest { .. } => "MetadataRequest",
            GridMessage::MetadataResponse { .. } => "MetadataResponse",
            GridMessage::Error { .. } => "Error",
        }
    }

    /// Handshake 메시지 생성 헬퍼
    pub fn handshake(info_hash: [u8; 32], peer_id: [u8; 32]) -> Self {
        GridMessage::Handshake {
            protocol_version: PROTOCOL_VERSION,
            info_hash,
            peer_id,
            extensions: extensions::FAST_EXTENSION | extensions::DHT | extensions::METADATA_EXCHANGE,
        }
    }

    /// Bitfield 메시지 생성 헬퍼
    pub fn bitfield(data: Vec<u8>, length: usize) -> Self {
        GridMessage::Bitfield { data, length }
    }

    /// Request 메시지 생성 헬퍼
    pub fn request(piece_index: u32, offset: u32, length: u32) -> Self {
        GridMessage::Request {
            piece_index,
            offset,
            length,
        }
    }

    /// Piece 메시지 생성 헬퍼
    pub fn piece(piece_index: u32, offset: u32, data: Vec<u8>) -> Self {
        GridMessage::Piece {
            piece_index,
            offset,
            data,
        }
    }
}

/// 메시지 배치 전송 (여러 메시지를 한 번에)
pub struct MessageBatch {
    messages: Vec<GridMessage>,
}

impl MessageBatch {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
        }
    }

    pub fn push(&mut self, msg: GridMessage) {
        self.messages.push(msg);
    }

    pub async fn write_all<W>(&self, writer: &mut W) -> io::Result<()>
    where
        W: AsyncWrite + Unpin,
    {
        for msg in &self.messages {
            msg.write_to(writer).await?;
        }
        writer.flush().await?;
        Ok(())
    }
}

impl Default for MessageBatch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn test_message_roundtrip() {
        let original = GridMessage::Have { piece_index: 42 };

        let mut buffer = Vec::new();
        original.write_to(&mut buffer).await.unwrap();

        let mut cursor = Cursor::new(buffer);
        let decoded = GridMessage::read_from(&mut cursor).await.unwrap();

        match decoded {
            GridMessage::Have { piece_index } => assert_eq!(piece_index, 42),
            _ => panic!("Wrong message type"),
        }
    }

    #[tokio::test]
    async fn test_handshake_message() {
        let info_hash = [1u8; 32];
        let peer_id = [2u8; 32];
        let msg = GridMessage::handshake(info_hash, peer_id);

        let mut buffer = Vec::new();
        msg.write_to(&mut buffer).await.unwrap();

        let mut cursor = Cursor::new(buffer);
        let decoded = GridMessage::read_from(&mut cursor).await.unwrap();

        match decoded {
            GridMessage::Handshake {
                protocol_version,
                info_hash: ih,
                peer_id: pid,
                ..
            } => {
                assert_eq!(protocol_version, PROTOCOL_VERSION);
                assert_eq!(ih, info_hash);
                assert_eq!(pid, peer_id);
            }
            _ => panic!("Wrong message type"),
        }
    }

    #[tokio::test]
    async fn test_piece_message() {
        let data = vec![0u8; 1024];
        let msg = GridMessage::piece(5, 0, data.clone());

        let mut buffer = Vec::new();
        msg.write_to(&mut buffer).await.unwrap();

        let mut cursor = Cursor::new(buffer);
        let decoded = GridMessage::read_from(&mut cursor).await.unwrap();

        match decoded {
            GridMessage::Piece {
                piece_index,
                offset,
                data: d,
            } => {
                assert_eq!(piece_index, 5);
                assert_eq!(offset, 0);
                assert_eq!(d.len(), 1024);
            }
            _ => panic!("Wrong message type"),
        }
    }
}
