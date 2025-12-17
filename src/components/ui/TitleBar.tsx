import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { X, Minus, Square, Copy } from 'lucide-react';

/**
 * 커스텀 타이틀바 컴포넌트
 * Tauri v2 환경에서 윈도우 제어 기능을 제공합니다.
 * 데스크탑 모드에서만 표시됩니다.
 */
export const TitleBar: React.FC = () => {
  const appWindow = getCurrentWindow();

  const handleMinimize = () => appWindow.minimize();
  const handleMaximize = () => appWindow.toggleMaximize();
  const handleClose = () => appWindow.close();

  return (
    <div
      data-tauri-drag-region
      className="fixed top-0 left-0 right-0 h-10 bg-black/80 backdrop-blur-md z-50 flex items-center justify-between px-4 select-none border-b border-white/5"
    >
      {/* 로고 및 드래그 영역 */}
      <div className="flex items-center gap-2 text-sm font-bold tracking-wider text-gray-400 pointer-events-none">
        <span className="text-cyan-400">PONS</span>WARP
      </div>

      {/* 윈도우 컨트롤 버튼 */}
      <div className="flex items-center gap-1">
        <button
          onClick={handleMinimize}
          className="p-2 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white"
          title="최소화"
        >
          <Minus size={16} />
        </button>
        <button
          onClick={handleMaximize}
          className="p-2 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white"
          title="최대화/복원"
        >
          <Square size={14} />
        </button>
        <button
          onClick={handleClose}
          className="p-2 hover:bg-red-500/20 hover:text-red-500 rounded-lg transition-colors text-gray-400"
          title="닫기"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
};
