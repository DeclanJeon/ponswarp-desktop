/**
 * useGridSwarm - Grid Swarm 상태 관리 훅
 *
 * Grid Protocol의 Swarm 상태를 React 컴포넌트에서 쉽게 사용할 수 있도록 합니다.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  GridSwarmState,
  GridPeerDiscoveredEvent,
  GridInfo,
} from '../types/grid';
import {
  getGridInfo,
  onGridStateUpdate,
  onPeerDiscovered,
  onTransferComplete,
  onGridError,
  autoConnectBootstrap,
  BootstrapNodeInfo,
} from '../services/gridService';
import { isNative } from '../utils/tauri';

interface UseGridSwarmOptions {
  onComplete?: (jobId: string) => void;
  onError?: (error: string) => void;
  onPeerFound?: (peer: GridPeerDiscoveredEvent) => void;
  /** 자동으로 부트스트랩 노드 발견 및 연결 */
  autoDiscoverBootstrap?: boolean;
  onBootstrapConnected?: (nodes: BootstrapNodeInfo[]) => void;
}

interface UseGridSwarmReturn {
  /** 현재 Swarm 상태 */
  state: GridSwarmState | null;
  /** Grid 정보 */
  info: GridInfo | null;
  /** 활성 상태 여부 */
  isActive: boolean;
  /** 로딩 중 여부 */
  isLoading: boolean;
  /** 에러 메시지 */
  error: string | null;
  /** 발견된 피어 목록 */
  discoveredPeers: GridPeerDiscoveredEvent[];
  /** 연결된 부트스트랩 노드 */
  bootstrapNodes: BootstrapNodeInfo[];
  /** 부트스트랩 연결 상태 */
  bootstrapConnected: boolean;
  /** 상태 초기화 */
  reset: () => void;
  /** 수동으로 부트스트랩 발견 시작 */
  discoverBootstrap: () => Promise<void>;
}

export function useGridSwarm(
  options: UseGridSwarmOptions = {}
): UseGridSwarmReturn {
  const [state, setState] = useState<GridSwarmState | null>(null);
  const [info, setInfo] = useState<GridInfo | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discoveredPeers, setDiscoveredPeers] = useState<
    GridPeerDiscoveredEvent[]
  >([]);
  const [bootstrapNodes, setBootstrapNodes] = useState<BootstrapNodeInfo[]>([]);
  const [bootstrapConnected, setBootstrapConnected] = useState(false);

  const reset = useCallback(() => {
    setState(null);
    setIsActive(false);
    setError(null);
    setDiscoveredPeers([]);
    setBootstrapNodes([]);
    setBootstrapConnected(false);
  }, []);

  const discoverBootstrap = useCallback(async () => {
    try {
      const result = await autoConnectBootstrap();
      setBootstrapNodes(result.nodes);
      setBootstrapConnected(result.connected > 0);
      options.onBootstrapConnected?.(result.nodes);
    } catch (e) {
      setError(`부트스트랩 발견 실패: ${e}`);
    }
  }, [options]);

  useEffect(() => {
    // Grid 정보 로드
    getGridInfo()
      .then(setInfo)
      .catch(e => setError(e.toString()))
      .finally(() => setIsLoading(false));

    // 자동 부트스트랩 발견 (웹 환경에서만)
    if (options.autoDiscoverBootstrap) {
      isNative().then(native => {
        if (!native) {
          console.log('[useGridSwarm] 웹 환경: 부트스트랩 자동 연결 시작');
          discoverBootstrap();
        } else {
          console.log(
            '[useGridSwarm] 네이티브 환경: 부트스트랩 자동 연결 건너뜀'
          );
        }
      });
    }
  }, [options.autoDiscoverBootstrap, discoverBootstrap]);

  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];

    // 상태 업데이트 리스너
    unlisteners.push(
      onGridStateUpdate(newState => {
        setState(newState);
        setIsActive(true);
      })
    );

    // 피어 발견 리스너
    unlisteners.push(
      onPeerDiscovered(peer => {
        setDiscoveredPeers(prev => {
          if (prev.some(p => p.peer_id === peer.peer_id)) {
            return prev;
          }
          return [...prev, peer];
        });
        options.onPeerFound?.(peer);
      })
    );

    // 전송 완료 리스너
    unlisteners.push(
      onTransferComplete(jobId => {
        options.onComplete?.(jobId);
      })
    );

    // 에러 리스너
    unlisteners.push(
      onGridError(errorMsg => {
        setError(errorMsg);
        options.onError?.(errorMsg);
      })
    );

    return () => {
      unlisteners.forEach(p => p.then(unlisten => unlisten()));
    };
  }, [options]);

  return {
    state,
    info,
    isActive,
    isLoading,
    error,
    discoveredPeers,
    bootstrapNodes,
    bootstrapConnected,
    reset,
    discoverBootstrap,
  };
}

export default useGridSwarm;
