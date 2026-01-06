import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield,
  X,
  FileText,
  Clock,
  HardDrive,
  AlertTriangle,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { formatBytes } from '../../utils/fileUtils';
import { logInfo, logError } from '../../utils/logger';

interface TransferApprovalModalProps {
  isOpen: boolean;
  request: {
    job_id: string;
    file_name: string;
    file_size: number;
    sender_name: string;
    sender_device: string;
    timestamp: number;
  };
  onApprove: (request: any, reason?: string) => void;
  onReject: (request: any, reason: string) => void;
  onClose: () => void;
}

export const TransferApprovalModal: React.FC<TransferApprovalModalProps> = ({
  isOpen,
  request,
  onApprove,
  onReject,
  onClose,
}) => {
  const [reason, setReason] = useState('');
  const [isApproving, setIsApproving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setIsApproving(false);
    }
  }, [isOpen]);

  if (!isOpen || !request) return null;

  const handleApprove = async () => {
    if (isApproving) return;

    try {
      setIsApproving(true);
      await invoke('approve_transfer', {
        jobId: request.job_id,
        approved: true,
        reason: reason || undefined,
      });

      logInfo(
        '[TransferApprovalModal]',
        `Transfer approved: ${request.file_name}`
      );

      onApprove(request, reason || undefined);
      onClose();
    } catch (error) {
      logError(
        '[TransferApprovalModal]',
        `Failed to approve transfer: ${error}`
      );
      setIsApproving(false);
      alert(`Failed to approve transfer: ${error}`);
    }
  };

  const handleReject = async () => {
    const rejectReason = reason || 'Transfer rejected by user';

    try {
      setIsApproving(true);
      await invoke('approve_transfer', {
        jobId: request.job_id,
        approved: false,
        reason: rejectReason,
      });

      logInfo(
        '[TransferApprovalModal]',
        `Transfer rejected: ${request.file_name}`
      );

      onReject(request, rejectReason);
      onClose();
    } catch (error) {
      logError(
        '[TransferApprovalModal]',
        `Failed to reject transfer: ${error}`
      );
      setIsApproving(false);
      alert(`Failed to reject transfer: ${error}`);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden"
          >
            <div className="p-6">
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center space-x-3">
                  <div className="p-3 bg-orange-100 dark:bg-orange-900 rounded-lg">
                    <Shield className="text-orange-600 dark:text-orange-400 w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                      File Transfer Request
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {request.sender_name} wants to send you a file
                    </p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  disabled={isApproving}
                >
                  <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
                  <div className="flex items-start space-x-3 mb-4">
                    <FileText className="text-blue-600 dark:text-blue-400 w-5 h-5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="font-semibold text-gray-900 dark:text-gray-100">
                        {request.file_name}
                      </p>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {formatBytes(request.file_size)}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm text-gray-600 dark:text-gray-400">
                    <div className="flex items-center space-x-2">
                      <Clock className="w-4 h-4" />
                      <span>Timestamp</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <HardDrive className="w-4 h-4" />
                      <span>
                        {new Date(request.timestamp * 1000).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                        From
                      </p>
                      <p className="text-gray-600 dark:text-gray-400">
                        {request.sender_name}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                        Device
                      </p>
                      <p className="text-gray-600 dark:text-gray-400">
                        {request.sender_device}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Reason (optional)
                    </label>
                    <textarea
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      placeholder="Enter a reason for approval or rejection..."
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                      rows={3}
                      disabled={isApproving}
                    />
                  </div>

                  <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                    <div className="flex items-start space-x-3">
                      <AlertTriangle className="text-yellow-600 dark:text-yellow-400 w-5 h-5 flex-shrink-0" />
                      <p className="text-sm text-yellow-800 dark:text-yellow-200">
                        <strong>Security Notice:</strong> This file will be
                        transferred peer-to-peer. The sender cannot be verified.
                        Only accept files from trusted sources.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex space-x-3">
                  <motion.button
                    onClick={handleReject}
                    className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors shadow-lg shadow-red-500/30"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    disabled={isApproving}
                  >
                    Reject
                  </motion.button>

                  <motion.button
                    onClick={handleApprove}
                    className="flex-1 px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors shadow-lg shadow-green-500/30"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    disabled={isApproving}
                  >
                    {isApproving ? 'Approving...' : 'Accept'}
                  </motion.button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
