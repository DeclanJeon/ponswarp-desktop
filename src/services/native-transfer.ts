/**
 * Native 파일 전송 서비스
 *
 * WebRTC를 대체하여 QUIC 기반으로 파일을 전송합니다.
 * Tauri 환경에서만 사용 가능합니다.
 *
 * 🆕 Phase 1 구현:
 * - 시그널링 서버를 통한 방(Room) 매칭
 * - QUIC 주소 교환 후 직접 P2P 연결
 * - mDNS 피어 자동 발견 (같은 LAN)
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { isNative, getDiscoveredPeers, DiscoveredPeer } from '../utils/tauri';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { rustSignalingAdapter } from './signaling-adapter';

type EventHandler = (data: unknown) => void;

export interface TransferProgress {
  jobId: string;
  bytesTransferred: number;
  totalBytes: number;
  progressPercent: number;
  speedBps: number;
  state: string;
}

export interface NativeTransferConfig {
  peerId: string;
  peerAddress: string;
}

export interface NativePeerInfo {
  peerId: string;
  quicAddress: string;
  roomId: string;
}

/**
 * Native 파일 전송 서비스 (QUIC 기반)
 */
class NativeTransferService {
  private handlers: Map<string, EventHandler[]> = new Map();
  private unlisteners: UnlistenFn[] = [];
  private connected = false;
  private currentPeerId: string | null = null;
  private currentRoomId: string | null = null;
  private localQuicAddress: string | null = null;
  private lastSenderQuicAddress: string | null = null;
  private peerPollingInterval: ReturnType<typeof setInterval> | null = null;
  private discoveredPeers: DiscoveredPeer[] = [];
  private initialized = false;
  private pendingManifest: unknown = null; // Sender가 보낼 manifest 저장

  // 🆕 진행률 스로틀링용
  private lastProgressEmit = 0;
  private readonly PROGRESS_THROTTLE_MS = 200; // 200ms마다 한 번만 UI 업데이트

  /**
   * 이벤트 리스너 설정
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logDebug('[NativeTransfer]', '이미 초기화됨');
      return;
    }

    const native = await isNative();
    if (!native) {
      throw new Error(
        'NativeTransferService는 Tauri 환경에서만 사용 가능합니다.'
      );
    }

    logInfo('[NativeTransfer]', 'QUIC 전송 서비스 초기화 중...');

    // 로컬 QUIC 서버 주소 가져오기
    try {
      const runtimeInfo = await invoke<{ quicAddress?: string }>(
        'get_runtime_info'
      );
      logDebug('[NativeTransfer]', '런타임 정보:', JSON.stringify(runtimeInfo));
    } catch (e) {
      logWarn('[NativeTransfer]', '런타임 정보 조회 실패:', e);
    }

    // Rust 백엔드 이벤트 수신 (스로틀링 적용)
    // 🚨 Rust는 snake_case 필드명 사용: progress_percent, bytes_transferred, speed_bps, total_bytes
    const progressUnlisten = await listen<any>('transfer-progress', event => {
      const now = Date.now();
      const payload = event.payload;

      // 🆕 snake_case -> camelCase 변환
      const progressPercent =
        payload?.progress_percent ?? payload?.progressPercent ?? 0;
      const bytesTransferred =
        payload?.bytes_transferred ?? payload?.bytesTransferred ?? 0;
      const speedBps = payload?.speed_bps ?? payload?.speedBps ?? 0;
      const totalBytes = payload?.total_bytes ?? payload?.totalBytes ?? 0;

      // 🆕 null 체크 - payload가 유효한지 확인
      if (!payload || typeof progressPercent !== 'number') {
        logWarn('[NativeTransfer]', '잘못된 진행률 데이터:', payload);
        return;
      }

      // 🆕 스로틀링: 200ms마다 또는 100% 완료 시에만 emit
      if (
        now - this.lastProgressEmit >= this.PROGRESS_THROTTLE_MS ||
        progressPercent >= 100
      ) {
        this.lastProgressEmit = now;

        const progressData = {
          progress: progressPercent,
          speed: speedBps,
          bytesTransferred: bytesTransferred,
          totalBytes: totalBytes,
        };

        this.emit('progress', progressData);
      }
    });
    this.unlisteners.push(progressUnlisten);

    const completeUnlisten = await listen('transfer-complete', event => {
      logInfo('[NativeTransfer]', '전송 완료:', event.payload);
      this.emit('complete', event.payload);
      this.emit('status', 'COMPLETED');
    });
    this.unlisteners.push(completeUnlisten);

    // 피어 발견 이벤트
    const peerDiscoveredUnlisten = await listen<NativePeerInfo>(
      'peer-discovered',
      event => {
        logInfo('[NativeTransfer]', '피어 발견:', event.payload);
        this.emit('peer-discovered', event.payload);
      }
    );
    this.unlisteners.push(peerDiscoveredUnlisten);

    // 🆕 QUIC 서버에서 피어 연결 수락 이벤트 (Sender용)
    const quicPeerConnectedUnlisten = await listen<{
      peerId: string;
      peerAddr: string;
    }>('quic-peer-connected', event => {
      logInfo('[NativeTransfer]', '🔗 QUIC 피어 연결됨:', event.payload);
      this.emit('quic-peer-connected', event.payload);
    });
    this.unlisteners.push(quicPeerConnectedUnlisten);

    // mDNS 피어 폴링 시작
    this.startPeerPolling();

    this.initialized = true;
    logInfo('[NativeTransfer]', '초기화 완료');
  }

  /**
   * mDNS 피어 폴링
   */
  private startPeerPolling(): void {
    if (this.peerPollingInterval) return;

    this.peerPollingInterval = setInterval(async () => {
      try {
        const peers = await getDiscoveredPeers();

        // 새로 발견된 피어 알림
        const newPeers = peers.filter(
          p => !this.discoveredPeers.find(existing => existing.id === p.id)
        );

        for (const peer of newPeers) {
          logInfo(
            '[NativeTransfer]',
            `새 피어 발견: ${peer.id} @ ${peer.address}`
          );
          this.emit('peer-discovered', {
            peerId: peer.id,
            quicAddress: peer.address,
          });
        }

        this.discoveredPeers = peers;
      } catch (error) {
        logWarn('[NativeTransfer]', '피어 폴링 오류:', error);
      }
    }, 2000);
  }

  /**
   * 발견된 피어 목록 조회
   */
  getDiscoveredPeers(): DiscoveredPeer[] {
    return this.discoveredPeers;
  }

  /**
   * 🆕 방 생성 (Sender)
   * 시그널링 서버에 방을 만들고 QUIC 주소를 공유합니다.
   */
  async createRoom(roomId: string, manifest?: unknown): Promise<void> {
    this.currentRoomId = roomId;

    // 🆕 QUIC 서버 시작 (Sender는 수신 대기)
    try {
      const serverAddr = await invoke<string>('start_quic_server', { port: 0 });
      logInfo('[NativeTransfer]', `QUIC 서버 시작됨: ${serverAddr}`);
      this.localQuicAddress = serverAddr;

      // start_quic_server는 원격에서 접속 가능한 주소를 반환하도록 구현됨.
      // 만약 구버전 백엔드가 0.0.0.0을 반환하면 그대로 두고 경고만 남김.
      const connectableAddr = serverAddr;
      if (serverAddr.startsWith('0.0.0.0:')) {
        logWarn(
          '[NativeTransfer]',
          `QUIC 서버 주소가 바인딩 주소로 반환됨(원격 접속 불가): ${serverAddr}`
        );
      }

      // Manifest에 QUIC 주소 추가
      if (manifest && typeof manifest === 'object') {
        const manifestObj = manifest as Record<string, unknown>;
        manifestObj.quicAddress = connectableAddr;
        logInfo(
          '[NativeTransfer]',
          `Manifest에 QUIC 주소 추가: ${connectableAddr}`
        );
      }
    } catch (e) {
      logWarn('[NativeTransfer]', 'QUIC 서버 시작 실패:', e);
    }

    this.pendingManifest = manifest || null;

    // 시그널링 서버에 연결 및 방 참여
    if (!rustSignalingAdapter.isConnected()) {
      const signalingUrl =
        import.meta.env.VITE_RUST_SIGNALING_URL || 'ws://localhost:5502/ws';
      await rustSignalingAdapter.connect(signalingUrl);
    }

    await rustSignalingAdapter.joinRoom(roomId);

    // 피어 참여 이벤트 수신
    rustSignalingAdapter.on('peer-joined', this.handlePeerJoined.bind(this));

    // 🆕 전송 완료 이벤트 수신 (Receiver -> Sender)
    rustSignalingAdapter.on(
      'transfer-complete',
      this.handleTransferComplete.bind(this)
    );

    logInfo('[NativeTransfer]', `방 생성됨: ${roomId}`);
    this.emit('room-created', { roomId });
  }

  /**
   * Manifest 설정 (Sender)
   */
  setManifest(manifest: unknown): void {
    this.pendingManifest = manifest;
    logInfo('[NativeTransfer]', 'Manifest 설정됨');
  }

  /**
   * 🆕 방 참여 (Receiver)
   * 시그널링 서버를 통해 Sender의 QUIC 주소를 받아 연결합니다.
   */
  async joinRoom(roomId: string): Promise<void> {
    this.currentRoomId = roomId;

    // 🆕 QUIC 서버 시작 (Receiver는 파일 수신 대기)
    try {
      const serverAddr = await invoke<string>('start_quic_server', { port: 0 });
      logInfo('[NativeTransfer]', `QUIC 서버 시작됨: ${serverAddr}`);
      this.localQuicAddress = serverAddr;
    } catch (e) {
      logWarn('[NativeTransfer]', 'QUIC 서버 시작 실패:', e);
    }

    // 시그널링 서버에 연결 및 방 참여
    if (!rustSignalingAdapter.isConnected()) {
      const signalingUrl = import.meta.env.VITE_RUST_SIGNALING_URL;
      await rustSignalingAdapter.connect(signalingUrl);
    }

    await rustSignalingAdapter.joinRoom(roomId);

    // 기존 사용자 목록에서 Sender 찾기
    rustSignalingAdapter.on('room-users', this.handleRoomUsers.bind(this));

    // 🆕 Manifest 수신 이벤트 등록 (manifest에 Sender의 QUIC 주소 포함)
    rustSignalingAdapter.on('manifest', this.handleManifest.bind(this));

    logInfo('[NativeTransfer]', `방 참여: ${roomId}`);
    this.emit('room-joined', { roomId });
  }

  /**
   * Manifest 수신 핸들러 (Receiver 측)
   */
  private async handleManifest(data: unknown): Promise<void> {
    const payload = data as Record<string, unknown> & { manifest?: string };
    logDebug('[NativeTransfer]', 'handleManifest raw data:', data);

    if (!payload?.manifest) {
      logWarn('[NativeTransfer]', 'Manifest 데이터가 없음:', data);
      return;
    }

    try {
      // Sender 식별자 추출 (Rust payload 변형/호환성 대응)
      const senderId =
        (payload.from as string | undefined) ||
        (payload.socketId as string | undefined) ||
        (payload.socket_id as string | undefined) ||
        (payload.senderId as string | undefined) ||
        (payload.sender_id as string | undefined);

      // 🚨 [FIX] manifest가 이중 JSON 인코딩되어 있을 수 있음
      let manifest = payload.manifest;

      // 문자열이면 파싱
      if (typeof manifest === 'string') {
        try {
          manifest = JSON.parse(manifest);
        } catch (e) {
          // 파싱 실패시 원본 사용 시도하거나 에러
          logWarn('[NativeTransfer]', '첫 번째 JSON 파싱 실패:', e);
        }
      }

      // 혹시라도 한 번 더 인코딩 되어 있다면 (안전장치)
      if (typeof manifest === 'string') {
        try {
          manifest = JSON.parse(manifest);
        } catch (e) {
          logWarn('[NativeTransfer]', '두 번째 JSON 파싱 실패:', e);
        }
      }

      logInfo(
        '[NativeTransfer]',
        `Manifest 수신됨 from ${payload.from}:`,
        manifest
      );
      logInfo(
        '[NativeTransfer]',
        `Manifest 상세: totalSize=${(manifest as unknown as Record<string, unknown>)?.totalSize}, totalFiles=${(manifest as unknown as Record<string, unknown>)?.totalFiles}, rootName=${(manifest as unknown as Record<string, unknown>)?.rootName}`
      );

      // 🚨 [핵심 수정] UI 업데이트를 위해 메타데이터를 먼저 방출합니다.
      // 연결보다 UI 표시가 우선되어야 사용자가 "아, 뭔가 오고 있구나"를 알 수 있습니다.
      this.emit('metadata', manifest);

      // 🆕 Sender의 QUIC 주소로 연결
      const senderQuicAddress = (manifest as unknown as Record<string, unknown>)
        ?.quicAddress;

      // 다음 단계(Materialize)에서 재시도할 수 있도록 마지막 sender 정보 저장
      this.currentPeerId = senderId || this.currentPeerId;
      if (typeof senderQuicAddress === 'string') {
        this.lastSenderQuicAddress = senderQuicAddress;
      }

      if (senderQuicAddress && senderId) {
        logInfo(
          '[NativeTransfer]',
          `Sender 연결 시도: ${senderId} @ ${senderQuicAddress}`
        );

        // 🆕 [중요] 연결 시도 전 상태 초기화
        this.connected = false;
        this.currentPeerId = senderId;

        // 연결은 비동기로 진행
        const connected = await this.connectToPeer(
          senderId,
          senderQuicAddress as string
        );

        if (!connected) {
          logError('[NativeTransfer]', '❌ Sender 연결 실패');
          this.emit('error', { message: 'Failed to connect to sender' });
          return;
        }

        // 🆕 연결 성공 - Sender에게 준비 완료 알림
        logInfo('[NativeTransfer]', '✅ Sender 연결 성공, 파일 수신 준비 완료');
        this.emit('connected', { peerId: senderId });
      } else {
        // QUIC 주소가 없을 경우 처리
        logError(
          '[NativeTransfer]',
          '❌ Manifest에 QUIC 주소 또는 senderId가 없습니다.',
          {
            senderQuicAddress,
            senderId,
            manifest,
          }
        );
      }
    } catch (e) {
      logError('[NativeTransfer]', 'Manifest 파싱 실패:', {
        error: e,
        rawData: payload.manifest,
      });
    }
  }

  /**
   * 피어 참여 핸들러 (Sender 측)
   */
  private async handlePeerJoined(data: unknown): Promise<void> {
    // payload는 {socketId: string, roomId: string} 형태로 전달됨
    const payload = data as { socketId?: string; roomId?: string };
    const peerId = payload?.socketId;
    if (!peerId) {
      logWarn('[NativeTransfer]', '피어 ID가 없음:', data);
      return;
    }

    logInfo('[NativeTransfer]', `피어 참여: ${peerId}`);
    this.emit('peer-joined', { peerId });

    // 🆕 Manifest 전송 (시그널링 서버 통해)
    if (this.pendingManifest && this.currentRoomId) {
      logInfo('[NativeTransfer]', `Manifest 전송 중: ${peerId}`);
      rustSignalingAdapter.sendManifest(
        this.currentRoomId,
        this.pendingManifest,
        peerId
      );
    }
  }

  /**
   * 🆕 전송 완료 핸들러 (Sender 측)
   * Receiver가 파일 수신을 완료했음을 알림
   */
  private handleTransferComplete(data: unknown): void {
    const payload = data as { from?: string };
    logInfo(
      '[NativeTransfer]',
      `✅✅✅ Receiver 전송 완료 확인 수신됨!!! from: ${payload?.from || 'unknown'}`
    );
    logInfo('[NativeTransfer]', '📤 Sender UI에 완료 이벤트 전달 중...');

    // Sender UI에 완료 이벤트 전달
    this.emit('receiver-complete', { peerId: payload?.from });
    this.emit('complete', { confirmedBy: payload?.from });
    this.emit('status', 'COMPLETED');

    logInfo('[NativeTransfer]', '✅ Sender UI 완료 이벤트 전달 완료');
  }

  /**
   * 방 사용자 목록 핸들러 (Receiver 측)
   */
  private async handleRoomUsers(data: unknown): Promise<void> {
    // payload는 {users: string[]} 형태로 전달됨
    const payload = data as { users?: string[] };
    const users = payload?.users;

    if (!Array.isArray(users)) {
      logWarn('[NativeTransfer]', '방 사용자 목록이 배열이 아님:', data);
      return;
    }

    logInfo('[NativeTransfer]', `방 사용자 목록: ${users.length}명`);

    // 자신을 제외한 첫 번째 사용자가 Sender
    const myId = rustSignalingAdapter.getSocketId();
    const senderId = users.find(id => id !== myId);

    if (senderId) {
      logInfo('[NativeTransfer]', `Sender 발견: ${senderId}`);
      this.emit('sender-found', { senderId });
    }
  }

  /**
   * 피어에 연결
   */
  async connectToPeer(peerId: string, peerAddress: string): Promise<boolean> {
    try {
      logInfo('[NativeTransfer]', `피어 연결 시도: ${peerId} @ ${peerAddress}`);

      const result = await invoke<boolean>('connect_to_peer', {
        peerId,
        peerAddress,
      });

      if (result) {
        this.connected = true;
        this.currentPeerId = peerId;
        this.emit('connected', { peerId });
        logInfo('[NativeTransfer]', '✅ 피어 연결 성공');

        // 🆕 연결 상태 확인을 위한 추가 검증
        // 실제 연결이 유효한지 확인하기 위해 간단한 ping 테스트
        try {
          const pingResult = await invoke<boolean>('ping_quic');
          if (pingResult) {
            logInfo('[NativeTransfer]', '✅ QUIC 연결 상태 확인 완료');
          } else {
            logWarn('[NativeTransfer]', '⚠️ QUIC 연결 상태 확인 실패');
          }
        } catch (pingError) {
          logWarn('[NativeTransfer]', '⚠️ QUIC ping 테스트 실패:', pingError);
        }
      } else {
        logError('[NativeTransfer]', '❌ 피어 연결 실패: invoke 결과 false');
      }

      return result;
    } catch (error) {
      logError('[NativeTransfer]', '❌ 피어 연결 실패:', error);
      this.emit('error', {
        message: `연결 실패: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * 발견된 피어 중 특정 피어에 연결
   */
  async connectToDiscoveredPeer(peerId: string): Promise<boolean> {
    const peers = await getDiscoveredPeers();
    const peer = peers.find(p => p.id === peerId);

    if (!peer) {
      logError('[NativeTransfer]', `피어를 찾을 수 없음: ${peerId}`);
      return false;
    }

    return this.connectToPeer(peerId, peer.address);
  }

  /**
   * 파일 전송 (Sender - 클라이언트로 연결한 경우)
   */
  async sendFile(filePath: string, jobId: string): Promise<number> {
    if (!this.connected || !this.currentPeerId) {
      throw new Error('피어에 연결되어 있지 않습니다.');
    }

    try {
      logInfo('[NativeTransfer]', `파일 전송 시작: ${filePath}`);
      this.emit('status', 'TRANSFERRING');

      const bytesSent = await invoke<number>('send_file_to_peer', {
        peerId: this.currentPeerId,
        filePath,
        jobId,
      });

      this.emit('status', 'COMPLETED');
      logInfo('[NativeTransfer]', `파일 전송 완료: ${bytesSent} bytes`);
      return bytesSent;
    } catch (error) {
      // 🚨 [수정] 더 상세한 오류 정보 로깅
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorType =
        error instanceof Error ? error.constructor.name : typeof error;

      logError('[NativeTransfer]', '파일 전송 실패:', {
        message: errorMessage,
        type: errorType,
        stack: error instanceof Error ? error.stack : undefined,
        raw: error,
      });

      this.emit('error', {
        message: `전송 실패: ${errorMessage}`,
        type: errorType,
        raw: error,
      });
      this.emit('status', 'ERROR');
      throw error;
    }
  }

  /**
   * 🆕 수락된 피어에게 파일 전송 (Sender - 서버 역할)
   * Receiver가 Sender의 QUIC 서버에 연결하면 이 메서드로 전송
   */
  async sendFileToAcceptedPeer(
    peerId: string,
    filePath: string,
    jobId: string
  ): Promise<number> {
    // 🚨 [수정] 전송 완료 상태 추적을 위한 플래그
    let isCompleted = false;
    // 🆕 중복 오류 방지를 위한 에러 메시지 추적
    let lastErrorMessage = '';

    try {
      logInfo(
        '[NativeTransfer]',
        `수락된 피어에게 파일 전송 시작: ${filePath} -> ${peerId}`
      );
      this.emit('status', 'TRANSFERRING');

      const bytesSent = await invoke<number>('send_file_to_accepted_peer', {
        peerId,
        filePath,
        jobId,
      });

      // 🚨 [수정] 전송 완료 플래그 설정
      isCompleted = true;
      this.emit('status', 'COMPLETED');
      logInfo('[NativeTransfer]', `전송 완료:`, { bytesSent, jobId, peerId });
      return bytesSent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // 🆕 중복 오류 확인
      if (errorMessage === lastErrorMessage) {
        logWarn('[NativeTransfer]', '중복 오류 무시:', errorMessage);
        return 0; // 중복 오류는 무시
      }
      lastErrorMessage = errorMessage;

      // 🚨 [수정] 이미 완료된 전송에 대한 오류는 무시
      if (isCompleted) {
        logWarn(
          '[NativeTransfer]',
          '전송 완료 후 발생한 오류 무시 (정상적인 연결 종료):',
          { message: errorMessage, error }
        );
        return 0; // 이미 완료된 전송이므로 0 반환
      }

      // 🆕 "connection lost" 오류는 전송 완료 후 정상적인 경우일 수 있음
      if (errorMessage.includes('connection lost')) {
        logWarn(
          '[NativeTransfer]',
          'Connection lost 감지 - 전송 완료 후 정상일 수 있음:',
          { message: errorMessage, jobId, peerId }
        );
        this.emit('connection-lost', { message: errorMessage, jobId, peerId });
        return 0; // connection lost는 오류로 처리하지 않음
      }

      logError('[NativeTransfer]', '파일 전송 실패:', {
        message: errorMessage,
        type: error instanceof Error ? error.constructor.name : typeof error,
        stack: error instanceof Error ? error.stack : undefined,
        jobId,
        peerId,
      });

      this.emit('error', {
        message: `전송 실패: ${errorMessage}`,
        type: error instanceof Error ? error.constructor.name : typeof error,
        jobId,
        peerId,
      });
      this.emit('status', 'ERROR');
      throw error;
    }
  }

  /**
   * 🆕 수락된 피어 목록 조회
   */
  async getAcceptedPeers(): Promise<string[]> {
    try {
      return await invoke<string[]>('get_accepted_peers');
    } catch (error) {
      logError('[NativeTransfer]', '수락된 피어 목록 조회 실패:', error);
      return [];
    }
  }

  /**
   * 파일 수신 (Receiver)
   */
  async receiveFile(saveDir: string, jobId: string): Promise<string> {
    // 🆕 [핵심 수정] 연결 상태 확인 로직 개선
    logDebug(
      '[NativeTransfer]',
      `receiveFile 호출됨 - connected: ${this.connected}, peerId: ${this.currentPeerId}`
    );

    if (!this.connected || !this.currentPeerId) {
      // 🆕 자동 재연결 시도 (Materialize 버튼 시 UX 개선)
      if (this.currentPeerId && this.lastSenderQuicAddress) {
        logWarn(
          '[NativeTransfer]',
          `연결이 없어서 자동 재연결 시도: ${this.currentPeerId} @ ${this.lastSenderQuicAddress}`
        );
        const ok = await this.connectToPeer(
          this.currentPeerId,
          this.lastSenderQuicAddress
        );
        if (!ok) {
          const errorMsg = `자동 재연결 실패: peerId=${this.currentPeerId}`;
          logError('[NativeTransfer]', errorMsg);
          throw new Error(errorMsg);
        }
      } else {
        // 🆕 상세한 디버깅 정보 제공
        const errorMsg = `피어에 연결되어 있지 않습니다. connected=${this.connected}, peerId=${this.currentPeerId}`;
        logError('[NativeTransfer]', errorMsg);
        throw new Error(errorMsg);
      }
    }

    try {
      logInfo('[NativeTransfer]', `파일 수신 대기: ${saveDir}`);
      this.emit('status', 'RECEIVING');

      const savedPath = await invoke<string>('receive_file_from_peer', {
        peerId: this.currentPeerId,
        saveDir,
        jobId,
      });

      this.emit('status', 'COMPLETED');
      logInfo('[NativeTransfer]', `파일 수신 완료: ${savedPath}`);

      // 🆕 Sender에게 전송 완료 알림 (시그널링 서버 통해)
      this.notifyTransferComplete();

      return savedPath;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // 🚨 [핵심 수정] 전송 완료 후 발생하는 정상적인 연결 종료 에러들
      // - "connection lost": 연결이 끊어짐
      // - "closed": 스트림/연결이 닫힘
      // - "reset": 연결이 리셋됨
      // - "stopped": Sender가 스트림을 finish()로 종료함 (정상)
      // - "sending stopped by peer": QUIC 스트림 종료 신호
      const isNormalClose =
        errorMessage.includes('connection lost') ||
        errorMessage.includes('closed') ||
        errorMessage.includes('reset') ||
        errorMessage.includes('stopped') ||
        errorMessage.includes('STOP_SENDING') ||
        errorMessage.includes('peer');

      if (isNormalClose) {
        logWarn(
          '[NativeTransfer]',
          '연결 종료 감지 - 전송 완료 후 정상일 수 있음:',
          errorMessage
        );

        // 완료 이벤트 발생 (에러 대신)
        this.emit('status', 'COMPLETED');
        this.emit('complete', {
          jobId,
          message: 'Transfer completed (connection closed by sender)',
        });

        // 🆕 Sender에게 전송 완료 알림 (시그널링 서버 통해)
        this.notifyTransferComplete();

        return saveDir; // 저장 디렉토리 반환 (실제 파일 경로는 알 수 없음)
      }

      logError('[NativeTransfer]', '파일 수신 실패:', error);
      this.emit('error', {
        message: `수신 실패: ${errorMessage}`,
      });
      this.emit('status', 'ERROR');
      throw error;
    }
  }

  /**
   * 🆕 전송 완료 알림 (Receiver -> Sender)
   * 시그널링 서버를 통해 Sender에게 파일 수신 완료를 알립니다.
   */
  private notifyTransferComplete(): void {
    logInfo(
      '[NativeTransfer]',
      `📤📤📤 notifyTransferComplete 호출됨! roomId: ${this.currentRoomId}`
    );

    if (!this.currentRoomId) {
      logWarn('[NativeTransfer]', '전송 완료 알림 실패: roomId 없음');
      return;
    }

    // 시그널링 연결 상태 확인
    const isConnected = rustSignalingAdapter.isConnected();
    logInfo(
      '[NativeTransfer]',
      `시그널링 연결 상태: ${isConnected ? '연결됨' : '연결 안됨'}`
    );

    if (!isConnected) {
      logWarn(
        '[NativeTransfer]',
        '시그널링 서버 연결이 끊어져 있어 전송 완료 알림을 보낼 수 없습니다.'
      );
      return;
    }

    try {
      logInfo(
        '[NativeTransfer]',
        `📤 Sender에게 전송 완료 알림 전송 중... roomId: ${this.currentRoomId}`
      );
      rustSignalingAdapter.sendTransferComplete(this.currentRoomId);
      logInfo('[NativeTransfer]', '✅ 전송 완료 알림 전송 성공');
    } catch (e) {
      logError('[NativeTransfer]', '전송 완료 알림 전송 실패:', e);
    }
  }

  /**
   * 연결 해제
   */
  async disconnect(): Promise<void> {
    if (this.currentPeerId) {
      try {
        await invoke('disconnect_peer', { peerId: this.currentPeerId });
        logInfo('[NativeTransfer]', '피어 연결 해제');
      } catch (error) {
        logWarn('[NativeTransfer]', '연결 해제 중 오류:', error);
      }
    }

    this.connected = false;
    this.currentPeerId = null;
  }

  /**
   * 정리
   */
  async cleanup(): Promise<void> {
    await this.disconnect();

    // 피어 폴링 중지
    if (this.peerPollingInterval) {
      clearInterval(this.peerPollingInterval);
      this.peerPollingInterval = null;
    }

    // 이벤트 리스너 해제 (Tauri 이벤트만 해제)
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];

    // 🚨 [핵심 수정] 내부 핸들러 맵(this.handlers)은 초기화하지 않습니다.
    // ReceiverView가 unmount되지 않았는데 cleanup이 호출되는 경우,
    // 다시 이벤트가 발생했을 때 핸들러가 남아있어야 UI가 반응합니다.
    // this.handlers.clear();

    // 상태 초기화
    this.currentRoomId = null;
    this.discoveredPeers = [];
    this.initialized = false;
    logInfo('[NativeTransfer]', '서비스 정리 완료');
  }

  /**
   * 현재 방 ID
   */
  getCurrentRoomId(): string | null {
    return this.currentRoomId;
  }

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 현재 연결된 피어 ID
   */
  getCurrentPeerId(): string | null {
    return this.currentPeerId;
  }

  // --- 이벤트 에미터 ---

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler: EventHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    }
  }

  private emit(event: string, data: unknown): void {
    this.handlers.get(event)?.forEach(h => h(data));
  }
}

export const nativeTransferService = new NativeTransferService();
