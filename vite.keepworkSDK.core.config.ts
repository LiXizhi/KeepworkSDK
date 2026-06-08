import { defineConfig, loadEnv } from 'vite'
import path from 'path'

/**
 * Vite config for the core-only bundle — everything except AIChat /
 * DigitalHuman modules.  Produces `keepworkSDK.core.iife.js`.
 *
 * Pages that also need AIChat features should load the AIChat chunk
 * (`keepworkSDK.AIChat.iife.js`) after this bundle, or call
 * `keepwork.loadAIChat()` for on-demand loading.
 */

// 构建期密钥注入（CDN/IIFE 自用产物含真实 key；缺失则空串）。
const env = loadEnv(process.env.NODE_ENV || 'production', __dirname, '')
const MAISI_API_KEY = env.MAISI_API_KEY || ''

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'indexCore.ts'),
      name: 'keepworkSDK',
      fileName: () => 'keepworkSDK.core.iife.js',
      formats: ['iife'],
    },
    outDir: 'dist',
    sourcemap: true,
    minify: 'terser',
    emptyOutDir: false,
    rollupOptions: {
      external: [],
      output: {
        exports: 'named',
        globals: {
          'keepworkSDK': 'keepworkSDK'
        }
      }
    },
  },
  define: {
    // 构建期注入 maisi API key（CDN 自用产物含真实 key）
    __MAISI_API_KEY__: JSON.stringify(MAISI_API_KEY),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../../'),
    },
  },
})
