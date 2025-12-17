import { SIGNALING_SERVER_URL } from '../utils/constants';

// Rust 서버와의 호환성을 위해 /ws 엔드포인트 사용 (Nginx 프록시)
// ws://localhost:5502/ws 또는 wss://warp.ponslink.online/ws
const WS_URL = SIGNALING_SERVER_URL;

type SignalHandler = (data: any) => void;

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
  message?: string; // 추가된 속성
}

export interface TurnConfigRequest {
  roomId: string;
  forceRefresh?: boolean;
}

export interface TurnConfigResponse {
  success: boolean;
  data?: TurnCredentials;
  error?: string;
  message?: string;
  retryAfter?: number;
}

class SignalingService {
  private ws: WebSocket | null = null;
  private handlers: Record<string, SignalHandler[]> = {};
  private isConnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionPromise: Promise<void> | null = null;

  public async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('[Signaling] ✅ Already connected');
      return Promise.resolve();
    }

    if (this.isConnecting && this.connectionPromise) {
      console.log('[Signaling] ⏳ Connection already in progress, waiting...');
      return this.connectionPromise;
    }

    this.isConnecting = true;
    console.log('[Signaling] 🔌 Connecting to WebSocket:', WS_URL);

    this.connectionPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(WS_URL);

        this.ws.onopen = () => {
          console.log('[Signaling] ✅ WebSocket Connected');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.emit('connected', 'native-ws-client');
          resolve();
        };

        this.ws.onmessage = event => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (e) {
            console.warn('[Signaling] Failed to parse message:', event.data);
          }
        };

        this.ws.onclose = event => {
          this.isConnecting = false;
          console.warn(`[Signaling] 🔌 Disconnected (Code: ${event.code})`);
          this.emit('disconnected', null);
          this.handleReconnect();
        };

        this.ws.onerror = error => {
          console.error('[Signaling] ❌ WebSocket Error:', error);
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

  public disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
  }

  private handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Signaling] 🚫 Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    console.log(`[Signaling] ⏳ Reconnecting in ${delay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch(() => {});
    }, delay);
  }

  /**
   * 메시지 처리 (Rust 서버 프로토콜 호환)
   * Rust 서버는 { type: "EventType", payload: { ... } } 형식을 사용
   */
  private handleMessage(message: any) {
    const { type, payload } = message;

    // Rust 스타일(Snake Case) 페이로드를 JS 스타일(Camel Case)로 변환 필요 시 처리
    // 현재 RustSignaling 코드 참고 시, Rust 서버가 이미 적절히 처리하거나
    // 클라이언트가 snake_case를 처리해야 할 수 있음.
    // 여기서는 받은 그대로 emit 하되, 필요시 변환 로직 추가.

    console.debug(`[Signaling] 📩 Received: ${type}`, payload);

    // 기존 Socket.io 이벤트 핸들러들과 호환성을 위해 이벤트명 매핑
    switch (type) {
      case 'Offer':
        this.emit('offer', payload); // payload: { sdp, roomId, from }
        break;
      case 'Answer':
        this.emit('answer', payload);
        break;
      case 'IceCandidate':
        this.emit('ice-candidate', payload);
        break;
      case 'PeerJoined':
        this.emit('peer-joined', payload); // payload: { peerId }
        break;
      case 'Error':
        this.emit('error', payload);
        break;
      case 'JoinedRoom':
        this.emit('joined-room', payload);
        break;
      case 'RoomUsers':
        this.emit('room-users', payload);
        break;
      case 'UserLeft':
        this.emit('user-left', payload);
        break;
      case 'RoomFull':
        this.emit('room-full', payload);
        break;
      default:
        this.emit(type.toLowerCase(), payload);
        break;
    }
  }

  /**
   * 메시지 전송
   */
  public send(type: string, payload: any = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[Signaling] Cannot send: WebSocket not open');
      return;
    }

    // Rust 서버가 기대하는 포맷으로 전송
    const message = JSON.stringify({
      type,
      payload,
    });

    this.ws.send(message);
  }

  public on(event: string, handler: SignalHandler): void {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  public off(event: string, handler: SignalHandler): void {
    if (!this.handlers[event]) return;
    this.handlers[event] = this.handlers[event].filter(h => h !== handler);
  }

  private emit(event: string, data: any): void {
    this.handlers[event]?.forEach(h => h(data));
  }

  public getWebSocket(): WebSocket | null {
    return this.ws;
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // API Methods (Socket.io 버전과 동일한 인터페이스 유지)
  public async joinRoom(roomId: string): Promise<void> {
    if (!this.isConnected()) {
      console.log('[Signaling] Not connected, waiting...');
      await this.connect();
    }

    console.log('[Signaling] 🚪 Joining room:', roomId);
    this.send('JoinRoom', { roomId });
  }

  public leaveRoom(roomId: string) {
    this.send('LeaveRoom', { roomId });
  }

  /**
   * 🚀 [Multi-Receiver] target 파라미터 추가 - 특정 피어에게만 전달
   */
  public sendOffer(
    roomId: string,
    offer: RTCSessionDescriptionInit,
    target?: string
  ) {
    console.log('[Signaling] 📤 Sending offer to:', target || roomId);
    this.send('Offer', { roomId, offer, target });
  }

  public sendAnswer(
    roomId: string,
    answer: RTCSessionDescriptionInit,
    target?: string
  ) {
    console.log('[Signaling] 📤 Sending answer to:', target || roomId);
    this.send('Answer', { roomId, answer, target });
  }

  public sendCandidate(
    roomId: string,
    candidate: RTCIceCandidate,
    target?: string
  ) {
    console.log('[Signaling] 📤 Sending ICE candidate to:', target || roomId);
    this.send('IceCandidate', { roomId, candidate, target });
  }

  // TURN 설정 관련 메서드 추가 (기존 유지)
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

      console.log('[Signaling] 🔄 Requesting TURN config for room:', roomId);

      // 타임아웃 설정 (3초) - 네트워크가 느릴 경우를 대비
      const timeout = setTimeout(() => {
        reject(new Error('TURN config request timed out'));
      }, 3000);

      // WebSocket 이벤트로 TURN 설정 요청
      const handleTurnConfig = (response: TurnConfigResponse) => {
        clearTimeout(timeout); // 응답 오면 타임아웃 해제
        this.off('turn-config-response', handleTurnConfig);

        if (response.success && response.data) {
          console.log('[Signaling] ✅ TURN config received:', {
            roomId,
            iceServerCount: response.data.iceServers.length,
            ttl: response.data.ttl,
            turnServerConnected:
              response.data.turnServerStatus.primary.connected,
          });
          resolve(response);
        } else {
          console.error('[Signaling] ❌ TURN config request failed:', response);
          reject(response);
        }
      };

      this.on('turn-config-response', handleTurnConfig);
      this.send('RequestTurnConfig', { roomId });
    });
  }

  public async refreshTurnCredentials(
    roomId: string,
    currentUsername: string
  ): Promise<TurnConfigResponse> {
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
        '[Signaling] 🔄 Refreshing TURN credentials for room:',
        roomId
      );

      const handleTurnCredentials = (response: TurnConfigResponse) => {
        this.off('turn-credentials-response', handleTurnCredentials);

        if (response.success) {
          console.log('[Signaling] ✅ TURN credentials refreshed:', {
            roomId,
            oldUsername: currentUsername,
            message: response.data?.message,
          });
          resolve(response);
        } else {
          console.error(
            '[Signaling] ❌ TURN credentials refresh failed:',
            response
          );
          reject(response);
        }
      };

      this.on('turn-credentials-response', handleTurnCredentials);
      this.send('RefreshTurnCredentials', { roomId, currentUsername });
    });
  }

  public async checkTurnServerStatus(): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject({
          success: false,
          error: 'NOT_CONNECTED',
          message: '시그널링 서버에 연결되지 않았습니다.',
        });
        return;
      }

      console.log('[Signaling] 🔄 Checking TURN server status');

      const handleTurnStatus = (response: any) => {
        this.off('turn-server-status-response', handleTurnStatus);

        if (response.success) {
          console.log(
            '[Signaling] ✅ TURN server status received:',
            response.data
          );
          resolve(response);
        } else {
          console.error(
            '[Signaling] ❌ TURN server status check failed:',
            response
          );
          reject(response);
        }
      };

      this.on('turn-server-status-response', handleTurnStatus);
      this.send('CheckTurnServerStatus', {});
    });
  }

  public async testTurnConnection(roomId = 'test-room'): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject({
          success: false,
          error: 'NOT_CONNECTED',
          message: '시그널링 서버에 연결되지 않았습니다.',
        });
        return;
      }

      console.log('[Signaling] 🧪 Testing TURN connection for room:', roomId);

      const handleTurnTest = (response: any) => {
        this.off('turn-connection-test-response', handleTurnTest);

        if (response.success) {
          console.log(
            '[Signaling] ✅ TURN connection test initiated:',
            response.data
          );
          resolve(response);
        } else {
          console.error(
            '[Signaling] ❌ TURN connection test failed:',
            response
          );
          reject(response);
        }
      };

      this.on('turn-connection-test-response', handleTurnTest);
      this.send('TestTurnConnection', { testRoomId: roomId });
    });
  }

  // TURN 연결 테스트 결과 전송
  public sendTurnConnectionTestResult(roomId: string, result: any): void {
    if (!this.isConnected()) {
      console.error('[Signaling] Cannot send TURN test result: Not connected');
      return;
    }

    console.log('[Signaling] 📤 Sending TURN connection test result:', {
      roomId,
      result,
    });

    this.send('TurnConnectionTestResult', {
      testRoomId: roomId,
      result: {
        success: result.success,
        error: result.error,
        connectionTime: result.connectionTime,
        timestamp: Date.now(),
        userAgent: navigator.userAgent,
      },
    });
  }

  // TURN 관련 이벤트 리스너 등록
  public onTurnServerStatusUpdate(callback: (data: any) => void): void {
    this.on('turn-server-status-update', callback);
  }

  public onTurnTestResult(callback: (data: any) => void): void {
    this.on('turn-test-result', callback);
  }

  // REST API를 통한 TURN 설정 요청 (폴백용)
  public async requestTurnConfigViaHttp(
    roomId: string
  ): Promise<TurnConfigResponse> {
    try {
      console.log(
        '[Signaling] 🔄 Requesting TURN config via HTTP for room:',
        roomId
      );

      const baseUrl = SIGNALING_SERVER_URL;
      const response = await fetch(
        `${baseUrl}/api/turn-config?roomId=${encodeURIComponent(roomId)}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': navigator.userAgent,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: TurnConfigResponse = await response.json();

      if (data.success && data.data) {
        console.log('[Signaling] ✅ TURN config received via HTTP:', {
          roomId,
          iceServerCount: data.data.iceServers.length,
          ttl: data.data.ttl,
        });
      }

      return data;
    } catch (error: any) {
      console.error(
        '[Signaling] ❌ TURN config request via HTTP failed:',
        error
      );
      return {
        success: false,
        error: 'HTTP_REQUEST_FAILED',
        message: `HTTP 요청 실패: ${error.message}`,
      };
    }
  }

  // REST API를 통한 TURN 자격 증명 갱신
  public async refreshTurnCredentialsViaHttp(
    roomId: string,
    currentUsername: string
  ): Promise<TurnConfigResponse> {
    try {
      console.log(
        '[Signaling] 🔄 Refreshing TURN credentials via HTTP for room:',
        roomId
      );

      const baseUrl = SIGNALING_SERVER_URL;
      const response = await fetch(`${baseUrl}/api/turn-refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': navigator.userAgent,
        },
        body: JSON.stringify({
          roomId,
          currentUsername,
          force: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: TurnConfigResponse = await response.json();

      if (data.success) {
        console.log('[Signaling] ✅ TURN credentials refreshed via HTTP:', {
          roomId,
          oldUsername: currentUsername,
          message: data.data?.message,
        });
      }

      return data;
    } catch (error: any) {
      console.error(
        '[Signaling] ❌ TURN credentials refresh via HTTP failed:',
        error
      );
      return {
        success: false,
        error: 'HTTP_REQUEST_FAILED',
        message: `HTTP 요청 실패: ${error.message}`,
      };
    }
  }
}

export const signalingService = new SignalingService();
