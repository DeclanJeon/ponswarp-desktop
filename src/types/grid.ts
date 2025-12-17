/**
 * Grid Protocol 타입 정의
 */

/** 피어 정보 */
export interface GridPeerInfo {
  peerId: string;
  address: string;
  rttMs?: number;
  downloadSpeed: number;
  uploadSpeed: number;
  piecesHave: number;
  isChoked: boolean;
  isInterested: boolean;
}

/** Swarm 상태 */
export interface GridSwarmState {
  jobId: string;
  totalPieces: number;
  completedPieces: number[];
  peers: GridPeerInfo[];
  downloadSpeed: number;
  uploadSpeed: number;
  progress: number;
}

/** Grid 상태 업데이트 이벤트 (Rust -> JS) */
export interface GridStateUpdateEvent {
  job_id: string;
  total_pieces: number;
  completed_pieces: number[];
  peers: {
    address: string;
    peer_id: string;
    rtt_ms: number | null;
    download_speed: number;
    upload_speed: number;
    pieces_have: number;
    is_choked: boolean;
    is_interested: boolean;
  }[];
  download_speed: number;
  upload_speed: number;
  progress: number;
}

/** 피어 발견 이벤트 */
export interface GridPeerDiscoveredEvent {
  peer_id: string;
  address: string;
  source: 'mdns' | 'dht';
}

/** 파일 메타데이터 */
export interface GridFileMetadata {
  infoHash: string;
  fileName: string;
  fileSize: number;
  pieceSize: number;
  totalPieces: number;
  pieceHashes: string[];
}

/** 스케줄링 모드 */
export type ScheduleMode = 'random-first' | 'rare-first' | 'endgame';

/** 스케줄러 통계 */
export interface SchedulerStats {
  totalPieces: number;
  completed: number;
  pending: number;
  connectedPeers: number;
  mode: ScheduleMode;
  rarestPiece?: {
    index: number;
    frequency: number;
  };
}

/** Grid 설정 */
export interface GridConfig {
  maxPeers: number;
  maxPendingRequests: number;
  pieceSize: number;
  enableDht: boolean;
  enableMdns: boolean;
  uploadLimit?: number; // bytes/sec, undefined = unlimited
  downloadLimit?: number;
}

/** Grid 정보 (get_grid_info 응답) */
export interface GridInfo {
  version: string;
  features: string[];
  defaultPieceSize: number;
  maxPeers: number;
  maxPendingRequests: number;
}

/** Rust 이벤트 이름 */
export const GRID_EVENTS = {
  STATE_UPDATE: 'grid-update',
  PEER_DISCOVERED: 'grid-peer-discovered',
  PIECE_COMPLETED: 'grid-piece-completed',
  TRANSFER_COMPLETE: 'grid-transfer-complete',
  ERROR: 'grid-error',
} as const;

/** GridStateUpdateEvent를 GridSwarmState로 변환 */
export function convertGridState(event: GridStateUpdateEvent): GridSwarmState {
  return {
    jobId: event.job_id,
    totalPieces: event.total_pieces,
    completedPieces: event.completed_pieces,
    peers: event.peers.map(p => ({
      peerId: p.peer_id,
      address: p.address,
      rttMs: p.rtt_ms ?? undefined,
      downloadSpeed: p.download_speed,
      uploadSpeed: p.upload_speed,
      piecesHave: p.pieces_have,
      isChoked: p.is_choked,
      isInterested: p.is_interested,
    })),
    downloadSpeed: event.download_speed,
    uploadSpeed: event.upload_speed,
    progress: event.progress,
  };
}
