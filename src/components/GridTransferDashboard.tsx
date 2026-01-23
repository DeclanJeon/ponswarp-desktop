/**
 * GridTransferDashboard - Grid Protocol 전송 대시보드
 *
 * Grid Swarm 상태, 조각 맵, 피어 목록을 통합 표시합니다.
 */

import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { GridVisualizer } from './GridVisualizer';
import { SwarmStatus, SwarmState, PeerInfo } from './SwarmStatus';
import { Settings } from 'lucide-react';

interface GridStateUpdate {
  job_id: string;
  total_pieces: number;
  completed_pieces: number[];
  peers: {
    address: string;
    peer_id: string;
    rtt_ms: number | null;
    download_speed: number;
    upload_speed: number;
    pieces_have: number;
    is_choked: boolean;
    is_interested: boolean;
  }[];
  download_speed: number;
  upload_speed: number;
  progress: number;
}

interface GridTransferDashboardProps {
  className?: string;
}

export const GridTransferDashboard: React.FC<GridTransferDashboardProps> = ({
  className = '',
}) => {
  const [swarmState, setSwarmState] = useState<SwarmState | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [pendingPieces] = useState<number[]>([]);

  useEffect(() => {
    // Grid 상태 업데이트 리스너
    const unlistenUpdate = listen<GridStateUpdate>('grid-update', event => {
      const data = event.payload;

      const peers: PeerInfo[] = data.peers.map(p => ({
        peerId: p.peer_id,
        address: p.address,
        rttMs: p.rtt_ms ?? undefined,
        downloadSpeed: p.download_speed,
        uploadSpeed: p.upload_speed,
        piecesHave: p.pieces_have,
        isChoked: p.is_choked,
        isInterested: p.is_interested,
      }));

      setSwarmState({
        jobId: data.job_id,
        totalPieces: data.total_pieces,
        completedPieces: data.completed_pieces,
        peers,
        downloadSpeed: data.download_speed,
        uploadSpeed: data.upload_speed,
        progress: data.progress,
      });

      setIsActive(true);
    });

    // 피어 발견 이벤트
    const unlistenPeer = listen('grid-peer-discovered', event => {
      console.log('Peer discovered:', event.payload);
    });

    return () => {
      unlistenUpdate.then(f => f());
      unlistenPeer.then(f => f());
    };
  }, []);

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  const estimatedTime =
    swarmState && swarmState.downloadSpeed > 0
      ? Math.ceil(
          ((swarmState.totalPieces - swarmState.completedPieces.length) *
            1024 *
            1024) /
            swarmState.downloadSpeed
        )
      : 0;

  return (
    <div className={`space-y-4 ${className}`}>
      {/* 헤더 */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-white">Grid Transfer</h2>
          <p className="text-sm text-gray-400">
            {isActive ? 'Transfer in progress' : 'Waiting for transfer'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isActive && (
            <div className="flex items-center gap-2 px-3 py-1 bg-green-500/20 rounded-full">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-sm text-green-400">Active</span>
            </div>
          )}

          <button
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            title="Settings"
          >
            <Settings className="w-5 h-5 text-gray-400" />
          </button>
        </div>
      </div>

      {/* 통계 카드 */}
      {swarmState && (
        <div className="grid grid-cols-4 gap-3">
          <StatCard
            label="Peers"
            value={swarmState.peers.length.toString()}
            subValue="connected"
          />
          <StatCard
            label="Download"
            value={formatSpeed(swarmState.downloadSpeed)}
            subValue="current"
            color="text-green-400"
          />
          <StatCard
            label="Upload"
            value={formatSpeed(swarmState.uploadSpeed)}
            subValue="current"
            color="text-blue-400"
          />
          <StatCard
            label="ETA"
            value={estimatedTime > 0 ? formatTime(estimatedTime) : '--'}
            subValue="remaining"
          />
        </div>
      )}

      {/* Grid 시각화 */}
      <GridVisualizer
        totalPieces={swarmState?.totalPieces ?? 0}
        completedPieces={swarmState?.completedPieces ?? []}
        pendingPieces={pendingPieces}
      />

      {/* Swarm 상태 */}
      <SwarmStatus state={swarmState} />
    </div>
  );
};

interface StatCardProps {
  label: string;
  value: string;
  subValue: string;
  color?: string;
}

const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  subValue,
  color = 'text-white',
}) => (
  <div className="bg-white/5 backdrop-blur-sm rounded-xl p-3">
    <div className="text-xs text-gray-400 mb-1">{label}</div>
    <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
    <div className="text-xs text-gray-500">{subValue}</div>
  </div>
);

const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec >= 1024 * 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(1)} GB/s`;
  }
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSec >= 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }
  return `${bytesPerSec} B/s`;
};

export default GridTransferDashboard;
