/**
 * global.d.ts — KeepworkSDK 全局类型扩展
 *
 * 声明所有由 IIFE bundle 挂载到 `window` 的公共全局变量，
 * 以及 SDK 内部使用的隐式 window 属性（预配置、共享状态等）。
 *
 * 重要设计原则：
 * - 此文件无 top-level import/export，是纯类型声明的 ambient script 文件
 * - 所有属性类型在过渡期使用 unknown，随各模块迁移逐步精化
 * - 使用 import() 类型表达式引用其他模块类型（不是 import 语句）
 *
 * 每个 Phase 迁移完对应模块后，应同步把对应属性的 unknown 替换为具体类型。
 */

// ──────────────────── SDK 预配置 ────────────────────

/** window.__sdkLogConfig 预配置对象，在 SDK script 标签加载前设置 */
interface SDKLogConfig {
  /** 是否全局启用日志，默认 true */
  globalEnabled?: boolean;
  /** 各模块的启用状态，key 为模块名 */
  modules?: Record<string, boolean>;
}

// ──────────────────── window 全局扩展 ────────────────────
// 纯 ambient script 文件（无 export）——直接扩展全局 Window 接口是最简洁的方式

interface Window {
  // ── SDK 预配置（宿主项目在 SDK 加载前设置）──
  __sdkLogConfig?: SDKLogConfig;

  // ── AgentRouter 共享实例（同一 window 下所有 SDK 实例共用）──
  __keepworkAgentRouter?: unknown;

  // ── 核心全局（由 index.ts / indexCore.ts 挂载）──
  // 过渡期使用 unknown，待各模块迁移完成后精化为具体类型
  SDKLogger: unknown;
  KeepworkSDK: unknown;
  AudioEngine: unknown;
  PersonalPageStore: unknown;
  LocalStorageUtil: unknown;
  StorageUtil: unknown;
  YMLParser: unknown;
  NPLUtil: unknown;
  NPLJS: unknown;
  ParacraftEvent: unknown;
  RemoteLog: unknown;
  WxLaunchApp: unknown;
  WxAuth: unknown;
  WxUtils: unknown;
  LoginWindow: unknown;
  ProfileWindow: unknown;
  SandboxToolEnv: unknown;
  CopilotTools: unknown;
  CloudDrive: unknown;
  LocalAPIKeySettings: unknown;
  AIGenerators: unknown;
  UserWorks: unknown;
  SocialFriends: unknown;
  Translation: unknown;
  installI18nGlobals: unknown;

  // ── AIChat / DigitalHuman 全局（由 index.ts 或 indexAIChat.ts 挂载）──
  AIChat: unknown;
  AIChatRTC: unknown;
  AIChatRTCLocal: unknown;
  SpeechRTC: unknown;
  DigitalHuman: unknown;
  DigitalHumanFrame: unknown;
  AgentConfig: unknown;
  SummarizeTool: unknown;
  SummarizeAgent: unknown;
  MinigameTools: unknown;
  WorkspaceViewer: unknown;
  createWorkspaceViewer: unknown;

  // ── 默认 SDK 实例（随模块迁移后逐步精化类型）──
  keepwork: unknown;

  // ── i18n 向后兼容全局（由 installI18nGlobals 注入）──
  i18n?: unknown;
  t?: (key: string, ...args: unknown[]) => string;
}
