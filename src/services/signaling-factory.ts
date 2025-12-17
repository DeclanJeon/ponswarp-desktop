/**
 * 시그널링 서비스 팩토리
 * 환경에 따라 적절한 시그널링 백엔드 선택:
 * 1. Native (Tauri): QUIC 기반 P2P 시그널링 (mDNS 자동 발견)
 * 2. Rust WebSocket: ponswarp-signaling-rs 서버
 * 3. Node.js Socket.io: 레거시 시그널링 서버
 */

import { signalingService } from './signaling';
import { rustSignalingAdapter } from './signaling-adapter';
import { nativeSignalingService } from './native-signaling';
import {
  USE_RUST_SIGNALING,
  RUST_SIGNALING_URL,
  SIGNALING_SERVER_URL,
} from '../utils/constants';
import { isNative } from '../utils/tauri';

export interface ISignalingService {
  connect(): Promise<void>;
  joinRoom(roomId: string): Promise<void>;
  leaveRoom(roomId: string): void;
  sendOffer(
    roomId: string,
    offer: RTCSessionDescriptionInit,
    target?: string
  ): void;
  sendAnswer(
    roomId: string,
    answer: RTCSessionDescriptionInit,
    target?: string
  ): void;
  sendCandidate(
    roomId: string,
    candidate: RTCIceCandidate,
    target?: string
  ): void;
  requestTurnConfig(roomId: string): Promise<unknown>;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  getSocketId(): string | null | undefined;
  isConnected(): boolean;
  disconnect(): void;
}

type SignalingMode = 'native' | 'rust' | 'socketio';

class SignalingFactory {
  private service: ISignalingService | null = null;
  private initialized = false;
  private mode: SignalingMode = 'socketio';
  private nativeMode = false;

  async detectMode(): Promise<SignalingMode> {
    const native = await isNative();
    this.nativeMode = native;

    if (native) {
      console.log('[SignalingFactory] 🖥️ Native (Tauri) 환경 감지');
      console.log('[SignalingFactory] ✅ mDNS P2P 시그널링 활성화');
      return 'native';
    }

    if (USE_RUST_SIGNALING) {
      console.log('[SignalingFactory] 🦀 Rust WebSocket 시그널링 사용');
      return 'rust';
    }

    console.log('[SignalingFactory] 🌐 Socket.io 시그널링 사용');
    return 'socketio';
  }

  getService(): ISignalingService {
    // 🚀 [FIX] 항상 현재 모드에 맞는 서비스를 반환하도록 수정 (Proxy 패턴 지원)
    // 기존에는 this.service를 캐싱하여 모드 변경 시에도 이전 서비스를 반환하는 문제가 있었음
    if (this.mode === 'native') {
      return nativeSignalingService as unknown as ISignalingService;
    } else if (this.mode === 'rust' || USE_RUST_SIGNALING) {
      return rustSignalingAdapter as unknown as ISignalingService;
    } else {
      return signalingService as unknown as ISignalingService;
    }
  }

  async connect(): Promise<void> {
    this.mode = await this.detectMode();

    if (this.mode === 'native') {
      // 🚨 [Phase 1 미완성] mDNS P2P 시그널링은 아직 방(Room) 매칭을 지원하지 않음
      // 현재는 Rust WebSocket으로 폴백됨 (detectMode에서 'rust' 반환)
      console.log('[SignalingFactory] Native 모드 - mDNS P2P 시그널링 활성화');
      await nativeSignalingService.connect();
    } else if (this.mode === 'rust') {
      console.log(
        '[SignalingFactory] Rust WebSocket 시그널링 연결 중:',
        RUST_SIGNALING_URL
      );
      await rustSignalingAdapter.connect(RUST_SIGNALING_URL);
    } else {
      await signalingService.connect();
    }

    this.initialized = true;
  }

  isUsingRust(): boolean {
    return this.mode === 'rust' || this.mode === 'native';
  }

  isNativeMode(): boolean {
    return this.nativeMode;
  }

  getMode(): SignalingMode {
    return this.mode;
  }

  getServerUrl(): string {
    if (this.mode === 'native') {
      return 'quic://localhost (P2P)';
    }
    return this.mode === 'rust' ? RUST_SIGNALING_URL : SIGNALING_SERVER_URL;
  }
}

export const signalingFactory = new SignalingFactory();

// 🚀 [FIX] Proxy 패턴 적용:
// 모듈 로드 시점이 아닌, 실제 메서드 호출 시점에 서비스를 가져오도록 함
// 이를 통해 초기화 시점 불일치(Race Condition) 문제를 해결
export const getSignalingService = () => {
  return new Proxy({} as ISignalingService, {
    get: (_target, prop) => {
      const service = signalingFactory.getService();
      const value = service[prop as keyof ISignalingService];
      return typeof value === 'function' ? value.bind(service) : value;
    },
  });
};
