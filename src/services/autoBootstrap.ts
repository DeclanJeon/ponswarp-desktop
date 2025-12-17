/**
 * 자동 부트스트랩 노드 실행 서비스
 *
 * Tauri: 내장 부트스트랩 사용
 * 웹: 외부 부트스트랩 노드 확인
 */

import { logInfo, logError, logWarn } from '../utils/logger';
import {
  isTauriEnvironment,
  getEmbeddedBootstrapStatus,
} from './embeddedBootstrap';

export interface BootstrapNodeStatus {
  isRunning: boolean;
  pid?: number;
  port: number;
  address: string;
}

/**
 * 현재 PC에서 부트스트랩 노드 실행 상태 확인
 */
export async function checkBootstrapNodeStatus(): Promise<BootstrapNodeStatus> {
  // Tauri 환경에서는 내장 부트스트랩 상태 확인
  if (isTauriEnvironment()) {
    try {
      // 최대 3초 대기하며 부트스트랩 시작 완료를 기다림
      const maxRetries = 6;
      const retryDelayMs = 500;

      for (let i = 0; i < maxRetries; i++) {
        const status = await getEmbeddedBootstrapStatus();

        if (status.state === 'running' && status.bound_ports) {
          logInfo(
            '[AutoBootstrap]',
            '✅ 내장 부트스트랩 실행 중',
            status.bound_ports
          );
          return {
            isRunning: true,
            port: status.bound_ports.stats_port,
            address: `localhost:${status.bound_ports.stats_port}`,
          };
        }

        // 'starting' 상태면 대기 후 재시도
        if (status.state === 'starting') {
          logInfo(
            '[AutoBootstrap]',
            `⏳ 부트스트랩 시작 대기 중... (${i + 1}/${maxRetries})`
          );
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }

        // stopped 또는 error 상태면 즉시 반환
        break;
      }
    } catch (error) {
      logWarn('[AutoBootstrap]', '내장 부트스트랩 상태 확인 실패:', error);
    }

    return {
      isRunning: false,
      port: 6883,
      address: 'localhost:6883',
    };
  }

  // 웹 환경에서는 외부 부트스트랩 노드 확인
  try {
    // 🆕 [수정] 여러 포트 확인 (6881, 6882, 6883)
    const ports = [6881, 6882, 6883];

    for (const port of ports) {
      try {
        // 🆕 [수정] 타임아웃을 위한 AbortController 사용
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(`http://localhost:${port}/stats`, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        });

        clearTimeout(timeoutId);
        if (response.ok) {
          const stats = await response.json();
          logInfo(
            '[AutoBootstrap]',
            `✅ 부트스트랩 노드 발견: 포트 ${port}`,
            stats
          );
          return {
            isRunning: true,
            port: port,
            address: `localhost:${port}`,
          };
        }
      } catch (portError) {
        // 다음 포트 시도
        continue;
      }
    }
  } catch (error) {
    logWarn('[AutoBootstrap]', '부트스트랩 노드 상태 확인 실패:', error);
  }

  return {
    isRunning: false,
    port: 6881,
    address: 'localhost:6881',
  };
}

/**
 * 부트스트랩 노드 자동 실행 (가상 환경)
 *
 * 참고: 실제 브라우저에서는 보안상의 이유로 직접 프로세스 실행 불가
 * Tauri 환경에서만 가능
 */
export async function startBootstrapNode(): Promise<boolean> {
  logWarn(
    '[AutoBootstrap]',
    '브라우저 환경에서는 직접 부트스트랩 노드 실행 불가'
  );
  logInfo('[AutoBootstrap]', '수동으로 부트스트랩 노드를 실행해주세요');

  // 사용자 안내 메시지 표시
  if (confirm('부트스트랩 노드를 실행하시겠습니까?')) {
    // 부트스트랩 노드 실행 안내
    alert(
      '터미널에서 다음 명령을 실행하세요:\ncd ponswarp-bootstrap\n./target/debug/ponswarp-bootstrap'
    );
    return true;
  }

  return false;
}

/**
 * 부트스트랩 노드 실행 안내 메시지
 */
export function getBootstrapNodeInstructions(): string {
  return `
사내망 P2P 파일 전송을 위해 부트스트랩 노드 실행이 필요합니다.

각 PC에서 다음 명령을 실행하세요:

1. 터미널 열기
2. 부트스트랩 노드 디렉토리로 이동:
   cd ponswarp-bootstrap

3. 부트스트랩 노드 실행:
   ./target/debug/ponswarp-bootstrap

4. 실행 확인:
   curl http://localhost:6883/stats

팁:
- 여러 PC에서 실행할수록 네트워크 안정성이 향상됩니다
- 부트스트랩 노드는 백그라운드에서 계속 실행해주세요
- 포트 6881, 6882, 6883이 사용 가능해야 합니다
  `.trim();
}

/**
 * 사내망 IP 주소 확인
 */
export async function getLocalNetworkInfo(): Promise<{
  ips: string[];
  primaryIp: string;
}> {
  try {
    // 🆕 [수정] 로컬 네트워크 인터페이스 자동 감지
    const localIps = await getLocalNetworkInterfaces();

    // 공인 IP 조회 (선택적)
    let primaryIp = 'unknown';
    try {
      // 🆕 [수정] 타임아웃을 위한 AbortController 사용
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch('https://api.ipify.org?format=json', {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const data = await response.json();
      primaryIp = data.ip;
    } catch (error) {
      logWarn(
        '[AutoBootstrap]',
        '공인 IP 조회 실패 (로컬 네트워크만 사용):',
        error
      );
    }

    return {
      ips: localIps,
      primaryIp,
    };
  } catch (error) {
    logError('[AutoBootstrap]', '네트워크 정보 조회 실패:', error);
    return {
      ips: ['127.0.0.1'],
      primaryIp: 'unknown',
    };
  }
}

/**
 * 🆕 로컬 네트워크 인터페이스 자동 감지
 */
async function getLocalNetworkInterfaces(): Promise<string[]> {
  try {
    // Tauri 환경에서는 Rust 명령으로 네트워크 인터페이스 조회
    if (isTauriEnvironment()) {
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        const interfaces = await invoke<string[]>('get_network_interfaces');
        return interfaces.filter(
          ip => ip !== '127.0.0.1' && !ip.startsWith('169.254')
        );
      } catch (error) {
        logWarn('[AutoBootstrap]', '네트워크 인터페이스 조회 실패:', error);
      }
    }

    // 웹 환경에서는 WebRTC를 통한 IP 감지 (fallback)
    return await detectLocalIPsViaWebRTC();
  } catch (error) {
    logError('[AutoBootstrap]', '로컬 IP 감지 실패:', error);
    return ['127.0.0.1'];
  }
}

/**
 * 🆕 WebRTC를 통한 로컬 IP 감지 (웹 환경용)
 */
async function detectLocalIPsViaWebRTC(): Promise<string[]> {
  return new Promise(resolve => {
    const pcs = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    const ips = new Set<string>();

    pcs.onicecandidate = event => {
      if (event.candidate) {
        const candidate = event.candidate.candidate;
        const match = candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (match) {
          const ip = match[1];
          if (ip !== '127.0.0.1' && !ip.startsWith('169.254')) {
            ips.add(ip);
          }
        }
      }
    };

    // 임시 offer/createAnswer를 통해 ICE candidate 생성
    pcs.createDataChannel('test');
    pcs
      .createOffer()
      .then(offer => pcs.setLocalDescription(offer))
      .catch(() => {});

    // 2초 후 결과 반환
    setTimeout(() => {
      pcs.close();
      resolve(Array.from(ips));
    }, 2000);
  });
}
