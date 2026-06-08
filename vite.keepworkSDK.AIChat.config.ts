import { defineConfig } from 'vite'
import path from 'path'

/**
 * Vite config for the AIChat chunk — a separate IIFE that contains the
 * heavier AI / Digital-Human modules.
 *
 * Shared modules that are already provided by the core keepworkSDK.iife.js
 * bundle (SandboxToolEnv, YMLParser) are marked as external so they are
 * resolved from `window.*` globals at runtime instead of being duplicated.
 */

/**
 * Map of shared modules → window global names.
 * These modules exist in the core keepworkSDK.iife.js bundle and should not
 * be duplicated in the AIChat chunk.  Rollup will replace their imports with
 * references to the corresponding `window.*` globals.
 */
const sharedGlobals: Record<string, string> = {
  SandboxToolEnv: 'SandboxToolEnv',
  YMLParser: 'YMLParser',
};

function isSharedExternal(id: string): string | null {
  for (const name of Object.keys(sharedGlobals)) {
    if (
      id.endsWith(`/${name}.ts`) || id.endsWith(`\\${name}.ts`) ||
      id.endsWith(`/${name}`)   || id.endsWith(`\\${name}`)
    ) return name;
  }
  return null;
}

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'indexAIChat.ts'),
      name: 'keepworkSDKAIChat',
      fileName: () => 'keepworkSDK.AIChat.iife.js',
      formats: ['iife'],
    },
    outDir: 'dist',
    sourcemap: true,
    minify: 'terser',
    // Do NOT empty the outDir — the core bundle is already there.
    emptyOutDir: false,
    rollupOptions: {
      external: (id: string) => !!isSharedExternal(id),
      output: {
        exports: 'named',
        globals: (id: string) => {
          const name = isSharedExternal(id);
          return (name && sharedGlobals[name]) || id;
        },
      },
    },
  },
  define: {
    // AIChat chunk 不应包含 maisi key（API_KEYS 在 core bundle），统一注入空串。
    __MAISI_API_KEY__: JSON.stringify(''),
  },
  // Reuse the same resolve aliases as the main config.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../../'),
    },
  },
})
