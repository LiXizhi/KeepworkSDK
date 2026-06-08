---
name: upload-deploy-cdn-files
description: 上传 keepworkSDK 构建产物或本地文件/目录到七牛 CDN (cdn.keepwork.com)
---

# 上传文件到七牛 CDN

## 触发关键词

匹配以下任一关键词时立即执行本技能：

| 关键词 | 动作 |
|--------|------|
| **上传keepworksdk** / **上传keepworkSDK** | **快捷指令**：直接执行下方「快捷命令」，无需额外确认 |
| 上传到七牛 / 上传文件到CDN / deploy to CDN / upload to CDN | 通用上传：需从用户消息中提取要上传的本地路径 |

---

## 快捷命令（上传 keepworkSDK 构建产物）

当用户说 **"上传keepworksdk"** 时，**不需要询问任何参数**，直接在终端执行：

```bash
npm run upload
```

这等价于运行 `node scripts/uploadKeepworkSDK.mjs`，它会自动：
1. 执行 `npm run localDeploy`（build + 拷贝到 `../resource/`）
2. 优先调用 `python .github/skills/upload-deploy-cdn-files/qiniu_upload_local_files.py --prefix sdk/` 上传全部 7 个文件；如果本地 Python 环境不可用，再改用 `node scripts/qiniuUploadLocalFiles.mjs --prefix sdk/`

如果只需上传（跳过构建），可传 `--no-build`：

```bash
node scripts/uploadKeepworkSDK.mjs --no-build
```

`npm run build` 会依次构建三个包：

| 产物文件 | 说明 |
|----------|------|
| `keepworkSDK.iife.js` (+.map) | **全量包**（向后兼容），包含 core + AIChat 所有模块 |
| `keepworkSDK.core.iife.js` (+.map) | **核心包**，不含 AIChat / DigitalHuman 等 AI 模块 |
| `keepworkSDK.AIChat.iife.js` (+.map) | **AIChat 扩展包**，依赖 core，可按需延迟加载 |
| `DigitalHumanFrame.html` | **数字人 iframe 宿主页** |

`localDeploy` 会先 build，再把 7 个文件拷贝到 `../resource/`。

上传到 `sdk/` 前缀下后，生成的链接形如：

```text
https://cdn.keepwork.com/sdk/keepworkSDK.iife.js
https://cdn.keepwork.com/sdk/keepworkSDK.iife.js.map
https://cdn.keepwork.com/sdk/keepworkSDK.core.iife.js
https://cdn.keepwork.com/sdk/keepworkSDK.core.iife.js.map
https://cdn.keepwork.com/sdk/keepworkSDK.AIChat.iife.js
https://cdn.keepwork.com/sdk/keepworkSDK.AIChat.iife.js.map
https://cdn.keepwork.com/sdk/DigitalHumanFrame.html
```

上传成功后会输出 CDN 链接，将链接告知用户即可。

---

## 通用上传（任意文件/目录）

当用户指定了其他本地路径时，用以下命令格式：

```bash
python .github/skills/upload-deploy-cdn-files/qiniu_upload_local_files.py <路径1> [路径2] ...
```

如果本地 Python 环境不可用，再改用：

```bash
node scripts/qiniuUploadLocalFiles.mjs <路径1> [路径2] ...
```

- 支持文件和目录，目录会递归上传并保留结构。
- 普通文件默认上传到远程前缀 `keepwork/cdn/`，生成的 CDN 地址格式为：
  `https://cdn.keepwork.com/keepwork/cdn/<文件名或相对路径>`
- 如需其他前缀，可通过参数传入：`--prefix <前缀>`，例如 `--prefix sdk/`。
- 凭证只搜索现有的 `qiniu.yaml`；若未找到，再提示用户从 `ai-skill-accesskey` 仓库拉取配置（详见后续步骤）。缺少 `accessKey` / `secretKey` 时上传必须失败，不能改用其他配置文件静默成功。

---

## 依赖

Python 脚本依赖 `qiniu` 和 `pyyaml`，如首次运行报错缺包，先执行：

```bash
pip install qiniu pyyaml
```

如果改走 Node 兜底脚本，则依赖 `qiniu` 和 `js-yaml`，先执行：

```bash
npm install
```

## AI 执行步骤

1. **判断场景**：如果匹配「上传keepworksdk」→ 直接执行 `npm run upload`；否则从用户消息提取要上传的本地路径。
2. **检查并获取配置**：
  - 先搜索现有的 `qiniu.yaml`。优先检查当前工作目录、SKILL 所在目录、仓库内常见位置，以及它们下面的同名文件。
  - 不要使用 `config.yaml` 作为上传凭证来源；缺少 `qiniu.yaml` 或缺少 `accessKey` / `secretKey` 时应让上传失败，并提示按下方步骤下载配置仓库。
  - 如果检测到配置文件缺失或首次运行，Python 上传脚本会自动尝试在本 SKILL 同级目录下 clone `ai-skill-accesskey` 仓库；如果自动 clone 失败，再按下方命令手动获取配置：
   - 请**提示用户**：需要从 `http://code.kp-para.cn/devops/ai-skill-accesskey.git` 这个 gitlab 仓库把配置文件 clone 下来，并说明**克隆时可能需要在终端输入 gitlab 的用户名和密码**。
   - 用户输入完成后，获取的仓库默认存放在与本 SKILL 相同的目录下。提供给用户的克隆命令（命令先获取本地 SKILL.md 的目录，然后切换到该目录下，拉取 ai-skill-accesskey.git 仓库）：
     ```bash
     SKILL_DIR=$(dirname $(find . -name "SKILL.md" | grep "upload-deploy-cdn-files" | head -n 1))
     cd "$SKILL_DIR"
     git clone http://code.kp-para.cn/devops/ai-skill-accesskey.git
     cd -
     ```
3. **在终端运行**命令：上传 keepworkSDK 构建产物时，运行 `npm run upload`（等价于 `node scripts/uploadKeepworkSDK.mjs`，会自动 build + localDeploy + 上传 7 个文件）。其他场景直接运行上传命令；若需要自定义远程目录，可显式传入 `--prefix <前缀>`（从工作区根目录执行）。
4. **读取输出**，将 CDN 链接汇报给用户。
5. **缓存刷新**：脚本在上传完成后，会自动调用七牛云接口对新上传的链接进行 CDN 缓存刷新。