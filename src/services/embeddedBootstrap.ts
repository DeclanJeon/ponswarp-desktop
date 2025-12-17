/**
 * 내장 부트스트랩 노드 서비스
 *
 * Tauri 앱에 내장된 DHT 부트스트랩 및 릴레이 노드 관리
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { logInfo, logError, logWarn } from '../utils/logger';

export interface BootstrapConfig {
  enabled: boolean;
  dht_port: number;
  quic_port: number;
  stats_port: number;
  external_bootstrap_nodes: string[];
  enable_mdns_discovery: boolean;
  enable_relay: boolean;
  max_relay_sessions: number;
}

export interface BoundPorts {
  dht_port: number;
  quic_port: number;
  stats_port: number;
}

export interface DhtStats {
  nodes_in_routing_table: number;
  providers_stored: number;
  messages_received: number;
  messages_sent: number;
}

export interface RelayStats {
  active_sessions: number;
  total_connections: number;
  bytes_relayed: number;
}

export interface BootstrapStatus {
  state: string;
  uptime_secs: number;
  bound_ports: BoundPorts | null;
  dht_stats: DhtStats;
  relay_stats: RelayStats;
  connected_bootstrap_nodes: number;
  discovered_peers: number;
}

export interface BootstrapStateChangedEvent {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  error?: string;
  ports?: {
    dht: number;
    quic: number;
    stats: number;
  };
}

export interface BootstrapPeerDiscoveredEvent {
  nodeId: string;
  address: string;
  source: 'mdns' | 'dht' | 'configured';
}

/**
 * 내장 부트스트랩 서비스 시작
 */
export async function startEmbeddedBootstrap(
  config?: Partial<BootstrapConfig>
): Promise<BoundPorts> {
  try {
    logInfo('[EmbeddedBootstrap]', '부트스트랩 시작 요청');

    const fullConfig: BootstrapConfig = {
      enabled: true,
      dht_port: 6881,
      quic_port: 6882,
      stats_port: 6883,
      external_bootstrap_nodes: [],
      enable_mdns_discovery: true,
      enable_relay: true,
      max_relay_sessions: 50,
      ...config,
    };

    const ports = await invoke<BoundPorts>('start_embedded_bootstrap', {
      config: fullConfig,
    });

    logInfo('[EmbeddedBootstrap]', '부트스트랩 시작 완료', ports);
    return ports;
  } catch (error) {
    logError('[EmbeddedBootstrap]', '부트스트랩 시작 실패:', error);
    throw error;
  }
}

/**
 * 내장 부트스트랩 서비스 중지
 */
export async function stopEmbeddedBootstrap(): Promise<void> {
  try {
    logInfo('[EmbeddedBootstrap]', '부트스트랩 중지 요청');
    await invoke('stop_embedded_bootstrap');
    logInfo('[EmbeddedBootstrap]', '부트스트랩 중지 완료');
  } catch (error) {
    logError('[EmbeddedBootstrap]', '부트스트랩 중지 실패:', error);
    throw error;
  }
}

/**
 * 부트스트랩 상태 조회
 */
export async function getEmbeddedBootstrapStatus(): Promise<BootstrapStatus> {
  try {
    const status = await invoke<BootstrapStatus>(
      'get_embedded_bootstrap_status'
    );
    return status;
  } catch (error) {
    logError('[EmbeddedBootstrap]', '상태 조회 실패:', error);
    throw error;
  }
}

/**
 * 부트스트랩 설정 업데이트
 */
export async function updateBootstrapConfig(
  config: Partial<BootstrapConfig>,
  restart: boolean = false
): Promise<void> {
  try {
    logInfo('[EmbeddedBootstrap]', '설정 업데이트 요청', { restart });

    const fullConfig: BootstrapConfig = {
      enabled: true,
      dht_port: 6881,
      quic_port: 6882,
      stats_port: 6883,
      external_bootstrap_nodes: [],
      enable_mdns_discovery: true,
      enable_relay: true,
      max_relay_sessions: 50,
      ...config,
    };

    await invoke('update_bootstrap_config', {
      config: fullConfig,
      restart,
    });

    logInfo('[EmbeddedBootstrap]', '설정 업데이트 완료');
  } catch (error) {
    logError('[EmbeddedBootstrap]', '설정 업데이트 실패:', error);
    throw error;
  }
}

/**
 * 부트스트랩 상태 변경 이벤트 구독
 */
export async function onBootstrapStateChanged(
  callback: (event: BootstrapStateChangedEvent) => void
): Promise<UnlistenFn> {
  return await listen<BootstrapStateChangedEvent>(
    'bootstrap-state-changed',
    event => {
      logInfo('[EmbeddedBootstrap]', '상태 변경:', event.payload);
      callback(event.payload);
    }
  );
}

/**
 * 피어 발견 이벤트 구독
 */
export async function onBootstrapPeerDiscovered(
  callback: (event: BootstrapPeerDiscoveredEvent) => void
): Promise<UnlistenFn> {
  return await listen<BootstrapPeerDiscoveredEvent>(
    'bootstrap-peer-discovered',
    event => {
      logInfo('[EmbeddedBootstrap]', '피어 발견:', event.payload);
      callback(event.payload);
    }
  );
}

/**
 * Tauri 환경 감지
 */
export function isTauriEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
  );
}
