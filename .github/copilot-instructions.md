# KeepworkSDK Copilot Instructions

## Project Overview

KeepworkSDK is a **browser-side TypeScript SDK** (strict mode; `src/` is fully TypeScript — no `.js` runtime files remain) bundled as **Vite IIFE** outputs. The bundle exposes a selected public surface on `window`, creates `window.keepwork = new KeepworkSDK()`, and automatically initializes NPL message listeners.

The current SDK scope includes core Keepwork API access, page/site CRUD, personal-page-backed storage and file operations, AI chat sessions, sandboxed tool execution, cross-iframe and NPL agent routing, login UI helpers, WeChat integrations, and optional RTC voice agents.

## Architecture

### Entry Point & Build

- There are **three TypeScript entries**, one per bundle:
  - `index.ts` → `dist/keepworkSDK.iife.js` (full bundle: core + AIChat + DigitalHuman)
  - `indexCore.ts` → `dist/keepworkSDK.core.iife.js` (core only)
  - `indexAIChat.ts` → `dist/keepworkSDK.AIChat.iife.js` (AIChat / DigitalHuman chunk)
- Entry `index.ts` imports the public bundle surface, attaches exported modules to `window`, creates the default `KeepworkSDK` instance, and calls `NPLUtil.initializeMessageListeners()`. (The legacy `.js` entries have been removed; `.ts` are the only entries.)
- Public globals from the bundle: `SDKLogger`, `KeepworkSDK`, `PersonalPageStore`, `StorageUtil`, `YMLParser`, `NPLUtil`, `NPLJS`, `ParacraftEvent`, `RemoteLog`, `WxLaunchApp`, `WxAuth`, `WxUtils`, `LoginWindow`, `SandboxToolEnv`, `AIChatRTC`, `DigitalHuman`, `DigitalHumanFrame`, plus `window.keepwork`.
- Runtime-only services live on the SDK instance rather than as globals: `keepwork.personalPageStore`, `keepwork.remoteLog`, `keepwork.speech`, `keepwork.copilotTools`, `keepwork.aiChat`, `keepwork.wxLaunchApp`, `keepwork.wxAuth`, `keepwork.loginWindow`, and the lazy shared `keepwork.agentRouter` getter.
- `AIChatRTC` is exported as a constructor but is **not** instantiated by `KeepworkSDK`; create it explicitly with `new AIChatRTC(window.keepwork)` when needed.
- `DigitalHuman` and `DigitalHumanFrame` are exported as constructors but are **not** instantiated by `KeepworkSDK`; create them explicitly (e.g. `new DigitalHuman({ sdk, container })`).
- Build configs: `vite.keepworkSDK.config.ts` (full), `vite.keepworkSDK.core.config.ts` (core), `vite.keepworkSDK.AIChat.config.ts` (AIChat). The full config outputs `dist/keepworkSDK.iife.js` (+ sourcemap) and copies to `../resource/`.
- `npm run build` runs `tsc --noEmit` first (type gate), then builds all three IIFE bundles in sequence. `npm run typecheck` runs the type check alone.
- Dev commands: `npm run dev`, `npm run build:watch`, `npm run preview`.
- Dev server: serves on port `3001`, redirects `/` to `test/testKeepworkSDK.html`, and enables CORS. Test HTML pages bootstrap via `import('../index.ts')` (Vite transpiles `.ts` on the fly) with a fallback to the built IIFE.

### Module Map

| File | Class / Export | Purpose |
|------|----------------|---------|
| `keepworkSDK.ts` | `KeepworkSDK` (default) | Core SDK: auth, user/profile caching, page CRUD, site management, request retry helpers, login helpers, lazy `AgentRouter` access |
| `SDKLogger.ts` | `SDKLogger` (default) | Unified console log management: module-level console shadowing, global/per-module enable/disable, pre-config via `window.__sdkLogConfig` |
| `AIChat.ts` | `AIChat`, `ChatSession` | Streaming chat API, chat history persistence, session workspaces, tool calling, child-agent support |
| `AgentRouter.ts` | `AgentRouter` | Cross-iframe / cross-window agent discovery, task forwarding, streaming relay, direct tool-call delegation, optional NPLJS bridge |
| `AIChatRTC.ts` | `AIChatRTC`, `RTCChatSession` | VolcEngine RTC-based voice/text sessions with sandboxed tools, realtime events, and AI/human modes |
| `ChildSessionMixin.ts` | mixin helpers | Shared child-agent queueing, bubbling, and callback logic used by `ChatSession` and `RTCChatSession` |
| `CopilotTools.ts` | `CopilotTools` | Category-based tool registry and dispatcher for `mqtt`, `fileOps`, `execute`, `web`, `personalPage`, and `agent` |
| `SandboxToolEnv.ts` | `SandboxToolEnv` | Sandboxed tool execution, `${...}` prompt templating, custom APIs, and tool proxying through `AgentRouter` |
| `ExecuteTool.ts` | `ExecuteTool` | Async JavaScript execution in the current browser context with captured console output |
| `WebTool.ts` | `WebTool` | Webpage fetching, HTML text extraction, and query-focused snippets for AI tools |
| `PersonalPageStore.ts` | `PersonalPageStore`, `StorageUtil` | Three-layer persistence, workspace-scoped file operations, and Git-backed remote sync |
| `YMLParser.ts` | `YMLParser` (default) | Custom YAML ↔ Object serializer for Keepwork page data |
| `NPL.ts` | `NPLUtil`, `NPLJS`, `ParacraftEvent` | Paracraft/NPL communication bridge and platform-specific message transport |
| `MqttManager.ts` | `MqttManager` | Runtime-loaded MQTT client used by `CopilotTools` |
| `Speech.ts` | `Speech` | Keepwork TTS helpers, Volcano synth endpoint integration, and browser speech fallback modes |
| `RemoteLog.ts` | `RemoteLog` (default) | Event tracking / telemetry with retry behavior |
| `LoginWindow.ts` | `LoginWindow` | Self-contained username/password login modal wired to `sdk.login()` |
| `WxAuth.ts` | `WxAuth` (default) | WeChat OAuth2 login flow |
| `WxLaunchApp.ts` | `WxLaunchApp` (default) | WeChat “Open in App” launch tag integration |
| `WxUtils.ts` | `WxUtils` (default) | WeChat environment detection, JS-SDK loading, and cookie helpers |
| `DigitalHuman.ts` | `DigitalHuman` (default) | Virtual character rendering (Video / Live2D / WebP), AI chat session lifecycle, voice chat via AIChatRTC, bracket-action parsing, lip sync |
| `DigitalHumanFrame.ts` | `DigitalHumanFrame` (default) | Iframe-isolated DigitalHuman with full API mirroring, tool-call delegation to parent via AgentRouter toolProxy |

### Runtime Topology

```text
IIFE entry (`index.ts`)
├── window globals + window.keepwork
└── NPLUtil.initializeMessageListeners()

KeepworkSDK (default instance on window.keepwork)
├── PersonalPageStore ↔ YMLParser
├── RemoteLog
├── Speech
├── CopilotTools
│   ├── MqttManager
│   ├── ExecuteTool
│   └── WebTool
├── AIChat
│   ├── ChatSession
│   ├── SandboxToolEnv
│   └── ChildSessionMixin
├── WxLaunchApp / WxAuth / LoginWindow
└── agentRouter getter → shared window.__keepworkAgentRouter

External / optional integrations
├── AgentRouter ↔ iframe tree via window.postMessage
├── AgentRouter ↔ Lua background agent via NPLJS / NPLWindowProxy
└── AIChatRTC → SandboxToolEnv + ChildSessionMixin + VolcEngine RTC CDN
└── DigitalHuman → AIChat + AIChatRTC + CopilotTools (optional digitalhuman tool category)
└── DigitalHumanFrame → DigitalHuman (in iframe) + AgentRouter tool delegation
```

Most runtime modules receive the parent `KeepworkSDK` instance via constructor and access it as `this.sdk`. Important exceptions:

- `AgentRouter` is created lazily and shared per browser window.
- `AIChatRTC` is created manually and receives `sdk` only when instantiated.
- `DigitalHuman` is created manually and receives `sdk` + `container` when instantiated.
- `DigitalHumanFrame` is created manually and receives `sdk` + `container`; it spawns a DigitalHuman inside an iframe and bridges tool calls to the parent via AgentRouter.
- `ChildSessionMixin`, `ExecuteTool`, and `WebTool` are helpers rather than top-level SDK services.

## Coding Conventions

### Language & Style

- **TypeScript (strict mode), no JSX.** `src/` is fully TypeScript — every runtime module is a `.ts` file (no `.js` remain). New source files MUST be `.ts`. `strict: true` and `noImplicitAny` are enforced; avoid `any` — prefer `unknown`, generics, or type assertions for hard-to-type cases. (Heavily-dynamic browser/SDK/RTC modules migrated from JS may use a file-local loose alias such as `type XAny = any` with an `eslint-disable @typescript-eslint/no-explicit-any` comment as a pragmatic migration aid.)
- **Type-checking is a build gate.** `npm run build` runs `tsc --noEmit` before Vite; type errors block the build. Run `npm run typecheck` independently to check types.
- **Import paths are extension-less** in `.ts` files (e.g. `./SDKLogger`, not `./SDKLogger.js`). `tsconfig` has `allowImportingTsExtensions` + `noEmit`; Vite/esbuild resolves `.ts`.
- **No thin wrappers remain.** Historically some modules were "thin TS wrappers" bridging to a `.js` runtime; these have all been fully TS-ified and the `.js` files deleted. Some larger modules are split into multiple `.ts` files (e.g. `AIChat.core.ts` + `AIChat.session.ts` aggregated by `AIChat.ts`); the aggregator re-exports and triggers side-effect mixins.
- **副作用注册必须用「导出函数 + 聚合入口实际调用」，禁止裸顶层副作用语句（防 Rollup tree-shake 误删）。** 这是踩过坑的强约束：拆分模块（如 `AIChat.session.ts` / `AIChatRTC.session.ts` / `AIChatRTCLocal.session.ts`）里对**类的 prototype / 跨模块导入符号**做注册时——例如 `Object.assign(X.prototype, mixin)`、`X.prototype.method = ...`、`AIChat.prototype.createSession = ...`——若写成模块**顶层裸语句**或仅靠聚合器**纯副作用 import**（`import './X.session'`）触发，Rollup 在 IIFE 自打包时会判定这些顶层语句「无外部可观测副作用」而删除，导致运行时方法丢失（典型症状：`createSession not yet initialized` 抛错占位符未被覆盖、子 agent 的 `_triggerImmediateCallback` 缺失）。**正确做法**：把全部 prototype/注册副作用收进一个**导出**的安装函数（如 `installAIChatSessionFactory()` / `installRTCChatSessionMixin()` / `installLocalRTCSessionMixin()`），然后在聚合入口（`AIChat.ts` / `AIChatRTC.ts` / `AIChatRTCLocal.core.ts`）**显式 `import { installXxx } from './X.session'` 并调用**，使其成为「被引用的有副作用调用」被 Rollup 保留；模块内可保留一次顶层调用作双保险。注意：仅靠 `package.json` 的 `sideEffects` 列 `.ts` 路径**不可靠**（对 IIFE 自打包入口图不一定生效，已验证拦不住）。新增/改动这类拆分模块的注册逻辑后，务必 `npm run build` 后在产物里 grep 确认注册语句仍在（如 `Object.assign(<minified>.prototype,{createSession`）。
- **避免「纯副作用 import」（`import './x'` 无绑定）。** 这类 import 易被 tree-shake，且语义模糊。若被导入模块真有需触发的副作用，改用上一条的「导出函数 + 调用」模式；若该模块只是定义类/常量供别处有绑定 import 使用（如 `AIChatRTCLocal.backends`），则删掉多余的纯副作用 import。
- **ES modules in source**; Vite bundles them into IIFE outputs. `allowJs` is off — `src/` contains only `.ts`.
- Prefer **class-based architecture** for top-level modules and small helper utilities for shared logic.
- Use `async/await` for user-facing async flows. Promise constructors and event listeners are fine where streaming or browser APIs require them.
- 注释采用**中英混合**：英文技术术语 + 中文说明；类型由 TS 签名负责，JSDoc 不重复写类型。

### Public Surface Rules

- If a module should become part of the public bundle API, update **all three** in `index.ts`: the import list, the named export list, and the `window.*` attachment.
- Not every file under `src/` is a global. Internal modules like `AIChat`, `AgentRouter`, `CopilotTools`, `ExecuteTool`, `WebTool`, and `ChildSessionMixin` are primarily accessed through `window.keepwork` or other exported constructors.
- Preserve backwards compatibility for `window.keepwork` and any existing public method / tool names.

### SDK Composition Patterns

- `KeepworkSDK` eagerly creates `personalPageStore`, `remoteLog`, `speech`, `copilotTools`, `aiChat`, `wxLaunchApp`, `wxAuth`, and `loginWindow` in its constructor.
- `agentRouter` is a lazy getter backed by `window.__keepworkAgentRouter`; all SDK instances in the same window share it.
- Use `this.sdk.request()` (or `this.request()` inside the core SDK) for standard Keepwork core API calls.
- Direct `fetch()` is acceptable when a module needs streaming responses, non-core endpoints, third-party page fetching, or RTC-specific flows (`AIChat`, `Speech`, `WebTool`, some auth/RTC code).
- Domain detection is based on `window.location.hostname` and falls back to `keepwork.com` for localhost / LAN environments.

### AI, Agent, and Tooling Patterns

- `AIChat.createSession()` returns a `ChatSession` that owns conversation state, optional persisted chat history (`modId` / `chatId`), a session workspace, and a `SandboxToolEnv`.
- Keep the distinction between:
	- **LLM-visible tool exposure**: `enableTools` / `tools` passed into `AIChat.chat()` or `ChatSession.send()`.
	- **Local execution surface**: `SandboxToolEnv` `enabledCategories`, which defaults to `['fileOps', 'execute']` for text chat sessions.
- Named top-level `ChatSession`s auto-register with `sdk.agentRouter`. Child agents are implemented through `ChildSessionMixin`, share the parent sandbox when possible, and currently allow at most **2 child sessions** with max depth **3**.
- `AgentRouter` supports:
	- cross-iframe discovery and task forwarding via `window.postMessage`
	- optional NPLJS/Lua bridging via `attachNPLJS()`
	- direct `toolCallOnly` execution so proxied tools can bypass an LLM round-trip
- `SandboxToolEnv` resolution order is: custom API → function/category proxy to remote agent → built-in `CopilotTools`.
- `CopilotTools` is category-based. Built-in categories are `mqtt`, `fileOps`, `execute`, `web`, `personalPage`, and `agent`. When adding a new category, also update the alias maps used by `resolveEnabledCategories()` and `setToolConfig()`.
- `AIChatRTC` is a separate constructor for RTC voice/text sessions. It creates its sandbox on `start()`, supports `mode: 'ai' | 'human'`, emits realtime events, and defaults its enabled tool categories to `['fileOps', 'agent']`.
- If you add another session type that supports child agents, initialize `ChildSessionMixin` state and override `_triggerImmediateCallback()` appropriately.

### Storage and File-Operation Pattern

- `PersonalPageStore` remains a 3-layer store: **memory cache (L1)** → **localStorage (L2)** → **IndexedDB (L3)**.
- Data larger than roughly 2 MB skips the localStorage layer automatically.
- Remote sync is batched every **5 seconds** through Git-backed page storage.
- File operations (`readFile`, `replaceStringInFile`, `grepSearch`, `createFile`, `listDir`) operate on PersonalPageStore page content, **not** on the host filesystem.
- File operations are **workspace-scoped** for safety:
	- direct `PersonalPageStore` file-op calls require `setWorkspace()` first
	- `CopilotTools` applies the session workspace when present and otherwise falls back to `workspace_default`
- Structured data keys use dot notation for nested access (for example, `user.settings.theme`).

### Messaging and Compatibility

- `NPLUtil.initializeMessageListeners()` is called automatically from `index.ts`.
- `NPLJS` and `ParacraftEvent` are exposed as constructors, but instances are **not** auto-created.
- Agent-router messages use `is_agent_router: true`; NPL / Paracraft messages use `is_paracraft_message`. Do not rename or mix these markers without updating both sides of the bridge.

### Naming

- File names: PascalCase for modules (`PersonalPageStore.ts`, `AgentRouter.ts`), camelCase only for the core entry (`keepworkSDK.ts`).
- Class names: PascalCase.
- Methods and config keys: camelCase.
- Internal helpers may use `_` prefixes.
- Preserve existing public method names and tool/function names.

### Console Logging (SDKLogger)

**Every source file under `src/` (`.ts` or `.js`) that uses `console.log`, `console.info`, or `console.debug` MUST shadow the global `console` with an SDKLogger module console.** This allows host projects to silence SDK log output without modifying SDK source.

Add these two lines after all other imports, before any code. In `.ts` files use extension-less imports; legacy `.js` files use the `.js` extension:

```ts
// .ts file:
import SDKLogger from './SDKLogger';             // or '../SDKLogger' from src/tools/
const console = SDKLogger.createModuleConsole('ModuleName');

// legacy .js file:
import SDKLogger from './SDKLogger.js';
const console = SDKLogger.createModuleConsole('ModuleName');
```

- `'ModuleName'` should match the class name or file purpose (e.g. `'AIChat'`, `'CopilotTools'`, `'SummarizeTool'`).
- **Do NOT modify existing `console.log(...)` call sites.** The `const console` declaration shadows the global and intercepts all calls automatically.
- `console.warn` and `console.error` always pass through regardless of enable-state.
- `console.log`, `console.info`, `console.debug` are controlled by `SDKLogger.isEnabled(moduleName)` (checked on every access via getter).
- Default behavior: all modules enabled (backward-compatible). Host projects disable via `SDKLogger.setGlobalEnabled(false)`, `SDKLogger.setModuleEnabled('X', false)`, or `SDKLogger.setOnlyEnabled(['X'])`. Pre-config is supported via `window.__sdkLogConfig = { globalEnabled, modules }` before the SDK script loads.
- `SDKLogger` is exposed as `window.SDKLogger` and `window.keepwork.logger`.
- If you create a **new** file under `src/` that contains any `console.log` / `console.info` / `console.debug` call, you **must** add the two-line SDKLogger import above. If the file only uses `console.warn` / `console.error`, the import is optional but recommended for future consistency.
- `test/` files and build configs do **not** need SDKLogger — it is for SDK runtime source only.

## Testing

Test coverage is still browser/manual HTML pages under `test/`:

- `testKeepworkSDK.html` — core SDK flows
- `testIndexedDB.html` — storage and capacity behavior
- `testYML.html` — YAML parser
- `testAudioResources.html` — Speech / TTS behavior
- `testVoiceMapping.html` — voice configuration mapping
- `testSandboxToolEnv.html` — sandboxed tool execution and templating
- `testAgentRouter.html` — iframe / router behavior
- `testNplAgentRouter.html` — AgentRouter ↔ NPLJS bridge
- `testAIChatRTC.html` — RTC voice/text agent flows
- `testDigitalHuman.html` — DigitalHuman avatar rendering and AI chat session flows
- `testDigitalHumanFrame.html` — iframe-isolated DigitalHumanFrame with tool proxying via AgentRouter
- `testDigitalHumanWebView.html` — NPLJS WebView inner page for DigitalHumanWebView.lua (Paracraft integration)

When creating or updating a test HTML page, prefer a module bootstrap that first loads `../index.ts` (the TypeScript entry, served on the fly by the Vite dev server) and falls back to `../dist/keepworkSDK.iife.js`. This keeps the page working in both the Vite dev server and VS Code Live Preview:

```html
<script type="module">
try { await import('../index.ts'); } catch (e) { await import('../dist/keepworkSDK.iife.js'); }
</script>
```

No unit test framework is configured; validation is via build plus browser/manual test pages.

## Key Constraints

1. **Runtime code under `index.ts`, `src/`, and `test/` must stay browser-compatible.** Do not use Node-only APIs there. The Vite build config is the exception and already uses Node `fs` / `path`.
2. **Bundle-level npm dependencies should stay minimal.** `blueimp-md5` is the only imported runtime dependency today; MQTT, WeChat JS-SDK, and VolcEngine RTC are loaded at runtime.
3. **The bundle is shipped as a single IIFE with named exports.** If you add a public API, keep `index.ts` imports, named exports, and `window.*` globals aligned.
4. **`window.keepwork` is the primary downstream integration surface.** Avoid renaming or removing public methods without considering existing Keepwork and Paracraft pages.
5. **WeChat compatibility matters.** `WxAuth` / `WxUtils` / launch flows must keep working inside embedded WeChat browsers.
6. **Cross-window and cross-NPL routing is protocol-sensitive.** Treat changes to `is_agent_router`, `is_paracraft_message`, and task/result/stream envelopes as compatibility changes.
7. **File tools and sandbox execution are page/workspace scoped, not unrestricted filesystem or shell access.** Preserve that boundary unless the API contract is intentionally changed.
