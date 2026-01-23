/**
 * File Processor Worker
 *
 * Backpressure 제어 및 파일 처리를 담당하는 워커
 * - Credit-based Flow Control 구현
 * - Water Mark 기반 메모리 관리
 * - WASM을 통한 고성능 데이터 처리
 */

import initPonsCore from 'pons-core-wasm';
import { WasmReorderingBuffer } from '../services/wasmReorderingBuffer';

// 설정값
const HIGH_WATER_MARK = 16 * 1024 * 1024; // 16MB (이 이상 쌓이면 PAUSE 요청)
const LOW_WATER_MARK = 4 * 1024 * 1024; // 4MB (이 밑으로 떨어지면 RESUME 요청)
const BATCH_THRESHOLD = 8 * 1024 * 1024; // 8MB (배치 처리 임계값)

// 상태 타입 정의
interface WorkerStatus {
  type: 'PAUSE' | 'RESUME' | 'PROGRESS' | 'ERROR' | 'INITIALIZED';
  loaded: number;
  queueSize?: number;
  error?: string;
}

// 내부 상태
let fileHandle: FileSystemFileHandle | null = null;
let writable: FileSystemWritableFileStream | null = null;
let reorderingBuffer: WasmReorderingBuffer | null = null;
let currentQueueSize = 0;
let isPaused = false;
let processedOffset = 0;
let totalSize = 0;
let isInitialized = false;

// 메인 스레드로 상태를 보내기 위한 콜백
let statusCallback: ((status: WorkerStatus) => void) | null = null;

// 배치 처리용 버퍼
let writeBuffer: Uint8Array[] = [];
let currentBatchSize = 0;

/**
 * 초기화 함수
 */
async function init(
  handle: FileSystemFileHandle,
  cb: (status: WorkerStatus) => void,
  fileSize: number
): Promise<void> {
  try {
    fileHandle = handle;
    writable = await fileHandle.createWritable({ keepExistingData: false });
    statusCallback = cb;
    totalSize = fileSize;

    // WASM 초기화
    await initPonsCore();
    reorderingBuffer = new WasmReorderingBuffer();
    await reorderingBuffer.initialize(0);

    isInitialized = true;

    statusCallback?.({
      type: 'INITIALIZED',
      loaded: 0,
      queueSize: 0,
    });

    console.log('[Worker] Initialized & WASM Ready');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Worker] Initialization failed:', error);
    statusCallback?.({
      type: 'ERROR',
      loaded: 0,
      error: errorMsg,
    });
    throw error;
  }
}

/**
 * 청크 수신 및 처리 (Backpressure 핵심 로직)
 */
async function pushChunk(chunk: Uint8Array, offset: number): Promise<void> {
  if (!isInitialized) {
    throw new Error('Worker not initialized');
  }

  // 1. 큐 사이즈 증가
  currentQueueSize += chunk.byteLength;

  // 2. High Water Mark 체크 -> 메인 스레드에 "그만 보내!" 신호 전송
  if (!isPaused && currentQueueSize > HIGH_WATER_MARK) {
    isPaused = true;
    statusCallback?.({
      type: 'PAUSE',
      loaded: processedOffset,
      queueSize: currentQueueSize,
    });
    console.warn(
      `[Worker] 🛑 Backpressure triggered (Queue: ${(currentQueueSize / 1024 / 1024).toFixed(2)}MB)`
    );
  }

  try {
    // 3. 순서 정렬 버퍼에 추가
    if (reorderingBuffer) {
      const chunksToWrite = reorderingBuffer.push(
        chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength
        ) as ArrayBuffer,
        offset
      );

      // 4. 배치 버퍼에 적재
      for (const chunkToWrite of chunksToWrite) {
        const data = new Uint8Array(chunkToWrite);
        writeBuffer.push(data);
        currentBatchSize += data.byteLength;
      }

      // 5. 배치 임계값 도달 시 디스크에 쓰기
      if (currentBatchSize >= BATCH_THRESHOLD) {
        await flushWriteBuffer();
      }
    }
  } catch (err) {
    console.error('[Worker] Processing error:', err);
    const errorMsg = err instanceof Error ? err.message : String(err);
    statusCallback?.({
      type: 'ERROR',
      loaded: processedOffset,
      error: errorMsg,
    });
    throw err;
  } finally {
    // 6. 처리 완료 후 큐 사이즈 감소
    currentQueueSize -= chunk.byteLength;

    // 7. Low Water Mark 체크 -> 메인 스레드에 "다시 보내!" 신호 전송
    if (isPaused && currentQueueSize < LOW_WATER_MARK) {
      isPaused = false;
      statusCallback?.({
        type: 'RESUME',
        loaded: processedOffset,
        queueSize: currentQueueSize,
      });
      console.log('[Worker] ▶️ Resuming (Queue drained)');
    }

    // 8. 진행률 보고 (쓰로틀링 적용)
    statusCallback?.({
      type: 'PROGRESS',
      loaded: processedOffset,
      queueSize: currentQueueSize,
    });
  }
}

/**
 * 배치 버퍼를 디스크에 플러시
 */
async function flushWriteBuffer(): Promise<void> {
  if (writeBuffer.length === 0 || !writable) return;

  try {
    // 큰 버퍼 하나로 병합
    const mergedBuffer = new Uint8Array(currentBatchSize);
    let offset = 0;
    for (const chunk of writeBuffer) {
      mergedBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // OPFS 쓰기
    await writable.write({
      type: 'write',
      position: processedOffset,
      data: mergedBuffer,
    });

    // 상태 업데이트
    processedOffset += currentBatchSize;
    writeBuffer = [];
    currentBatchSize = 0;

    console.debug(
      `[Worker] Flushed ${formatBytes(offset)} to disk, total: ${formatBytes(processedOffset)}`
    );
  } catch (error) {
    console.error('[Worker] Flush error:', error);
    throw error;
  }
}

/**
 * 최종화 함수
 */
async function finalize(): Promise<void> {
  if (!isInitialized) return;

  try {
    // 남은 데이터 모두 플러시
    await flushWriteBuffer();

    // 파일 쓰기 완료
    if (writable) {
      await writable.close();
      writable = null;
    }

    // 버퍼 정리
    if (reorderingBuffer) {
      reorderingBuffer.clear();
      reorderingBuffer = null;
    }

    console.log('[Worker] Finalization complete');
  } catch (error) {
    console.error('[Worker] Finalization error:', error);
    throw error;
  }
}

/**
 * 정리 함수
 */
async function cleanup(): Promise<void> {
  try {
    await finalize();

    if (writable) {
      await writable.abort();
      writable = null;
    }

    fileHandle = null;
    isInitialized = false;
    currentQueueSize = 0;
    isPaused = false;
    processedOffset = 0;
    totalSize = 0;

    console.log('[Worker] Cleanup complete');
  } catch (error) {
    console.error('[Worker] Cleanup error:', error);
  }
}

/**
 * 현재 상태 조회
 */
function getStatus(): {
  queueSize: number;
  isPaused: boolean;
  processedOffset: number;
  totalSize: number;
  isInitialized: boolean;
} {
  return {
    queueSize: currentQueueSize,
    isPaused,
    processedOffset,
    totalSize,
    isInitialized,
  };
}

// 헬퍼 함수
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Worker 메시지 핸들러
self.onmessage = async (event: MessageEvent) => {
  const { type, payload, id } = event.data;

  try {
    let result;

    switch (type) {
      case 'init':
        result = await init(payload.handle, payload.callback, payload.fileSize);
        break;

      case 'pushChunk':
        result = await pushChunk(payload.chunk, payload.offset);
        break;

      case 'finalize':
        result = await finalize();
        break;

      case 'cleanup':
        result = await cleanup();
        break;

      case 'getStatus':
        result = getStatus();
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    // 성공 응답
    self.postMessage({
      type: 'response',
      id,
      success: true,
      result,
    });
  } catch (error) {
    // 에러 응답
    self.postMessage({
      type: 'response',
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
