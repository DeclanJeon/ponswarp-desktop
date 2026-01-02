/* 🪲 [DEBUG] SenderView UI/UX 개선 시작 */
console.log('[SenderView] 🪲 [DEBUG] UI/UX Enhancement Started:');
console.log('[SenderView] 🪲 [DEBUG] - Applying focal point principles');
console.log(
  '[SenderView] 🪲 [DEBUG] - Implementing gestalt proximity grouping'
);
console.log('[SenderView] 🪲 [DEBUG] - Adding responsive layout improvements');

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Upload,
  Folder,
  File as FileIcon,
  CheckCircle,
  Copy,
  Check,
  Loader2,
  FilePlus,
  AlertTriangle,
  Users,
  Zap,
} from 'lucide-react';
import { SwarmManager, MAX_DIRECT_PEERS } from '../services/swarmManager';
import { createManifest, formatBytes } from '../utils/fileUtils';
import { scanFiles, processInputFiles } from '../utils/fileScanner';
import { motion, AnimatePresence } from 'framer-motion';
import { AppMode, TransferManifest } from '../types/types';
import { useTransferStore } from '../store/transferStore';
import { nativeTransferService } from '../services/native-transfer';
import { isWebRTCSupported } from '../services/singlePeerConnection';
// Tauri API imports for native file selection
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';

interface SenderViewProps {
  onComplete?: () => void;
}

const SenderView: React.FC<SenderViewProps> = () => {
  const { setStatus: setGlobalStatus, useNativeTransfer } = useTransferStore();

  // 🆕 Native QUIC 전송 모드 여부
  const isNativeMode = useNativeTransfer || !isWebRTCSupported();
  const [manifest, setManifest] = useState<TransferManifest | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<
    | 'IDLE'
    | 'PREPARING'
    | 'WAITING'
    | 'CONNECTING'
    | 'TRANSFERRING'
    | 'REMOTE_PROCESSING'
    | 'READY_FOR_NEXT'
    | 'DONE'
  >('IDLE');
  const [progressData, setProgressData] = useState({
    progress: 0,
    speed: 0,
    bytesTransferred: 0,
    totalBytes: 0,
  });

  // 🚀 [Multi-Receiver] 피어 상태 추적
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [readyPeers, setReadyPeers] = useState<string[]>([]);
  const [readyCountdown, setReadyCountdown] = useState<number | null>(null);
  const [completedPeers, setCompletedPeers] = useState<string[]>([]);
  const [queuedPeers, setQueuedPeers] = useState<string[]>([]);
  const [waitingPeersCount, setWaitingPeersCount] = useState(0);
  const [currentTransferPeerCount, setCurrentTransferPeerCount] = useState(0);

  // SwarmManager 인스턴스
  const swarmManagerRef = useRef<SwarmManager | null>(null);

  // Input Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // 🆕 [FIX] 전송 시작 여부 플래그 (Ref로 관리하여 즉시 반영)
  const isTransferStartedRef = useRef(false);

  // 🆕 [CRITICAL FIX] Ref들을 컴포넌트 상단에 정의하여 클로저 문제 해결
  const selectedFilesRef = useRef<any[]>([]);
  const manifestRef = useRef<TransferManifest | null>(null);
  const [scannedFileList, setScannedFileList] = useState<any[]>([]);

  useEffect(() => {
    // 🆕 Native QUIC 모드일 때는 nativeTransferService 사용
    if (isNativeMode) {
      console.log('[SenderView] 🚀 Native QUIC Transfer Mode');

      nativeTransferService.initialize().catch(err => {
        console.error('[SenderView] Native transfer init failed:', err);
      });

      nativeTransferService.on('status', (s: any) => {
        if (s === 'PREPARING') setStatus('PREPARING');
        if (s === 'TRANSFERRING') setStatus('TRANSFERRING');
        if (s === 'COMPLETED') setStatus('DONE');
        if (s === 'ERROR') setStatus('IDLE');
      });

      nativeTransferService.on('progress', (data: any) => {
        const rawState = String(data?.state || '').toUpperCase();
        if (rawState.includes('PREPAR')) setStatus('PREPARING');
        else setStatus('TRANSFERRING');

        console.log('[SenderView] 📊 Progress event:', data);
        setProgressData({
          progress: data.progress ?? data.progressPercent ?? 0,
          speed: data.speed ?? data.speedBps ?? 0,
          bytesTransferred: data.bytesTransferred || 0,
          totalBytes: data.totalBytes || 0,
        });
      });

      nativeTransferService.on('complete', () => {
        console.log('[SenderView] ✅ Transfer complete event received');
        setStatus('DONE');
      });

      // 🆕 Receiver가 파일 수신 완료 확인 (시그널링 서버 통해)
      nativeTransferService.on('receiver-complete', (data: any) => {
        console.log(
          '[SenderView] ✅ Receiver confirmed transfer complete:',
          data?.peerId
        );
        setStatus('DONE');
      });

      // 🚨 [수정] 오류 중복 발생 방지를 위한 상태 추적
      let lastErrorTime = 0;
      let lastErrorMessage = '';

      nativeTransferService.on('error', (err: any) => {
        const now = Date.now();
        const errorMessage = err?.message || 'Unknown error';

        // 🚨 [수정] 동일한 오류가 1초 내에 반복되면 무시
        if (errorMessage === lastErrorMessage && now - lastErrorTime < 1000) {
          console.warn('[SenderView] Duplicate error ignored:', errorMessage);
          return;
        }

        lastErrorTime = now;
        lastErrorMessage = errorMessage;

        console.error('[SenderView] Native transfer error:', err);

        // 🚨 [수정] "connection lost" 오류는 전송 완료 후 정상적인 현상일 수 있음
        if (errorMessage.includes('connection lost')) {
          console.warn(
            '[SenderView] Connection lost detected - may be normal after transfer completion'
          );
          // 이미 DONE 상태이면 오류 표시하지 않음
          if (status === 'DONE') {
            console.log(
              '[SenderView] Already in DONE status, ignoring connection lost error'
            );
            return;
          }
        }

        // 🚨 [수정] alert() 대신 console.error() 사용
        console.error('[SenderView] Transfer error:', errorMessage);
        setStatus('IDLE');
      });

      // 🆕 피어 연결 이벤트 (시그널링 서버 통해)
      nativeTransferService.on('peer-joined', (data: any) => {
        console.log('[SenderView] Native peer joined:', data.peerId);
        setConnectedPeers(prev => [...prev, data.peerId]);
        setStatus('CONNECTING');
      });

      nativeTransferService.on('connected', (data: any) => {
        console.log('[SenderView] Native peer connected:', data.peerId);
        setStatus('TRANSFERRING');
      });

      // 🆕 피어 발견 이벤트 (mDNS)
      nativeTransferService.on('peer-discovered', (data: any) => {
        console.log('[SenderView] Native peer discovered:', data.peerId);
      });

      // 🆕 connection lost 이벤트 처리
      nativeTransferService.on('connection-lost', (data: any) => {
        console.log('[SenderView] Connection lost event received:', data);
        // 이미 DONE 상태이면 아무것도 하지 않음
        if (status === 'DONE') {
          console.log(
            '[SenderView] Already in DONE status, ignoring connection lost'
          );
          return;
        }
        // connection lost는 정상적인 연결 종료일 수 있으므로 경고만 표시
        console.warn(
          '[SenderView] Connection lost - may be normal after transfer completion'
        );
      });

      // 🆕 QUIC 서버에서 피어 연결 수락 이벤트 (Receiver가 직접 연결)
      nativeTransferService.on('quic-peer-connected', async (data: any) => {
        console.log(
          '[SenderView] 🔗 QUIC peer connected to server:',
          data.peerId
        );
        setConnectedPeers(prev => [...prev, data.peerId]);

        // 🆕 [FIX] 이미 전송이 시작되었다면 중복 실행 방지
        if (isTransferStartedRef.current) {
          console.warn(
            '[SenderView] Transfer already started, ignoring duplicate connection event.'
          );
          return;
        }

        const files = selectedFilesRef.current;
        if (!files || files.length === 0) {
          console.error('[SenderView] No files selected to transfer.');
          return;
        }

        // 전송 시작 플래그 설정
        isTransferStartedRef.current = true;

        // 🆕 Receiver가 준비될 때까지 대기
        console.log('[SenderView] ⏳ Waiting 2s for receiver to be ready...');
        setStatus('CONNECTING');
        await new Promise(resolve => setTimeout(resolve, 2000));

        setStatus('TRANSFERRING');

        try {
          // 🆕 [CRITICAL] Ref에서 최신 transferId 가져오기
          const batchId =
            manifestRef.current?.transferId || `fallback-${Date.now()}`;

          console.log(`[SenderView] Starting transfer with ID: ${batchId}`);
          console.log(`[SenderView] File count: ${files.length}`);

          // 🆕 [핵심 변경] startTransferDispatcher 사용 (자동 분기)
          // - 단일 파일: 기존 방식
          // - 다중 파일: Zip 스트리밍
          await nativeTransferService.startTransferDispatcher(
            files,
            data.peerId,
            batchId
          );

          // 완료 처리
          setStatus('DONE');
        } catch (error: any) {
          console.error('[SenderView] Transfer failed:', error);
          isTransferStartedRef.current = false;
          setStatus('IDLE');
        }
      });

      return () => {
        // cleanup 시 플래그 초기화
        isTransferStartedRef.current = false;
        nativeTransferService.cleanup();
      };
    }

    // WebRTC 모드: SwarmManager 사용
    const swarmManager = new SwarmManager();
    swarmManagerRef.current = swarmManager;

    // 이벤트 핸들러 등록
    swarmManager.on('status', (s: any) => {
      if (s === 'WAITING_FOR_PEER') setStatus('WAITING');
      if (s === 'CONNECTING') setStatus('CONNECTING');
      if (s === 'TRANSFERRING') setStatus('TRANSFERRING');
    });

    swarmManager.on('error', (errorMsg: string) => {
      console.error('[SenderView] SwarmManager error:', errorMsg);

      setStatus('IDLE');
    });

    // 🆕 WebRTC 미지원 이벤트 처리
    swarmManager.on('webrtc-not-supported', (data: any) => {
      console.error('[SenderView] WebRTC not supported:', data.message);
      console.error(
        '[SenderView] WebRTC is not supported in this environment. Please use a web browser or enable Native QUIC mode.'
      );
      setStatus('IDLE');
    });

    // 🚀 [Multi-Receiver] 피어 이벤트
    swarmManager.on('peer-connected', (peerId: string) => {
      setConnectedPeers((prev: string[]) => [...prev, peerId]);
    });

    swarmManager.on('peer-disconnected', ({ peerId }: { peerId: string }) => {
      setConnectedPeers((prev: string[]) =>
        prev.filter((id: string) => id !== peerId)
      );
      setReadyPeers((prev: string[]) =>
        prev.filter((id: string) => id !== peerId)
      );
    });

    swarmManager.on('peer-ready', (peerId: string) => {
      setReadyPeers((prev: string[]) => [...prev, peerId]);
    });

    // 🚀 [Multi-Receiver] Ready 카운트다운 이벤트
    let countdownInterval: ReturnType<typeof setInterval> | null = null;

    swarmManager.on(
      'ready-countdown-start',
      ({ waitTime }: { waitTime: number }) => {
        // 기존 interval 정리
        if (countdownInterval) {
          clearInterval(countdownInterval);
        }

        setReadyCountdown(waitTime / 1000);

        // 1초마다 카운트다운 감소
        countdownInterval = setInterval(() => {
          setReadyCountdown((prev: number | null) => {
            if (prev === null || prev <= 1) {
              if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
              }
              return null;
            }
            return prev - 1;
          });
        }, 1000);
      }
    );

    swarmManager.on('all-peers-ready', () => {
      setReadyCountdown(null); // 카운트다운 종료
    });

    // 🚀 [Multi-Receiver] 전송 배치 시작 이벤트
    swarmManager.on(
      'transfer-batch-start',
      ({ peerCount }: { peerCount: number }) => {
        setCurrentTransferPeerCount(peerCount);
        setStatus('TRANSFERRING');
      }
    );

    swarmManager.on('remote-processing', () => {
      setStatus('REMOTE_PROCESSING');
    });

    // 🚀 [Multi-Receiver] 피어 완료 이벤트
    swarmManager.on('peer-complete', (peerId: string) => {
      setCompletedPeers((prev: string[]) => [...prev, peerId]);
      // 완료된 피어는 readyPeers에서 제거
      setReadyPeers((prev: string[]) =>
        prev.filter((id: string) => id !== peerId)
      );
    });

    // 🚀 [Multi-Receiver] 피어 대기열 추가 이벤트
    swarmManager.on('peer-queued', ({ peerId }: { peerId: string }) => {
      setQueuedPeers((prev: string[]) => [...prev, peerId]);
    });

    // 🚀 [Multi-Receiver] 다음 전송 준비 상태
    swarmManager.on(
      'ready-for-next',
      ({ waitingCount }: { waitingCount: number }) => {
        setWaitingPeersCount(waitingCount);
        setStatus('READY_FOR_NEXT');
      }
    );

    // 🚀 [Multi-Receiver] 배치 완료 (대기 중인 피어 없음)
    swarmManager.on('batch-complete', () => {
      // 대기 중인 피어가 없으면 READY_FOR_NEXT로 전환
      setStatus('READY_FOR_NEXT');
    });

    // 🚀 [Multi-Receiver] 다음 전송 준비 중
    swarmManager.on(
      'preparing-next-transfer',
      ({ queueSize }: { queueSize: number }) => {
        setCurrentTransferPeerCount(queueSize);
        setQueuedPeers([]); // 대기열 초기화
        setStatus('TRANSFERRING');
      }
    );

    // 🚀 [Multi-Receiver] 대기열 처리 완료 이벤트
    swarmManager.on('queue-cleared', () => {
      setQueuedPeers([]); // 대기열 UI 초기화
    });

    // 🚀 [Multi-Receiver] 진행률 리셋 (새 전송 시작 시)
    swarmManager.on('progress', (data: any) => {
      // 진행률이 0으로 리셋되면 새 전송 시작
      if (data.progress === 0 && data.totalBytesSent === 0) {
        setProgressData({
          progress: 0,
          speed: 0,
          bytesTransferred: 0,
          totalBytes: data.totalBytes || 0,
        });
      } else {
        setProgressData({
          progress:
            data.progress ||
            (data.totalBytes > 0
              ? (data.totalBytesSent / data.totalBytes) * 100
              : 0),
          speed: data.speed || 0,
          bytesTransferred: data.totalBytesSent || data.bytesTransferred || 0,
          totalBytes: data.totalBytes || 0,
        });
      }
    });

    swarmManager.on('all-transfers-complete', () => {
      console.log(
        '[SenderView] 🎉 Received all-transfers-complete event, setting status to DONE'
      );
      setStatus('DONE');
    });

    swarmManager.on('complete', () => {
      console.log(
        '[SenderView] 🎉 Received complete event, setting status to DONE'
      );
      setStatus('DONE');
    });

    return () => {
      swarmManager.cleanup();
      swarmManager.removeAllListeners();
    };
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const scannedFiles = processInputFiles(e.target.files);
      processScannedFiles(scannedFiles);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    useTransferStore.setState({ status: 'DRAGGING_FILES' });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    useTransferStore.setState({ status: 'IDLE' });
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useTransferStore.setState({ status: 'IDLE' });

    // 네이티브 모드일 때는 드래그앤드롭으로 파일 선택을 지원하지 않음
    if (isNativeMode) {
      return;
    }

    // DataTransferItemList가 있으면 FileSystemEntry 스캔 사용
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const scannedFiles = await scanFiles(e.dataTransfer.items);
      processScannedFiles(scannedFiles);
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // Fallback: 단순 파일 처리
      const scannedFiles = processInputFiles(e.dataTransfer.files);
      processScannedFiles(scannedFiles);
    }
  };

  // 🆕 네이티브 파일 선택 핸들러 (Zero-Copy 최적화)
  const handleNativeFileSelect = async () => {
    try {
      console.log('[SenderView] 📂 Opening file selection dialog...');

      // 1. Tauri 파일 다이얼로그 오픈 (Rust 백엔드에서 구현)
      const selected = await invoke('open_file_dialog', {
        multiple: true,
        directory: false,
      });

      if (!selected) {
        console.log('[SenderView] User cancelled file selection');
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      console.log('[SenderView] Selected paths:', paths);

      // 2. 선택된 경로들의 메타데이터(크기 등) 조회하여 'File 유사 객체' 생성
      const filesWithMeta = await Promise.all(
        paths.map(async (path: string) => {
          let size = 0;
          const name = path.split(/[\\/]/).pop() || 'unknown';
          let modified = Date.now();

          try {
            console.log('[SenderView] 🔍 Fetching metadata for:', path);

            // Rust 백엔드에서 파일 메타데이터 조회
            const meta = await invoke('get_file_metadata', { path });
            console.log('[SenderView] 📊 Raw metadata response:', meta);
            console.log(
              '[SenderView] 📊 JSON stringify:',
              JSON.stringify(meta)
            );

            // 옵셔널 체이닝으로 안전하게 값 추출
            const metaObj = meta as any;
            size = metaObj?.size ?? 0;
            if (metaObj?.modifiedAt || metaObj?.modified_at) {
              modified = new Date(
                metaObj.modifiedAt || metaObj.modified_at
              ).getTime();
            }

            console.log('[SenderView] 📊 File metadata:', {
              path,
              size,
              name,
              modified,
            });

            if (size === 0) {
              console.error('[SenderView] ❌ File size is 0! Path:', path);
            }
          } catch (e) {
            console.warn('[SenderView] ⚠️ Metadata fetch failed for', path, e);
            console.error('[SenderView] Error details:', e);
            // 실패 시 기본값 사용 (size = 0)
            size = 0;
          }

          // 🚀 Zero-Copy 최적화: 더미 데이터 없이 경로만 포함한 객체 생성
          // Native 모드에서는 파일 내용을 JavaScript 메모리에 올리지 않음
          return {
            file: null, // 🆕 Native 모드에서는 File 객체 불필요
            path: path, // Native 전송에 필수
            nativePath: path, // 🆕 명시적 절대 경로
            nativeSize: size, // 실제 파일 크기
            name: name,
            lastModified: modified,
          };
        })
      );

      console.log(
        '[SenderView] Files with metadata:',
        filesWithMeta.map(f => ({ name: f.name, size: f.nativeSize }))
      );

      // 3. 기존 파일 처리 로직에 전달 (nativeSize 포함)
      if (filesWithMeta.length > 0) {
        // 🆕 nativeSize를 포함한 ScannedFile 형태로 변환
        const scannedFilesWithSize = filesWithMeta.map(item => ({
          file: item.file,
          path: item.path,
          nativePath: item.nativePath || item.path, // 🆕 명시적 절대 경로
          nativeSize: item.nativeSize, // 실제 파일 크기
          name: item.name,
          lastModified: item.lastModified,
        }));

        console.log(
          '[SenderView] Calling processScannedFiles with',
          scannedFilesWithSize.length,
          'files'
        );

        // 🆕 파일 목록 UI에 표시
        setScannedFileList(scannedFilesWithSize);
        processScannedFiles(scannedFilesWithSize);
      }
    } catch (err) {
      console.error('[SenderView] ❌ Native file selection failed:', err);
      console.error('[SenderView] Error type:', typeof err);
      console.error(
        '[SenderView] Error details:',
        err instanceof Error ? err.message : String(err)
      );
      console.error(
        '[SenderView] Stack:',
        err instanceof Error ? err.stack : 'N/A'
      );

      // 권한 에러 등이 발생할 수 있으므로 사용자에게 알림
      console.error(
        '[SenderView] 파일 선택 중 오류가 발생했습니다. tauri.conf.json의 fs/dialog 권한을 확인해주세요.'
      );
    }
  };

  // 🆕 네이티브 폴더 선택 핸들러 (재귀적 스캔)
  const handleNativeFolderSelect = async () => {
    try {
      console.log('[SenderView] 📁 Opening folder selection dialog...');

      // 1. Tauri 폴더 다이얼로그 오픈
      const selected = await invoke<string | null>('open_file_dialog', {
        multiple: false,
        directory: true,
      });

      if (!selected) return;

      const folderPath = selected;
      console.log('[SenderView] 📁 Selected folder root:', folderPath);

      // 2. Rust 측 스캔
      const scannedFiles = await invoke<any[]>('scan_folder', {
        path: folderPath,
      });

      if (!scannedFiles || scannedFiles.length === 0) return;

      // 3. [CRITICAL FIX] 경로 결합 로직 수정
      const filesWithMeta = await Promise.all(
        scannedFiles.map(async (item: any) => {
          // item.path는 상대 경로 (예: "subfolder/file.txt")
          // Tauri API를 통해 OS에 맞는 절대 경로 생성
          const fullPath = await join(folderPath, item.path);

          let size = item.size || 0;
          const name = item.name || item.path.split(/[\\/]/).pop() || 'unknown';

          // 🆕 [FIX] 더미 File 객체 생성 (크기 정보 포함)
          const dummyFile = new File([new ArrayBuffer(size || 0)], name, {
            type: 'application/octet-stream',
            lastModified: Date.now(),
          });

          // 🆕 [FIX] 모든 경로 필드에 올바른 값 주입
          (dummyFile as any).path = fullPath; // 절대 경로
          (dummyFile as any).nativePath = fullPath; // 🆕 명시적 nativePath

          return {
            file: dummyFile,
            path: fullPath, // 절대 경로 (전송 시 사용)
            nativePath: fullPath, // 🆕 명시적 절대 경로 (전송 시 사용)
            relativePath: item.path, // 상대 경로 (Manifest용)
            nativeSize: size, // 실제 파일 크기
            name: name,
            lastModified: Date.now(),
          };
        })
      );

      // 🆕 파일 목록 UI에 표시
      setScannedFileList(filesWithMeta);
      processScannedFiles(filesWithMeta);
    } catch (err) {
      console.error('[SenderView] Folder selection failed:', err);
    }
  };

  const processScannedFiles = async (scannedFiles: any[]) => {
    if (scannedFiles.length === 0) return;

    // [중요] 전송 세션 ID 생성 (Job ID 동기화의 핵심)
    const transferId = `warp-${Date.now().toString(36)}`;

    // 🚀 Zero-Copy 최적화: Native 모드에서는 파일 경로와 메타데이터만 사용
    let manifest: TransferManifest, files;

    if (isNativeMode) {
      // Native 모드: 파일 경로와 크기 정보로 manifest 생성
      // ScannedFile 타입에 맞게 더미 File 객체 생성 (Zero-Copy를 위해 내용은 비어있음)
      const nativeFiles = scannedFiles.map(item => {
        // 파일명 추출 (path, name 중에서 우선 순위로 선택)
        const fileName =
          item.name || item.path?.split(/[\\/]/).pop() || 'unknown';

        // 더미 File 객체 생성 (내용은 비어있음)
        const dummyFile = new File([], fileName, {
          type: 'application/octet-stream',
          lastModified: item.lastModified || Date.now(),
        });

        // File 객체에 path 속성 추가
        (dummyFile as any).path = item.path;

        return {
          file: dummyFile, // ScannedFile 타입 호환을 위한 더미 File 객체
          path: item.relativePath || item.path, // Manifest에는 '상대 경로'를 넣어야 Receiver가 폴더 구조를 복원함
          relativePath:
            item.relativePath || item.path?.split(/[\\/]/).pop() || fileName, // Zip 엔트리명용 상대 경로/파일명
          nativePath: item.nativePath || item.path, // 🆕 [FIX] 실제 전송 시 사용할 절대 경로
          nativeSize: item.nativeSize, // 실제 파일 크기
          name: fileName, // 파일명 명시적 저장
        };
      });

      // Native 모드용 manifest 생성 함수 호출
      const result = createManifest(nativeFiles);

      // [중요] createManifest가 생성한 transferId를 덮어써서 송수신자 동기화
      manifest = {
        ...result.manifest,
        transferId: transferId,
      } as TransferManifest;

      // Native 모드에서는 파일 객체 대신 경로 저장
      files = nativeFiles;

      // [수정] 다중 파일이거나 폴더인 경우 Zip Streaming 모드 플래그 추가
      if (files.length > 1 || manifest.isFolder) {
        manifest.isZipStream = true;
        // Receiver가 알 수 있도록 파일명을 .zip으로 변경 제안
        manifest.rootName = (manifest.rootName || 'archive') + '.zip';
        console.log(
          '[SenderView] 🗜️ Zip Streaming mode enabled for multi-file/folder transfer'
        );
      }

      console.log('[SenderView] 🚀 Native mode - Zero-copy manifest created:', {
        isFolder: manifest.isFolder,
        totalFiles: manifest.totalFiles,
        totalSize: manifest.totalSize,
        rootName: manifest.rootName,
        isZipStream: manifest.isZipStream,
        transferId: manifest.transferId,
      });
    } else {
      // WebRTC 모드: 기존 방식대로 File 객체 사용
      const result = createManifest(scannedFiles);
      // [중요] WebRTC 모드에서도 transferId 포함 (송수신자 동기화)
      manifest = {
        ...result.manifest,
        transferId: transferId,
      } as TransferManifest;
      files = result.files;

      console.log('[SenderView] 🌐 WebRTC mode - Standard manifest created:', {
        isFolder: manifest.isFolder,
        totalFiles: manifest.totalFiles,
        totalSize: manifest.totalSize,
        rootName: manifest.rootName,
        transferId: manifest.transferId,
      });
    }

    setManifest(manifest);
    manifestRef.current = manifest; // 🆕 [CRITICAL] Ref에도 최신 manifest 저장 (클로저 문제 해결)
    selectedFilesRef.current = files; // Native 모드용 파일 저장

    // 여러 파일이면 ZIP 압축 준비 중 표시
    if (files.length > 1) {
      setStatus('PREPARING');
    } else {
      setStatus('WAITING');
    }

    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(id);
    setShareLink(`${window.location.origin}/receive/${id}`);

    console.log('[SenderView] 🏠 [DEBUG] Room created:', id);

    // 🆕 Native QUIC 모드
    if (isNativeMode) {
      console.log('[SenderView] 🚀 Native QUIC mode - Creating room:', id);

      try {
        // 시그널링 서버에 방 생성 (manifest 포함)
        await nativeTransferService.createRoom(id, manifest);
        setStatus('WAITING');
        console.log('[SenderView] ✅ Native room created, waiting for peers');
      } catch (error: any) {
        console.error('[SenderView] ❌ Native room creation failed:', error);
        console.error(
          '[SenderView] Failed to create room:',
          error?.message || 'Unknown error'
        );
        setStatus('IDLE');
      }
      return;
    }

    // WebRTC 모드
    try {
      console.log('[SenderView] 🚀 [DEBUG] Initializing SwarmManager...');
      await swarmManagerRef.current?.initSender(manifest, files, id);
      console.log(
        '[SenderView] ✅ [DEBUG] SwarmManager initialized successfully'
      );

      // 초기화 완료 후 WAITING 상태로 전환
      setStatus('WAITING');
    } catch (error: any) {
      console.error('[SenderView] ❌ [DEBUG] Init failed:', error);

      console.error(
        '[SenderView] Failed to initialize transfer:',
        error?.message || 'Unknown error'
      );
      setStatus('IDLE');
    }
  };

  const copyToClipboard = async () => {
    if (shareLink) {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 공통 Glass Panel 스타일 (통일성 유지)
  const glassPanelClass =
    'bg-black/40 backdrop-blur-2xl border border-cyan-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)] overflow-hidden';

  return (
    <div className="flex flex-col items-center justify-center h-full w-full px-4 py-6 md:px-0 z-10 relative">
      <AnimatePresence mode="wait">
        {/* --- STATE: IDLE (File Selection) --- */}
        {status === 'IDLE' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
            className={`w-full max-w-2xl p-2 ${glassPanelClass}`}
          >
            {/* Drag & Drop Zone (Focal Point) */}
            <div
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              // [수정] 클릭 시 Native 모드면 다이얼로그, 아니면 input 클릭
              onClick={e => {
                // 이벤트 버블링 방지
                if (e.target !== e.currentTarget) return;

                if (isNativeMode) {
                  handleNativeFileSelect();
                } else {
                  fileInputRef.current?.click();
                }
              }}
              className="border-2 border-dashed border-cyan-500/30 rounded-[1.8rem] py-8 px-4 md:py-16 md:px-10 flex flex-col items-center justify-center text-center transition-all hover:border-cyan-400/60 hover:bg-cyan-500/5 cursor-pointer"
            >
              <input
                type="file"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileSelect}
                multiple
              />
              <input
                type="file"
                className="hidden"
                ref={folderInputRef}
                onChange={handleFileSelect}
                multiple
                {...({ webkitdirectory: '' } as any)}
              />

              <div className="w-16 h-16 md:w-20 md:h-20 bg-cyan-900/20 rounded-full flex items-center justify-center mb-6 md:mb-8 shadow-[0_0_30px_rgba(6,182,212,0.2)] group-hover:scale-110 transition-transform duration-300">
                <Upload className="w-8 h-8 md:w-10 md:h-10 text-cyan-400 animate-pulse" />
              </div>

              <h2 className="text-2xl md:text-3xl font-bold mb-3 md:mb-4 brand-font text-white">
                DROP FILES
              </h2>
              <p className="text-cyan-100/60 text-sm md:text-lg mb-6 md:mb-8 font-rajdhani tracking-wide">
                or select from device
              </p>

              {/* 버튼 세로 배치(모바일) -> 가로 배치(태블릿 이상) 유지하되 크기 조절 */}
              <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
                <button
                  onClick={e => {
                    // 이벤트 버블링 방지
                    if (e.target !== e.currentTarget) return;

                    if (isNativeMode) {
                      handleNativeFileSelect();
                    } else {
                      fileInputRef.current?.click();
                    }
                  }}
                  className="flex-1 bg-gray-800/80 hover:bg-gray-700 border border-gray-600 hover:border-cyan-500 text-white py-3 md:py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all group/btn shadow-lg"
                >
                  <FilePlus className="w-4 h-4 md:w-5 md:h-5 text-cyan-400 group-hover/btn:scale-110 transition-transform" />
                  <span className="font-bold tracking-wider text-sm md:text-base">
                    FILES
                  </span>
                </button>

                <button
                  onClick={e => {
                    // 이벤트 버블링 방지
                    if (e.target !== e.currentTarget) return;

                    if (isNativeMode) {
                      handleNativeFolderSelect();
                    } else {
                      folderInputRef.current?.click();
                    }
                  }}
                  className="flex-1 bg-gray-800/80 hover:bg-gray-700 border border-gray-600 hover:border-yellow-500 text-white py-3 md:py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all group/btn shadow-lg"
                >
                  <Folder className="w-4 h-4 md:w-5 md:h-5 text-yellow-400 group-hover/btn:scale-110 transition-transform" />
                  <span className="font-bold tracking-wider text-sm md:text-base">
                    FOLDER
                  </span>
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {status === 'PREPARING' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center p-8 bg-cyan-900/20 rounded-3xl border border-cyan-500/30 max-w-lg w-full"
          >
            <div className="relative w-20 h-20 mx-auto mb-6">
              <Loader2 className="w-full h-full text-cyan-500 animate-spin" />
            </div>

            <h2 className="text-2xl font-bold text-white mb-2">
              Preparing Files...
            </h2>
            <p className="text-gray-400 mb-4">
              Compressing {manifest?.totalFiles} files into ZIP archive
            </p>
            <div className="bg-black/30 backdrop-blur-md p-4 rounded-2xl border border-white/5">
              <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
                <span>{Math.floor(progressData.progress)}%</span>
                <span>
                  {formatBytes(progressData.bytesTransferred)} /{' '}
                  {formatBytes(progressData.totalBytes)}
                </span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 transition-all duration-200"
                  style={{
                    width: `${Math.min(100, Math.max(0, progressData.progress))}%`,
                  }}
                />
              </div>
              <p className="mt-3 text-xs text-gray-500">
                Packaging speed: {formatBytes(progressData.speed)}/s
              </p>
            </div>
          </motion.div>
        )}

        {/* --- STATE: WAITING (QR & Room ID) --- */}
        {status === 'WAITING' && roomId && shareLink && (
          <motion.div
            key="waiting"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`w-full max-w-sm p-6 md:p-8 flex flex-col items-center ${glassPanelClass}`}
          >
            {/* Status Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 mb-6 md:mb-8">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
              </span>
              <span className="text-xs font-bold text-cyan-300 tracking-[0.2em]">
                WARP GATE OPEN
              </span>
            </div>

            {/* QR Code */}
            <div
              className="bg-white p-3 md:p-4 rounded-2xl mb-6 md:mb-8 shadow-[0_0_40px_rgba(6,182,212,0.25)] cursor-pointer"
              onClick={copyToClipboard}
            >
              <QRCodeSVG
                value={shareLink}
                size={140}
                className="md:w-[180px] md:h-[180px]"
              />
            </div>

            {/* Room ID Display */}
            <div
              className="text-center mb-6 md:mb-8 w-full group cursor-pointer"
              onClick={copyToClipboard}
            >
              <p className="text-gray-500 text-[10px] tracking-[0.3em] uppercase mb-2">
                Warp Key
              </p>
              <div className="relative">
                <p className="text-4xl md:text-6xl font-mono font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-white to-cyan-400 bg-300% animate-shine group-hover:scale-105 transition-transform">
                  {roomId}
                </p>
                {copied && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute -right-8 top-1/2 -translate-y-1/2 text-green-400"
                  >
                    <Check size={24} />
                  </motion.div>
                )}
              </div>
            </div>

            {/* Peer Status Indicators (Visual Hierarchy) */}
            <div className="w-full bg-gray-900/40 p-4 rounded-xl mb-4 border border-gray-700/50 backdrop-blur-sm">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-sm text-gray-300">
                  <Users size={14} className="text-cyan-400" />
                  <span>Receivers</span>
                </div>
                <span className="text-xs font-mono text-gray-500">
                  {connectedPeers.length}/{MAX_DIRECT_PEERS} MAX
                </span>
              </div>
              <div className="flex gap-2">
                {[...Array(MAX_DIRECT_PEERS)].map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition-all duration-500 ${
                      i < connectedPeers.length
                        ? readyPeers.length > i
                          ? 'bg-green-500 shadow-[0_0_10px_#22c55e]'
                          : 'bg-cyan-500 shadow-[0_0_10px_#06b6d4]'
                        : 'bg-gray-800'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* File Info Card (Left Aligned for Readability - 7.webp) */}
            <div className="w-full bg-gray-800/30 p-4 rounded-xl border border-gray-700/50 flex items-center gap-4 text-left">
              <div className="w-10 h-10 rounded-lg bg-gray-700/50 flex items-center justify-center flex-shrink-0">
                {manifest?.isFolder ? (
                  <Folder className="text-yellow-400 w-5 h-5" />
                ) : (
                  <FileIcon className="text-blue-400 w-5 h-5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-white text-sm truncate">
                  {manifest?.rootName}
                </p>
                <p className="text-xs text-gray-400 font-mono mt-0.5">
                  {manifest?.totalFiles} files •{' '}
                  {formatBytes(manifest?.totalSize || 0)}
                </p>
              </div>
            </div>

            {/* 🆕 파일 목록 표시 (폴더 스캔 시) */}
            {scannedFileList.length > 0 && (
              <div className="w-full bg-gray-900/40 p-4 rounded-xl border border-gray-700/50 max-h-48 overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Folder className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs text-gray-300 font-bold">
                      {scannedFileList.length} files selected
                    </span>
                  </div>
                  <span className="text-xs text-gray-500 font-mono">
                    {formatBytes(
                      scannedFileList.reduce(
                        (sum, f) => sum + (f.nativeSize || 0),
                        0
                      )
                    )}
                  </span>
                </div>
                <div className="space-y-1">
                  {scannedFileList.slice(0, 10).map((file, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between py-1 px-2 rounded bg-black/20 hover:bg-black/30 text-xs"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <FileIcon className="w-3 h-3 text-gray-400 flex-shrink-0" />
                        <span className="text-gray-300 truncate">
                          {file.name || file.path.split('/').pop()}
                        </span>
                      </div>
                      <span className="text-gray-500 font-mono">
                        {formatBytes(file.nativeSize || 0)}
                      </span>
                    </div>
                  ))}
                  {scannedFileList.length > 10 && (
                    <div className="text-xs text-gray-500 text-center py-1">
                      ... and {scannedFileList.length - 10} more files
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Waiting Message / Countdown */}
            <div className="mt-6 text-center h-6">
              {readyCountdown !== null ? (
                <p className="text-yellow-400 text-sm font-bold animate-pulse tracking-wide">
                  Auto-starting in {readyCountdown}s...
                </p>
              ) : (
                <p className="text-xs text-gray-500 font-mono">
                  {connectedPeers.length === 0
                    ? 'Waiting for connection...'
                    : 'Waiting for receiver to accept...'}
                </p>
              )}
            </div>
          </motion.div>
        )}

        {/* --- STATE: TRANSFERRING (Progress Bar) --- */}
        {(status === 'TRANSFERRING' || status === 'CONNECTING') && (
          <motion.div
            key="transferring"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-xl space-y-8"
          >
            {/* Header */}
            <div className="text-center">
              <h2 className="text-3xl font-bold mb-2 animate-pulse brand-font text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-400">
                WARPING DATA...
              </h2>
              <p className="text-6xl font-mono font-black text-white drop-shadow-[0_0_20px_rgba(6,182,212,0.5)]">
                {progressData.progress.toFixed(1)}
                <span className="text-2xl text-gray-500">%</span>
              </p>
            </div>

            {/* Peer Status Badge */}
            <div className="flex justify-center gap-3">
              <div className="flex items-center gap-2 bg-gray-900/60 px-4 py-2 rounded-full border border-gray-700 backdrop-blur-sm">
                <Users size={14} className="text-cyan-400" />
                <span className="text-xs text-gray-300 font-mono">
                  Sending to {currentTransferPeerCount || readyPeers.length}{' '}
                  peer(s)
                </span>
              </div>
              {queuedPeers.length > 0 && (
                <div className="flex items-center gap-2 bg-yellow-900/40 px-4 py-2 rounded-full border border-yellow-700/50 backdrop-blur-sm">
                  <span className="text-xs text-yellow-400 font-bold">
                    +{queuedPeers.length} Queued
                  </span>
                </div>
              )}
            </div>

            {/* Progress Bar (Visual) */}
            <div className="relative h-6 bg-gray-900/50 rounded-full overflow-hidden border border-gray-700 shadow-inner">
              <motion.div
                className="absolute top-0 left-0 h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-600"
                initial={{ width: 0 }}
                animate={{ width: `${progressData.progress}%` }}
                transition={{ type: 'spring', stiffness: 50, damping: 15 }}
              />
              {/* Shine effect on bar */}
              <div className="absolute top-0 left-0 w-full h-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)] bg-[length:50%_100%] animate-shine opacity-50" />
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-3 gap-3 md:gap-4">
              <div className="bg-black/30 backdrop-blur-md p-3 md:p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Speed
                </p>
                <p className="font-mono font-bold text-cyan-300 text-base md:text-lg">
                  {formatBytes(progressData.speed)}/s
                </p>
              </div>
              <div className="bg-black/30 backdrop-blur-md p-3 md:p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Sent
                </p>
                <p className="font-mono text-white text-base md:text-lg">
                  {formatBytes(progressData.bytesTransferred)}
                </p>
              </div>
              <div className="bg-black/30 backdrop-blur-md p-3 md:p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Total
                </p>
                <p className="font-mono text-gray-400 text-base md:text-lg">
                  {formatBytes(progressData.totalBytes)}
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {status === 'REMOTE_PROCESSING' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center p-8 bg-yellow-900/20 rounded-3xl border border-yellow-500/30 max-w-lg w-full"
          >
            <div className="relative w-20 h-20 mx-auto mb-6">
              <Loader2 className="w-full h-full text-yellow-500 animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-bold text-white">WAIT</span>
              </div>
            </div>

            <h2 className="text-2xl font-bold text-white mb-2">
              Sending Completed...
            </h2>
            <h3 className="text-xl text-yellow-400 font-bold mb-6 animate-pulse">
              Waiting for Receivers to Save
            </h3>

            <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-yellow-500/20">
              <AlertTriangle className="w-6 h-6 text-yellow-500 flex-shrink-0" />
              <div className="text-sm text-gray-300">
                <p className="font-bold text-white mb-1">
                  Do NOT close this window.
                </p>
                <p>
                  The receivers are currently saving files. The connection must
                  remain open until they finish downloading.
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {/* 🚀 [Multi-Receiver] 다음 전송 대기 상태 */}
        {status === 'READY_FOR_NEXT' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center p-8 bg-cyan-900/20 rounded-3xl border border-cyan-500/30 max-w-lg w-full"
          >
            <div className="relative w-20 h-20 mx-auto mb-6">
              <CheckCircle className="w-full h-full text-green-500" />
            </div>

            <h2 className="text-2xl font-bold text-white mb-2">
              Transfer Batch Complete
            </h2>
            <p className="text-gray-400 mb-4">
              {completedPeers.length} receiver(s) have successfully downloaded
              files.
            </p>

            {/* 피어 상태 표시 */}
            <div className="w-full bg-gray-900/50 p-4 rounded-lg mb-6 border border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-400" />
                  <span className="text-sm text-gray-300">Receiver Status</span>
                </div>
              </div>
              <div className="space-y-2 text-left">
                {connectedPeers.map((peerId: string, i: number) => (
                  <div
                    key={peerId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-gray-400">Receiver {i + 1}</span>
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        completedPeers.includes(peerId)
                          ? 'bg-green-900/50 text-green-400'
                          : queuedPeers.includes(peerId)
                            ? 'bg-yellow-900/50 text-yellow-400'
                            : 'bg-gray-800 text-gray-400'
                      }`}
                    >
                      {completedPeers.includes(peerId)
                        ? '✓ Complete'
                        : queuedPeers.includes(peerId)
                          ? '⏳ In Queue'
                          : '○ Waiting'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {waitingPeersCount > 0 ? (
              <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-cyan-500/20 mb-4">
                <Loader2 className="w-6 h-6 text-cyan-500 animate-spin flex-shrink-0" />
                <div className="text-sm text-gray-300">
                  <p className="font-bold text-white mb-1">
                    Waiting for {waitingPeersCount} more receiver(s)
                  </p>
                  <p>
                    Keep this window open. Transfer will start automatically
                    when they click "Start Download".
                  </p>
                </div>
              </div>
            ) : (
              <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-gray-700 mb-4">
                <AlertTriangle className="w-6 h-6 text-gray-500 flex-shrink-0" />
                <div className="text-sm text-gray-300">
                  <p className="font-bold text-white mb-1">
                    No more receivers waiting
                  </p>
                  <p>You can send another file or close this window.</p>
                </div>
              </div>
            )}

            <button
              onClick={() => window.location.reload()}
              className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-cyan-50 transition-colors"
            >
              Send New Files
            </button>
          </motion.div>
        )}

        {/* --- STATE: DONE --- */}
        {status === 'DONE' && (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <div className="w-24 h-24 mx-auto mb-6 bg-green-500/20 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(34,197,94,0.4)]">
              <CheckCircle className="w-12 h-12 text-green-400" />
            </div>
            <h2 className="text-4xl font-bold text-white mb-4 brand-font tracking-wide">
              SUCCESS
            </h2>
            <p className="text-gray-400 text-lg mb-10 max-w-md mx-auto">
              All transfers have been completed successfully.
            </p>

            <button
              onClick={() => window.location.reload()}
              className="bg-white/10 border border-white/20 text-white px-10 py-4 rounded-full font-bold hover:bg-white/20 transition-all flex items-center gap-3 mx-auto"
            >
              <FilePlus size={20} />
              Send More Files
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SenderView;
