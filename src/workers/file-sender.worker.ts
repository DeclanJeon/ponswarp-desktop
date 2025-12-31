/* eslint-disable no-restricted-globals */
/**
 * file-sender.worker.ts (v2.0 - Warp Engine)
 *
 * [Capabilities]
 * - Multi-file Streaming: Automatically transitions between files.
 * - Zero-Copy Transfer: Uses Transferable Objects to prevent memory spikes.
 * - Precision Seek: Handles offsets accurately for resumption.
 */

import { TransferManifest } from '../types/types';
import { CHUNK_SIZE_MAX } from '../utils/constants';

// --- Worker State ---
let files: File[] = [];
let manifest: TransferManifest | null = null;

// Processing State
let currentFileIndex = 0;
let currentOffset = 0;
let totalBytesSent = 0;

// Control Flags
let isPaused = false;
let isJobRunning = false;

const ctx: Worker = self as any;

/**
 * Worker Message Handler
 */
ctx.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'init':
      initializeJob(payload.files, payload.manifest);
      break;

    case 'process-batch':
      if (isJobRunning && !isPaused) {
        await processBatch(payload.count || 4); // Default batch size 4
      }
      break;

    case 'pause':
      isPaused = true;
      break;

    case 'resume':
      isPaused = false;
      // Resume immediately if job was running
      if (isJobRunning) {
        await processBatch(1);
      }
      break;

    case 'abort':
      resetState();
      break;
  }
};

/**
 * Initialize the transfer job
 */
function initializeJob(inputFiles: File[], inputManifest: TransferManifest) {
  files = inputFiles;
  manifest = inputManifest;
  
  // Reset pointers
  currentFileIndex = 0;
  currentOffset = 0;
  totalBytesSent = 0;
  
  isPaused = false;
  isJobRunning = true;

  console.log(`[SenderWorker] Initialized: ${files.length} files, Total: ${manifest.totalSize} bytes`);
  
  // Signal main thread that we are ready
  ctx.postMessage({ type: 'init-complete' });
}

/**
 * Reads and processes a batch of chunks
 * Uses a State Machine loop to handle file transitions seamlessly.
 */
async function processBatch(count: number) {
  const chunksToSend = [];
  const transferables: Transferable[] = []; // For Zero-Copy

  for (let i = 0; i < count; i++) {
    // 1. Check Completion
    if (currentFileIndex >= files.length) {
      finalizeTransfer();
      return;
    }

    const currentFile = files[currentFileIndex];
    const fileSize = currentFile.size;

    // 2. Check File Boundary (Empty file skip or Move next)
    // If currentOffset reached fileSize, move to next file
    if (currentOffset >= fileSize) {
      // If file size is 0, we still might need to send a header, 
      // but usually we just skip to next for data stream.
      // NOTE: Zero-byte files are handled by manifest structure on receiver side usually.
      currentFileIndex++;
      currentOffset = 0;
      i--; // Decrement counter to retry this slot with the next file
      continue;
    }

    // 3. Determine Chunk Size
    const remaining = fileSize - currentOffset;
    const readSize = Math.min(CHUNK_SIZE_MAX, remaining);

    try {
      // 4. Read File (Slice)
      const blob = currentFile.slice(currentOffset, currentOffset + readSize);
      const buffer = await blob.arrayBuffer();

      // 5. Pack Data
      chunksToSend.push({
        fileIndex: currentFileIndex,
        offset: currentOffset,
        data: buffer,
        size: buffer.byteLength
      });

      // Mark buffer for Zero-Copy transfer
      transferables.push(buffer);

      // 6. Update Pointers
      currentOffset += readSize;
      totalBytesSent += readSize;

    } catch (err) {
      console.error(`[SenderWorker] Read error at index ${currentFileIndex}:`, err);
      ctx.postMessage({ 
        type: 'error', 
        payload: { message: `File read failed: ${(err as Error).message}` } 
      });
      isJobRunning = false;
      return;
    }
  }

  // 7. Send Batch to Main Thread
  if (chunksToSend.length > 0) {
    ctx.postMessage({
      type: 'chunk-batch',
      payload: {
        chunks: chunksToSend,
        progressData: calculateProgress()
      }
    }, transferables); // <--- Key: Zero-Copy Transfer
  }
}

/**
 * Calculates overall progress
 */
function calculateProgress() {
  if (!manifest || manifest.totalSize === 0) {
    return {
      progress: 0,
      bytesTransferred: 0,
      totalBytes: 0
    };
  }

  // Calculate percentage
  const progress = (totalBytesSent / manifest.totalSize) * 100;

  return {
    progress: Math.min(100, progress),
    bytesTransferred: totalBytesSent,
    totalBytes: manifest.totalSize
  };
}

function finalizeTransfer() {
  isJobRunning = false;
  ctx.postMessage({ type: 'complete' });
}

function resetState() {
  isJobRunning = false;
  files = [];
  manifest = null;
  currentFileIndex = 0;
  currentOffset = 0;
  totalBytesSent = 0;
}

export {};
