/**
 * 七牛云文件上传工具（Node 版）
 *
 * 用法:
 *   node scripts/qiniuUploadLocalFiles.mjs [--prefix 前缀] <本地路径1> [本地路径2] ...
 *
 * 路径可以是文件或目录。目录会递归上传其中所有文件，保留相对目录结构。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import qiniu from 'qiniu'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

let remotePrefix = 'keepwork/cdn/'
let bucketName = 'haqi'
let domain = 'https://cdn.keepwork.com'
let uploadHost = 'https://up.qiniup.com'

function normalizePrefix(prefix) {
  if (!prefix) {
    return ''
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`
}

function candidateConfigPaths() {
  const scriptDir = path.resolve(__dirname)
  const searchRoots = [path.resolve(process.cwd()), scriptDir, projectRoot]
  const candidatePaths = []
  const seen = new Set()
  const ignoredParts = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.venv', 'venv'])

  function addCandidate(candidatePath) {
    const resolvedPath = path.resolve(candidatePath)
    if (seen.has(resolvedPath)) {
      return
    }
    seen.add(resolvedPath)
    candidatePaths.push(resolvedPath)
  }

  function walk(rootPath) {
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    for (const entry of entries) {
      if (ignoredParts.has(entry.name)) {
        continue
      }

      const fullPath = path.join(rootPath, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }

      if (entry.name === 'qiniu.yaml') {
        addCandidate(fullPath)
      }
    }
  }

  for (const rootPath of searchRoots) {
    addCandidate(path.join(rootPath, 'qiniu.yaml'))
    addCandidate(path.join(rootPath, 'deploy_tools', 'qiniu.yaml'))
    addCandidate(path.join(rootPath, 'ai-skill-accesskey', 'qiniu.yaml'))
  }

  // 兄弟仓库查找：从每个 searchRoot 逐级向上，尝试 <上层目录>/ai-skill-accesskey/qiniu.yaml。
  // ai-skill-accesskey 常与本仓库（keepworksdk）平级 clone 在某个上层/盘符目录下，
  // 而调用方（如 silvermind 的 build-cdn-postprocess）会把 cwd 设为 keepworksdk/scripts，
  // 故需向上回溯才能命中 D:\ai-skill-accesskey 这类兄弟仓库位置。
  for (const rootPath of searchRoots) {
    let dir = rootPath
    for (let i = 0; i < 8; i += 1) {
      addCandidate(path.join(dir, 'ai-skill-accesskey', 'qiniu.yaml'))
      const parent = path.dirname(dir)
      if (parent === dir) {
        break
      }
      dir = parent
    }
  }

  for (const rootPath of searchRoots) {
    walk(rootPath)
  }

  return candidatePaths
}

function printDownloadInstructions() {
  const skillDir = path.resolve(projectRoot, '.github/skills/upload-deploy-cdn-files')
  console.error('提示：请按 SKILL.md 下载配置仓库，确保 qiniu.yaml 位于脚本同级目录或其 ai-skill-accesskey 子目录下。')
  console.error('Git 仓库: http://code.kp-para.cn/devops/ai-skill-accesskey.git')
  console.error('PowerShell 示例:')
  console.error(`  Set-Location "${skillDir}"`)
  console.error('  git clone http://code.kp-para.cn/devops/ai-skill-accesskey.git')
  console.error('Bash 示例:')
  console.error('  SKILL_DIR=$(dirname $(find . -name "SKILL.md" | grep "upload-deploy-cdn-files" | head -n 1))')
  console.error('  cd "$SKILL_DIR"')
  console.error('  git clone http://code.kp-para.cn/devops/ai-skill-accesskey.git')
  console.error('  cd -')
}

function extractQiniuConfig(config) {
  if (!config || typeof config !== 'object') {
    return null
  }

  const qiniuConfig = config.qiniu && typeof config.qiniu === 'object' ? config.qiniu : config
  const accessKey = qiniuConfig.accessKey || ''
  const secretKey = qiniuConfig.secretKey || ''

  if (!accessKey || !secretKey) {
    return null
  }

  return {
    accessKey,
    secretKey,
    bucketName: qiniuConfig.bucketName || bucketName,
    domain: (qiniuConfig.publicDomain || domain).replace(/\/+$/, ''),
    uploadHost: qiniuConfig.uploadHost || uploadHost,
    remotePrefix: normalizePrefix(qiniuConfig.remotePrefix || remotePrefix),
  }
}

function loadConfig() {
  const configPaths = candidateConfigPaths()

  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
      continue
    }

    try {
      const fileContent = fs.readFileSync(configPath, 'utf8')
      const parsedConfig = yaml.load(fileContent)
      const qiniuConfig = extractQiniuConfig(parsedConfig)
      if (!qiniuConfig) {
        continue
      }

      bucketName = qiniuConfig.bucketName
      domain = qiniuConfig.domain
      uploadHost = qiniuConfig.uploadHost
      remotePrefix = qiniuConfig.remotePrefix
      return qiniuConfig
    } catch (error) {
      console.warn(`跳过无法解析的配置文件: ${configPath}`)
    }
  }

  console.error('❌ 找不到可用的七牛配置，或其中缺少 accessKey / secretKey')
  console.error('已搜索以下位置:')
  for (const configPath of configPaths) {
    console.error(`  - ${configPath}`)
  }
  printDownloadInstructions()
  process.exit(2)
}

function formatSize(size) {
  if (size > 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }
  if (size > 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(2)} MB`
  }
  if (size > 1024) {
    return `${(size / 1024).toFixed(2)} KB`
  }
  return `${size} B`
}

function collectFiles(paths, prefix) {
  const entries = []

  for (const inputPath of paths) {
    const normalizedPath = path.normalize(inputPath)
    if (!fs.existsSync(normalizedPath)) {
      console.warn(`⚠️  路径不存在，已跳过: ${normalizedPath}`)
      continue
    }

    const stat = fs.statSync(normalizedPath)
    if (stat.isFile()) {
      entries.push({
        localPath: normalizedPath,
        remoteKey: `${prefix}${path.basename(normalizedPath)}`,
        size: stat.size,
      })
      continue
    }

    if (!stat.isDirectory()) {
      continue
    }

    const dirName = path.basename(normalizedPath)
    const stack = [normalizedPath]
    while (stack.length > 0) {
      const currentPath = stack.pop()
      const children = fs.readdirSync(currentPath, { withFileTypes: true })
      for (const child of children) {
        const fullPath = path.join(currentPath, child.name)
        if (child.isDirectory()) {
          stack.push(fullPath)
          continue
        }

        const childStat = fs.statSync(fullPath)
        const relativePath = path.relative(normalizedPath, fullPath).split(path.sep).join('/')
        entries.push({
          localPath: fullPath,
          remoteKey: `${prefix}${dirName}/${relativePath}`,
          size: childStat.size,
        })
      }
    }
  }

  return entries
}

function parseArgs(argv) {
  let prefixOverride = null
  const localPaths = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--prefix') {
      if (index + 1 >= argv.length) {
        console.error('❌ --prefix 需要一个参数，例如 --prefix sdk/')
        process.exit(1)
      }
      prefixOverride = normalizePrefix(argv[index + 1])
      index += 1
      continue
    }
    localPaths.push(arg)
  }

  return { prefixOverride, localPaths }
}

async function uploadFile(qiniuConfig, localPath, remoteKey) {
  const mac = new qiniu.auth.digest.Mac(qiniuConfig.accessKey, qiniuConfig.secretKey)
  const putPolicy = new qiniu.rs.PutPolicy({
    scope: `${qiniuConfig.bucketName}:${remoteKey}`,
    expires: 3600,
  })
  const uploadToken = putPolicy.uploadToken(mac)
  const uploadUrl = qiniuConfig.uploadHost || uploadHost
  const fileBuffer = await fs.promises.readFile(localPath)
  const formData = new FormData()

  formData.append('token', uploadToken)
  formData.append('key', remoteKey)
  formData.append('file', new Blob([fileBuffer]), path.basename(localPath))

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`上传失败 (${response.status}): ${errorBody}`)
  }

  return `${qiniuConfig.domain}/${remoteKey}`
}

async function refreshCdn(qiniuConfig, urls) {
  if (urls.length === 0) {
    return
  }

  const mac = new qiniu.auth.digest.Mac(qiniuConfig.accessKey, qiniuConfig.secretKey)
  const cdnManager = new qiniu.cdn.CdnManager(mac)

  for (let index = 0; index < urls.length; index += 100) {
    const chunk = urls.slice(index, index + 100)
    await new Promise((resolve, reject) => {
      cdnManager.refreshUrls(chunk, (error, responseBody, responseInfo) => {
        if (error) {
          reject(error)
          return
        }
        if (!responseInfo || responseInfo.statusCode !== 200) {
          reject(new Error(responseBody?.error || '刷新 CDN 缓存失败'))
          return
        }
        console.log(`  ✅ 成功提交刷新请求 (${chunk.length} 个 URL)`)
        resolve()
      })
    })
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || ['-h', '--help', 'help'].includes(argv[0])) {
    console.log('用法: node scripts/qiniuUploadLocalFiles.mjs [--prefix 前缀] <本地路径1> [本地路径2] ...')
    return
  }

  const { prefixOverride, localPaths } = parseArgs(argv)
  if (localPaths.length === 0) {
    console.error('❌ 请至少提供一个本地文件或目录路径。')
    process.exit(1)
  }

  const qiniuConfig = loadConfig()
  const finalPrefix = prefixOverride || remotePrefix
  const entries = collectFiles(localPaths, finalPrefix)

  if (entries.length === 0) {
    console.error('❌ 没有找到可上传的文件。')
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log('🚀 七牛云上传工具（Node）')
  console.log(`🎯 目标桶: ${qiniuConfig.bucketName}`)
  console.log(`📂 远程目录: ${finalPrefix}`)
  console.log(`📄 共计 ${entries.length} 个文件`)
  console.log('='.repeat(60))

  const success = []
  const failed = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    console.log(`\n[${index + 1}/${entries.length}] ${entry.localPath}`)
    console.log(`  -> ${entry.remoteKey}  (${formatSize(entry.size)})`)
    try {
      const cdnUrl = await uploadFile(qiniuConfig, entry.localPath, entry.remoteKey)
      success.push({ localPath: entry.localPath, cdnUrl })
      console.log(`  ✅ ${cdnUrl}`)
    } catch (error) {
      failed.push(entry.localPath)
      console.error(`  ❌ ${error.message}`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log('📊 上传结果汇总')
  console.log(`  ✅ 成功: ${success.length} 个`)
  if (failed.length > 0) {
    console.log(`  ❌ 失败: ${failed.length} 个`)
  }
  console.log('='.repeat(60))

  if (success.length > 0) {
    console.log('\n🔗 CDN 外网链接:')
    const urls = success.map(item => item.cdnUrl)
    for (const url of urls) {
      console.log(`  ${url}`)
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log('🔄 正在刷新 CDN 缓存...')
    try {
      await refreshCdn(qiniuConfig, urls)
    } catch (error) {
      console.error(`  ❌ 刷新 CDN 缓存时发生异常: ${error.message}`)
    }
  }

  if (failed.length > 0) {
    console.error('\n❌ 上传失败的文件:')
    for (const failedPath of failed) {
      console.error(`  ${failedPath}`)
    }
    process.exit(1)
  }
}

main().catch(error => {
  console.error(`❌ 执行失败: ${error.message}`)
  process.exit(1)
})