/**
 * SinglePeerConnection - 단일 피어와의 WebRTC 연결 캡슐화
 *
 * Sender와 Receiver 모두에서 사용할 수 있는 범용 WebRTC 연결 래퍼입니다.
 * SwarmManager와 webRTCService 모두에서 사용하여 아키텍처를 통일합니다.
 */
import SimplePeer from 'simple-peer/simplepeer.min.js';
import { LOW_WATER_MARK } from '../utils/constants';
import { logInfo, logError, logWarn } from '../utils/logger';

/**
 * WebRTC 지원 여부 확인
 * Tauri WebView(특히 Linux WebKitGTK)에서는 WebRTC가 지원되지 않을 수 있음
 */
export function isWebRTCSupported(): boolean {
  try {
    // RTCPeerConnection 존재 여부 확인
    if (typeof RTCPeerConnection === 'undefined') {
      return false;
    }
    // getUserMedia 또는 mediaDevices 확인 (WebRTC 완전 지원 여부)
    if (typeof navigator !== 'undefined') {
      // RTCPeerConnection 생성 테스트
      const testPc = new RTCPeerConnection({ iceServers: [] });
      testPc.close();
      return true;
    }
    return false;
  } catch (e) {
    logWarn('[WebRTC]', 'WebRTC support check failed:', e);
    return false;
  }
}

type EventHandler = (data: any) => void;

export interface PeerConfig {
  iceServers: RTCIceServer[];
  channelConfig?: RTCDataChannelInit;
}

export interface PeerState {
  id: string;
  connected: boolean;
  bufferedAmount: number;
  ready: boolean;
}

export class SinglePeerConnection {
  public readonly id: string;
  public connected: boolean = false;
  public ready: boolean = false;

  // @ts-ignore
  public pc: SimplePeer.Instance | null = null;
  private destroyed: boolean = false;
  private drainEmitted: boolean = false;
  private eventListeners: Record<string, EventHandler[]> = {};

  constructor(peerId: string, initiator: boolean, config: PeerConfig) {
    this.id = peerId;
    this.initializePeer(initiator, config);
  }

  public on(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }

  public off(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(
      h => h !== handler
    );
  }

  private emit(event: string, data?: any): void {
    this.eventListeners[event]?.forEach(h => h(data));
  }

  public removeAllListeners(): void {
    this.eventListeners = {};
  }

  private initializePeer(initiator: boolean, config: PeerConfig): void {
    // 🚨 WebRTC 지원 여부 먼저 확인
    if (!isWebRTCSupported()) {
      const errorMsg =
        'WebRTC is not supported in this environment. ' +
        'This may occur in Tauri desktop apps on Linux (WebKitGTK limitation). ' +
        'Please use a web browser for file transfer.';
      logError(`[Peer ${this.id}]`, errorMsg);
      throw new Error(errorMsg);
    }

    try {
      this.pc = new SimplePeer({
        initiator,
        trickle: true,
        config: { iceServers: config.iceServers },
        channelConfig: {
          ordered: true,
          bufferedAmountLowThreshold: LOW_WATER_MARK,
          ...config.channelConfig,
        },
      } as any);

      this.setupEventHandlers();
      logInfo(`[Peer ${this.id}]`, `Created (initiator: ${initiator})`);
    } catch (error) {
      logError(`[Peer ${this.id}]`, 'Failed to create SimplePeer:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.pc) return;

    // binaryType 강제 설정
    const forceArrayBuffer = () => {
      // @ts-ignore
      if (this.pc?._channel && this.pc._channel.binaryType !== 'arraybuffer') {
        // @ts-ignore
        this.pc._channel.binaryType = 'arraybuffer';
      }
    };

    this.pc.on('signal', (data: SimplePeer.SignalData) => {
      this.emit('signal', data);
    });

    this.pc.on('connect', () => {
      forceArrayBuffer();
      this.connected = true;
      this.drainEmitted = false;
      logInfo(`[Peer ${this.id}]`, 'Connected');
      this.emit('connected', this.id);
      this.setupChannelEvents();
    });

    this.pc.on('data', (data: any) => {
      // Uint8Array -> ArrayBuffer 변환
      const buffer =
        data instanceof Uint8Array
          ? data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            )
          : data;
      this.emit('data', buffer);
    });

    this.pc.on('error', (error: Error) => {
      logError(`[Peer ${this.id}]`, 'Error:', error);
      this.emit('error', error);
    });

    this.pc.on('close', () => {
      logInfo(`[Peer ${this.id}]`, 'Closed');
      this.connected = false;
      this.emit('close');
    });
  }

  private setupChannelEvents(): void {
    // @ts-ignore
    const channel = this.pc?._channel as RTCDataChannel;
    if (!channel) return;

    channel.onbufferedamountlow = () => {
      if (!this.drainEmitted && this.connected) {
        this.drainEmitted = true;
        this.emit('drain', this.id);
        // 다음 drain 이벤트를 위해 리셋
        setTimeout(() => {
          this.drainEmitted = false;
        }, 0);
      }
    };
  }

  /**
   * 시그널링 데이터 처리 (offer/answer/ice-candidate)
   */
  public signal(data: SimplePeer.SignalData): void {
    if (this.destroyed || !this.pc) {
      logError(`[Peer ${this.id}]`, 'Cannot signal: peer destroyed');
      return;
    }
    this.pc.signal(data);
  }

  /**
   * 데이터 전송 (connected 상태일 때만)
   */
  public send(data: ArrayBuffer | string): void {
    if (!this.connected || this.destroyed || !this.pc) {
      // 연결되지 않은 상태에서는 조용히 무시 (throw하지 않음)
      return;
    }

    // @ts-ignore
    const channel = this.pc._channel as RTCDataChannel;
    if (!channel || channel.readyState !== 'open') {
      return;
    }

    this.pc.send(data);
  }

  /**
   * 현재 버퍼 크기 조회
   */
  public getBufferedAmount(): number {
    if (!this.pc || this.destroyed) return 0;
    // @ts-ignore
    const channel = this.pc._channel as RTCDataChannel;
    return channel?.bufferedAmount ?? 0;
  }

  /**
   * 피어 상태 조회
   */
  public getState(): PeerState {
    return {
      id: this.id,
      connected: this.connected,
      bufferedAmount: this.getBufferedAmount(),
      ready: this.ready,
    };
  }

  /**
   * 피어 연결 정리
   */
  public destroy(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.connected = false;
    this.ready = false;

    if (this.pc) {
      this.pc.destroy();
      this.pc = null;
    }

    this.removeAllListeners();
    logInfo(`[Peer ${this.id}]`, 'Destroyed');
  }

  /**
   * 파괴 여부 확인
   */
  public isDestroyed(): boolean {
    return this.destroyed;
  }
}
