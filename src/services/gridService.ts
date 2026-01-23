/**
 * Grid Protocol 서비스
 *
 * Tauri 백엔드의 Grid 기능을 호출하는 API 래퍼
 * 웹 환경에서는 WebSocket을 통해 부트스트랩 노드에 직접 연결
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { isNative } from '../utils/tauri';
import {
  GridInfo,
  GridStateUpdateEvent,
  GridSwarmState,
  GridPeerDiscoveredEvent,
  convertGridState,
  GRID_EVENTS,
} from '../types/grid';

// 웹 환경용 Grid 서비스 임포트
import {
  getWebGridInfo,
  connectWebBootstrapNode,
  autoConnectWebBootstrap,
  setWebBootstrapNodes,
  getWebBootstrapNodes,
} from './webGridService';

/**
 * Grid 정보 조회
 */
export async function getGridInfo(): Promise<GridInfo> {
  const native = await isNative();
  if (native) {
    return invoke<GridInfo>('get_grid_info');
  } else {
    return getWebGridInfo();
  }
}

/**
 * 파일 메타데이터 생성 (Grid 전송 준비)
 */
export async function createGridMetadata(
  filePath: string,
  pieceSize?: number
): Promise<{
  infoHash: string;
  fileName: string;
  fileSize: number;
  pieceSize: number;
  totalPieces: number;
  merkleRoot?: string;
}> {
  return invoke('create_grid_metadata', {
    filePath,
    pieceSize,
  });
}

/**
 * Grid 상태 업데이트 리스너 등록
 */
export function onGridStateUpdate(
  callback: (state: GridSwarmState) => void
): Promise<UnlistenFn> {
  return listen<GridStateUpdateEvent>(GRID_EVENTS.STATE_UPDATE, event => {
    callback(convertGridState(event.payload));
  });
}

/**
 * 피어 발견 이벤트 리스너 등록
 */
export function onPeerDiscovered(
  callback: (event: GridPeerDiscoveredEvent) => void
): Promise<UnlistenFn> {
  return listen<GridPeerDiscoveredEvent>(GRID_EVENTS.PEER_DISCOVERED, event => {
    callback(event.payload);
  });
}

/**
 * 전송 완료 이벤트 리스너 등록
 */
export function onTransferComplete(
  callback: (jobId: string) => void
): Promise<UnlistenFn> {
  return listen<{ jobId: string }>(GRID_EVENTS.TRANSFER_COMPLETE, event => {
    callback(event.payload.jobId);
  });
}

/**
 * Grid 에러 이벤트 리스너 등록
 */
export function onGridError(
  callback: (error: string) => void
): Promise<UnlistenFn> {
  return listen<{ message: string }>(GRID_EVENTS.ERROR, event => {
    callback(event.payload.message);
  });
}

/**
 * 속도 포맷팅 유틸리티
 */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(1)} GB/s`;
  }
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSec >= 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }
  return `${bytesPerSec} B/s`;
}

/**
 * 파일 크기 포맷팅 유틸리티
 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

/**
 * 시간 포맷팅 유틸리티
 */
export function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * DHT 부트스트랩 노드에 연결
 */
export async function connectBootstrapNode(address: string): Promise<boolean> {
  const native = await isNative();
  if (native) {
    return invoke<boolean>('connect_bootstrap_node', { address });
  } else {
    return connectWebBootstrapNode(address);
  }
}

/**
 * DHT 부트스트랩 노드 목록 설정
 */
export async function setBootstrapNodes(addresses: string[]): Promise<number> {
  const native = await isNative();
  if (native) {
    return invoke<number>('set_bootstrap_nodes', { addresses });
  } else {
    return setWebBootstrapNodes(addresses);
  }
}

/**
 * 기본 부트스트랩 노드 주소 (사내망 설정)
 */
export const DEFAULT_BOOTSTRAP_NODES = [
  // 사내망 부트스트랩 노드 주소를 여기에 추가
  // 'bootstrap1.internal:6881',
  // 'bootstrap2.internal:6881',
];

/**
 * 부트스트랩 노드 정보
 */
export interface BootstrapNodeInfo {
  address: string;
  ip: string;
  port: number;
}

/**
 * 부트스트랩 노드 자동 발견 (mDNS)
 * 사내망에서 실행 중인 부트스트랩 노드를 자동으로 찾습니다.
 */
export async function discoverBootstrapNodes(): Promise<BootstrapNodeInfo[]> {
  const native = await isNative();
  if (native) {
    return invoke<BootstrapNodeInfo[]>('discover_bootstrap_nodes');
  } else {
    const webNodes = await getWebBootstrapNodes();
    // WebBootstrapNodeInfo를 BootstrapNodeInfo로 변환
    return webNodes.map(node => ({
      address: node.address,
      ip: node.ip,
      port: node.port,
    }));
  }
}

/**
 * 부트스트랩 노드 자동 발견 및 연결
 * 발견된 모든 노드에 자동으로 연결을 시도합니다.
 */
export async function autoConnectBootstrap(): Promise<{
  discovered: number;
  connected: number;
  nodes: BootstrapNodeInfo[];
}> {
  const native = await isNative();
  if (native) {
    const nodes = await discoverBootstrapNodes();
    let connected = 0;

    for (const node of nodes) {
      try {
        const success = await connectBootstrapNode(node.address);
        if (success) connected++;
      } catch (e) {
        console.warn(`부트스트랩 노드 연결 실패: ${node.address}`, e);
      }
    }

    return {
      discovered: nodes.length,
      connected,
      nodes,
    };
  } else {
    // 웹 환경에서는 WebSocket 기반 연결 사용
    const webResult = await autoConnectWebBootstrap();
    // WebBootstrapNodeInfo를 BootstrapNodeInfo로 변환
    const convertedNodes = webResult.nodes.map(node => ({
      address: node.address,
      ip: node.ip,
      port: node.port,
    }));

    return {
      discovered: webResult.discovered,
      connected: webResult.connected,
      nodes: convertedNodes,
    };
  }
}
