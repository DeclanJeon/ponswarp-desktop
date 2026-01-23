/**
 * SwarmStatus - Grid Swarm 네트워크 상태 표시
 *
 * 연결된 피어 목록, 속도, RTT 등을 표시합니다.
 */

import React from 'react';
import { Users, ArrowDown, ArrowUp, WifiOff } from 'lucide-react';

export interface PeerInfo {
  peerId: string;
  address: string;
  rttMs?: number;
  downloadSpeed: number;
  uploadSpeed: number;
  piecesHave: number;
  isChoked: boolean;
  isInterested: boolean;
}

export interface SwarmState {
  jobId: string;
  totalPieces: number;
  completedPieces: number[];
  peers: PeerInfo[];
  downloadSpeed: number;
  uploadSpeed: number;
  progress: number;
}

interface SwarmStatusProps {
  state: SwarmState | null;
  className?: string;
}

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

const getRttColor = (rttMs?: number): string => {
  if (!rttMs) return 'text-gray-500';
  if (rttMs < 20) return 'text-green-400';
  if (rttMs < 50) return 'text-yellow-400';
  if (rttMs < 100) return 'text-orange-400';
  return 'text-red-400';
};

export const SwarmStatus: React.FC<SwarmStatusProps> = ({
  state,
  className = '',
}) => {
  if (!state) {
    return (
      <div
        className={`bg-white/5 backdrop-blur-sm rounded-xl p-4 ${className}`}
      >
        <div className="flex items-center justify-center h-32 text-gray-500">
          <WifiOff className="w-6 h-6 mr-2" />
          <span>Waiting for connection...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-white/5 backdrop-blur-sm rounded-xl p-4 ${className}`}>
      {/* 헤더: 전체 속도 */}
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-blue-400" />
          <h3 className="text-sm font-semibold text-gray-300">
            Swarm ({state.peers.length} peers)
          </h3>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1 text-green-400">
            <ArrowDown className="w-4 h-4" />
            <span className="text-sm font-mono">
              {formatSpeed(state.downloadSpeed)}
            </span>
          </div>
          <div className="flex items-center gap-1 text-blue-400">
            <ArrowUp className="w-4 h-4" />
            <span className="text-sm font-mono">
              {formatSpeed(state.uploadSpeed)}
            </span>
          </div>
        </div>
      </div>

      {/* 피어 목록 */}
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {state.peers.length === 0 ? (
          <div className="text-center text-gray-500 py-4">
            No peers connected
          </div>
        ) : (
          state.peers.map(peer => (
            <div
              key={peer.peerId}
              className="flex items-center justify-between p-2 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
            >
              <div className="flex items-center gap-3">
                {/* 연결 상태 아이콘 */}
                <div
                  className={`w-2 h-2 rounded-full ${
                    peer.isChoked ? 'bg-red-500' : 'bg-green-500'
                  }`}
                />

                {/* 피어 정보 */}
                <div>
                  <div className="text-sm font-mono text-gray-300">
                    {peer.address}
                  </div>
                  <div className="text-xs text-gray-500">
                    {peer.piecesHave} pieces
                    {peer.isInterested && ' • Interested'}
                  </div>
                </div>
              </div>

              {/* 속도 및 RTT */}
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1 text-green-400">
                  <ArrowDown className="w-3 h-3" />
                  <span className="font-mono">
                    {formatSpeed(peer.downloadSpeed)}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-blue-400">
                  <ArrowUp className="w-3 h-3" />
                  <span className="font-mono">
                    {formatSpeed(peer.uploadSpeed)}
                  </span>
                </div>
                <div className={`font-mono ${getRttColor(peer.rttMs)}`}>
                  {peer.rttMs ? `${peer.rttMs}ms` : 'N/A'}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 진행률 바 */}
      <div className="mt-4">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>Progress</span>
          <span>{(state.progress * 100).toFixed(1)}%</span>
        </div>
        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-300"
            style={{ width: `${state.progress * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
};

export default SwarmStatus;
