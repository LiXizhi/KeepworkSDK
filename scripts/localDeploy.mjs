import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist')
const resourceDir = path.resolve(projectRoot, '../resource')
const filesToCopy = [
  'keepworkSDK.iife.js', 'keepworkSDK.iife.js.map',
  'keepworkSDK.core.iife.js', 'keepworkSDK.core.iife.js.map',
  'keepworkSDK.AIChat.iife.js', 'keepworkSDK.AIChat.iife.js.map',
  'DigitalHumanFrame.html',
]
const sourceMapHashLength = 12

if (!fs.existsSync(distDir)) {
  throw new Error(`Build output not found: ${distDir}`)
}

fs.mkdirSync(resourceDir, { recursive: true })

/**
 * Append a content-based hash to the sourceMappingURL inside a JS bundle
 * so that browsers bust the cache for the .map file when content changes.
 */
function appendHashToSourceMapUrl(filePath) {
  const bundleContent = fs.readFileSync(filePath, 'utf8')
  const mapFileName = path.basename(filePath).replace(/\.js$/, '.js.map')
  const pattern = new RegExp(
    `//# sourceMappingURL=${mapFileName.replace(/\./g, '\\.')}(\\?v=[^\\r\\n]+)?$`,
    'm'
  )
  const bundleHash = crypto
    .createHash('sha256')
    .update(bundleContent)
    .digest('hex')
    .slice(0, sourceMapHashLength)
  const replacement = `//# sourceMappingURL=${mapFileName}?v=${bundleHash}`
  const updatedContent = bundleContent.replace(pattern, replacement)

  if (updatedContent === bundleContent) {
    console.warn(`Warning: could not find sourceMappingURL in ${path.basename(filePath)}`)
    return
  }

  fs.writeFileSync(filePath, updatedContent)
  console.log(`Updated sourceMappingURL hash for ${path.basename(filePath)}`)
}

for (const fileName of filesToCopy) {
  const sourceFile = path.join(distDir, fileName)
  const destinationFile = path.join(resourceDir, fileName)

  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Expected build artifact not found: ${sourceFile}`)
  }

  fs.copyFileSync(sourceFile, destinationFile)
  console.log(`Copied ${fileName} to ${resourceDir}`)

  if (fileName === 'keepworkSDK.iife.js' || fileName === 'keepworkSDK.core.iife.js') {
    appendHashToSourceMapUrl(destinationFile)
  }
}