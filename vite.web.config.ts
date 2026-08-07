import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ROOT = __dirname;
// 默认指向 bin/hermit-mvp/server.mjs(5680);用 cc-connect sidecar 作为后端
const standalonePort = process.env.VITE_STANDALONE_PORT?.trim() || '5680';
const webPort = Number.parseInt(process.env.VITE_WEB_PORT?.trim() || '5174', 10);
function readAppVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string') {
      return (parsed as { version: string }).version;
    }
  } catch {
    // The development server remains usable if package metadata is unavailable.
  }
  return '0.0.0';
}

const appVersion = readAppVersion();

export default defineConfig({
  root: resolve(ROOT, 'src/renderer'),
  publicDir: resolve(ROOT, 'public'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${standalonePort}`,
        changeOrigin: false,
        bypass: (req: { url?: string }) => {
          // Don't proxy Vite module requests (renderer's api/ directory)
          if (req.url && /\.(ts|tsx)(\?|$)/.test(req.url)) return req.url;
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@codemirror/language-data'],
    exclude: ['@claude-teams/agent-graph'],
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN ?? ''),
  },
  resolve: {
    alias: {
      '@features': resolve(ROOT, 'src/features'),
      '@renderer': resolve(ROOT, 'src/renderer'),
      '@shared': resolve(ROOT, 'src/shared'),
      '@main': resolve(ROOT, 'src/main'),
      '@claude-teams/agent-graph': resolve(ROOT, 'packages/agent-graph/src/index.ts'),
    },
  },
  // top-level await 在 splash scene 入口里被使用,默认 esbuild target 太老
  build: {
    target: 'es2022',
    // Mermaid is loaded only by message previews. Keeping it separate avoids
    // delaying the primary workbench chunk while avoiding circular vendor chunks.
    chunkSizeWarningLimit: 6_000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return id.includes('/node_modules/mermaid/') ? 'mermaid' : undefined;
        },
      },
    },
  },
  esbuild: {
    target: 'es2022',
  },
});

