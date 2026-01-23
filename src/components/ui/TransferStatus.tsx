import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, ArrowUp, ArrowDown, Clock } from 'lucide-react';
import { formatBytes } from '../../utils/fileUtils';

interface TransferStatusProps {
  fileName: string;
  fileSize: number;
  progress: number; // 0 ~ 100
  speed: number; // Bytes per second
  status: 'idle' | 'sending' | 'receiving' | 'completed' | 'error';
  isSender: boolean;
  onClose: () => void;
  error?: string;
}

export const TransferStatus: React.FC<TransferStatusProps> = ({
  fileName,
  fileSize,
  progress,
  speed,
  status,
  isSender,
  onClose,
  error,
}) => {
  // 🚀 [성능 최적화] 속도 포맷팅
  const formattedSpeed = React.useMemo(() => {
    return speed > 0 ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s` : '0 MB/s';
  }, [speed]);

  // 🚀 [성능 최적화] 남은 시간 계산
  const eta = React.useMemo(() => {
    if (speed <= 0 || progress >= 100) return '';
    const remainingBytes = fileSize * (1 - progress / 100);
    const seconds = remainingBytes / speed;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  }, [fileSize, progress, speed]);

  // 🚀 [성능 최적화] 상태별 아이콘 및 색상
  const getStatusIcon = () => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="text-green-500 w-8 h-8" />;
      case 'error':
        return <XCircle className="text-red-500 w-8 h-8" />;
      case 'sending':
        return <ArrowUp className="text-blue-500 w-8 h-8" />;
      case 'receiving':
        return <ArrowDown className="text-blue-500 w-8 h-8" />;
      default:
        return <Clock className="text-gray-500 w-8 h-8" />;
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'completed':
        return 'text-green-500';
      case 'error':
        return 'text-red-500';
      case 'sending':
      case 'receiving':
        return 'text-blue-500';
      default:
        return 'text-gray-500';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'completed':
        return 'Transfer Successful!';
      case 'error':
        return 'Transfer Failed';
      case 'sending':
        return 'Sending File...';
      case 'receiving':
        return 'Receiving File...';
      default:
        return 'Ready';
    }
  };

  // 🚀 [성능 최적화] 프로그레스 링 색상 계산
  const getProgressColor = () => {
    if (status === 'error') return 'bg-red-500';
    if (status === 'completed') return 'bg-green-500';
    return 'bg-blue-600';
  };

  return (
    <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden border border-gray-100 dark:border-gray-700">
      {/* 1. Header Area */}
      <div className="p-6 pb-2">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div
              className={`p-2 rounded-lg ${
                isSender
                  ? 'bg-blue-100 text-blue-600'
                  : 'bg-green-100 text-green-600'
              }`}
            >
              {getStatusIcon()}
            </div>
            <div>
              <h3 className={`text-lg font-bold ${getStatusColor()}`}>
                {getStatusText()}
              </h3>
              <p className="text-sm text-gray-500 truncate max-w-[200px]">
                {fileName}
              </p>
            </div>
          </div>
          {status === 'completed' && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.3 }}
            >
              <CheckCircle className="text-green-500 w-8 h-8" />
            </motion.div>
          )}
        </div>

        {/* 2. Main Status (Progress & Speed) */}
        <div className="space-y-2">
          <div className="flex justify-between items-end">
            <span className={`text-4xl font-extrabold ${getStatusColor()}`}>
              {Math.floor(progress)}%
            </span>
            <div className="text-right">
              <div className="text-xl font-semibold text-gray-600 dark:text-gray-300 mb-1">
                {status === 'completed' ? 'Done' : formattedSpeed}
              </div>
              {status !== 'completed' && status !== 'error' && eta && (
                <div className="text-sm text-gray-500">{eta} left</div>
              )}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
            <motion.div
              className={`h-full ${getProgressColor()} transition-all duration-300 ease-out`}
              style={{ width: `${progress}%` }}
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
        </div>
      </div>

      {/* 3. Detail & Actions Area */}
      <div className="bg-gray-50 dark:bg-gray-900 px-6 py-4 flex justify-between items-center">
        <div className="text-xs text-gray-400">
          {/* 기술 정보는 작게 표시 */}
          <div>Size: {formatBytes(fileSize)}</div>
          {speed > 0 && <div>Speed: {formattedSpeed}</div>}
        </div>

        {status === 'completed' ? (
          <motion.button
            onClick={onClose}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors shadow-lg shadow-blue-500/30"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            Close & Finish
          </motion.button>
        ) : (
          <motion.button
            className="px-4 py-2 text-red-500 hover:bg-red-50 font-medium rounded-lg transition-colors"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            Cancel
          </motion.button>
        )}
      </div>

      {/* 4. Error State Overlay */}
      <AnimatePresence>
        {status === 'error' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-red-500/10 backdrop-blur-sm flex items-center justify-center"
          >
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 m-4 max-w-sm">
              <XCircle className="text-red-500 w-12 h-12 mx-auto mb-4" />
              <h3 className="text-lg font-bold text-red-600 dark:text-red-400 mb-2">
                Transfer Failed
              </h3>
              <p className="text-gray-600 dark:text-gray-300 text-sm mb-4">
                {error || 'An unknown error occurred during file transfer.'}
              </p>
              <motion.button
                onClick={onClose}
                className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                Try Again
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
