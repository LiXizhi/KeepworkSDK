/**
 * GitLab → GitHub 脱敏快照同步工具
 *
 * 把当前仓库工作树（不含 git 历史）脱敏后，作为单一提交强推到目标 GitHub 仓库。
 * 流程：复制源工作树到临时目录 → 排除密钥文件 → 替换硬编码真密钥为占位符 →
 *      防泄漏断言 → 覆盖目标工作树 → 单一 commit 强推。
 *
 * 用法:
 *   node scripts/syncToGithub.mjs                 # 正式同步（脱敏 + 覆盖 + commit + push -f）
 *   node scripts/syncToGithub.mjs --dry-run       # 仅脱敏到临时目录并打印报告，不改目标仓库、不推送
 *   node scripts/syncToGithub.mjs --no-push       # 脱敏 + 覆盖目标工作树 + commit，但不 push（留给人工 push）
 *   node scripts/syncToGithub.mjs --target=<dir>  # 覆盖目标仓库本地路径
 *   node scripts/syncToGithub.mjs --branch=<name> # 覆盖目标分支（默认 main）
 *
 * 设计约束：
 * - 源仓库（cwd）零改动，所有脱敏在临时目录进行。
 * - 真密钥文件整体排除；源码/测试里的硬编码真密钥替换为占位符（双保险）。
 * - push 前对临时目录做密钥防泄漏扫描，命中任一已知真密钥即终止。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SOURCE_ROOT = path.resolve(__dirname, '..')

// ── CLI 参数 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const NO_PUSH = argv.includes('--no-push')
function getArgValue(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : fallback
}
const TARGET_REPO = path.resolve(getArgValue('--target', 'D:\\LiXizhi\\KeepworkSDK'))
const BRANCH = getArgValue('--branch', 'main')

// ── 配置区 ─────────────────────────────────────────────────────────────────

// 整体排除：不复制到目标仓库（密钥文件 / 构建产物 / 本地仓库元数据）。
// 以「相对源根的路径前缀」匹配（用 / 分隔，跨平台统一）。
const EXCLUDE_PATHS = [
  '.git',
  'node_modules',
  'dist',
  'dist-npm',
  'models',
  'ai-skill-accesskey',
  '__pycache__',
  'deploy_tools',          // 含明文七牛密钥的旧 CDN 上传工具（密钥已由 ai-skill-accesskey 托管）
  '.env',
  '.env.local',
]
// 额外按精确文件名排除（任意层级）
const EXCLUDE_FILENAMES = [
  '.env',
]
// 按后缀排除（任意层级）：.env.* 本地变体
function isExcludedByPattern(relPath) {
  const base = path.basename(relPath)
  if (base === '.env') return true
  if (base.startsWith('.env.') && base.endsWith('.local')) return true
  if (base === '.env.local') return true
  return false
}

// 仅对这些后缀的文本文件做内容脱敏扫描（避免误改二进制 / 大模型文件）。
const SCAN_EXT = new Set(['.html', '.mjs', '.js', '.ts', '.tsx', '.json', '.yaml', '.yml', '.md', '.txt', '.vue', '.css'])

// 脱敏规则：把已知真密钥字面量替换为占位符（双保险——源码理论上已改为变量引用，
// 但若有遗漏，这里兜底）。
//
// 真密钥值本身**不硬编码在本脚本里**（否则脚本会被推到 GitHub 暴露密钥，也会被自身脱敏
// 而丧失检测能力）。改为从环境变量 / 本地 .env 读取，再加上 ai-skill-accesskey 仓库的
// qiniu.yaml（与源 .env 同源）。.env 已 .gitignore，不进 Git。
//
// 基于「密钥格式」的兜底脱敏规则：不依赖具体值，按常见 API key 前缀/结构匹配。
// 覆盖 GitHub Push Protection 会拦截的常见类型，避免再次被远端拒绝。
const FORMAT_RULES = [
  // OpenRouter: sk-or-v1-<64 hex>
  { name: 'OPENROUTER_API_KEY', pattern: /sk-or-v1-[0-9a-f]{32,}/g, replace: 'YOUR_OPENROUTER_API_KEY' },
  // OpenAI 项目/用户 key: sk-proj-... 或 sk-<20+ 字符>（排除已被上一条处理的 sk-or-）
  { name: 'OPENAI_API_KEY', pattern: /sk-(?:proj-)?(?!or-)[A-Za-z0-9_-]{20,}/g, replace: 'YOUR_OPENAI_API_KEY' },
  // Anthropic: sk-ant-...
  { name: 'ANTHROPIC_API_KEY', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: 'YOUR_ANTHROPIC_API_KEY' },
]

const SANITIZE_RULES = buildSanitizeRules()

function buildSanitizeRules() {
  loadDotEnvIntoProcess()
  const qiniu = loadQiniuSecrets()
  const raw = [
    { name: 'VOLC_ACCESS_TOKEN', value: process.env.VOLC_ACCESS_TOKEN, replace: 'YOUR_VOLC_ACCESS_TOKEN' },
    { name: 'QINIU_ACCESS_KEY', value: qiniu.accessKey, replace: 'YOUR_QINIU_ACCESS_KEY' },
    { name: 'QINIU_SECRET_KEY', value: qiniu.secretKey, replace: 'YOUR_QINIU_SECRET_KEY' },
    { name: 'MAISI_API_KEY', value: process.env.MAISI_API_KEY, replace: 'YOUR_MAISI_API_KEY' },
  ]
  const rules = []
  for (const r of raw) {
    if (r.value && r.value.trim().length >= 8) {
      const escaped = r.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      rules.push({ name: r.name, pattern: new RegExp(escaped, 'g'), replace: r.replace })
    }
  }
  // 追加基于格式的兜底规则（即使未在 .env 配置，也能拦住硬编码的 key）。
  rules.push(...FORMAT_RULES)
  return rules
}

// 轻量读取源根 .env，仅填充未设置的 process.env 键。
function loadDotEnvIntoProcess() {
  try {
    const envPath = path.join(SOURCE_ROOT, '.env')
    if (!fs.existsSync(envPath)) return
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
      if (!(key in process.env)) process.env[key] = val
    }
  } catch { /* ignore */ }
}

// 从 ai-skill-accesskey 仓库的 qiniu.yaml 读取七牛密钥（向上回溯查找）。
function loadQiniuSecrets() {
  const candidates = []
  let dir = SOURCE_ROOT
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(dir, 'ai-skill-accesskey', 'qiniu.yaml'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push(path.join(SOURCE_ROOT, 'deploy_tools', 'config.yaml')) // 兼容旧位置（若还在）
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const text = fs.readFileSync(p, 'utf8')
      const ak = (text.match(/accessKey\s*:\s*(.+)/) || [])[1]
      const sk = (text.match(/secretKey\s*:\s*(.+)/) || [])[1]
      if (ak && sk) {
        return { accessKey: ak.trim().replace(/^['"]|['"]$/g, ''), secretKey: sk.trim().replace(/^['"]|['"]$/g, '') }
      }
    } catch { /* ignore */ }
  }
  return { accessKey: '', secretKey: '' }
}

// push 前防泄漏断言：临时目录中若仍命中任一真密钥即终止。
const LEAK_PATTERNS = SANITIZE_RULES.map((r) => ({ name: r.name, pattern: new RegExp(r.pattern.source) }))

// ── 工具函数 ───────────────────────────────────────────────────────────────

function log(msg) { console.log(msg) }
function fail(msg) { console.error(`\n❌ ${msg}`); process.exit(1) }

function relToPosix(absPath, root) {
  return path.relative(root, absPath).split(path.sep).join('/')
}

function isExcluded(relPosix) {
  for (const ex of EXCLUDE_PATHS) {
    if (relPosix === ex || relPosix.startsWith(`${ex}/`)) return true
  }
  if (EXCLUDE_FILENAMES.includes(path.basename(relPosix))) return true
  if (isExcludedByPattern(relPosix)) return true
  return false
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// 递归复制源工作树到临时目录，跳过排除项。
function copyTree(srcRoot, destRoot) {
  const copied = []
  const excluded = []
  function walk(curr) {
    const entries = fs.readdirSync(curr, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(curr, entry.name)
      const rel = relToPosix(abs, srcRoot)
      if (isExcluded(rel)) { excluded.push(rel); continue }
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.isFile()) {
        const destPath = path.join(destRoot, rel)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.copyFileSync(abs, destPath)
        copied.push(rel)
      }
    }
  }
  walk(srcRoot)
  return { copied, excluded }
}

// 对临时目录的文本文件应用脱敏规则，返回命中明细。
function sanitizeTree(root) {
  const hits = []
  function walk(curr) {
    for (const entry of fs.readdirSync(curr, { withFileTypes: true })) {
      const abs = path.join(curr, entry.name)
      if (entry.isDirectory()) { walk(abs); continue }
      if (!entry.isFile()) continue
      if (!SCAN_EXT.has(path.extname(entry.name).toLowerCase())) continue
      let content = fs.readFileSync(abs, 'utf8')
      let changed = false
      for (const rule of SANITIZE_RULES) {
        const matches = content.match(rule.pattern)
        if (matches && matches.length > 0) {
          content = content.replace(rule.pattern, rule.replace)
          hits.push({ file: relToPosix(abs, root), rule: rule.name, count: matches.length })
          changed = true
        }
      }
      if (changed) fs.writeFileSync(abs, content, 'utf8')
    }
  }
  walk(root)
  return hits
}

// 防泄漏扫描：返回仍含真密钥的命中列表（应为空）。
function scanLeaks(root) {
  const leaks = []
  function walk(curr) {
    for (const entry of fs.readdirSync(curr, { withFileTypes: true })) {
      const abs = path.join(curr, entry.name)
      if (entry.isDirectory()) { walk(abs); continue }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      // 扫描所有文本类文件 + 无后缀文件，跳过明显二进制
      if (ext && !SCAN_EXT.has(ext) && ext !== '') {
        // 仍尝试读取小文件，避免漏网；大文件跳过
        try { if (fs.statSync(abs).size > 5 * 1024 * 1024) continue } catch { continue }
      }
      let content
      try { content = fs.readFileSync(abs, 'utf8') } catch { continue }
      for (const lp of LEAK_PATTERNS) {
        if (lp.pattern.test(content)) leaks.push({ file: relToPosix(abs, root), rule: lp.name })
      }
    }
  }
  walk(root)
  return leaks
}

// 清空目标仓库工作树（保留 .git）。
function clearWorktree(repoRoot) {
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    fs.rmSync(path.join(repoRoot, entry.name), { recursive: true, force: true })
  }
}

// 把临时目录内容复制进目标工作树。
function copyInto(srcRoot, destRoot) {
  let count = 0
  function walk(curr) {
    for (const entry of fs.readdirSync(curr, { withFileTypes: true })) {
      const abs = path.join(curr, entry.name)
      const rel = relToPosix(abs, srcRoot)
      if (entry.isDirectory()) { walk(abs); continue }
      if (!entry.isFile()) continue
      const destPath = path.join(destRoot, rel)
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.copyFileSync(abs, destPath)
      count += 1
    }
  }
  walk(srcRoot)
  return count
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  log('=== GitLab → GitHub 脱敏快照同步 ===')
  log(`源仓库:   ${SOURCE_ROOT}`)
  log(`目标仓库: ${TARGET_REPO}`)
  log(`分支:     ${BRANCH}`)
  log(`模式:     ${DRY_RUN ? 'DRY-RUN（不改目标、不推送）' : NO_PUSH ? 'NO-PUSH（覆盖+commit，不推送）' : '正式同步（覆盖+commit+push -f）'}`)

  // 1. 前置检查（dry-run 跳过目标仓库校验）
  if (!DRY_RUN) {
    if (!fs.existsSync(path.join(TARGET_REPO, '.git'))) {
      fail(`目标不是 git 仓库（缺少 .git）: ${TARGET_REPO}`)
    }
    let originUrl = ''
    try { originUrl = git(['remote', 'get-url', 'origin'], TARGET_REPO) } catch { /* no origin */ }
    log(`目标 origin: ${originUrl || '(未配置)'}`)
    if (!/github\.com/i.test(originUrl)) {
      fail(`目标 origin 不是 GitHub 仓库，已终止以防误推: ${originUrl}`)
    }
  }

  // 2. 创建临时目录
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwsdk-sync-'))
  log(`\n临时目录: ${tmpRoot}`)

  try {
    // 3. 复制源工作树（跳过排除项）
    const { copied, excluded } = copyTree(SOURCE_ROOT, tmpRoot)
    log(`\n已复制 ${copied.length} 个文件，排除 ${excluded.length} 个路径。`)

    // 4. 脱敏
    const hits = sanitizeTree(tmpRoot)
    log(`\n── 脱敏命中（${hits.length} 处）──`)
    if (hits.length === 0) {
      log('  (无命中——源码应已用变量引用，符合预期)')
    } else {
      for (const h of hits) log(`  ${h.rule}  ×${h.count}  ${h.file}`)
    }

    // 5. 防泄漏断言
    const leaks = scanLeaks(tmpRoot)
    if (leaks.length > 0) {
      log('\n🚨 防泄漏扫描发现残留真密钥：')
      for (const l of leaks) log(`  ${l.rule}  ${l.file}`)
      fail('临时目录仍含真密钥，已终止。请更新 SANITIZE_RULES 或排除清单后重试。')
    }
    log('\n✅ 防泄漏扫描通过：临时目录无已知真密钥。')

    // 报告被排除的关键文件（仅展示前若干个非常规排除项）
    const notableExcluded = excluded.filter((p) => !/^(node_modules|dist|dist-npm|models|__pycache__|\.git)(\/|$)/.test(p))
    if (notableExcluded.length > 0) {
      log('\n── 已排除（密钥/工具类，非常规构建目录）──')
      for (const p of notableExcluded.slice(0, 50)) log(`  ${p}`)
    }

    if (DRY_RUN) {
      log(`\n[DRY-RUN] 脱敏后的内容保留在: ${tmpRoot}`)
      log('[DRY-RUN] 未改动目标仓库，未推送。检查无误后去掉 --dry-run 重新执行。')
      return // 保留临时目录供检查
    }

    // 6. 覆盖目标工作树
    log(`\n清空目标工作树（保留 .git）: ${TARGET_REPO}`)
    clearWorktree(TARGET_REPO)
    const written = copyInto(tmpRoot, TARGET_REPO)
    log(`已写入 ${written} 个文件到目标工作树。`)

    // 7-8. 以 orphan 单一 commit 重建目标分支：丢弃所有旧历史（含可能残留密钥的旧 commit），
    // 确保 GitHub 上永远只有一个不含任何旧密钥历史的快照提交。
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    let committed = true
    const tmpBranch = `__sync_orphan_${Date.now()}`
    try {
      // 切到全新孤儿分支（无父提交），暂存全部内容并提交
      git(['checkout', '--orphan', tmpBranch], TARGET_REPO)
      git(['add', '-A'], TARGET_REPO)
      git(['commit', '-m', `sync: sanitized snapshot from GitLab (${stamp})`], TARGET_REPO)
      // 用孤儿分支替换目标分支（删除旧分支与其历史），并切回目标分支名
      try { git(['branch', '-D', BRANCH], TARGET_REPO) } catch { /* 目标分支可能不存在 */ }
      git(['branch', '-m', BRANCH], TARGET_REPO)
      // 清理残留的悬空对象（旧含密钥 commit），尽量减少本地泄漏面
      try { git(['reflog', 'expire', '--expire=now', '--all'], TARGET_REPO) } catch { /* ignore */ }
      try { git(['gc', '--prune=now'], TARGET_REPO) } catch { /* ignore */ }
    } catch (e) {
      committed = false
      log(`(orphan 重建提交失败: ${e.message.split('\n')[0]})`)
    }

    if (NO_PUSH) {
      log(`\n[NO-PUSH] 已${committed ? '提交' : '处理'}，未推送。可手动执行: git -C "${TARGET_REPO}" push -f origin ${BRANCH}`)
      return
    }

    // 9. 强推
    log(`\n推送到 origin/${BRANCH}（强推）...`)
    git(['push', '-f', 'origin', BRANCH], TARGET_REPO)
    log('✅ 推送完成。')
    log(`\n请到 GitHub 网页核对无密钥: ${git(['remote', 'get-url', 'origin'], TARGET_REPO)}`)
  } finally {
    // dry-run 保留临时目录；其余清理
    if (!DRY_RUN) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

main()
