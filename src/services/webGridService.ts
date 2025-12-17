/**
 * 웹 환경용 Grid 서비스
 *
 * Tauri API 대신 WebSocket을 통해 부트스트랩 노드에 직접 연결
 */

import {
  GridInfo,
  GridSwarmState,
  GridPeerDiscoveredEvent,
} from '../types/grid';

// 웹 환경용 부트스트랩 노드 주소 (로컬 테스트용)
const WEB_BOOTSTRAP_NODES = [
  '192.168.0.25:6881', // 실제 IP 주소 사용
  'localhost:6881',
  // 추가 부트스트랩 노드 주소를 여기에 추가
];

/**
 * 웹 환경에서 부트스트랩 노드에 연결
 */
export async function connectWebBootstrapNode(
  address: string
): Promise<boolean> {
  try {
    const [host, portStr] = address.split(':');
    const port = parseInt(portStr);

    console.log(`[WebGrid] 부트스트랩 노드 연결 시도: ${address}`);

    // 부트스트랩 노드의 통계 API를 통해 연결 상태 확인
    const response = await fetch(`http://${host}:6883/stats`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      console.log(`[WebGrid] 부트스트랩 노드 연결 성공: ${address}`);
      return true;
    } else {
      console.warn(`[WebGrid] 부트스트랩 노드 응답 없음: ${address}`);
      return false;
    }
  } catch (error) {
    console.error(`[WebGrid] 부트스트랩 노드 연결 오류: ${address}`, error);
    return false;
  }
}

/**
 * 웹 환경에서 모든 부트스트랩 노드에 연결 시도
 */
export async function autoConnectWebBootstrap(): Promise<{
  discovered: number;
  connected: number;
  nodes: WebBootstrapNodeInfo[];
}> {
  console.log('[WebGrid] 부트스트랩 노드 자동 연결 시작...');

  let connected = 0;
  const results: string[] = [];

  for (const address of WEB_BOOTSTRAP_NODES) {
    const success = await connectWebBootstrapNode(address);
    if (success) {
      connected++;
      results.push(address);
    }
  }

  console.log(
    `[WebGrid] 연결 결과: ${connected}/${WEB_BOOTSTRAP_NODES.length}`
  );

  const nodeInfos: WebBootstrapNodeInfo[] = results.map(address => {
    const [ip, port] = address.split(':');
    return {
      address,
      ip,
      port: parseInt(port),
      connected: true,
    };
  });

  return {
    discovered: WEB_BOOTSTRAP_NODES.length,
    connected,
    nodes: nodeInfos,
  };
}

/**
 * 웹 환경용 Grid 정보 조회 (모의 구현)
 */
export async function getWebGridInfo(): Promise<GridInfo> {
  return {
    version: '1.0.0-web',
    features: ['web-bootstrap', 'websocket'],
    defaultPieceSize: 64 * 1024, // 64KB
    maxPeers: 50,
    maxPendingRequests: 100,
  };
}

/**
 * 웹 환경에서 부트스트랩 노드 목록 설정
 */
export async function setWebBootstrapNodes(
  addresses: string[]
): Promise<number> {
  console.log('[WebGrid] 부트스트랩 노드 목록 설정:', addresses);
  // 실제 구현에서는 이 주소들을 저장하고 재사용
  return addresses.length;
}

/**
 * 부트스트랩 노드 정보 (웹용)
 */
export interface WebBootstrapNodeInfo {
  address: string;
  ip: string;
  port: number;
  connected: boolean;
}

/**
 * 웹 환경에서 사용 가능한 부트스트랩 노드 목록 조회
 */
export async function getWebBootstrapNodes(): Promise<WebBootstrapNodeInfo[]> {
  return WEB_BOOTSTRAP_NODES.map(address => {
    const [ip, port] = address.split(':');
    return {
      address,
      ip,
      port: parseInt(port),
      connected: false, // 실제 연결 상태는 별도로 확인 필요
    };
  });
}
