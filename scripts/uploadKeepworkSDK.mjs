/**
 * Upload keepworkSDK build artifacts to Qiniu CDN (cdn.keepwork.com/sdk/).
 *
 * Usage:
 *   node scripts/uploadKeepworkSDK.mjs          # build + upload all 7 files
 *   node scripts/uploadKeepworkSDK.mjs --no-build  # upload only (skip build)
 */
import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const resourceDir = path.resolve(projectRoot, '../resource')

const FILES = [
  'keepworkSDK.iife.js',
  'keepworkSDK.iife.js.map',
  'keepworkSDK.core.iife.js',
  'keepworkSDK.core.iife.js.map',
  'keepworkSDK.AIChat.iife.js',
  'keepworkSDK.AIChat.iife.js.map',
  'DigitalHumanFrame.html',
]

const PYTHON_UPLOAD_SCRIPT = path.join(
  projectRoot,
  '.github/skills/upload-deploy-cdn-files/qiniu_upload_local_files.py'
)
const NODE_UPLOAD_SCRIPT = path.join(projectRoot, 'scripts/qiniuUploadLocalFiles.mjs')

const skipBuild = process.argv.includes('--no-build')

// Step 1: build + localDeploy (copies to ../resource/)
if (!skipBuild) {
  console.log('=== Building and deploying locally ===')
  execSync('npm run localDeploy', { cwd: projectRoot, stdio: 'inherit' })
}

// Step 2: upload to CDN
console.log('\n=== Uploading to CDN (sdk/) ===')
const filePaths = FILES.map(f => path.join(resourceDir, f)).join(' ')

try {
  console.log('Trying Python uploader first...')
  execSync(`python "${PYTHON_UPLOAD_SCRIPT}" --prefix sdk/ ${filePaths}`, {
    cwd: projectRoot,
    stdio: 'inherit',
  })
} catch (error) {
  if (error?.status === 2) {
    console.error('\nPython uploader failed because qiniu.yaml access keys are missing. Aborting instead of falling back.')
    process.exit(2)
  }
  console.warn('\nPython uploader failed, falling back to Node uploader...')
  execSync(`node "${NODE_UPLOAD_SCRIPT}" --prefix sdk/ ${filePaths}`, {
    cwd: projectRoot,
    stdio: 'inherit',
  })
}

console.log('\n✅ Done! All 7 files uploaded to cdn.keepwork.com/sdk/')
