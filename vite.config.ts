import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';

// @ts-ignore process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const isProduction = mode === 'production';

  return {
    root: path.resolve(__dirname, '.'),
    publicDir: 'public',

    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 5173,
      strictPort: true,
      host: host || 'localhost',
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 5174,
          }
        : undefined,
      fs: {
        allow: ['..'],
      },
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      watch: {
        // 3. tell vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
      },
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
      target: 'esnext', // 최신 브라우저 타겟 (번들 사이즈 감소)
      minify: 'esbuild', // 빠른 빌드 속도
      cssCodeSplit: true,
      sourcemap: !isProduction, // 프로덕션에서는 소스맵 제거
      chunkSizeWarningLimit: 1000, // 1MB까지 경고 무시 (Three.js가 큼)

      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
        },
        output: {
          // 🚀 [핵심] 매뉴얼 청크 분할 전략
          manualChunks(id) {
            if (id.includes('node_modules')) {
              // 1. 3D 렌더링 관련 (가장 무거운 부분)
              if (id.includes('three') || id.includes('@react-three')) {
                return 'vendor-visualizer';
              }
              // 2. React 핵심 코어
              if (
                id.includes('react') ||
                id.includes('react-dom') ||
                id.includes('scheduler')
              ) {
                return 'vendor-react';
              }
              // 3. P2P 네트워크 및 파일 처리
              if (
                id.includes('simple-peer') ||
                id.includes('streamsaver') ||
                id.includes('fflate')
              ) {
                return 'vendor-network';
              }
              // 4. 유틸리티 및 상태 관리
              if (
                id.includes('zustand') ||
                id.includes('framer-motion') ||
                id.includes('lucide-react')
              ) {
                return 'vendor-utils';
              }
              // 나머지는 vendor-common으로 번들링
              return 'vendor-common';
            }
          },
        },
      },
    },

    assetsInclude: ['**/*.wasm'],
    plugins: [
      react({
        jsxImportSource: 'react',
        jsxRuntime: 'automatic',
      }),
      NodeGlobalsPolyfillPlugin({
        process: true,
        buffer: true,
      }),
      NodeModulesPolyfillPlugin(),
      {
        name: 'wasm-content-type',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            }
            next();
          });
        },
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            }
            next();
          });
        },
      },
    ],

    define: {
      'process.env.SIGNALING_SERVER_URL': JSON.stringify(
        env.SIGNALING_SERVER_URL
      ),
      'process.env': {},
      global: 'globalThis',
      'import.meta.env.DEV': mode === 'development',
      'import.meta.env.PROD': isProduction,
    },
    esbuild: {
      drop: isProduction ? ['console', 'debugger'] : [],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        stream: 'stream-browserify',
        buffer: 'buffer',
        util: 'util',
        process: 'process/browser',
        three: 'three',
      },
    },
    worker: {
      format: 'es',
      plugins: () => [
        {
          name: 'wasm-worker-loader',
          resolveId(id) {
            if (id.endsWith('.wasm')) {
              return { id, external: false };
            }
          },
          load(id) {
            if (id.endsWith('.wasm')) {
              return null;
            }
          },
        },
      ],
    },
    optimizeDeps: {
      // 🚀 Socket.io 제거됨
      include: [
        'react',
        'react-dom',
        'three',
        '@react-three/fiber',
        'simple-peer',
        'buffer',
        'process',
      ],
      exclude: ['pons-core-wasm'],
      esbuildOptions: {
        define: { global: 'globalThis' },
        plugins: [
          NodeGlobalsPolyfillPlugin({ process: true, buffer: true }),
          NodeModulesPolyfillPlugin(),
        ],
      },
    },
  };
});
