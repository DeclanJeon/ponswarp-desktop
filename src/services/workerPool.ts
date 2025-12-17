/**
 * 병렬 암호화 워커 풀
 * 하드웨어 코어 수만큼 워커를 생성하여 파일을 병렬로 처리합니다.
 */

import Worker from '../workers/file-sender.worker?worker'; // Vite/Webpack 워커 임포트 문법

export interface ChunkProcessedPayload {
  jobId: string;
  blockIndex: number;
  data: Uint8Array;
  size: number;
}

export interface WorkerPoolOptions {
  concurrency?: number;
  onProgress?: (jobId: string, progress: number) => void;
  onChunk?: (chunk: ChunkProcessedPayload) => void;
  onError?: (error: string) => void;
}

/**
 * 병렬 암호화 워커 풀
 */
export class EncryptionWorkerPool {
  private workers: Worker[] = [];
  private concurrency: number;
  private jobMap = new Map<
    string,
    { totalBlocks: number; completedBlocks: number }
  >();
  private options: WorkerPoolOptions;
  private isInitialized = false;

  constructor(options: WorkerPoolOptions = {}) {
    // 🚀 [수정] 워커 수 제한
    // CPU 코어를 다 쓰면 메인 스레드(네트워크 전송 담당)가 굶어 죽음 (Starvation)
    // P-Core/E-Core 구조를 고려해 여유를 둠
    const logicalCores = navigator.hardwareConcurrency || 4;
    this.concurrency = options.concurrency || Math.max(1, logicalCores - 2); // 2개 정도 여유

    this.options = {
      concurrency: this.concurrency,
      onProgress: () => {},
      onChunk: () => {},
      onError: () => {},
      ...options,
    };
  }

  /**
   * 워커 풀 초기화
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log(`🔥 WorkerPool 초기화: ${this.concurrency}개 스레드`);

    // 워커 생성
    for (let i = 0; i < this.concurrency; i++) {
      const worker = new Worker();
      this.setupWorker(worker, i);
      this.workers.push(worker);
    }

    this.isInitialized = true;
  }

  /**
   * 워커 설정
   */
  private setupWorker(worker: Worker, workerIndex: number) {
    worker.onmessage = e => {
      const { type, payload } = e.data;

      switch (type) {
        case 'init-complete':
          console.log(`✅ Worker ${workerIndex} 초기화 완료`);
          break;

        case 'chunk-processed':
          this.handleChunkProcessed(payload);
          break;

        case 'batch-complete':
          console.log(`🔄 Worker ${payload.workerId} 배치 완료`);
          break;

        case 'complete':
          console.log(`✅ Worker ${workerIndex} 작업 완료`);
          break;

        case 'error':
          this.options.onError?.(payload.message);
          break;

        default:
          console.warn(`Worker ${workerIndex}: 알 수 없는 메시지 타입`, type);
      }
    };

    worker.onerror = error => {
      console.error(`Worker ${workerIndex} 오류:`, error);
      this.options.onError?.(`Worker ${workerIndex} 오류: ${error.message}`);
    };
  }

  /**
   * 처리된 청크 핸들러
   */
  private handleChunkProcessed(payload: ChunkProcessedPayload) {
    // 메인 스레드에서 네트워크 전송 로직으로 전달 (WebRTC/DataChannel)
    this.options.onChunk?.(payload);

    // 진행률 업데이트
    const job = this.jobMap.get(payload.jobId);
    if (job) {
      job.completedBlocks++;
      const percent = (job.completedBlocks / job.totalBlocks) * 100;
      this.options.onProgress?.(payload.jobId, percent);

      if (job.completedBlocks >= job.totalBlocks) {
        console.log('✅ 모든 블록 암호화 완료');
      }
    }
  }

  /**
   * 작업 시작
   */
  public async startJob(
    jobId: string,
    files: File[],
    key: Uint8Array,
    randomPrefix?: Uint8Array
  ): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    // 16MB 청크 기준 총 블록 수 계산 (간소화를 위해 파일 1개 가정)
    const totalBlocks = Math.ceil(totalSize / (16 * 1024 * 1024));

    this.jobMap.set(jobId, { totalBlocks, completedBlocks: 0 });

    console.log(`🚀 WorkerPool 작업 시작: ${jobId}, ${totalBlocks}개 블록`);

    // 모든 워커에 초기화 메시지 전송
    const initPromises = this.workers.map((worker, index) => {
      return new Promise<void>(resolve => {
        const handler = () => {
          worker.removeEventListener('message', handler);
          resolve();
        };
        worker.addEventListener('message', handler);

        worker.postMessage({
          type: 'init',
          payload: {
            files,
            shardIndex: index,
            totalShards: this.concurrency,
            key,
            randomPrefix,
            jobId,
          },
        });
      });
    });

    await Promise.all(initPromises);

    // 작업 시작 트리거
    this.workers.forEach(worker => {
      worker.postMessage({
        type: 'process-batch',
        payload: { count: Math.ceil(totalBlocks / this.concurrency) },
      });
    });
  }

  /**
   * 작업 중지
   */
  public stopJob(jobId: string): void {
    this.jobMap.delete(jobId);
    console.log(`🛑 작업 중지: ${jobId}`);
  }

  /**
   * 워커 풀 종료
   */
  public terminate(): void {
    this.workers.forEach(worker => worker.terminate());
    this.workers = [];
    this.jobMap.clear();
    this.isInitialized = false;
    console.log('🔌 WorkerPool 종료');
  }

  /**
   * 활성 워커 수
   */
  public get activeWorkers(): number {
    return this.workers.length;
  }

  /**
   * 동시성 수
   */
  public get concurrencyCount(): number {
    return this.concurrency;
  }
}

// 싱글톤 인스턴스 (필요 시)
export const encryptionPool = new EncryptionWorkerPool();
