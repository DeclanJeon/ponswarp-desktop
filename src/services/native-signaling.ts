/**
 * Native (Tauri) 시그널링 서비스
 *
 * Phase 1에서 구현 예정:
 * - QUIC 기반 P2P 시그널링
 * - mDNS를 통한 피어 자동 발견
 * - 중앙 서버 없는 직접 연결
 *
 * 현재는 Stub으로, Rust WebSocket으로 폴백합니다.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isNative, getDiscoveredPeers, DiscoveredPeer } from '../utils/tauri';

type MessageHandler = (data: unknown) => void;

class NativeSignalingService {
  private handlers: Map<string, MessageHandler[]> = new Map();
  private nodeId: string | null = null;
  private connected = false;
  private peers: DiscoveredPeer[] = [];
  private peerPollingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(): Promise<void> {
    const native = await isNative();
    if (!native) {
      throw new Error(
        'NativeSignalingService는 Tauri 환경에서만 사용 가능합니다.'
      );
    }

    console.log('[NativeSignaling] QUIC P2P 시그널링 초기화 중...');

    this.nodeId = `ponswarp-${Date.now().toString(36)}`;
    this.connected = true;

    // 🆕 Rust 백엔드에서 오는 시그널링 이벤트를 수신 대기
    this.setupTauriEventListeners();

    this.startPeerPolling();

    this.emit('connected', this.nodeId);
    console.log('[NativeSignaling] 연결됨:', this.nodeId);
  }

  /**
   * 🆕 Rust 백엔드에서 오는 시그널링 이벤트를 수신 대기
   */
  private setupTauriEventListeners(): void {
    // Offer 이벤트 수신
    listen('signaling-offer', event => {
      console.log(
        '[NativeSignaling] 📨 Offer received from Rust:',
        event.payload
      );
      const payload = event.payload as any;
      this.emit('offer', {
        from: payload.from,
        offer: { type: 'offer', sdp: payload.sdp },
      });
    });

    // Answer 이벤트 수신
    listen('signaling-answer', event => {
      console.log(
        '[NativeSignaling] 📨 Answer received from Rust:',
        event.payload
      );
      const payload = event.payload as any;
      this.emit('answer', {
        from: payload.from,
        answer: { type: 'answer', sdp: payload.sdp },
      });
    });

    // ICE Candidate 이벤트 수신
    listen('signaling-ice-candidate', event => {
      console.log(
        '[NativeSignaling] 📨 ICE Candidate received from Rust:',
        event.payload
      );
      const payload = event.payload as any;
      this.emit('ice-candidate', {
        from: payload.from,
        candidate: { candidate: payload.candidate },
      });
    });
  }

  private startPeerPolling() {
    this.peerPollingInterval = setInterval(async () => {
      try {
        const peers = await getDiscoveredPeers();

        const newPeers = peers.filter(
          p => !this.peers.find(existing => existing.id === p.id)
        );

        const removedPeers = this.peers.filter(
          p => !peers.find(current => current.id === p.id)
        );

        for (const peer of newPeers) {
          console.log('[NativeSignaling] 새 피어 발견:', peer.id);
          this.emit('peer-joined', { socketId: peer.id, roomId: 'local' });
        }

        for (const peer of removedPeers) {
          console.log('[NativeSignaling] 피어 제거:', peer.id);
          this.emit('user-left', { socketId: peer.id });
        }

        this.peers = peers;
      } catch (error) {
        console.error('[NativeSignaling] 피어 폴링 오류:', error);
      }
    }, 2000);
  }

  async joinRoom(roomId: string): Promise<void> {
    console.log('[NativeSignaling] 방 참여:', roomId);
    console.log('[NativeSignaling] Native 모드에서는 mDNS 기반 자동 발견 사용');

    this.emit('joined-room', {
      roomId,
      socketId: this.nodeId,
      userCount: this.peers.length + 1,
    });

    this.emit(
      'room-users',
      this.peers.map(p => p.id)
    );
  }

  leaveRoom(_roomId: string): void {
    console.log('[NativeSignaling] 방 퇴장');
  }

  sendOffer(
    roomId: string,
    offer: RTCSessionDescriptionInit,
    target?: string
  ): void {
    if (!target) {
      console.error(
        '[NativeSignaling] ❌ sendOffer requires a target peer ID for P2P'
      );
      return;
    }

    const message = {
      type: 'Offer',
      room_id: roomId,
      sdp: offer.sdp,
      target,
    };

    invoke('send_signaling_message', {
      peerId: target,
      message: message,
    })
      .then(() => {
        console.log(`[NativeSignaling] ✅ Offer sent to ${target}`);
      })
      .catch(error => {
        console.error('[NativeSignaling] ❌ Failed to send offer:', error);
        this.emit('error', { message: 'Failed to send offer' });
      });
  }

  sendAnswer(
    roomId: string,
    answer: RTCSessionDescriptionInit,
    target?: string
  ): void {
    if (!target) {
      console.error(
        '[NativeSignaling] ❌ sendAnswer requires a target peer ID for P2P'
      );
      return;
    }

    const message = {
      type: 'Answer',
      room_id: roomId,
      sdp: answer.sdp,
      target,
    };

    invoke('send_signaling_message', {
      peerId: target,
      message: message,
    })
      .then(() => {
        console.log(`[NativeSignaling] ✅ Answer sent to ${target}`);
      })
      .catch(error => {
        console.error('[NativeSignaling] ❌ Failed to send answer:', error);
        this.emit('error', { message: 'Failed to send answer' });
      });
  }

  sendCandidate(
    roomId: string,
    candidate: RTCIceCandidate,
    target?: string
  ): void {
    if (!target) {
      console.error(
        '[NativeSignaling] ❌ sendCandidate requires a target peer ID for P2P'
      );
      return;
    }

    const message = {
      type: 'IceCandidate',
      room_id: roomId,
      candidate: candidate.candidate,
      target,
    };

    invoke('send_signaling_message', {
      peerId: target,
      message: message,
    })
      .then(() => {
        console.log(`[NativeSignaling] ✅ ICE Candidate sent to ${target}`);
      })
      .catch(error => {
        console.error(
          '[NativeSignaling] ❌ Failed to send ICE candidate:',
          error
        );
        this.emit('error', { message: 'Failed to send ICE candidate' });
      });
  }

  async requestTurnConfig(_roomId: string): Promise<unknown> {
    console.log('[NativeSignaling] Native 모드에서는 TURN 불필요 (직접 연결)');
    return {
      success: true,
      data: {
        iceServers: [],
        ttl: 86400,
        timestamp: Date.now(),
        roomId: _roomId,
      },
    };
  }

  on(event: string, handler: MessageHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    }
  }

  private emit(event: string, data: unknown): void {
    this.handlers.get(event)?.forEach(h => h(data));
  }

  getSocketId(): string | null {
    return this.nodeId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.peerPollingInterval) {
      clearInterval(this.peerPollingInterval);
      this.peerPollingInterval = null;
    }
    this.connected = false;
    this.nodeId = null;
    this.peers = [];
    console.log('[NativeSignaling] 연결 해제됨');
  }

  getPeers(): DiscoveredPeer[] {
    return this.peers;
  }
}

export const nativeSignalingService = new NativeSignalingService();
