/**
 * Patch rollup's native.js for OpenHarmony.
 * OpenHarmony's hmdfs filesystem blocks loading native .node files via SELinux/hmmac,
 * so we redirect to @rollup/wasm-node instead.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';

// Only patch on OpenHarmony; other platforms use native bindings natively.
if (platform !== 'openharmony') {
  process.exit(0);
}

const nativeJsPath = join(
  import.meta.dirname,
  '..',
  'node_modules',
  'rollup',
  'dist',
  'native.js'
);

let content = readFileSync(nativeJsPath, 'utf8');

const oldStr = `const { parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16 } = requireWithFriendlyError(
\texistsSync(path.join(__dirname, localName)) ? localName : \`@rollup/rollup-\${packageBase}\`
);`;

const newStr = `// On OpenHarmony, the hmdfs filesystem blocks native .node loading via SELinux/hmmac.
// Fall back to the WASM build (@rollup/wasm-node) which does not require native binaries.
const rollupBindingId =
\tplatform === 'openharmony'
\t\t? '@rollup/wasm-node'
\t\t: existsSync(path.join(__dirname, localName))
\t\t\t? localName
\t\t\t: \`@rollup/rollup-\${packageBase}\`;
const { parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16 } =
\trequireWithFriendlyError(rollupBindingId);`;

if (content.includes(oldStr)) {
  content = content.replace(oldStr, newStr);
  writeFileSync(nativeJsPath, content, 'utf8');
  console.log('[patch-rollup-openharmony] ✅ Patched rollup native.js for OpenHarmony (WASM fallback)');
} else if (content.includes("platform === 'openharmony'")) {
  console.log('[patch-rollup-openharmony] Already patched, skipping.');
} else {
  console.warn('[patch-rollup-openharmony] ⚠️  native.js has unexpected content, manual intervention may be needed.');
}
