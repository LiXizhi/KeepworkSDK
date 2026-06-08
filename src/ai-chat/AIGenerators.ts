/**
 * AIGenerators.ts — AI 图像/视频生成模块主入口（TypeScript 版）
 *
 * 组合层：从 AIGenerators.media.ts 重导出完整类（包含 base + media 层）。
 *
 * 拆分结构：
 * - AIGenerators.base.ts  — 公共工具 + 聊天路由（chat / callLLM / chatCompletion / SSE 读取等）
 * - AIGenerators.media.ts — 继承 base，添加 genImage / genVideo / pollVideoTask 等媒体生成方法
 * - AIGenerators.ts        — 本文件：组合入口 + 统一导出
 */

export { default } from './AIGenerators.media';
export type { GenImageOptions, GenVideoOptions, VideoTaskStatus, PollVideoCallbacks } from './AIGenerators.media';
export { DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from './AIGenerators.base';
export type { GenMessage, GenChatOptions, LocalModelSettings, RouteDirectDecision, AIGeneratorsSDKRef } from './AIGenerators.base';
