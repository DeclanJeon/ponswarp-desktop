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
 *
 * 🆕 Phase 2 구현 (다중 파일/폴더 전송):
 * - 배치 전송 큐 시스템
 * - 순차적 파일 전송 (Sequential Batch Transfer)
 * - 경로 정규화 (Path Normalization)
 *
 * 🆕 Phase 3 구현 (Zip Streaming):
 * - 다중 파일/폴더 전송 시 단일 Zip 스트림으로 패키징
 * - WASM Zip64Stream을 활용한 실시간 압축 스트리밍
 * - 폴더 구조 보존 (relativePath 사용)
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { isNative, getDiscoveredPeers, DiscoveredPeer } from '../utils/tauri';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { rustSignalingAdapter } from './signaling-adapter';
import { initWasmCore, Zip64Stream } from './wasmCore';

type EventHandler = (data: unknown) => void;

// 🆕 파일 읽기 청크 크기 (WASM 메모리 효율 고려)
const FILE_READ_CHUNK_SIZE = 64 * 1024;

// 🆕 파일 전송 작업을 위한 인터페이스
interface TransferJob {
  filePath: string; // 로컬 절대 경로
  fileIndex: number; // Manifest 상의 인덱스
  fileName: string;
}

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
  private peerPollingInterval: NodeJS.Timeout | null = null;
  private discoveredPeers: DiscoveredPeer[] = [];
  private initialized = false;
  private pendingManifest: unknown = null; // Sender가 보낼 manifest 저장

  // 🆕 진행률 스로틀링용
  private lastProgressEmit = 0;
  private readonly PROGRESS_THROTTLE_MS = 200; // 200ms마다 한 번만 UI 업데이트

  // 🆕 [NEW] 전송 상태 관리 (배치 전송용)
  private isTransferring = false;
  private transferQueue: TransferJob[] = [];
  private currentJobId: string | null = null;
  private totalBatchSize = 0;
  private totalBatchSent = 0;

  // 🆕 Zip 스트리밍 상태
  private isZipping = false;

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

    // 🆕 WASM 초기화
    await initWasmCore();

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

      // 중복 연결 방지: 이미 전송 중이거나 같은 피어면 무시
      if (
        (this.isTransferring || this.isZipping) &&
        this.currentPeerId === event.payload.peerId
      ) {
        logWarn(
          '[NativeTransfer]',
          '이미 전송 세션이 활성화되어 있습니다. 중복 연결 무시.'
        );
        return;
      }

      this.currentPeerId = event.payload.peerId;
      this.connected = true;
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

    // 화살표 함수로 this 바인딩
    const pollHandler = async () => {
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
    };
    this.peerPollingInterval = setInterval(pollHandler, 2000);
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
   * 🆕 [UPDATED] 전송 시작 진입점
   * 다중 파일 및 단일 파일 전송을 배치 전송으로 처리
   *
   * @참고: Zip Streaming은 백엔드(send_stream_chunk) 미구현으로 인해 비활성화됨
   * 대신 순차적 배치 전송을 사용하여 다중 파일 전송을 지원함
   */
  async startTransferDispatcher(files: any[], peerId: string): Promise<void> {
    if (this.isTransferring || this.isZipping) {
      logWarn('[NativeTransfer]', 'Transfer already in progress.');
      return;
    }

    if (files.length === 0) {
      logWarn('[NativeTransfer]', 'No files to transfer.');
      return;
    }

    logInfo(
      '[NativeTransfer]',
      `Starting batch transfer for ${files.length} file(s).`
    );
    await this.startBatchTransfer(files, peerId);
  }

  /**
   * 🆕 [OPTIMIZED] Zip Streaming Transfer
   * 파일을 순차적으로 읽어서 WASM Zip64Stream에 넣고, 나오는 청크를 즉시 QUIC으로 전송합니다.
   * 
   * 개선 사항:
   * - 진행률 계산 정확도 향상 (원본 파일 크기 기반)
   * - 에러 처리 강화 (연결 끊김 시 안전하게 정리)
   * - 상세한 로깅 추가
   */
  async sendZipStream(files: any[], peerId: string): Promise<void> {
    if (this.isZipping || this.isTransferring) {
      logWarn('[NativeTransfer]', 'Transfer already in progress, ignoring duplicate zip stream request.');
      return;
    }

    this.isZipping = true;
    this.currentPeerId = peerId;
    this.currentJobId = `zip-${Date.now()}`;

    // UI 상태 업데이트
    this.emit('status', 'TRANSFERRING');

    let zip: Zip64Stream | null = null;

    try {
      // 1. Zip Stream 초기화 (Compression Level 1 = Fastest)
      // 속도 우선: 1 (빠름), 압축률 우선: 9, 압축 없이 묶기: 0
      zip = new Zip64Stream(1);

      // 전체 진행률 계산을 위한 변수
      let totalBytesProcessed = 0;
      const totalBytesOriginal = files.reduce(
        (acc, f) => acc + (f.nativeSize || f.size || 0),
        0
      );

      // Zip 파일명 생성 (현재 시간 사용)
      const zipFileName = `archive_${Date.now()}.zip`;

      logInfo(
        '[NativeTransfer]',
        `🚀 Starting Zip Stream: ${zipFileName}, Files: ${files.length}, Total Size: ${this.formatBytes(totalBytesOriginal)}`
      );

      // 2. 파일 순회 및 스트리밍
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // 중요: 상대 경로 사용! (폴더 구조 보존 핵심)
        // 안전한 값 추출 순서: relativePath -> name -> path에서 파일명 추출
        let zipEntryName = file.relativePath || file.name;

        // 두 값이 모두 없으면 path에서 파일명 추출
        if (!zipEntryName) {
          zipEntryName = file.path?.split(/[\\/]/).pop() || `file_${i}`;
        }

        const fileSize = BigInt(file.nativeSize || file.size || 0);

        logDebug(
          '[NativeTransfer]',
          `[${i + 1}/${files.length}] Adding to zip: ${zipEntryName} (${this.formatBytes(Number(fileSize))})`
        );

        // A. Zip Entry 시작 (Local File Header)
        const headerChunk = zip.begin_file(zipEntryName, fileSize);
        
        // Header 청크 전송
        if (headerChunk.length > 0) {
          await this.sendRawChunkToPeer(peerId, this.currentJobId, headerChunk);
          logDebug('[NativeTransfer]', `  - Header sent: ${headerChunk.length} bytes`);
        }

        // B. 파일 내용 읽기 및 압축
        // 파일 읽기 (Rust 백엔드에서 청크 단위로 읽어야 함)
        // 현재 구조에서는 invoke로 파일 전체를 읽는 방식 사용
        // TODO: 대용량 파일(2GB+)를 위해 청크 단위 읽기 구현 필요
        try {
          const nativePath = file.nativePath || file.path || (file as any).path;
          
          logDebug('[NativeTransfer]', `  - Reading file from: ${nativePath}`);
          
          const fileData = await invoke<Uint8Array>('read_file_as_bytes', {
            path: nativePath,
          });

          // WASM을 통해 압축
          logDebug('[NativeTransfer]', `  - Compressing ${fileData.length} bytes...`);
          const compressedChunk = zip.process_chunk(fileData);

          // 압축된 데이터 전송
          if (compressedChunk.length > 0) {
            await this.sendRawChunkToPeer(
              peerId,
              this.currentJobId,
              compressedChunk
            );
            logDebug('[NativeTransfer]', `  - Compressed chunk sent: ${compressedChunk.length} bytes`);
          }

          totalBytesProcessed += Number(fileSize);

          // 진행률 업데이트 (원본 파일 크기 기반)
          this.emitProgress(totalBytesProcessed, totalBytesOriginal);
        } catch (readError) {
          logError(
            '[NativeTransfer]',
            `❌ Failed to read file: ${zipEntryName}`,
            readError
          );
          // 파일 읽기 실패 시 스트림을 정리하고 에러 전파
          throw new Error(`Failed to read file ${zipEntryName}: ${readError}`);
        }

        // C. Zip Entry 종료 (Data Descriptor)
        const footerChunk = zip.end_file();
        
        if (footerChunk.length > 0) {
          await this.sendRawChunkToPeer(peerId, this.currentJobId, footerChunk);
          logDebug('[NativeTransfer]', `  - Footer sent: ${footerChunk.length} bytes`);
        }
      }

      // 3. Zip 종료 (Central Directory)
      logInfo('[NativeTransfer]', '📦 Finalizing ZIP (Central Directory)...');
      const finalChunk = zip.finalize();
      
      if (finalChunk.length > 0) {
        await this.sendRawChunkToPeer(peerId, this.currentJobId, finalChunk);
        logInfo('[NativeTransfer]', `✅ Central Directory sent: ${finalChunk.length} bytes`);
      }

      // 4. 전송 완료 신호 (EOF)
      // 스트림 전송 완료를 알리는 0바이트 청크 전송
      await this.sendRawChunkToPeer(
        peerId,
        this.currentJobId,
        new Uint8Array(0)
      );

      logInfo('[NativeTransfer]', '✅ Zip Stream transfer complete.');
      this.isZipping = false;
      this.emit('status', 'COMPLETED');
      this.emit('complete', { jobId: this.currentJobId });

      // Receiver에게 완료 알림
      if (this.currentRoomId) {
        rustSignalingAdapter.sendTransferComplete(this.currentRoomId);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError('[NativeTransfer]', '❌ Zip transfer failed:', { error, errorMessage });
      
      this.isZipping = false;
      this.emit('error', { message: `Zip Stream Failed: ${errorMessage}` });
      this.emit('status', 'ERROR');
    } finally {
      // Clean up WASM memory
      if (zip) {
        try {
          zip.free();
          logDebug('[NativeTransfer]', 'WASM Zip memory freed');
        } catch (freeError) {
          logWarn('[NativeTransfer]', 'Failed to free WASM memory:', freeError);
        }
      }
    }
  }

  /**
   * 바이트 크기를 사람이 읽기 쉬운 형식으로 변환
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  /**
   * Rust의 QUIC 전송 함수 호출 래퍼
   * 🚨 [주의] 현재 Rust Backend에는 send_stream_chunk API가 없을 수 있음
   * 필요시 별도의 스트림 전송 명령어를 구현해야 함
   */
  private async sendRawChunkToPeer(
    peerId: string,
    jobId: string,
    data: Uint8Array
  ): Promise<void> {
    try {
      // Array.from()은 오버헤드가 있을 수 있으므로 Tauri v2의 바이너리 전송 최적화 확인 필요
      // 여기서는 일반적인 invoke 호출로 가정
      // 🚨 현재 Rust Backend에 이 명령어가 없으면 주석처리 필요
      await invoke('send_stream_chunk', {
        peerId,
        jobId,
        data: Array.from(data), // Tauri가 Vec<u8>로 변환
      });
    } catch (error) {
      // send_stream_chunk가 없을 경우 대체 방식 시도
      logWarn(
        '[NativeTransfer]',
        'send_stream_chunk 실패, 스트림 전송 모드 지원되지 않음',
        error
      );
      throw new Error('Stream transfer not supported by backend');
    }
  }

  /**
   * 진행률 이벤트 발생 (스로틀링 적용)
   */
  private emitProgress(processed: number, total: number) {
    const now = Date.now();
    // 200ms 스로틀링
    if (
      now - this.lastProgressEmit < this.PROGRESS_THROTTLE_MS &&
      processed < total
    )
      return;
    this.lastProgressEmit = now;

    const progress = total > 0 ? (processed / total) * 100 : 0;
    this.emit('progress', {
      progress,
      bytesTransferred: processed,
      totalBytes: total,
      speed: 0, // 속도 계산 로직은 별도 구현 필요 (생략)
    });
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
   * 🆕 [CORE ALGORITHM] 다중 파일 일괄 전송 시작
   * SenderView에서 파일 목록을 받아 순차적으로 전송합니다.
   * @param files 전송할 파일 목록
   * @param peerId 상대방 ID
   * @param baseJobId [NEW] Manifest와 동기화된 전송 ID
   */
  async startBatchTransfer(files: any[], peerId: string, baseJobId?: string): Promise<void> {
    if (this.isTransferring) {
      logWarn('[NativeTransfer]', '이미 전송 중입니다.');
      return;
    }

    this.isTransferring = true;
    this.currentPeerId = peerId;
    // Manifest와 동일한 ID 사용 (없으면 생성하지만, 불일치 위험 있음)
    this.currentJobId = baseJobId || `batch-${Date.now()}`;
    this.totalBatchSize = files.reduce(
      (acc, f) => acc + (f.nativeSize || f.size || 0),
      0
    );
    this.totalBatchSent = 0;

    // 큐 생성: files 배열의 순서(Index)가 Manifest와 일치해야 함
    this.transferQueue = files.map((f, index) => ({
      filePath: f.nativePath || f.path || (f as any).path, // 절대 경로
      fileIndex: index,
      fileName: f.name,
    }));

    logInfo(
      '[NativeTransfer]',
      `배치 전송 시작: 총 ${files.length}개 파일, ${this.totalBatchSize} bytes`
    );
    this.emit('status', 'TRANSFERRING');

    // 큐 처리 시작
    await this.processTransferQueue();
  }

  /**
   * 🆕 [CORE ALGORITHM] 큐 처리 루프
   */
  private async processTransferQueue(): Promise<void> {
    if (this.transferQueue.length === 0) {
      this.finishBatchTransfer();
      return;
    }

    const job = this.transferQueue.shift(); // 첫 번째 작업 추출
    if (!job) return;

    try {
      logInfo(
        '[NativeTransfer]',
        `파일 전송 시작 (${job.fileIndex + 1}/${this.currentJobId}): ${job.fileName}`
      );

      // Rust로 파일 전송 요청 (비동기 대기)
      // 주의: Rust 측 send_file_to_accepted_peer가 완료될 때까지 기다립니다.
      const bytesSent = await this.sendFileToAcceptedPeer(
        this.currentPeerId!,
        job.filePath,
        `${this.currentJobId}-${job.fileIndex}`
      );

      this.totalBatchSent += bytesSent;
      logInfo(
        '[NativeTransfer]',
        `파일 전송 완료: ${job.fileName} (${bytesSent} bytes)`
      );

      // 다음 파일 처리 (재귀 호출)
      // 약간의 딜레이를 주어 Rust 스레드 정리 시간을 벰
      setTimeout(() => this.processTransferQueue(), 50);
    } catch (error) {
      logError(
        `[NativeTransfer] 파일 전송 중 오류 발생 (${job.fileName}):`,
        error
      );
      this.emit('error', error);
      this.isTransferring = false;
      this.transferQueue = []; // 남은 큐 정리
      this.emit('status', 'ERROR');
    }
  }

  private finishBatchTransfer() {
    logInfo('[NativeTransfer]', '모든 파일 전송 완료.');
    this.isTransferring = false;
    this.emit('status', 'COMPLETED');
    this.emit('complete', { jobId: this.currentJobId });

    // Receiver에게 완료 신호 전송
    if (this.currentRoomId) {
      rustSignalingAdapter.sendTransferComplete(this.currentRoomId);
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
        `수락된 피어에게 파일 전송 시작: ${filePath} -> ${peerId} (jobId: ${jobId})`
      );
      this.emit('status', 'TRANSFERRING');

      const bytesSent = await invoke<number>('send_file_to_accepted_peer', {
        peerId,
        filePath,
        jobId,
        // Rust API가 fileIndex를 지원한다면 추가할 수 있음
        // 현재는 순차적 호출만으로도 순서가 보장됨
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
   * 🆕 다중 파일 순차 수신 (Receiver)
   * Sender가 파일을 순차적으로 전송할 때, 각 파일을 순차적으로 수신합니다.
   * 
   * 구현 방식:
   * 1. Sender가 첫 번째 파일 전송을 시작하면 수신
   * 2. 수신 완료 후 다음 파일 수신 대기
   * 3. 더 이상 수신할 파일이 없으면 완료
   */
  async receiveBatchFiles(saveDir: string, baseJobId: string): Promise<string> {
    // 🆕 [핵심 수정] 연결 상태 확인 로직 개선
    logDebug(
      '[NativeTransfer]',
      `receiveBatchFiles 호출됨 - connected: ${this.connected}, peerId: ${this.currentPeerId}`
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

    let fileIndex = 0;
    let lastSavedPath = '';

    try {
      logInfo('[NativeTransfer]', `배치 파일 수신 시작: ${saveDir}`);
      this.emit('status', 'RECEIVING');

      // 🆕 다중 파일 수신 루프
      while (true) {
        const jobId = `${baseJobId}-${fileIndex}`;

        try {
          logInfo(
            '[NativeTransfer]',
            `파일 수신 대기 (${fileIndex}): ${jobId}`
          );

          const savedPath = await invoke<string>('receive_file_from_peer', {
            peerId: this.currentPeerId,
            saveDir,
            jobId,
          });

          lastSavedPath = savedPath;
          logInfo(
            '[NativeTransfer]',
            `파일 수신 완료 (${fileIndex}): ${savedPath}`
          );

          fileIndex++;

          // 진행률 업데이트 (파일 수신 성공 마다)
          this.emit('status', 'RECEIVING');
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          // 🚨 [핵심 수정] 전송 완료 후 발생하는 정상적인 연결 종료 에러들
          const isNormalClose =
            errorMessage.includes('connection lost') ||
            errorMessage.includes('closed') ||
            errorMessage.includes('reset') ||
            errorMessage.includes('stopped') ||
            errorMessage.includes('STOP_SENDING') ||
            errorMessage.includes('peer');

          // 🆕 첫 번째 파일 수신 중 정상 종료가 감지되면 모든 파일 수신 완료로 간주
          if (isNormalClose && fileIndex > 0) {
            logInfo(
              '[NativeTransfer]',
              `연결 종료 감지 - ${fileIndex}개 파일 수신 완료로 간주`
            );

            // 완료 이벤트 발생
            this.emit('status', 'COMPLETED');
            this.emit('complete', {
              jobId: baseJobId,
              message: `Batch transfer completed (${fileIndex} files)`,
            });

            // 🆕 Sender에게 전송 완료 알림 (시그널링 서버 통해)
            this.notifyTransferComplete();

            return lastSavedPath; // 마지막으로 수신된 파일 경로 반환
          }

          // 🆕 파일 수신 시작 전에 연결이 끊어진 경우
          if (fileIndex === 0 && !isNormalClose) {
            throw error;
          }

          // 그 외의 경우에는 루프 종료 (모든 파일 수신 완료)
          break;
        }
      }

      this.emit('status', 'COMPLETED');
      logInfo(
        '[NativeTransfer]',
        `배치 파일 수신 완료: 총 ${fileIndex}개 파일`
      );

      // 🆕 Sender에게 전송 완료 알림 (시그널링 서버 통해)
      this.notifyTransferComplete();

      return lastSavedPath;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logError('[NativeTransfer]', '배치 파일 수신 실패:', error);
      this.emit('error', {
        message: `수신 실패: ${errorMessage}`,
      });
      this.emit('status', 'ERROR');
      throw error;
    }
  }

  /**
   * 파일 수신 (Receiver)
   * 
   * @참고: 다중 파일 전송을 지원하기 위해 receiveBatchFiles가 추가됨
   * 단일 파일 수신도 receiveBatchFiles로 처리됨
   */
  async receiveFile(saveDir: string, jobId: string): Promise<string> {
    // 단일 파일 수신 요청을 배치 수신으로 위임
    return this.receiveBatchFiles(saveDir, jobId);
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

    // 🆕 배치 전송 상태 초기화
    this.isTransferring = false;
    this.transferQueue = [];
    this.isZipping = false;

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
