import { defineConfig } from 'vite'
import path from 'path'

/**
 * vite.npm.config.ts — 标准 npm 包构建配置（现代 ESM 产物）
 *
 * 与 CDN/IIFE 构建（vite.keepworkSDK.config.ts）的差异：
 * - 产物格式为 ESM（`import { KeepworkSDK } from 'keepwork-sdk'`），输出到 `dist-npm/`。
 * - **不读取 .env**：`__MAISI_API_KEY__` 恒为空串，确保发布到 npm 的产物不含任何 key。
 * - 与 IIFE 一致地内联打包全部代码（external: []），使用方无需额外安装运行时依赖。
 *
 * 类型声明（.d.ts）由独立的 `tsc` 步骤生成（见 package.json 的 build:npm 脚本）。
 */

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'index.ts'),
      formats: ['es'],
      fileName: () => 'keepwork-sdk.js',
    },
    outDir: 'dist-npm',
    sourcemap: true,
    minify: false, // npm 包保留可读源码，便于使用方调试与 tree-shaking
    emptyOutDir: true,
    rollupOptions: {
      // 与 IIFE 一致：内联打包所有代码，产物自包含、零运行时依赖
      external: [],
      output: {
        exports: 'named',
      },
    },
  },
  define: {
    // npm 发布产物绝不含 key —— 恒注入空串（不读 .env）
    __MAISI_API_KEY__: JSON.stringify(''),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../../'),
    },
  },
})
