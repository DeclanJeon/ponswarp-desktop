/**
 * Transfer Controller
 * 
 * Main Thread에서 WebRTC 데이터 수신을 제어하고 Backpressure를 관리합니다.
 * - Credit-based Flow Control 구현
 * - Worker 상태 모니터링
 * - 데이터 수신 쓰로틀링
 */

import type { Instance as SimplePeerInstance } from 'simple-peer';
import { logInfo, logWarn, logError, logDebug } from '../utils/logger';
import { useTransferStore } from '../store/transferStore';

// Worker 타입 정의
interface WorkerMessage {
  type: 'init' | 'pushChunk' | 'finalize' | 'cleanup' | 'getStatus';
  payload: any;
  id: string;
}

interface WorkerResponse {
  type: 'response';
  id: string;
  success: boolean;
  result?: any;
  error?: string;
}

// Worker 상태 타입
interface WorkerStatus {
  type: 'PAUSE' | 'RESUME' | 'PROGRESS' | 'ERROR' | 'INITIALIZED';
  loaded: number;
  queueSize?: number;
  error?: string;
}

// WebRTC 데이터 청크 정보
interface DataChunk {
  data: Uint8Array;
  offset: number;
  timestamp: number;
}

export class TransferController {
  private worker: Worker | null = null;
  private peer: SimplePeerInstance | null = null;
  private isPaused = false;
  private pendingQueue: DataChunk[] = [];
  private messageId = 0;
  private pendingMessages = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }>();
  
  // 상태 추적
  private totalReceived = 0;
  private totalProcessed = 0;
  private startTime = 0;
  private lastProgressReport = 0;
  private readonly PROGRESS_THROTTLE_MS = 200;
  
  // Store 참조
  private store: ReturnType<typeof useTransferStore.getState>;
  
  // 콜백
  private onProgressCallback: ((progress: number, speed: number) => void) | null = null;
  private onCompleteCallback: ((totalBytes: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  
  // 설정
  private readonly MAX_PENDING_QUEUE_SIZE = 500; // 최대 대기 큐 크기
  private readonly WORKER_TIMEOUT_MS = 30000; // Worker 응답 타임아웃

  constructor(peer: SimplePeerInstance) {
    this.peer = peer;
    this.setupWorker();
    
    // Store에서 상태 가져오기
    this.store = useTransferStore.getState();
  }

  /**
   * Worker 설정 및 메시지 핸들러 등록
   */
  private setupWorker(): void {
    try {
      this.worker = new Worker(
        new URL('../workers/file-processor.worker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = (error) => {
        logError('[TransferController]', 'Worker error:', error);
        this.onErrorCallback?.(`Worker error: ${error.message}`);
      };

      logInfo('[TransferController]', 'Worker initialized');
    } catch (error) {
      logError('[TransferController]', 'Failed to initialize worker:', error);
      this.onErrorCallback?.(`Failed to initialize worker: ${error}`);
    }
  }

  /**
   * Worker 메시지 처리
   */
  private handleWorkerMessage(event: MessageEvent<WorkerResponse>): void {
    const { id, success, result, error } = event.data;
    
    const pending = this.pendingMessages.get(id);
    if (!pending) {
      logWarn('[TransferController]', `Unknown message ID: ${id}`);
      return;
    }

    // 타임아웃 정리
    clearTimeout(pending.timeout);
    this.pendingMessages.delete(id);

    if (success) {
      pending.resolve(result);
    } else {
      pending.reject(new Error(error));
    }
  }

  /**
   * Worker에 메시지 전송 (Promise 기반)
   */
  private async sendToWorker<T>(type: string, payload: any): Promise<T> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = `msg_${++this.messageId}`;
    
    return new Promise<T>((resolve, reject) => {
      // 타임아웃 설정
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error(`Worker timeout for ${type}`));
      }, this.WORKER_TIMEOUT_MS);

      // 대기 중인 메시지 등록
      this.pendingMessages.set(id, { resolve, reject, timeout });

      // 메시지 전송
      this.worker!.postMessage({ type, payload, id } as WorkerMessage);
    });
  }

  /**
   * 파일 수신 시작
   */
  public async startReceiving(fileName: string, fileSize: number): Promise<void> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    try {
      // OPFS 파일 핸들 생성
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(fileName, { create: true });

      // Worker 초기화
      await this.sendToWorker('init', {
        handle: fileHandle,
        callback: this.handleWorkerStatus.bind(this),
        fileSize
      });

      // WebRTC 데이터 수신 이벤트 연결
      this.peer?.on('data', this.handleIncomingData.bind(this));

      // 시작 시간 기록
      this.startTime = Date.now();

      logInfo('[TransferController]', `Started receiving file: ${fileName} (${fileSize} bytes)`);
    } catch (error) {
      logError('[TransferController]', 'Failed to start receiving:', error);
      this.onErrorCallback?.(`Failed to start receiving: ${error}`);
      throw error;
    }
  }

  /**
   * Worker로부터 오는 Backpressure 신호 처리
   */
  private handleWorkerStatus(status: WorkerStatus): void {
    switch (status.type) {
      case 'PAUSE':
        this.isPaused = true;
        // 🚀 [Backpressure] Store 상태 업데이트
        this.store.setBackpressurePaused(true);
        if (status.queueSize !== undefined) {
          this.store.updateBackpressureQueue(status.queueSize);
        }
        logWarn('[TransferController]', `Pausing reception due to backpressure (queue: ${status.queueSize} bytes)`);
        break;
        
      case 'RESUME':
        this.isPaused = false;
        // 🚀 [Backpressure] Store 상태 업데이트
        this.store.setBackpressurePaused(false);
        if (status.queueSize !== undefined) {
          this.store.updateBackpressureQueue(status.queueSize);
        }
        logInfo('[TransferController]', `Resuming reception (queue: ${status.queueSize} bytes)`);
        this.processPendingQueue();
        break;
        
      case 'PROGRESS':
        this.totalProcessed = status.loaded;
        // 🚀 [Backpressure] Store 상태 업데이트
        if (status.queueSize !== undefined) {
          this.store.updateBackpressureQueue(status.queueSize);
        }
        this.reportProgress();
        break;
        
      case 'ERROR':
        logError('[TransferController]', `Worker error: ${status.error}`);
        this.onErrorCallback?.(status.error || 'Unknown worker error');
        break;
        
      case 'INITIALIZED':
        logInfo('[TransferController]', 'Worker initialized successfully');
        // 🚀 [Backpressure] Water Mark 설정
        this.store.setBackpressureWaterMarks(16 * 1024 * 1024, 4 * 1024 * 1024);
        break;
    }
  }

  /**
   * WebRTC 데이터 수신부
   */
  private handleIncomingData(data: Uint8Array): void {
    this.totalReceived += data.byteLength;
    
    // 데이터가 오면 무조건 받지만, Worker가 바쁘면 메모리에 쌓아둠
    if (this.isPaused) {
      // Worker가 꽉 찼음. 로컬 큐에 저장
      this.pendingQueue.push({
        data,
        offset: this.totalReceived - data.byteLength,
        timestamp: Date.now()
      });
      
      // 🚀 [Backpressure] Store 상태 업데이트
      this.store.updateBackpressureQueue(this.pendingQueue.length * 64 * 1024); // 추정 큐 크기
      
      // 안전장치: 로컬 큐가 너무 커지면 경고
      if (this.pendingQueue.length > this.MAX_PENDING_QUEUE_SIZE) {
        logWarn('[TransferController]', `Local queue is getting large (${this.pendingQueue.length} chunks)`);
        
        // 상대방에게 "전송 중단 요청" 시그널링 전송 로직 필요
        // this.signalingService.send('congestion-control', { action: 'pause' });
      }
    } else {
      // Worker에 바로 전달
      this.sendToWorker('pushChunk', {
        chunk: data,
        offset: this.totalReceived - data.byteLength
      }).catch(error => {
        logError('[TransferController]', 'Failed to send chunk to worker:', error);
        this.onErrorCallback?.(`Failed to process chunk: ${error}`);
      });
    }
  }

  /**
   * 대기 중인 큐 처리
   */
  private async processPendingQueue(): Promise<void> {
    while (!this.isPaused && this.pendingQueue.length > 0) {
      const chunk = this.pendingQueue.shift();
      if (!chunk) break;

      try {
        await this.sendToWorker('pushChunk', {
          chunk: chunk.data,
          offset: chunk.offset
        });
      } catch (error) {
        logError('[TransferController]', 'Failed to process pending chunk:', error);
        // 실패한 청크를 다시 큐에 넣음
        this.pendingQueue.unshift(chunk);
        break;
      }
    }
  }

  /**
   * 진행률 보고 (쓰로틀링 적용)
   */
  private reportProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressReport < this.PROGRESS_THROTTLE_MS) {
      return;
    }

    this.lastProgressReport = now;
    
    const progress = this.totalProcessed > 0 ? (this.totalProcessed / this.totalReceived) * 100 : 0;
    const elapsed = (now - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.totalProcessed / elapsed : 0;

    this.onProgressCallback?.(progress, speed);
  }

  /**
   * 전송 완료 처리
   */
  public async completeTransfer(): Promise<void> {
    try {
      // 남은 데이터 처리
      await this.processPendingQueue();
      
      // Worker 최종화
      await this.sendToWorker('finalize', {});
      
      logInfo('[TransferController]', `Transfer completed: ${this.totalProcessed} bytes`);
      this.onCompleteCallback?.(this.totalProcessed);
    } catch (error) {
      logError('[TransferController]', 'Failed to complete transfer:', error);
      this.onErrorCallback?.(`Failed to complete transfer: ${error}`);
      throw error;
    }
  }

  /**
   * 콜백 등록
   */
  public onProgress(callback: (progress: number, speed: number) => void): void {
    this.onProgressCallback = callback;
  }

  public onComplete(callback: (totalBytes: number) => void): void {
    this.onCompleteCallback = callback;
  }

  public onError(callback: (error: string) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * 상태 조회
   */
  public getStatus(): {
    isPaused: boolean;
    pendingQueueSize: number;
    totalReceived: number;
    totalProcessed: number;
  } {
    return {
      isPaused: this.isPaused,
      pendingQueueSize: this.pendingQueue.length,
      totalReceived: this.totalReceived,
      totalProcessed: this.totalProcessed
    };
  }

  /**
   * 정리
   */
  public async cleanup(): Promise<void> {
    try {
      // Worker 정리
      if (this.worker) {
        await this.sendToWorker('cleanup', {});
        this.worker.terminate();
        this.worker = null;
      }

      // 대기 중인 메시지 정리
      for (const pending of this.pendingMessages.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Controller cleanup'));
      }
      this.pendingMessages.clear();

      // 상태 초기화
      this.isPaused = false;
      this.pendingQueue = [];
      this.totalReceived = 0;
      this.totalProcessed = 0;

      logInfo('[TransferController]', 'Cleanup completed');
    } catch (error) {
      logError('[TransferController]', 'Cleanup error:', error);
    }
  }
}