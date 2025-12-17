/**
 * GridVisualizer - 파일 조각 상태를 캔버스로 시각화
 *
 * BitTorrent 스타일의 조각 맵을 표시합니다.
 * - 회색: 미완료
 * - 파란색: 완료
 * - 노란색: 다운로드 중
 */

import React, { useEffect, useRef, useCallback } from 'react';

interface GridVisualizerProps {
  totalPieces: number;
  completedPieces: number[];
  pendingPieces?: number[];
  className?: string;
}

export const GridVisualizer: React.FC<GridVisualizerProps> = ({
  totalPieces,
  completedPieces,
  pendingPieces = [],
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 컨테이너 크기에 맞춤
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    // 캔버스 초기화
    ctx.clearRect(0, 0, width, height);

    if (totalPieces === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data', width / 2, height / 2);
      return;
    }

    // 그리드 계산
    const cols = Math.ceil(Math.sqrt(totalPieces * (width / height)));
    const rows = Math.ceil(totalPieces / cols);
    const cellWidth = width / cols;
    const cellHeight = height / rows;
    const gap = Math.min(cellWidth, cellHeight) * 0.1;

    // 완료/진행 중 조각 Set으로 변환 (빠른 조회)
    const completedSet = new Set(completedPieces);
    const pendingSet = new Set(pendingPieces);

    // 각 조각 그리기
    for (let i = 0; i < totalPieces; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellWidth + gap / 2;
      const y = row * cellHeight + gap / 2;
      const w = cellWidth - gap;
      const h = cellHeight - gap;

      // 상태에 따른 색상
      if (completedSet.has(i)) {
        ctx.fillStyle = '#3b82f6'; // Blue-500 (완료)
      } else if (pendingSet.has(i)) {
        ctx.fillStyle = '#eab308'; // Yellow-500 (다운로드 중)
      } else {
        ctx.fillStyle = '#e2e8f0'; // Gray-200 (미완료)
      }

      // 둥근 모서리 사각형
      const radius = Math.min(w, h) * 0.2;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
    }
  }, [totalPieces, completedPieces, pendingPieces]);

  useEffect(() => {
    draw();

    // 리사이즈 대응
    const handleResize = () => draw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  const progress =
    totalPieces > 0
      ? ((completedPieces.length / totalPieces) * 100).toFixed(1)
      : '0.0';

  return (
    <div className={`bg-white/5 backdrop-blur-sm rounded-xl p-4 ${className}`}>
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-gray-300">Grid Map</h3>
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-blue-500"></span>
            완료
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-yellow-500"></span>
            진행중
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-gray-300"></span>
            대기
          </span>
        </div>
      </div>

      <div ref={containerRef} className="w-full aspect-[2/1] min-h-[120px]">
        <canvas ref={canvasRef} className="w-full h-full rounded-lg" />
      </div>

      <div className="mt-3 flex justify-between items-center text-sm">
        <span className="text-gray-400">
          {completedPieces.length} / {totalPieces} pieces
        </span>
        <span className="text-blue-400 font-mono font-semibold">
          {progress}%
        </span>
      </div>
    </div>
  );
};

export default GridVisualizer;
