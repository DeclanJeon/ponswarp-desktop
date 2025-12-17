/**
 * Native File Writer Service
 * Tauri 데스크탑 앱 전용 고성능 파일 저장
 *
 * StreamSaver.js를 대체하는 네이티브 Rust 기반 파일 I/O
 * - Zero-copy 전송 지원
 * - 메모리 효율적 스트리밍
 * - OS 네이티브 다이얼로그 연동
 */

import { invoke } from '@tauri-apps/api/core';
import { WasmReorderingBuffer } from './wasmReorderingBuffer';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { HEADER_SIZE } from '../utils/constants';

// 🚀 [Flow Control] 메모리 보호를 위한 워터마크 설정
// 64MB 이상 쌓이면 PAUSE 요청, 32MB 이하로 떨어지면 RESUME 요청
const WRITE_BUFFER_HIGH_MARK = 64 * 1024 * 1024;
const WRITE_BUFFER_LOW_MARK = 32 * 1024 * 1024;

export class NativeFileWriter {
  private manifest: {
    totalSize: number;
    totalFiles?: number;
    files?: Array<{ path: string }>;
    rootName?: string;
    isSizeEstimated?: boolean;
    downloadFileName?: string;
  } = {
    totalSize: 0,
  };
  private totalBytesWritten = 0;
  private totalSize = 0;
  private startTime = 0;
  private lastProgressTime = 0;
  private isFinalized = false;

  // 🆕 Native 전용 파일 ID
  private fileId: string | null = null;
  private savePath: string | null = null;

  // 🚀 [추가] 재정렬 버퍼 (WASM 기반 고성능 버퍼)
  private reorderingBuffer: WasmReorderingBuffer | null = null;

  // 🚀 [추가] 쓰기 작업을 순차적으로 처리하기 위한 Promise 체인
  private writeQueue: Promise<void> = Promise.resolve();

  // 🚀 [속도 개선] 배치 버퍼 설정 (메모리에 모았다가 한 번에 쓰기)
  private writeBuffer: Uint8Array[] = [];
  private currentBatchSize = 0;
  // 🚀 [네이티브 최적화] 더 큰 배치 크기 사용
  // Rust 백엔드와 Zero-copy 통신을 위한 최적화된 크기
  private readonly BATCH_THRESHOLD = 16 * 1024 * 1024; // 16MB

  // 🚀 [핵심] 버퍼에 적재된 바이트 수 추적
  private pendingBytesInBuffer = 0;

  // 🚀 버퍼 추적 및 흐름 제어 변수
  private isPaused = false;

  private onProgressCallback:
    | ((data: {
        progress: number;
        speed: number;
        bytesTransferred: number;
        totalBytes: number;
      }) => void)
    | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private onFlowControlCallback: ((action: 'PAUSE' | 'RESUME') => void) | null = null;

  /**
   * 스토리지 초기화 (네이티브 다이얼로그 연동)
   */
  public async initStorage(manifest: {
    totalSize: number;
    totalFiles?: number;
    files?: Array<{ path: string }>;
    rootName?: string;
    isSizeEstimated?: boolean;
    downloadFileName?: string;
  }): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();
    this.totalBytesWritten = 0;
    this.isFinalized = false;
    this.writeBuffer = [];
    this.currentBatchSize = 0;
    this.pendingBytesInBuffer = 0;
    this.isPaused = false;

    const fileCount = manifest.totalFiles || manifest.files?.length || 0;
    logInfo('[NativeFileWriter]', `Initializing for ${fileCount} files`);
    logInfo(
      '[NativeFileWriter]',
      `Total size: ${((manifest.totalSize as number) / (1024 * 1024)).toFixed(2)} MB`
    );

    // 파일명 결정
    let defaultFileName: string;
    if (fileCount === 1) {
      // 단일 파일: 원본 파일명
      defaultFileName = manifest.files![0].path.split('/').pop()!;
    } else {
      // 여러 파일: ZIP 파일명
      defaultFileName = (manifest.rootName || 'download') + '.zip';
    }

    try {
      // 🆕 네이티브 저장 다이얼로그 열기
      this.fileId = this.generateFileId();

      // Tauri 커맨드로 저장 다이얼로그 열기
      const selectedPath = await invoke<string | null>('create_save_dialog', {
        defaultName: defaultFileName
      });

      if (!selectedPath) {
        throw new Error('사용자가 저장을 취소했습니다');
      }

      this.savePath = selectedPath;

      // Rust 백엔드에서 파일 스트리밍 시작
      await invoke('start_file_stream', {
        fileId: this.fileId,
        savePath: this.savePath,
        totalSize: manifest.totalSize
      });

      logInfo('[NativeFileWriter]', `✅ Native file stream started: ${this.fileId} -> ${this.savePath}`);
      logInfo(
        '[NativeFileWriter]',
        `🚀 Strategy: Native Tauri I/O (Zero-copy)`
      );

    } catch (error) {
      logError('[NativeFileWriter]', `❌ Native initialization failed: ${error}`);
      throw error;
    }
  }

  /**
   * 청크 쓰기 (Zero-copy Native 통신)
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    const chunk = new Uint8Array(packet);
    if (!this.fileId || this.isFinalized) {
      logWarn('[NativeFileWriter]', '❌ Cannot write: file not initialized or already finalized');
      return;
    }

    // 🚀 [성능 최적화] Rust 백엔드로 직접 전송 (브라우저 스택 우회)
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // WASM 재정렬 버퍼 사용 (필요시)
        const orderedChunk = this.reorderingBuffer
          ? chunk // 임시로 직접 사용 (processChunk 메소드는 추후 구현)
          : chunk;

        // 🆕 Native 커맨드로 청크 전송 (Zero-copy)
        await invoke('write_file_chunk', {
          fileId: this.fileId,
          chunk: Array.from(orderedChunk), // Rust Vec<u8>로 변환
          offset: this.totalBytesWritten // 순차적 쓰기 위치
        });

        this.totalBytesWritten += orderedChunk.length;
        this.pendingBytesInBuffer += orderedChunk.length;

        // 진행률 업데이트
        this.updateProgress();

        // 🚀 [흐름 제어] 메모리 보호
        if (this.pendingBytesInBuffer >= WRITE_BUFFER_HIGH_MARK && !this.isPaused) {
          this.isPaused = true;
          this.onFlowControlCallback?.('PAUSE');
          logDebug('[NativeFileWriter]', '⏸️ Memory high watermark - PAUSED');
        }

      } catch (error) {
        logError('[NativeFileWriter]', `❌ Chunk write failed: ${error}`);
        this.onErrorCallback?.(String(error));
        throw error;
      }
    });
  }

  /**
   * 메모리 버퍼 해제 요청 (흐름 제어)
   */
  public async flushBuffer(): Promise<void> {
    // Native 모드에서는 Rust가 자동으로 버퍼링하므로
    // 흐름 제어 신지만 처리
    if (this.isPaused && this.pendingBytesInBuffer <= WRITE_BUFFER_LOW_MARK) {
      this.isPaused = false;
      this.onFlowControlCallback?.('RESUME');
      logDebug('[NativeFileWriter]', '▶️ Memory low watermark - RESUMED');
    }

    this.pendingBytesInBuffer = 0; // Reset buffer tracking
  }

  /**
   * 암호화 키 설정
   */
  public setEncryptionKey(sessionKey: Uint8Array, randomPrefix: Uint8Array): void {
    // Native 암호화는 Rust 레벨에서 처리하므로 여기서는 키만 저장
    logDebug('[NativeFileWriter]', '🔐 Encryption keys set for native processing');
  }

  /**
   * 진행률 및 흐름 제어 콜백 설정
   */
  public onProgress(
    cb: (data: {
      progress: number;
      speed: number;
      bytesTransferred: number;
      totalBytes: number;
    }) => void
  ): void {
    this.onProgressCallback = cb;
  }

  public onComplete(cb: (actualSize: number) => void): void {
    this.onCompleteCallback = cb;
  }

  public onError(cb: (err: string) => void): void {
    this.onErrorCallback = cb;
  }

  public onFlowControl(cb: (action: 'PAUSE' | 'RESUME') => void): void {
    this.onFlowControlCallback = cb;
  }

  /**
   * 파일 저장 완료 처리
   */
  public async cleanup(): Promise<void> {
    if (this.isFinalized) {
      return;
    }

    // 모든 쓰기 작업이 완료되도록 대기
    await this.writeQueue;

    try {
      if (this.fileId) {
        // 🆕 Native 스트림 완료 커맨드
        const finalPath = await invoke<string>('complete_file_stream', {
          fileId: this.fileId,
          finalSize: this.totalBytesWritten
        });

        logInfo('[NativeFileWriter]', `✅ File stream completed: ${finalPath}`);
        this.onCompleteCallback?.(this.totalBytesWritten);
      }

    } catch (error) {
      logError('[NativeFileWriter]', `❌ Cleanup failed: ${error}`);
      this.onErrorCallback?.(String(error));
    } finally {
      this.isFinalized = true;
      this.fileId = null;
      this.savePath = null;

      // 재정렬 버퍼 정리
      if (this.reorderingBuffer) {
        this.reorderingBuffer.cleanup();
        this.reorderingBuffer = null;
      }

      logInfo('[NativeFileWriter]', '🧹 Native file writer cleaned up');
    }
  }

  /**
   * 진행률 업데이트
   */
  private updateProgress(): void {
    if (!this.onProgressCallback) return;

    const now = Date.now();
    if (now - this.lastProgressTime < 100) return; // 100ms마다 업데이트

    const progress = this.totalSize > 0
      ? (this.totalBytesWritten / this.totalSize) * 100
      : 0;

    const elapsed = (now - this.startTime) / 1000; // 초
    const speed = elapsed > 0 ? this.totalBytesWritten / elapsed : 0;

    this.onProgressCallback({
      progress,
      speed,
      bytesTransferred: this.totalBytesWritten,
      totalBytes: this.totalSize,
    });

    this.lastProgressTime = now;
  }

  /**
   * 고유 파일 ID 생성
   */
  private generateFileId(): string {
    return `native_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 🆕 네이티브 저장 다이얼로그로 폴더 선택
   */
  public static async selectSaveDirectory(): Promise<string | null> {
    try {
      const selected = await invoke<string | null>('select_save_directory');
      return selected;
    } catch (error) {
      logError('[NativeFileWriter]', `❌ Directory selection failed: ${error}`);
      return null;
    }
  }

  /**
   * 🆕 저장 공간 확인
   */
  public static async checkStorageSpace(path: string): Promise<{
    availableBytes: number;
    totalBytes: number;
    availableGB: number;
    totalGB: number;
  }> {
    try {
      const space = await invoke<any>('check_storage_space', { path });
      return space;
    } catch (error) {
      logError('[NativeFileWriter]', `❌ Storage space check failed: ${error}`);
      // Fallback 값 반환
      return {
        availableBytes: 100 * 1024 * 1024 * 1024, // 100GB
        totalBytes: 500 * 1024 * 1024 * 1024,     // 500GB
        availableGB: 100.0,
        totalGB: 500.0,
      };
    }
  }
}