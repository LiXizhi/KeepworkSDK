/**
 * common.ts — KeepworkSDK 跨模块共享类型定义
 *
 * 收录在多个模块中重复出现的数据结构、联合类型和工具类型。
 * 各模块直接 import type { ... } from './types/common' 使用。
 */

// ────────────────────────────────────────────────────────────────
// 基础 / 工具类型
// ────────────────────────────────────────────────────────────────

/** 任意普通对象（比 object 更具体，比 Record<string,unknown> 更宽松） */
export type PlainObject = Record<string, unknown>;

/** 异步或同步的函数 */
export type MaybeAsyncFn<T = void> = (() => T) | (() => Promise<T>);

/** 可为 null 的值 */
export type Nullable<T> = T | null;

/** 可为 undefined 的值 */
export type Optional<T> = T | undefined;

// ────────────────────────────────────────────────────────────────
// Keepwork API 响应结构
// ────────────────────────────────────────────────────────────────

/** Keepwork 核心 API 的标准响应包装（大部分接口遵循此格式） */
export interface KwApiResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

/** 用户信息（来自 /user/getCurrentUser 等接口） */
export interface KwUser {
  id: number;
  username: string;
  nickname?: string;
  portrait?: string;
  email?: string;
  mobile?: string;
  vip?: number;
  [key: string]: unknown;
}

/** 页面（PersonalPage）基础信息 */
export interface KwPage {
  id?: number;
  username: string;
  sitename: string;
  pagename: string;
  content?: string;
  version?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

/** 站点基础信息 */
export interface KwSite {
  id?: number;
  username: string;
  sitename: string;
  displayName?: string;
  visibility?: string;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────
// AI / Chat 相关
// ────────────────────────────────────────────────────────────────

/** LLM 工具（Function Calling）定义 */
export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: {
      type: 'object';
      properties: Record<string, LLMToolParameterSchema>;
      required?: string[];
    };
  };
}

/** LLM 工具参数 Schema */
export interface LLMToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: unknown[];
  items?: LLMToolParameterSchema;
  properties?: Record<string, LLMToolParameterSchema>;
  [key: string]: unknown;
}

/** LLM 工具调用请求（来自模型响应） */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

/** 聊天消息角色 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 单条聊天消息 */
export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** AI 流式响应事件回调 */
export interface StreamCallbacks {
  /** 收到文本片段 */
  onText?: (delta: string, fullText: string) => void;
  /** 收到工具调用结果 */
  onToolResult?: (toolName: string, result: unknown) => void;
  /** 流结束（正常或被中断） */
  onEnd?: (finalText: string) => void;
  /** 发生错误 */
  onError?: (error: Error) => void;
}

// ────────────────────────────────────────────────────────────────
// AgentRouter 消息协议
// ────────────────────────────────────────────────────────────────

/** AgentRouter postMessage 信封（is_agent_router: true） */
export interface AgentRouterMessage {
  is_agent_router: true;
  agentName?: string;
  taskId?: string;
  /** 任务发布载荷 */
  payload?: {
    task?: string;
    tools?: LLMTool[];
    maxIterations?: number;
    systemPrompt?: string;
    model?: string;
    [key: string]: unknown;
  };
  /** 流式事件片段 */
  stream?: {
    eventName: string;
    eventData: unknown;
    taskId: string;
  };
  /** 任务最终结果 */
  result?: unknown;
  /** 错误信息 */
  error?: string;
  /** 发现/注册消息 */
  type?: 'register' | 'discover' | 'discoverReply' | 'task' | 'taskResult' | 'streamEvent';
  [key: string]: unknown;
}

/** NPL/Paracraft 消息信封（is_paracraft_message: true） */
export interface ParacraftMessage {
  is_paracraft_message: true;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────
// 工具配置
// ────────────────────────────────────────────────────────────────

/** CopilotTools 工具分类名称 */
export type ToolCategory =
  | 'mqtt'
  | 'fileOps'
  | 'execute'
  | 'web'
  | 'personalPage'
  | 'agent'
  | 'digitalhuman'
  | string; // 允许自定义分类

/** SandboxToolEnv / CopilotTools 工具调用请求 */
export interface ToolCallRequest {
  name: string;
  arguments: PlainObject;
  id?: string;
}

/** 工具执行结果 */
export type ToolCallResult = string | PlainObject | unknown;

// ────────────────────────────────────────────────────────────────
// 存储 / 文件操作
// ────────────────────────────────────────────────────────────────

/** PersonalPageStore 写操作选项 */
export interface WriteOptions {
  /** 是否跳过远程同步 */
  noRemote?: boolean;
  /** 是否跳过 localStorage 层 */
  noLocal?: boolean;
  /** 自定义版本号 */
  version?: number;
}

/** 文件操作路径信息 */
export interface FilePath {
  /** 工作空间（对应 PersonalPage 的 sitename） */
  workspace: string;
  /** 文件相对路径 */
  path: string;
}
