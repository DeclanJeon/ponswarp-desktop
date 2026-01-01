import { invoke } from '@tauri-apps/api/core';

export interface RuntimeInfo {
  platform: string;
  arch: string;
  cpu_cores: number;
  is_native: boolean;
  version: string;
}

export interface PeerCapabilities {
  maxBandwidthMbps: number;
  availableBandwidthMbps: number;
  cpuCores: number;
  canRelay: boolean;
}

export interface DiscoveredPeer {
  id: string;
  address: string;
  capabilities: PeerCapabilities;
}

let isNativeEnv: boolean | null = null;

export async function isNative(): Promise<boolean> {
  if (isNativeEnv !== null) return isNativeEnv;

  try {
    // window.__TAURI__ 객체 존재 여부만으로는 부족할 수 있음 (iframe 등)
    // 핵심 API인 invoke가 동작하는지 확인
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('ping_quic'); // 가벼운 핑 명령
    isNativeEnv = true;
  } catch (e) {
    console.debug('[Tauri] Native detection failed, fallback to Web mode', e);
    isNativeEnv = false;
  }

  return isNativeEnv;
}

export async function getRuntimeInfo(): Promise<RuntimeInfo | null> {
  if (!(await isNative())) return null;

  try {
    return await invoke<RuntimeInfo>('get_runtime_info');
  } catch (error) {
    console.error('[Tauri] getRuntimeInfo 실패:', error);
    return null;
  }
}

export async function pingQuic(): Promise<string | null> {
  if (!(await isNative())) return null;

  try {
    return await invoke<string>('ping_quic');
  } catch (error) {
    console.error('[Tauri] pingQuic 실패:', error);
    return null;
  }
}

export async function startQuicServer(
  port: number = 0
): Promise<string | null> {
  if (!(await isNative())) return null;

  try {
    const addr = await invoke<string>('start_quic_server', { port });
    console.log('[Tauri] QUIC 서버 시작됨:', addr);
    return addr;
  } catch (error) {
    console.error('[Tauri] QUIC 서버 시작 실패:', error);
    return null;
  }
}

export async function stopQuicServer(): Promise<void> {
  if (!(await isNative())) return;

  try {
    await invoke('stop_quic_server');
    console.log('[Tauri] QUIC 서버 중지됨');
  } catch (error) {
    console.error('[Tauri] QUIC 서버 중지 실패:', error);
  }
}

export async function startDiscovery(
  nodeId: string,
  port: number
): Promise<boolean> {
  if (!(await isNative())) return false;

  try {
    await invoke('start_discovery', { nodeId, port });
    console.log('[Tauri] 피어 발견 시작:', nodeId);
    return true;
  } catch (error) {
    console.error('[Tauri] 피어 발견 시작 실패:', error);
    return false;
  }
}

export async function getDiscoveredPeers(): Promise<DiscoveredPeer[]> {
  if (!(await isNative())) return [];

  try {
    return await invoke<DiscoveredPeer[]>('get_discovered_peers');
  } catch (error) {
    console.error('[Tauri] 피어 목록 조회 실패:', error);
    return [];
  }
}

export async function stopDiscovery(): Promise<void> {
  if (!(await isNative())) return;

  try {
    await invoke('stop_discovery');
    console.log('[Tauri] 피어 발견 중지됨');
  } catch (error) {
    console.error('[Tauri] 피어 발견 중지 실패:', error);
  }
}

export async function initializeNativeServices(): Promise<{
  isNative: boolean;
  runtimeInfo: RuntimeInfo | null;
  quicAddress: string | null;
}> {
  const native = await isNative();

  if (!native) {
    console.log('[Tauri] 웹 환경에서 실행 중 - 네이티브 기능 비활성화');
    return { isNative: false, runtimeInfo: null, quicAddress: null };
  }

  console.log('[Tauri] 네이티브 환경 감지됨');

  const runtimeInfo = await getRuntimeInfo();
  if (runtimeInfo) {
    console.log('[Tauri] 런타임 정보:', JSON.stringify(runtimeInfo));
  }

  const quicAddress = await startQuicServer(0);

  if (quicAddress) {
    const nodeId = `ponswarp-${Date.now().toString(36)}`;
    const port = parseInt(quicAddress.split(':').pop() || '0');
    await startDiscovery(nodeId, port);
  }

  return { isNative: true, runtimeInfo, quicAddress };
}

export async function cleanupNativeServices(): Promise<void> {
  if (!(await isNative())) return;

  console.log('[Tauri] 네이티브 서비스 정리 중...');
  await stopDiscovery();
  await stopQuicServer();
  console.log('[Tauri] 네이티브 서비스 정리 완료');
}
