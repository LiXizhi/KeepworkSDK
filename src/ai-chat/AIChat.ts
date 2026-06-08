/**
 * AIChat.ts — AI 聊天模块主入口（TypeScript 版）
 *
 * 组合层：导入核心类和 ChatSession，确保 AIChat.session.ts 的副作用
 * （将 createSession 挂载到 AIChat.prototype）已执行，然后统一重导出。
 *
 * 拆分结构：
 * - AIChat.core.ts  — AIChat 类（构造/请求头/chat循环/历史持久化）
 * - AIChat.session.ts — ChatSession 类 + ChildSessionMixin 注入 + createSession 挂载
 * - AIChat.ts        — 本文件：组合入口 + 统一导出
 */

import AIChat from './AIChat.core';

// 导入 AIChat.session.ts 以触发副作用：
// 1. 将 childSessionMethods 混入 ChatSession.prototype
// 2. 将 ChatSession._triggerImmediateCallback 覆盖
// 3. 将 AIChat.prototype.createSession 指向 ChatSession 工厂
//
// 关键：不能只写「纯副作用 import（import './AIChat.session'）」。Rollup tree-shaking
// 会把该模块里未被外部引用的顶层副作用语句（installAIChatSessionFactory() 调用）摇掉，
// 导致 createSession 退回抛错占位符。这里 import 出注册函数并真实调用，使其成为
// 「被引用的有副作用调用」，强制保留到打包产物中。
import { installAIChatSessionFactory } from './AIChat.session';

installAIChatSessionFactory();

export { ChatSession } from './AIChat.session';
export type { ChatMessage, ChatOptions, ChatHistoryPayload, ChatHistoryResponse, AIChatSDKRef } from './AIChat.core';
export type { ChatSessionOptions } from './AIChat.session';

export default AIChat;
