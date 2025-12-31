/**
 * Native File Writer Service (v2.0 - Warp Engine)
 *
 * [Capabilities]
 * - Multi-file Switching: Automatically handles stream transitions based on FileIndex.
 * - Directory Reconstruction: Creates folder structures on the fly.
 * - Zero-copy I/O: Passes buffers directly to Rust backend.
 */

import { invoke } from '@tauri-apps/api/core';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { HEADER_SIZE } from '../utils/constants';

// Flow Control Watermarks
const WRITE_BUFFER_HIGH_MARK = 64 * 1024 * 1024;
const WRITE_BUFFER_LOW_MARK = 32 * 1024 * 1024;

export class NativeFileWriter {
  // Manifest & State
  private manifest: {
    totalSize: number;
    totalFiles?: number;
    files?: Array<{ path: string; size: number }>; // Added size to interface
    rootName?: string;
    isSizeEstimated?: boolean;
    downloadFileName?: string;
  } = { totalSize: 0 };

  private totalBytesWritten = 0;
  private startTime = 0;
  private lastProgressTime = 0;
  private isFinalized = false;

  // File Handles
  private currentFileIndex: number = -1;
  private currentFileId: string | null = null;
  private baseDir: string | null = null;

  // Buffer & Control
  private writeQueue: Promise<void> = Promise.resolve();
  private writeBuffer: Uint8Array[] = [];
  private currentBatchSize = 0;
  private pendingBytesInBuffer = 0;
  private isPaused = false;
  private readonly BATCH_THRESHOLD = 16 * 1024 * 1024; // 16MB Batch

  // Callbacks
  private onProgressCallback: ((data: any) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private onFlowControlCallback: ((action: 'PAUSE' | 'RESUME') => void) | null = null;

  /**
   * Initialize Storage
   * Selects the BASE DIRECTORY for saving files.
   */
  public async initStorage(manifest: any): Promise<void> {
    this.manifest = manifest;
    this.startTime = Date.now();
    this.totalBytesWritten = 0;
    this.isFinalized = false;
    this.currentFileIndex = -1;
    this.writeBuffer = [];
    this.currentBatchSize = 0;
    this.pendingBytesInBuffer = 0;

    const fileCount = manifest.totalFiles || manifest.files?.length || 0;
    logInfo('[NativeWriter]', `Initializing for ${fileCount} files. Total: ${(manifest.totalSize / 1024 / 1024).toFixed(2)} MB`);

    try {
      // 1. Select Base Directory
      // Force directory selection to handle both single and multi-file logic uniformly
      const selectedPath = await invoke<string | null>('open_file_dialog', {
        directory: true,
        multiple: false
      });

      if (!selectedPath) {
        throw new Error('User cancelled directory selection');
      }

      this.baseDir = selectedPath;
      logInfo('[NativeWriter]', `Base directory set: ${this.baseDir}`);

    } catch (error) {
      logError('[NativeWriter]', `Init failed: ${error}`);
      throw error;
    }
  }

  /**
   * Process Incoming Packet
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    if (this.isFinalized) return;

    // Queue writes to ensure sequential processing
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.processChunkInternal(packet);
      } catch (error) {
        logError('[NativeWriter]', 'Write error:', error);
        this.onErrorCallback?.(String(error));
        throw error;
      }
    }).catch(() => {
      logWarn('[NativeWriter]', 'Recovering from write error chain');
    });

    return this.writeQueue;
  }

  private async processChunkInternal(packet: ArrayBuffer): Promise<void> {
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    
    // 1. Parse Header
    const fileIndex = view.getUint16(0, true);
    const offset = Number(view.getBigUint64(6, true)); // 64-bit offset
    const dataLen = view.getUint32(14, true);

    // 2. Check EOS (End of Stream)
    if (fileIndex === 0xffff) {
      logInfo('[NativeWriter]', 'EOS signal received. Finalizing...');
      await this.flushBuffer();
      await this.finalize();
      return;
    }

    // 3. File Switching Logic
    if (fileIndex !== this.currentFileIndex) {
      logDebug('[NativeWriter]', `File Switch: ${this.currentFileIndex} -> ${fileIndex}`);
      // Flush previous file's buffer before switching
      await this.flushBuffer();
      await this.switchFile(fileIndex);
    }

    // 4. Buffer Data
    // Note: We use offset relative to the CURRENT FILE
    const data = new Uint8Array(packet, HEADER_SIZE, dataLen);
    
    // Create copy of slice to prevent buffer detachment issues if packet is reused
    const chunkCopy = new Uint8Array(data);

    this.writeBuffer.push(chunkCopy);
    this.currentBatchSize += chunkCopy.byteLength;
    this.pendingBytesInBuffer += chunkCopy.byteLength;

    // 5. Backpressure Check
    this.checkBackpressure();

    // 6. Flush if threshold reached
    if (this.currentBatchSize >= this.BATCH_THRESHOLD) {
      await this.flushBuffer();
    }
  }

  /**
   * Switches the active file stream
   * Creates directories if needed.
   */
  private async switchFile(newIndex: number): Promise<void> {
    // Close existing stream
    if (this.currentFileId) {
      await invoke('close_file_stream', { fileId: this.currentFileId });
      this.currentFileId = null;
    }

    this.currentFileIndex = newIndex;
    const fileNode = this.manifest.files![newIndex];
    if (!fileNode) {
      throw new Error(`File index ${newIndex} out of bounds`);
    }

    // Construct full path
    // Rust side 'resolve_path' is safer, but we can do simple join for now if platform separator is handled
    // We rely on Tauri's invoke to handle path joining properly
    
    const relativePath = fileNode.path; // e.g. "folder/sub/file.txt"
    const fullPath = await invoke<string>('resolve_path', {
      base: this.baseDir,
      relative: relativePath
    });

    // Create parent directories
    await invoke('ensure_dir_exists', { filePath: fullPath });

    // Start new stream
    this.currentFileId = `file_${newIndex}_${Date.now()}`;
    
    logInfo('[NativeWriter]', `Opening file: ${fileNode.path} (${(fileNode.size / 1024).toFixed(1)} KB)`);
    
    await invoke('start_file_stream', {
      fileId: this.currentFileId,
      savePath: fullPath,
      totalSize: fileNode.size // Pre-allocate hint
    });
  }

  private async flushBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0 || !this.currentFileId) return;

    // Merge chunks
    const mergedBuffer = new Uint8Array(this.currentBatchSize);
    let offset = 0;
    for (const chunk of this.writeBuffer) {
      mergedBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Write to Rust
    await invoke('write_file_chunk', {
      fileId: this.currentFileId,
      chunk: Array.from(mergedBuffer),
      offset: -1 // -1 means "append" or "current position"
    });

    this.totalBytesWritten += this.currentBatchSize;
    this.pendingBytesInBuffer -= this.currentBatchSize;
    
    // Reset buffer
    this.writeBuffer = [];
    this.currentBatchSize = 0;

    // Resume if paused
    this.checkBackpressure();
    this.reportProgress();
  }

  private checkBackpressure() {
    if (!this.isPaused && this.pendingBytesInBuffer >= WRITE_BUFFER_HIGH_MARK) {
      this.isPaused = true;
      this.onFlowControlCallback?.('PAUSE');
      logWarn('[NativeWriter]', 'High watermark reached - PAUSING');
    } else if (this.isPaused && this.pendingBytesInBuffer <= WRITE_BUFFER_LOW_MARK) {
      this.isPaused = false;
      this.onFlowControlCallback?.('RESUME');
      logInfo('[NativeWriter]', 'Low watermark reached - RESUMING');
    }
  }

  private reportProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressTime < 100) return;

    const progress = this.manifest.totalSize > 0
      ? (this.totalBytesWritten / this.manifest.totalSize) * 100
      : 0;
    
    const elapsed = (now - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.totalBytesWritten / elapsed : 0;

    this.onProgressCallback?.({
      progress,
      speed,
      bytesTransferred: this.totalBytesWritten,
      totalBytes: this.manifest.totalSize
    });
    this.lastProgressTime = now;
  }

  private async finalize(): Promise<void> {
    if (this.isFinalized) return;
    this.isFinalized = true;

    // Close last file
    if (this.currentFileId) {
      await invoke('close_file_stream', { fileId: this.currentFileId });
    }

    logInfo('[NativeWriter]', `Transfer Complete! Total written: ${this.totalBytesWritten} bytes`);
    this.onCompleteCallback?.(this.totalBytesWritten);
  }

  // --- Public Listeners ---
  public onProgress(cb: any) { this.onProgressCallback = cb; }
  public onComplete(cb: any) { this.onCompleteCallback = cb; }
  public onError(cb: any) { this.onErrorCallback = cb; }
  public onFlowControl(cb: any) { this.onFlowControlCallback = cb; }
  public setEncryptionKey() { /* Native handles crypto in Rust if needed */ }

  public async cleanup(): Promise<void> {
    this.isFinalized = true;
    if (this.currentFileId) {
      try { await invoke('close_file_stream', { fileId: this.currentFileId }); } 
      catch {}
    }
  }
}
