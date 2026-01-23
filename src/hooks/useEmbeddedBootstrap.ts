/**
 * useEmbeddedBootstrap Hook
 *
 * 내장 부트스트랩 노드 상태 관리 및 제어
 */

import { useState, useEffect, useCallback } from 'react';
import {
  startEmbeddedBootstrap,
  stopEmbeddedBootstrap,
  getEmbeddedBootstrapStatus,
  updateBootstrapConfig,
  onBootstrapStateChanged,
  onBootstrapPeerDiscovered,
  isTauriEnvironment,
  type BootstrapConfig,
  type BootstrapStatus,
  type BootstrapPeerDiscoveredEvent,
} from '../services/embeddedBootstrap';
import { logInfo, logError } from '../utils/logger';

export interface UseEmbeddedBootstrapReturn {
  // 상태
  status: BootstrapStatus | null;
  isRunning: boolean;
  isLoading: boolean;
  error: string | null;
  discoveredPeers: BootstrapPeerDiscoveredEvent[];

  // 액션
  start: (config?: Partial<BootstrapConfig>) => Promise<void>;
  stop: () => Promise<void>;
  updateConfig: (
    config: Partial<BootstrapConfig>,
    restart?: boolean
  ) => Promise<void>;
  refreshStatus: () => Promise<void>;
}

export function useEmbeddedBootstrap(): UseEmbeddedBootstrapReturn {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveredPeers, setDiscoveredPeers] = useState<
    BootstrapPeerDiscoveredEvent[]
  >([]);

  const isRunning = status?.state === 'running';

  // 상태 새로고침
  const refreshStatus = useCallback(async () => {
    if (!isTauriEnvironment()) {
      return;
    }

    try {
      const newStatus = await getEmbeddedBootstrapStatus();
      setStatus(newStatus);
      setError(null);
    } catch (err) {
      logError('[useEmbeddedBootstrap]', '상태 조회 실패:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 시작
  const start = useCallback(
    async (config?: Partial<BootstrapConfig>) => {
      if (!isTauriEnvironment()) {
        setError('Tauri 환경이 아닙니다');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        await startEmbeddedBootstrap(config);
        await refreshStatus();
        logInfo('[useEmbeddedBootstrap]', '부트스트랩 시작 완료');
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        logError('[useEmbeddedBootstrap]', '부트스트랩 시작 실패:', err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [refreshStatus]
  );

  // 중지
  const stop = useCallback(async () => {
    if (!isTauriEnvironment()) {
      setError('Tauri 환경이 아닙니다');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await stopEmbeddedBootstrap();
      await refreshStatus();
      logInfo('[useEmbeddedBootstrap]', '부트스트랩 중지 완료');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
      logError('[useEmbeddedBootstrap]', '부트스트랩 중지 실패:', err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [refreshStatus]);

  // 설정 업데이트
  const updateConfig = useCallback(
    async (config: Partial<BootstrapConfig>, restart: boolean = false) => {
      if (!isTauriEnvironment()) {
        setError('Tauri 환경이 아닙니다');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        await updateBootstrapConfig(config, restart);
        await refreshStatus();
        logInfo('[useEmbeddedBootstrap]', '설정 업데이트 완료');
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        logError('[useEmbeddedBootstrap]', '설정 업데이트 실패:', err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [refreshStatus]
  );

  // 초기 상태 로드 및 이벤트 구독
  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    // 초기 상태 로드
    refreshStatus();

    // 주기적 상태 업데이트 (10초마다)
    const intervalId = setInterval(refreshStatus, 10000);

    // 상태 변경 이벤트 구독
    let unlistenState: (() => void) | null = null;
    let unlistenPeer: (() => void) | null = null;

    onBootstrapStateChanged(event => {
      logInfo('[useEmbeddedBootstrap]', '상태 변경 이벤트:', event);
      refreshStatus();
    }).then(unlisten => {
      unlistenState = unlisten;
    });

    // 피어 발견 이벤트 구독
    onBootstrapPeerDiscovered(event => {
      logInfo('[useEmbeddedBootstrap]', '피어 발견 이벤트:', event);
      setDiscoveredPeers(prev => [...prev, event]);
    }).then(unlisten => {
      unlistenPeer = unlisten;
    });

    // 정리
    return () => {
      clearInterval(intervalId);
      if (unlistenState) unlistenState();
      if (unlistenPeer) unlistenPeer();
    };
  }, [refreshStatus]);

  return {
    status,
    isRunning,
    isLoading,
    error,
    discoveredPeers,
    start,
    stop,
    updateConfig,
    refreshStatus,
  };
}
