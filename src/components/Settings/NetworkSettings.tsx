// React 19 with TypeScript 5.9, Tailwind CSS v4
//
// TURN Network Settings Component
//
// This component provides a UI for configuring TURN (Traversal Using Relays around NAT)
// server settings to enable external network P2P connections.
//
// Features:
// - Enable/disable TURN functionality
// - Configure TURN server URL and authentication
// - Display current TURN connection status
// - Test TURN server connectivity
// - Show ICE candidates and connection method

'use client';

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Types
interface TurnConfig {
  enabled: boolean;
  server_url: string;
  realm: string;
  enable_tls: boolean;
  username?: string;
  password?: string;
  secret?: string;
}

interface TurnStatus {
  enabled: boolean;
  connection_type: string;
  turn_relay_address?: string;
  ice_candidates: IceCandidate[];
  timestamp: number;
}

interface IceCandidate {
  type: 'host' | 'stun' | 'relay';
  address: string;
  priority: number;
  source: string;
}

export default function NetworkSettings() {
  // State

  const [config, setConfig] = useState<TurnConfig>({
    enabled: false,
    server_url: 'turn.ponslink.online:3478',
    realm: 'ponslink.online',
    enable_tls: true,
  });

  const [status, setStatus] = useState<TurnStatus>({
    enabled: false,
    connection_type: 'disconnected',
    turn_relay_address: undefined,
    ice_candidates: [],
    timestamp: 0,
  });

  const [status, setStatus] = useState<TurnStatus>({
    enabled: false,
    connection_type: 'disconnected',
    turn_relay_address: undefined,
    ice_candidates: [],
    timestamp: 0,
  });

  const [status, setStatus] = useState<TurnStatus>({
    enabled: false,
    connection_type: 'disconnected',
    turn_relay_address: undefined,
    ice_candidates: [],
    timestamp: 0,
  });

  const [testResult, setTestResult] = useState<{
    testing: boolean;
    connected: boolean;
    latency: number;
  }>({
    testing: false,
    connected: false,
    latency: 0,
  });

  // Load TURN configuration on mount
  useEffect(() => {
    loadTurnConfig();
  }, []);

  // Load TURN status periodically
  useEffect(() => {
    const interval = setInterval(() => {
      loadTurnStatus();
    }, 5000); // Every 5 seconds

    return () => clearInterval(interval);
  }, []);

  // Load TURN configuration
  const loadTurnConfig = async () => {
    try {
      const result = await invoke<string>('get_turn_config');
      setConfig(JSON.parse(result));
      console.log('TURN config loaded:', result);
    } catch (error) {
      console.error('Failed to load TURN config:', error);
    }
  };

  // Load TURN status
  const loadTurnStatus = async () => {
    try {
      const result = await invoke<string>('get_turn_status');
      setStatus(JSON.parse(result));
      console.log('TURN status loaded:', result);
    } catch (error) {
      console.error('Failed to load TURN status:', error);
    }
  };

  // Test TURN connection
  const testTurnConnection = async () => {
    console.log('TURN connection test triggered');
  };

  // Update TURN configuration
  const updateConfig = async (newConfig: Partial<TurnConfig>) => {
    try {
      const result = await invoke<string>('update_turn_config', {
        config: newConfig,
      });
      console.log('TURN config updated:', result);
      loadTurnConfig(); // Reload to apply changes
    } catch (error) {
      console.error('Failed to update TURN config:', error);
    }
  };

  // Toggle TURN
  const toggleTurn = async (enabled: boolean) => {
    await updateConfig({ enabled });
  };

  // Enable TURN
  const enableTurn = async () => {
    await toggleTurn(true);
  };

  // Disable TURN
  const disableTurn = async () => {
    await toggleTurn(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            TURN Network Settings
          </h1>
          <p className="text-sm text-gray-600">
            Configure TURN server for external network P2P connections
          </p>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center space-x-2">
          <div
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg border ${
              status.enabled
                ? 'bg-green-50 border-green-200'
                : 'bg-gray-50 border-gray-200'
            }`}
          >
            <div
              className={`w-3 h-3 rounded-full ${
                status.enabled ? 'bg-green-100' : 'bg-gray-200'
              }`}
            >
              {status.enabled ? (
                <svg
                  className="w-4 h-4 text-green-500"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M12 22C12.07 0l-11.31-2c-2.59 5.31-5.31-.7c.7-5.31-.3 5.31h11.31z" />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4 text-gray-500"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M18.36 19.32 1.06-4.14.59-4.14-7.07-5.31-5.31.31-5.31-.3 5.31-.7c-7-5.31-.7 5.31h12v12z" />
                </svg>
              )}
            </div>
            <div className="ml-3">
              <div className="text-sm font-medium">
                <p className="font-semibold">Status:</p>
                <p
                  className={
                    status.enabled ? 'text-green-600' : 'text-gray-600'
                  }
                >
                  {status.enabled ? 'Enabled' : 'Disabled'}
                </p>
                {status.connection_type && (
                  <p className="text-xs text-gray-500">
                    Connection: {status.connection_type}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Connection Test Button (Removed - Tauri command doesn't exist) */}

          {testResult.connected && !testResult.testing && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <p className="font-medium text-green-900">Success!</p>
              <p className="text-sm text-green-700">Connected to TURN server</p>
              <p className="text-xs text-green-600">
                Latency: {testResult.latency}ms
              </p>
            </div>
          )}

          {!testResult.connected && !testResult.testing && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="font-medium text-red-900">Failed</p>
              <p className="text-sm text-red-700">
                Could not connect to TURN server
              </p>
            </div>
          )}
        </div>

        {/* Configuration Form */}
        <div className="bg-white rounded-lg border border border-gray-200 shadow-lg p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            TURN Server Configuration
          </h2>

          {/* Enable/Disable Toggle */}
          <div className="flex items-center space-x-4 mb-6">
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={e => updateConfig({ enabled: e.target.checked })}
                className="w-5 h-5 text-blue-600 rounded border-gray-300 focus:ring-2 focus:ring-offset-2"
              />
              <span className="text-sm font-medium text-gray-700">
                Enable TURN
              </span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={enableTurn}
                disabled={config.enabled}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400 disabled:opacity-50 transition-colors duration-200"
              >
                Enable
              </button>
              <button
                onClick={disableTurn}
                disabled={!config.enabled}
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400 disabled:opacity-50 transition-colors duration-200"
              >
                Disable
              </button>
            </div>
          </div>

          {/* Server URL */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              TURN Server URL
            </label>
            <input
              type="text"
              value={config.server_url}
              onChange={e => updateConfig({ server_url: e.target.value })}
              placeholder="turn.ponslink.online:3478"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:opacity-50 text-sm"
            />
          </div>

          {/* Realm */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              TURN Realm
            </label>
            <input
              type="text"
              value={config.realm}
              onChange={e => updateConfig({ realm: e.target.value })}
              placeholder="ponslink.online"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:opacity-50 text-sm"
            />
          </div>

          {/* Enable TLS */}
          <div className="mb-4">
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={config.enable_tls}
                onChange={e => updateConfig({ enable_tls: e.target.checked })}
                className="w-5 h-5 text-blue-600 rounded border-gray-300 focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:opacity-50"
              />
              <span className="text-sm font-medium text-gray-700">
                Enable TLS
              </span>
            </label>
          </div>

          {/* Authentication Method Selection */}
          <div className="mb-6 bg-gray-50 border border-gray-200 rounded-lg p-4">
            <p className="text-sm text-gray-600 mb-2">
              Authentication will use environment variables (TURN_SECRET) when
              Long-term method is selected.
            </p>
          </div>

          {/* Update Config Button */}
          <button
            onClick={() => updateConfig(config)}
            disabled={!config.enabled}
            className="w-full px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:opacity-50 transition-colors duration-200"
          >
            Update Configuration
          </button>
        </div>

        {/* ICE Candidates Display */}
        <div className="bg-white rounded-lg border border border-gray-200 shadow-lg p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            ICE Candidates & Connection Info
          </h2>

          {/* Current Connection Method */}
          <div className="mb-4">
            <p className="text-sm font-medium text-gray-700 mb-1">
              Connection Method
            </p>
            <div
              className={`p-3 rounded-lg border ${
                status.connection_type === 'Direct QUIC'
                  ? 'bg-green-50 border-green-200 text-green-700'
                  : status.connection_type === 'STUN Hole Punching'
                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                    : status.connection_type === 'TURN Relay'
                      ? 'bg-orange-50 border-orange-200 text-orange-700'
                      : 'bg-gray-50 border-gray-200 text-gray-700'
              }`}
            >
              <div className="flex items-center space-x-2">
                <span className="font-semibold">
                  {status.connection_type || 'Disconnected'}
                </span>
                {status.connection_type === 'TURN Relay' &&
                  status.turn_relay_address && (
                    <span className="text-xs text-gray-500 ml-2">
                      ({status.turn_relay_address})
                    </span>
                  )}
              </div>
            </div>
          </div>

          {/* ICE Candidates List */}
          <div className="mb-4">
            <p className="text-sm font-medium text-gray-700 mb-2">
              ICE Candidates
            </p>
            {status.ice_candidates.length > 0 ? (
              <div className="space-y-2">
                {status.ice_candidates.map((candidate, index) => (
                  <div
                    key={index}
                    className={`flex items-center justify-between p-3 rounded-lg border ${
                      candidate.type === 'host'
                        ? 'bg-green-50 border-green-200 text-green-700'
                        : candidate.type === 'stun'
                          ? 'bg-blue-50 border-blue-200 text-blue-700'
                          : candidate.type === 'relay'
                            ? 'bg-orange-50 border-orange-200 text-orange-700'
                            : 'bg-gray-50 border-gray-200 text-gray-700'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <div>
                        <span
                          className={`text-xs font-semibold uppercase ${
                            candidate.type === 'host'
                              ? 'text-green-600'
                              : candidate.type === 'stun'
                                ? 'text-blue-600'
                                : candidate.type === 'relay'
                                  ? 'text-orange-600'
                                  : 'text-gray-500'
                          }`}
                        >
                          {candidate.type}
                        </span>
                        <span className="text-xs text-gray-500">
                          (Priority: {candidate.priority})
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {candidate.address}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">
                        {candidate.source}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                No ICE candidates available
              </p>
            )}
          </div>
        </div>

        {/* Last Updated Timestamp */}
        <div className="text-center mt-6">
          <p className="text-xs text-gray-500">
            Last updated: {new Date(status.timestamp).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  );
}
