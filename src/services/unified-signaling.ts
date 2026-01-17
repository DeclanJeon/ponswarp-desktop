/**
 * 통합 시그널링 서비스
 *
 * Rust 서버와의 데이터 포맷 불일치 문제를 해결하기 위한 통합 솔루션
 * - SnakeCase 필드명 사용 (Rust 서버 호환)
 * - SDP 데이터 직렬화/역직렬화 처리
 * - 타겟 피어 ID 명시적 관리
 */

import { SIGNALING_SERVER_URL } from '../utils/constants';

// 브라우저 호환성을 위한 간단한 EventEmitter 구현
class SimpleEventEmitter {
  private events: Record<string, Function[]> = {};

  on(event: string, listener: Function) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  }

  off(event: string, listener: Function) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(l => l !== listener);
  }

  emit(event: string, data?: any) {
    if (!this.events[event]) return;
    this.events[event].forEach(listener => listener(data));
  }
}

// 환경 변수 또는 하드코딩된 주소
const WS_URL = SIGNALING_SERVER_URL;

type SignalHandler = (data: any) => void;

// Rust 서버와 호환되는 메시지 인터페이스
interface RustMessage {
  type: string;
  payload: Record<string, any>;
}

// TURN 설정 관련 타입 정의
export interface TurnCredentials {
  iceServers: RTCIceServer[];
  turnServerStatus: {
    primary: {
      connected: boolean;
      url: string;
      error: string | null;
      responseTime: number;
    };
    fallback: Array<{
      url: string;
      connected: boolean;
      error: string | null;
      responseTime: number;
    }>;
  };
  ttl: number;
  timestamp: number;
  roomId: string;
  message?: string;
}

export interface TurnConfigResponse {
  success: boolean;
  data?: TurnCredentials;
  error?: string;
  message?: string;
  retryAfter?: number;
}

export class UnifiedSignalingService {
  private ws: WebSocket | null = null;
  private handlers: Record<string, SignalHandler[]> = {};
  private isConnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionPromise: Promise<void> | null = null;

  // 피어 관리
  private myPeerId: string | null = null;
  private targetPeerId: string | null = null;

  // 이벤트 이미터
  private eventEmitter: SimpleEventEmitter;

  // [NEW] TURN 서버 설정을 캐싱할 변수 추가
  private turnConfigCache: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' }, // Default Fallback
  ];

  constructor() {
    this.eventEmitter = new SimpleEventEmitter();
  }

  /**
   * WebSocket 연결
   */
  public async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('[UnifiedSignaling] ✅ Already connected');
      return Promise.resolve();
    }

    if (this.isConnecting && this.connectionPromise) {
      console.log(
        '[UnifiedSignaling] ⏳ Connection already in progress, waiting...'
      );
      return this.connectionPromise;
    }

    this.isConnecting = true;
    console.log('[UnifiedSignaling] 🔌 Connecting to WebSocket:', WS_URL);

    this.connectionPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(WS_URL);

        this.ws.onopen = async () => {
          console.log('[UnifiedSignaling] ✅ WebSocket Connected');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.eventEmitter.emit('connected', this.myPeerId);

          // [NEW] 연결 즉시 TURN 설정 요청 (Pre-fetching)
          // roomId 'global'은 초기 설정을 위한 임의의 식별자입니다.
          try {
            console.log('[UnifiedSignaling] Pre-fetching TURN config...');
            const config = await this.requestTurnConfig('global-init');
            if (
              config.success &&
              config.data &&
              config.data.iceServers.length > 0
            ) {
              // 기존 구글 STUN과 병합 (중복 제거 로직은 생략)
              this.turnConfigCache = [
                ...config.data.iceServers,
                { urls: 'stun:stun.l.google.com:19302' },
              ];
              console.log(
                '[UnifiedSignaling] TURN config cached:',
                this.turnConfigCache.length,
                'servers'
              );
            }
          } catch (e) {
            console.warn(
              '[UnifiedSignaling] Initial TURN fetch failed (using default STUN):',
              e
            );
          }

          resolve();
        };

        this.ws.onmessage = event => {
          try {
            const message: RustMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (e) {
            console.warn(
              '[UnifiedSignaling] Failed to parse message:',
              event.data
            );
          }
        };

        this.ws.onclose = event => {
          this.isConnecting = false;
          console.warn(
            `[UnifiedSignaling] 🔌 Disconnected (Code: ${event.code})`
          );
          this.eventEmitter.emit('disconnected', null);
          this.handleReconnect();
        };

        this.ws.onerror = error => {
          console.error('[UnifiedSignaling] ❌ WebSocket Error:', error);
          this.isConnecting = false;
          // 연결 실패 시 reject 처리 (최초 연결 시)
          if (this.reconnectAttempts === 0) reject(error);
        };
      } catch (e) {
        this.isConnecting = false;
        reject(e);
      }
    });

    return this.connectionPromise;
  }

  /**
   * 연결 해제
   */
  public disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    this.myPeerId = null;
    this.targetPeerId = null;
  }

  /**
   * 자동 재연결 처리
   */
  private handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[UnifiedSignaling] 🚫 Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    console.log(`[UnifiedSignaling] ⏳ Reconnecting in ${delay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch(() => {});
    }, delay);
  }

  /**
   * 메시지 수신 처리 (Rust 서버 프로토콜 호환)
   */
  private handleMessage(message: RustMessage) {
    const { type, payload } = message;

    console.debug(`[UnifiedSignaling] 📩 Received: ${type}`, payload);

    // Rust 스타일(Snake Case) 페이로드를 JS 스타일(Camel Case)로 변환
    const camelPayload = this.toCamelCase(payload);

    // 이벤트 핸들러 매핑
    switch (type) {
      case 'Connected':
        // payload: { socket_id: "..." }
        this.myPeerId = payload.socket_id;
        this.eventEmitter.emit('connected', this.myPeerId);
        break;

      case 'RoomJoined':
        // payload: { room_id: "...", peer_id: "..." }
        this.myPeerId = payload.peer_id;
        this.eventEmitter.emit('joined-room', {
          roomId: payload.room_id,
          socketId: payload.peer_id,
        });
        break;

      case 'PeerJoined':
        // payload: { peer_id: "..." }
        this.targetPeerId = payload.peer_id; // 상대방 ID 저장 (중요!)
        this.eventEmitter.emit('peer-joined', {
          peerId: payload.peer_id, // UI/로직용 CamelCase 변환
          socketId: payload.peer_id,
        });
        break;

      case 'Offer':
        // payload: { from: "...", sdp: "..." }
        this.targetPeerId = payload.from; // Offer를 보낸 사람이 나의 타겟
        // 🚨 [핵심 수정] SDP 문자열을 객체로 파싱
        const offerData =
          typeof payload.sdp === 'string'
            ? JSON.parse(payload.sdp)
            : payload.sdp;
        this.eventEmitter.emit('offer', {
          sdp: offerData,
          from: payload.from,
        });
        break;

      case 'Answer':
        // 🚨 [핵심 수정] SDP 문자열을 객체로 파싱
        const answerData =
          typeof payload.sdp === 'string'
            ? JSON.parse(payload.sdp)
            : payload.sdp;
        this.eventEmitter.emit('answer', {
          sdp: answerData,
          from: payload.from,
        });
        break;

      case 'IceCandidate':
        // 🚨 [핵심 수정] ICE 후보 문자열을 객체로 파싱
        const candidateData =
          typeof payload.candidate === 'string'
            ? JSON.parse(payload.candidate)
            : payload.candidate;
        this.eventEmitter.emit('ice-candidate', {
          candidate: candidateData,
          from: payload.from,
        });
        break;

      case 'Error':
        console.error('[UnifiedSignaling] Server Error:', payload.message);
        this.eventEmitter.emit('error', payload);
        break;

      case 'TurnConfig':
        this.eventEmitter.emit('turn-config', payload);
        break;

      default:
        this.eventEmitter.emit(type.toLowerCase(), camelPayload);
        break;
    }
  }

  /**
   * 메시지 전송 헬퍼 (Rust 서버 포맷 준수: SnakeCase 변환)
   */
  private send(type: string, payload: any = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[UnifiedSignaling] Cannot send: WebSocket not open');
      return;
    }

    // 🚨 [핵심 수정] CamelCase -> SnakeCase 변환
    const snakePayload = this.toSnakeCase(payload);

    // 🚨 [핵심 수정] SDP 데이터 직렬화
    if (type === 'Offer' || type === 'Answer') {
      const sdpField = type === 'Offer' ? 'offer' : 'answer';
      if (snakePayload[sdpField]) {
        snakePayload.sdp = JSON.stringify(snakePayload[sdpField]);
        delete snakePayload[sdpField];
      }
    }

    // 🚨 [핵심 수정] ICE 후보 직렬화
    if (type === 'IceCandidate' && snakePayload.candidate) {
      snakePayload.candidate = JSON.stringify(snakePayload.candidate);
    }

    // 🚨 [핵심 수정] target 필드 보장
    if (
      (type === 'Offer' || type === 'Answer' || type === 'IceCandidate') &&
      !snakePayload.target &&
      this.targetPeerId
    ) {
      snakePayload.target = this.targetPeerId;
    }

    const message = JSON.stringify({ type, payload: snakePayload });
    this.ws.send(message);

    console.log(`[UnifiedSignaling] 📤 Sent: ${type}`, snakePayload);
  }

  /**
   * CamelCase -> SnakeCase 변환
   */
  private toSnakeCase(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.toSnakeCase(item));
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      result[snakeKey] = this.toSnakeCase(value);
    }

    return result;
  }

  /**
   * SnakeCase -> CamelCase 변환
   */
  private toCamelCase(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.toCamelCase(item));
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      result[camelKey] = this.toCamelCase(value);
    }

    return result;
  }

  // ======================= PUBLIC API =======================

  /**
   * 캐싱된 최신 ICE 서버 목록을 반환
   * SwarmManager나 WebRTC Service에서 호출합니다.
   */
  public getCachedIceServers(): RTCIceServer[] {
    return [...this.turnConfigCache];
  }

  public on(event: string, handler: SignalHandler): void {
    this.eventEmitter.on(event, handler);
  }

  public off(event: string, handler: SignalHandler): void {
    this.eventEmitter.off(event, handler);
  }

  public getWebSocket(): WebSocket | null {
    return this.ws;
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public getSocketId(): string | null {
    return this.myPeerId;
  }

  // ======================= API Methods =======================

  /**
   * 방 참여 (Rust 서버 포맷: room_id)
   */
  public async joinRoom(roomId: string): Promise<void> {
    if (!this.isConnected()) {
      console.log('[UnifiedSignaling] Not connected, waiting...');
      await this.connect();
    }

    console.log('[UnifiedSignaling] 🚪 Joining room:', roomId);
    this.send('JoinRoom', { roomId }); // 자동으로 room_id로 변환
  }

  public leaveRoom(roomId: string) {
    this.send('LeaveRoom', { roomId }); // 자동으로 room_id로 변환
  }

  /**
   * Offer 전송 (Rust 서버 포맷: target, sdp)
   */
  public sendOffer(sdp: RTCSessionDescriptionInit, target?: string) {
    const targetPeerId = target || this.targetPeerId;
    if (!targetPeerId) {
      console.error('[UnifiedSignaling] Cannot send Offer: No target peer');
      return;
    }

    console.log('[UnifiedSignaling] 📤 Sending offer to:', targetPeerId);
    this.send('Offer', {
      target: targetPeerId,
      offer: sdp, // 자동으로 sdp 필드에 JSON 문자열로 변환
    });
  }

  /**
   * Answer 전송 (Rust 서버 포맷: target, sdp)
   */
  public sendAnswer(sdp: RTCSessionDescriptionInit, target?: string) {
    const targetPeerId = target || this.targetPeerId;
    if (!targetPeerId) return;

    console.log('[UnifiedSignaling] 📤 Sending answer to:', targetPeerId);
    this.send('Answer', {
      target: targetPeerId,
      answer: sdp, // 자동으로 sdp 필드에 JSON 문자열로 변환
    });
  }

  /**
   * ICE 후보 전송 (Rust 서버 포맷: target, candidate)
   */
  public sendIceCandidate(candidate: RTCIceCandidate, target?: string) {
    const targetPeerId = target || this.targetPeerId;
    if (!targetPeerId) return;

    console.log(
      '[UnifiedSignaling] 📤 Sending ICE candidate to:',
      targetPeerId
    );
    this.send('IceCandidate', {
      target: targetPeerId,
      candidate, // 자동으로 candidate 필드에 JSON 문자열로 변환
    });
  }

  /**
   * TURN 설정 요청
   */
  public async requestTurnConfig(roomId: string): Promise<TurnConfigResponse> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        const error: TurnConfigResponse = {
          success: false,
          error: 'NOT_CONNECTED',
          message: '시그널링 서버에 연결되지 않았습니다.',
        };
        reject(error);
        return;
      }

      console.log(
        '[UnifiedSignaling] 🔄 Requesting TURN config for room:',
        roomId
      );

      const timeout = setTimeout(() => {
        reject(new Error('TURN config request timed out'));
      }, 3000);

      const handleTurnConfig = (response: TurnConfigResponse) => {
        clearTimeout(timeout);
        this.eventEmitter.off('turn-config', handleTurnConfig);

        if (response.success && response.data) {
          console.log('[UnifiedSignaling] ✅ TURN config received:', {
            roomId,
            iceServerCount: response.data.iceServers.length,
            ttl: response.data.ttl,
          });
          resolve(response);
        } else {
          console.error(
            '[UnifiedSignaling] ❌ TURN config request failed:',
            response
          );
          reject(response);
        }
      };

      this.eventEmitter.on('turn-config', handleTurnConfig);
      this.send('RequestTurnConfig', { roomId }); // 자동으로 room_id로 변환
    });
  }
}

// 싱글톤 인스턴스 export
export const unifiedSignalingService = new UnifiedSignalingService();
