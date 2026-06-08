# KeepworkSDK Phase 9 接力计划（交给新 session）

> ✅ **Phase 9 已完成（src/ 已全量 TypeScript 化，零 .js 运行时文件）。** 本文件作为历史记录保留。
>
> 本文件用于把 KeepworkSDK 的 TypeScript 全量重构「Phase 9（薄封装文件完整 TS 化）」
> 剩余工作交接给新的对话 session，避免超长上下文。
> **最终目标：SDK 源码（src/）全部真正完整 TS 化，删除所有 .js 运行时文件，
> 同时保证构建产物与重构前功能完全一致。**
> 如需对比重构前产物，可查看 `D:\keepwork-nuxt\public\public\keepworkSDK`，这里是 TS 重构前的 keepworkSDK 源码

> ### ✅ 完成状态（最终）
> - `src/` 下 **0 个 .js**（全部 26 个剩余 .js 删除，导入改为无扩展名，3 个不完整 .ts 补全：
>   `window.NPL`(NPL.ts)、`RemoteLog.extractMainDomain`、`AIGenerators._openRouterJobIdFromTaskId`）。
> - `tsconfig`：移除 `src/**/*.js` include + 关闭 `allowJs`。
> - 验证：`tsc --noEmit` 0 错误；3 个 IIFE bundle 构建成功；
>   与重构前基线 **API 表面完全一致**（globals 38=38，所有类原型链方法/静态成员公开表面零差异，
>   仅 `KeepworkSDK._initCore`/`_API_BASE_URL` 等 `_` 私有项差异属正常）；
>   运行时 new 各类（DigitalHuman/AIChatRTC/PersonalPageStore/RemoteLog/AIGenerators…）无 ReferenceError。
> - DigitalHuman(7656行)/DigitalHumanFrame 见 commit c45223d/8aa4f00。
> - ⚠️ 关键发现：Vite 默认解析顺序 .js 先于 .ts，故无扩展名 import 在 .js 未删时仍走 .js；
>   "去 js" 必须删 .js 后用【原型链感知 + 含私有】的 API 对比验证（只看 own-props 会误判继承类丢方法）。

---

## 0. 背景与总目标

- KeepworkSDK 是浏览器端 TS SDK（strict 全开、禁用 any），Vite 打成 3 个 IIFE bundle。
- 重构原则：`strict: true` + `noImplicitAny`；难处理处用 `unknown`/泛型/类型断言，**不用 any**。
- 构建产物（`window.*` 全局、`window.keepwork` 方法、各类公开方法）必须与重构前**完全一致**。
- Phase 0-8 已完成（基础设施 + 大部分模块真正 TS 化 + 入口统一 .ts + 文档更新），已提交推送。
- Phase 9 是收尾：把剩下的「薄封装」文件（`.ts` 仅做类型桥接、`.js` 仍是真实现）逐个真正 TS 化。

---

## 1. 本次 session 已完成（Phase 9 批 1 / 批 2 / 批 3a）

当前 git HEAD：`e8490c7`（已推送 origin/master）。分支 `master`。

已真正 TS 化（删除 .js，实现迁入 .ts，并经构建产物 API 对比验证「IDENTICAL」）：

**批 1（commit 2fe4576）：**
- `AgentConfig.ts` — 配置读取器（JSON/YAML/MD/表格解析）
- `translation.ts` — i18n（注意 `t()` 是原型方法 + 构造里 `(this as {t}).t = this.t.bind(this)`，保持原 JS 原型表面）
- `VerifyHuman.ts` — 滑块验证码（`cleanup` 用 `let` 因要重新赋值）
- `WxLaunchApp.ts` — 微信打开 App（`loadWxSDK()` 返回 `undefined` 要 `?? null`）
- `WxAuth.ts` — 微信 OAuth2（补了 SDKLogger；sdk 用结构化接口）
- **额外清理**：删除 keepworkSDK 死文件 `keepworkSDK.js/.core.js/.pages.js/.utils.js`
  （真实现早在 `keepworkSDK.ts/.core.ts/.pages.ts/.utils.ts`，旧 .js 是残留）。

**批 2（commit 3d9f2d2）：**
- `CloudDrive.ts` — 七牛 CDN 文件管理（13 方法 IDENTICAL）
- `UserWorks.ts` — STEAM 作品（46 方法 + 静态 Status IDENTICAL）
- `SocialFriends.ts` — 好友/私聊/站内信（85 方法 + 静态枚举 IDENTICAL；限流+缓存逻辑保留）

**批 3a（commit e8490c7）：**
- `ProfileWindow.ts` — 用户资料弹窗 UI（957 行；原型方法 IDENTICAL(15)）

---

## 2. Phase 9 剩余待办（新 session 要做的）

按以下顺序逐个完成，**每个文件单独完成 + 验证 + 提交推送**（不要一次堆太多）。

### 批 3 剩余（大型 UI 文件，方法同 ProfileWindow 的转换法）
- [ ] `WorkspaceViewer.js`（1506 行）→ `WorkspaceViewer.ts`
  - 注意：它有命名导出 `createWorkspaceViewer` + 类 `WorkspaceViewer`；基于 Shadow DOM 的文件树。
  - 当前 `WorkspaceViewer.ts` 是薄封装（要删掉重写）；入口 `index.ts` 用 `import { WorkspaceViewer, createWorkspaceViewer } from './src/WorkspaceViewer'`。
- [ ] `LocalAPIKeySettings.js`（1563 行）→ `LocalAPIKeySettings.ts`
  - model/apikey 管理 + 设置弹窗 UI；方法很多（setModel/resolve/detectProvider/抽象名映射等）。
- [ ] `LoginWindow.js`（1766 行）→ `LoginWindow.ts`
  - 登录弹窗 + 微信扫码/网页授权 + Google OAuth 多视图。内部 import `./VerifyHuman`、`./WxAuth`（已是 .ts，无扩展名 import 已就绪）。

### 批 4（音频/RTC 层 — 这些是「拆分文件组」，每组有多个 .js + 1 个薄封装 .ts）
> ⚠️ 重要：这些 .js 是 Phase 5 拆分产物，内部相互 import（带 `.js` 扩展名）。
> TS 化时要把**整组**一起转：每个 .js → .ts，组内 import 改无扩展名，删掉薄封装 .ts 重写为真实现/组合层。
> ⚠️ 教训（Phase 8 踩过坑）：拆分文件之间「使用了但未跨文件 import 的符号」build 不报错、只在浏览器运行时 ReferenceError。
> 所以这几组**必须浏览器运行时验证**（new 实例 + createSession + 调用关键方法），不能只看 build。

- [ ] **AudioEngine 组**：`AudioEngine.utils.js`(324) + `AudioEngine.js`(1084) + 薄封装 `AudioEngine.ts`
- [ ] **SpeechRTC 组**：`SpeechRTC.transport.js`(880) + `SpeechRTC.js`(707) + 薄封装 `SpeechRTC.ts`
- [ ] **AIChatRTC 组**：`AIChatRTC.constants.js`(139) + `AIChatRTC.session.js`(1305) + `AIChatRTC.js`(112) + 薄封装 `AIChatRTC.ts`
- [ ] **AIChatRTCLocal 组**：`AIChatRTCLocal.backends.js`(2227) + `.core.js`(246) + `.session.js`(1048) + `.js`(11 入口) + 薄封装 `AIChatRTCLocal.ts`

### 批 5（DigitalHuman 系列 — 最大）
- [ ] `DigitalHumanFrame.js`(1567) → `DigitalHumanFrame.ts`（iframe 镜像 DigitalHuman API）
- [ ] `DigitalHuman.js`(6800) → `DigitalHuman.ts`（**最大文件**，6800 行；含 213 个原型方法；
  事件 on/off/emit 经 getter + EventEmitterMixin；内部已 import 5 个已 TS 化的 DigitalHuman 工具文件，无扩展名）
  - 建议：先考虑是否需要按功能拆成多个 .ts（avatar 渲染 / 会话 / 语音 / 远程控制），再逐块 TS 化；
    或先整体改名 + 逐方法加类型（与 ProfileWindow 同法，但量大很多）。

> 注：`Speech.ts`、`LocalRTC.ts`、DigitalHuman 的 5 个工具文件（Utils/Bridge/Config/FrameMessages/SubtitleOverlay）
> 已是完整 TS，**无需处理**。

---

## 3. 单个文件 TS 化的标准流程（已验证可行，务必遵循）

### A. 普通 class / 模块文件（如批 3 的大 UI 文件）
1. `Copy-Item src\X.js src\X.ts` 然后 `Remove-Item src\X.js`（保留全部内容：CSS/HTML/TRANSLATIONS/逻辑原样）。
   - 若已有薄封装 `X.ts`，先 `Remove-Item src\X.ts` 再复制改名。
2. 在 `.ts` 上**原地加类型**（不要重写整个文件，避免改错大段字符串常量）：
   - class 头：`class X {` → `export default class X {`（若原 export 在末尾，删掉末尾的 `export default X;` 避免重复 default）
   - 加 class 字段声明（在 constructor 之前列出所有 `this.xxx` 字段及类型）
   - `constructor(sdk) {` → `constructor(sdk: unknown) {`，内部 `this.sdk = sdk as XSdk`
   - 方法签名加参数/返回类型；私有方法（`_` 开头）加 `private`
   - `querySelector(...)` 返回断言为具体元素类型（如 `as HTMLInputElement | null` / `as HTMLElement`）
   - `q(sel)` helper 显式标注返回类型
   - `catch (err)` → err 是 unknown，用 `(err as Error)?.message`；`catch (_)` → `catch`
   - `navigator.userLanguage` → `(navigator as Navigator & { userLanguage?: string }).userLanguage`
   - sdk 调用：定义结构化接口 `interface XSdk { get(...): Promise<unknown>; post(...): ...; ... }`
   - 松散对象参数用 `Record<string, unknown>`，访问属性时按需 `as string` 等断言
   - 大段字符串常量加类型：`const STYLES: string = \`...\``
3. **不修改任何运行时逻辑**，只加类型。SDKLogger console 遮蔽行保持（若原文件有）。
4. 改所有引用该文件的地方：grep `from './X.js'` 和 `import('./X.js')`，改为无扩展名 `./X`
   （含 .js 文件里的 JSDoc `@param {import('./X.js').default}`）。
5. `npx tsc --noEmit 2>&1 | Select-String "X.ts"` 逐个修类型错误，直到 0 错误。

### B. 拆分文件组（批 4 / 批 5）
- 整组一起转：组内每个 .js → .ts，组内 `import ... from './Y.js'` 改为 `./Y`。
- 薄封装 `.ts`（如 `AudioEngine.ts`）删掉，改成：要么把主类实现迁进去，要么作为「组合层/re-export 入口」。
  - 参考已完成的 `AIChat.ts`（组合 AIChat.core.ts + AIChat.session.ts）、`AIGenerators.ts` 模式。
- ⚠️ 跨文件符号：确保每个 .ts 用到的常量/函数/类都在本文件定义或正确 import（Phase 8 踩坑点）。

---

## 4. 每个文件/每批完成后的验证（必做，缺一不可）

1. **类型检查**：`npx tsc --noEmit`（必须 0 错误）。
2. **检查死文件复活**：本 session 发现 `keepworkSDK.js` 会被某机制（疑似 VS Code 还原）反复重建。
   每次 build 前执行：`if (Test-Path src\keepworkSDK.js) { Remove-Item src\keepworkSDK.js -Force }`。
   （根因：旧 .js 已删但偶尔复活；它 import 已删的文件会导致 tsc/build 报错。）
3. **构建**：`npm run build`（三个 IIFE bundle 必须全部成功）。
4. **构建产物 API 对比（关键！确保功能等价）**：
   - 重构前源码在 `D:\keepwork-nuxt\public\public\keepworkSDK`（纯 JS，git HEAD 6108ac57）。
   - 生成重构前基线 dist（一次性，可复用）：
     ```
     cd "D:\keepwork-nuxt\public\public\keepworkSDK"
     cmd /c mklink /J node_modules "D:\keepworksdk\node_modules"   # junction 复用依赖
     npx vite build --config vite.keepworkSDK.config.js            # 生成 dist/keepworkSDK.iife.js (~863KB)
     ```
   - 把基线复制到工作区供 dev server 访问：
     ```
     cd d:\keepworksdk
     New-Item -ItemType Directory -Force -Path "dist_before" | Out-Null
     Copy-Item "D:\keepwork-nuxt\public\public\keepworkSDK\dist\keepworkSDK.iife.js" "dist_before\keepworkSDK.iife.js" -Force
     ```
   - `npm run dev`（端口 3001），用浏览器打开 `http://localhost:3001/test/testKeepworkSDK.html`。
   - 用 Playwright/浏览器在两个隐藏 iframe 里分别 import `/dist_before/...?v=时间戳` 和 `/dist/...?v=时间戳`
     （**务必加 `?v=Date.now()` 时间戳绕过缓存**），提取并 diff：
     - `window.*` 全局列表（应 37 个 IDENTICAL）
     - `keepwork` 原型方法
     - 本批改动的类的 `prototype` 方法名 + 静态成员名
   - 对比结果应为 IDENTICAL，或仅有 `_` 开头的私有项差异（属正常实现细节）。
   - 对批 4/5（音频/RTC/DigitalHuman），额外做**运行时实例化验证**：
     `new AudioEngine.getShared()` / `new SpeechRTC(sdk)` / `new AIChatRTC(sdk).createSession(...)` /
     `new AIChatRTCLocal(sdk).createSession(...)` / `new DigitalHuman({sdk,container})` 等，确认无 ReferenceError。
5. **清理**：`Remove-Item -Recurse -Force dist_before`（提交前删除，避免误入库；它不在 .gitignore）。
6. **提交推送**：
   ```
   git add -A
   git commit -m "refactor(ts): Phase 9 batch N - X to full TS"   # 用临时文件写多行 message（PowerShell 不支持 heredoc）
   git push origin master
   ```
   注：`git push` 在 PowerShell 下会把进度输出当 stderr 报 "RemoteException"，但看到
   `xxx..yyy master -> master` 且 `git status -sb` 显示 `## master...origin/master`（无 ahead/behind）即成功。

---

## 5. 已确认的关键技术事实（避免重新踩坑）

- **`.js` 可用无扩展名 import 一个 `.ts`**（vite + tsc 都能解析）→ 真正 TS 化某文件后，仍是 .js 的引用方改成 `./X`（无扩展名）即可。
- **薄封装识别**：`.ts` 里有 `import _X from './X.js'; const X = _X as unknown as XType` 且同名 `.js` 存在 → 是薄封装，需要真正 TS 化。
- **dev server `import('../index.ts')`** 已是测试页标准（24 个测试 HTML 已改）；vite 实时转译 .ts。
- **tsconfig** include `src/**/*.ts` + `src/**/*.js`（过渡期）+ 3 个 `.ts` 入口；`allowJs:true`、`allowImportingTsExtensions`、`noEmit`。
  - 全部 .js 删完后可考虑关 `allowJs` 并去掉 include 里的 `src/**/*.js`（最后收尾步骤）。
- **构建基线体积**：iife ~864KB / core ~463KB / AIChat ~436KB（TS 化后基本不变，差异 <2KB）。
- **已知遗留（非重构引入，不用管）**：
  - `testKeepworkSDK.html` 调 `sdk.speech.getSupportedAudioFormat()`（SDK 无此方法，测试页旧 bug）。
  - `testAIChatRTC.html` L911 HTML 标签未闭合（vite 解析报错，测试页旧 bug）。

---

## 6. Phase 9 全部完成后的最终收尾

1. 确认 `src/` 下**不再有任何 .js 运行时文件**（`Get-ChildItem src\*.js -Recurse` 应为空）。
2. 可选：关闭 tsconfig 的 `allowJs`，从 include 去掉 `src/**/*.js`，再跑一次 `tsc --noEmit` + `build` 确认。
3. 更新 `.github/copilot-instructions.md`：把仍写 `.js` 的模块表/描述更新为 `.ts`；删除「过渡期 allowJs」等措辞。
4. 更新 `readme.md` 的文件结构（若提到 .js 文件名）。
5. 最终全量回归：`tsc --noEmit` 0 错误 + 3 bundle 构建 + 浏览器加载 testKeepworkSDK 确认
   `window.keepwork` 及全部全局正常 + 与重构前基线 API 表面 IDENTICAL。
6. 最终提交推送，并在 commit message 标注「Phase 9 complete — src/ fully TypeScript」。

---

## 7. session memory（更详细的历史）

更完整的阶段历史与踩坑记录在 session memory：`/memories/session/plan.md`
（新 session 若能访问同一 memory 可参考；本文件已是自洽的接力说明）。

---

## 8. 给新 session 的开场建议

> 「请继续 KeepworkSDK 的 Phase 9 TypeScript 重构。请先读取工作区根目录的
> `PHASE9_HANDOFF_PLAN.md` 了解已完成内容、剩余任务、转换方法和验证步骤，
> 然后从『批 3 剩余』的 `WorkspaceViewer.js` 开始，按标准流程逐个文件
> 真正 TS 化 + 验证（含构建产物 API 对比）+ 提交推送。最终目标是 src/ 全部 .ts、零 .js，
> 且功能与重构前完全一致。」
