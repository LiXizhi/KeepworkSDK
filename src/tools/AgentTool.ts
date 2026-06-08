/**
 * AgentTool.ts — Agent 任务派发与管理工具（TypeScript 版）
 *
 * 向 LLM 暴露三个工具函数：
 * - `runAsyncAgentTask`：将任务委托给命名子 agent 异步执行
 * - `getParentAgentContext`：获取父 agent 会话的上下文
 * - `restartAgent`：重启当前 agent 会话（可指定新配置文件）
 * - `getAgentConfig`：读取 agent 的配置字段
 *
 * 依赖：AgentRouter（跨 iframe 路由）、ChildSessionMixin（本地子 agent）
 * 实现细节见 AgentTool.js，此文件提供类型声明和 TS 入口。
 */

import SDKLogger from '../utils/SDKLogger';
import { RestartAgentSignal } from '../ai-chat/SandboxToolEnv';

const console = SDKLogger.createModuleConsole('AgentTool');

/** 工具函数定义（OpenAI Function Calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** AgentTool 运行时配置 */
export interface AgentToolConfig {
  /** 关联的 ChatSession */
  _session?: AgentSession;
  [key: string]: unknown;
}

/** ChatSession 最小接口（避免循环引用） */
export interface AgentSession {
  name?: string;
  workspace?: string;
  model?: string;
  sandbox?: {
    processTemplate?: (v: string) => Promise<string>;
    _activePromptFile?: string | null;
    _templateSourceFile?: string | null;
  };
  messages?: Array<{ role: string; content: string }>;
  customTools?: unknown[];
  options?: Record<string, unknown>;
  _digitalHuman?: Record<string, unknown>;
  _digitalHumanFrame?: Record<string, unknown>;
  _pendingChildResults?: Array<unknown>;
  _restartSignal?: { promptFile?: string; tools?: string[]; options?: Record<string, unknown>; isRestartAgentSignal?: boolean; timestamp?: number } | null;
  _characterConfig?: Record<string, unknown>;
  _isSummarizing?: boolean;
  enqueueChildTask?: (name: string, task: string, tools: unknown, maxIter: number, sysPrompt: unknown, opts: unknown) => void;
  getParentContext?: (count: number) => unknown;
  restartAgent?: (promptFile: unknown, tools: string[], options: unknown) => Promise<{ configSource?: string }>;
  _handleChildCallback?: (mode: string, seconds: number) => void;
  _emitChildStream?: (event: unknown) => void;
  send?: (task: string, opts: Record<string, unknown>) => Promise<unknown>;
  clear?: () => void;
}

/** SDK 最小接口 */
interface SDKRef {
  agentRouter?: { hasRemoteAgent: (name: string) => boolean; submitTask: (name: string, payload: unknown, callbacks: unknown) => Promise<unknown> };
  aiChat?: { createSession: (opts: unknown) => AgentSession };
}

class AgentTool {
  // 完整工具定义（与 AgentTool.js 保持一致）
  static readonly definitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'runAsyncAgentTask',
        description:
          'Delegate a task to a named child agent that runs in parallel. The child agent is an independent AI session with its own conversation and tool access. ' +
          'The task runs asynchronously — this tool returns immediately after submission. ' +
          'When the child finishes, its result will be delivered back as a message in your conversation. ' +
          'At most 2 child agents can exist. Multiple tasks sent to the same agent will be queued or merged automatically.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'A detailed description of the task for the agent to perform. Supports inline ${...} template expansion via the sandbox.' },
            description: { type: 'string', description: 'A short (3-5 word) description of the task.' },
            agentName: { type: 'string', description: 'Optional name of a specific agent to invoke. If not provided, uses the current agent.' },
            tools: { type: 'array', items: { type: 'string' }, description: "Tool category names available to the child agent (e.g. ['web', 'fileOps', 'execute']). If omitted, inherits all tools from the parent agent." },
            maxIterations: { type: 'number', description: 'Maximum number of tool-call iterations for the child agent. Default is 10.' },
            systemPrompt: { type: 'string', description: 'Optional custom system prompt for the child agent.' },
            model: { type: 'string', description: "Override the model for the sub-agent (e.g. 'keepwork-pro', 'gpt-4o')." },
            thinking: { type: 'string', description: "Override the thinking level for the sub-agent run (e.g. 'none', 'low', 'medium', 'high')." },
            callbackMode: { type: 'string', enum: ['immediate', 'delay', 'debounce'], description: "How to deliver the child agent's result back to the parent." },
            debounceSeconds: { type: 'number', description: 'Seconds to wait in debounce mode before sending result to parent. Default is 5.' },
          },
          required: ['task'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getParentAgentContext',
        description: 'Get shared context from the parent agent session.',
        parameters: {
          type: 'object',
          properties: { messageCount: { type: 'number', description: 'Number of recent parent messages to include. Default is 10.' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'restartAgent',
        description:
          'Stop the current agent session and begin a new one. Optionally load a prompt file (URL to .md/.yaml agent config).',
        parameters: {
          type: 'object',
          properties: {
            promptFile: { type: 'string', description: 'URL or path to an agent.md or yaml file.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool category names to override default tools.' },
            options: { type: 'object', description: 'Advanced restart options.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getAgentConfig',
        description: "Get configuration values from the current agent's config.",
        parameters: {
          type: 'object',
          properties: { fields: { type: 'string', description: "One or more config field names separated by '|'. Use dot notation for nested fields." } },
          required: [],
        },
      },
    },
  ];

  private sdk: SDKRef;
  private config: AgentToolConfig = {};

  constructor(sdk: SDKRef) {
    this.sdk = sdk;
  }

  /** 更新工具运行时配置（由 CopilotTools.setToolConfig 调用）。 */
  setConfig(config: AgentToolConfig): void {
    this.config = config ?? {};
  }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行 agent 工具操作。
   * 核心逻辑（模板展开、路由选择、子 session 创建等）完整实现在此文件中。
   *
   * @param name   - 工具名
   * @param args   - 工具参数
   * @param config - 运行时配置（含 _session）
   */
  async execute(
    name: string,
    args: Record<string, unknown> = {},
    config: AgentToolConfig = {}
  ): Promise<string> {
    const mergedConfig: AgentToolConfig = { ...this.config, ...config };
    const session = mergedConfig._session;

    if (name === 'runAsyncAgentTask') {
      if (!session) return 'Failed: No session context available. runAsyncAgentTask must be called within a ChatSession.';

      const {
        task, description, agentName, tools, maxIterations,
        systemPrompt, model, thinking, callbackMode, debounceSeconds,
      } = args as Record<string, unknown>;

      if (!task) return "Failed: 'task' is a required parameter.";

      const resolvedAgentName = (agentName as string | undefined) || this.currentAgentName(session);
      console.log(`[CopilotTools] runAsyncAgentTask session='${session.name ?? 'root'}' target='${resolvedAgentName}' callbackMode=${(callbackMode as string | undefined) ?? 'delay'} task=${this.summarizeDebugValue(task)}`);

      // 展开 ${...} 模板
      const expandedTask = await this.expandTemplate(session, task as string, 'task');
      const expandedSystemPrompt = await this.expandTemplate(session, systemPrompt as string | undefined, 'systemPrompt');

      // 远程路由
      const router = this.sdk?.agentRouter;
      if (router?.hasRemoteAgent(resolvedAgentName)) {
        try {
          const taskPayload = { task: expandedTask, description, tools, maxIterations: (maxIterations as number | undefined) ?? 10, systemPrompt: expandedSystemPrompt, model, thinking, callbackMode, debounceSeconds };
          const taskId = `remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const resultPromise = router.submitTask(resolvedAgentName, taskPayload, {
            onStream: (streamMsg: unknown) => {
              const event = streamMsg as Record<string, unknown>;
              if (session._emitChildStream) {
                session._emitChildStream({ agentPath: `remote:${resolvedAgentName}`, agentName: resolvedAgentName, taskId: event['taskId'], type: event['streamType'], content: event['content'], fullResponse: event['fullResponse'] });
              }
            },
          });
          resultPromise.then((result) => {
            const taskSummary = (description as string | undefined) ?? ((expandedTask ?? '').length > 80 ? expandedTask.slice(0, 80) + '...' : expandedTask);
            session._pendingChildResults?.push({ agentName: resolvedAgentName, taskId, taskSummary, result });
            session._handleChildCallback?.((callbackMode as string | undefined) ?? 'delay', (debounceSeconds as number | undefined) ?? 5);
          }).catch((e: unknown) => {
            const taskSummary = (description as string | undefined) ?? expandedTask.slice(0, 80);
            session._pendingChildResults?.push({ agentName: resolvedAgentName, taskId, taskSummary, result: { error: (e as Error).message } });
            session._handleChildCallback?.((callbackMode as string | undefined) ?? 'delay', (debounceSeconds as number | undefined) ?? 5);
          });
          return `Task submitted to remote agent '${resolvedAgentName}'. The agent is working on it in another context. Results will be delivered as a message when complete.`;
        } catch (e) {
          if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) throw e;
          return `Failed to submit task to remote agent '${resolvedAgentName}': ${(e as Error).message}`;
        }
      }

      // DH / DHF 路径
      const dh = session._digitalHuman;
      const dhf = session._digitalHumanFrame;
      if (dh || dhf) {
        return this._runChildForDigitalHuman({ session, dh, dhf, task: expandedTask, description: description as string | undefined, agentName: resolvedAgentName, tools: tools as unknown, maxIterations: (maxIterations as number | undefined) ?? 10, systemPrompt: expandedSystemPrompt, model: model as string | undefined, thinking: thinking as unknown });
      }

      // 本地子 session
      try {
        session.enqueueChildTask?.(resolvedAgentName, expandedTask, tools, (maxIterations as number | undefined) ?? 10, expandedSystemPrompt, { model, thinking, callbackMode, debounceSeconds, description });
        return `Task submitted to agent '${resolvedAgentName}'. The agent is working on it in the background. Results will be delivered as a message when complete.`;
      } catch (e) {
        return `Failed to submit task to agent '${resolvedAgentName}': ${(e as Error).message}`;
      }
    }

    if (name === 'getParentAgentContext') {
      if (!session) return 'Failed: No session context available.';
      const context = session.getParentContext?.((args['messageCount'] as number | undefined) ?? 10);
      if (!context) return 'No parent session found. This agent is the root session.';
      return JSON.stringify(context);
    }

    if (name === 'getAgentConfig') {
      const characterConfig = this._resolveCharacterConfig(session);
      if (!characterConfig) return 'No agent config available.';
      const fieldsStr = ((args['fields'] as string | undefined) ?? 'description').trim();
      if (fieldsStr === '*') return JSON.stringify(Object.keys(characterConfig).filter((k) => !k.startsWith('_')));
      const fieldNames = fieldsStr.split('|').map((f) => f.trim()).filter(Boolean);
      const result: Record<string, unknown> = {};
      for (const field of fieldNames) result[field] = this._getNestedValue(characterConfig, field);
      if (fieldNames.length === 1) {
        const value = result[fieldNames[0]!];
        return typeof value === 'string' ? value : JSON.stringify(value);
      }
      return JSON.stringify(result);
    }

    if (name === 'restartAgent') {
      if (!session) return 'Failed: No session context available.';
      let { promptFile, tools, options } = args as { promptFile?: string; tools?: string[]; options?: Record<string, unknown> };
      options = options && typeof options === 'object' ? options : {};
      const normalizedTools = Array.isArray(tools) ? (tools as string[]).filter((t) => typeof t === 'string' && t.trim()) : [];

      try {
        const dh = session._digitalHuman;
        const dhf = session._digitalHumanFrame;
        const sandbox = session.sandbox;

        if (promptFile === 'thisfile') {
          promptFile = sandbox?._templateSourceFile
            ?? (dh?.['characterConfig'] as Record<string, unknown> | undefined)?.['_configSourceUrl'] as string | undefined
            ?? (dhf?.['characterConfig'] as Record<string, unknown> | undefined)?.['_configSourceUrl'] as string | undefined
            ?? sandbox?._activePromptFile
            ?? undefined;
        }

        if (!promptFile && dh && typeof (dh as Record<string, unknown>)['_resolveRestartAgentPromptFile'] === 'function') {
          promptFile = (dh as Record<string, (...a: unknown[]) => string>)['_resolveRestartAgentPromptFile'](promptFile);
        }

        const restartSignal = session._restartSignal;
        const signalTs = restartSignal?.timestamp ?? 0;
        const signalAgeMs = signalTs ? Date.now() - signalTs : Number.MAX_SAFE_INTEGER;
        const isStaleSignal = !!restartSignal && signalAgeMs > 5000;
        if (isStaleSignal) session._restartSignal = null;

        const isSameActivePrompt = !!(promptFile && sandbox?._activePromptFile === promptFile);
        const inRestartCycle = !!(restartSignal && !isStaleSignal && restartSignal.promptFile === promptFile && signalAgeMs <= 5000)
          || !!(dh?.['_restartAgentRunning']) || !!(dhf?.['_restartAgentRunning']);
        if (isSameActivePrompt && inRestartCycle) return '';

        if (dh || dhf) {
          if (sandbox) sandbox._activePromptFile = promptFile ?? null;
          session._restartSignal = { promptFile, tools: normalizedTools, options, isRestartAgentSignal: true, timestamp: Date.now() };
          throw new RestartAgentSignal(promptFile, normalizedTools, options);
        }

        if (typeof session.restartAgent === 'function') {
          const res = await session.restartAgent(promptFile, normalizedTools, options);
          return `Agent session restarted with config='${res?.configSource ?? 'default'}'.`;
        }
        return 'Failed: session does not support restartAgent.';
      } catch (e) {
        if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) throw e;
        return `Failed to restart agent: ${(e as Error).message}`;
      }
    }

    return 'Unknown agent tool';
  }

  // ──────────────────── 内部工具 ────────────────────

  private currentAgentName(session?: AgentSession): string {
    return session?.name ?? 'default';
  }

  private summarizeDebugValue(value: unknown, maxLength = 180): string {
    if (value === null || value === undefined) return String(value);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  }

  /**
   * 通过 session.sandbox.processTemplate 展开 ${...} 表达式。
   * 若无 sandbox 或无 ${...} 则原样返回。
   */
  private async expandTemplate(session: AgentSession | undefined, value: string | undefined, label: string): Promise<string> {
    if (typeof value !== 'string' || !session?.sandbox?.processTemplate) return value ?? '';
    if (!value.includes('${') && !/^\s*\/\S+/.test(value)) return value;
    try {
      const expanded = await session.sandbox.processTemplate(value);
      console.log(`[CopilotTools] runAsyncAgentTask ${label} expanded via sandbox: ${this.summarizeDebugValue(expanded)}`);
      return expanded;
    } catch (e) {
      if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) throw e;
      console.warn(`[CopilotTools] runAsyncAgentTask: ${label} template expansion failed. Error: ${(e as Error).message}`);
      return value;
    }
  }

  /**
   * 在 DigitalHuman / DigitalHumanFrame 路径下创建子 ChatSession 并执行任务。
   * 结果通过 dh.sendMessage / dhf.sendMessage 发回给主会话。
   * 立即返回确认字符串（fire-and-forget）。
   * @private
   */
  private _runChildForDigitalHuman(opts: {
    session: AgentSession;
    dh?: Record<string, unknown>;
    dhf?: Record<string, unknown>;
    task: string;
    description?: string;
    agentName: string;
    tools: unknown;
    maxIterations: number;
    systemPrompt?: string;
    model?: string;
    thinking?: unknown;
  }): string {
    const { session, dh, dhf, task, description, agentName, tools, maxIterations, systemPrompt, model, thinking } = opts;
    const aiChat = this.sdk?.aiChat;
    if (!aiChat) return `Failed to submit task to agent '${agentName}': sdk.aiChat is not available.`;

    const childSessionOpts = {
      name: `${agentName}-child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      backgroundAgent: true,
      parentSession: session,
      workspace: session.workspace,
      model: model ?? session.model,
    };
    const child = aiChat.createSession(childSessionOpts);
    if (session.sandbox) (child as unknown as { sandbox: unknown }).sandbox = session.sandbox;

    const sysPrompt = systemPrompt ?? `You are agent '${agentName}', a teammate working in parallel with the main agent. Complete the assigned task and return your final answer.`;
    child.messages?.push({ role: 'system', content: sysPrompt });

    const sendOptions: Record<string, unknown> = { enableTools: tools, maxIterations, stream: true };
    if (model) sendOptions['model'] = model;
    sendOptions['thinking'] = thinking ?? false;
    if (session.customTools?.length) sendOptions['tools'] = session.customTools;

    const target = dhf ?? dh;
    const targetLabel = dhf ? 'DigitalHumanFrame' : 'DigitalHuman';
    const taskSummary = description ?? (task.length > 80 ? task.slice(0, 80) + '...' : task);

    if (!child.send) return `Failed to submit task to agent '${agentName}': child session has no send().`;

    void child.send(task, sendOptions).then(async (response) => {
      const resultText = typeof response === 'string' ? response : ((response as Record<string, unknown>)?.['result'] ?? (response as Record<string, unknown>)?.['content'] ?? JSON.stringify(response));
      const payload = `[Agent '${agentName}' result for task "${taskSummary}"]:\n${resultText as string}`;
      try { await (target as Record<string, (...a: unknown[]) => Promise<void>>)?.['sendMessage']?.(payload); }
      catch (e) { console.error(`[CopilotTools] ${targetLabel}.sendMessage failed:`, e); }
    }).catch(async (e: unknown) => {
      const payload = `[Agent '${agentName}' failed for task "${taskSummary}"]: ${(e as Error).message ?? String(e)}`;
      try { await (target as Record<string, (...a: unknown[]) => Promise<void>>)?.['sendMessage']?.(payload); }
      catch (e2) { console.error(`[CopilotTools] ${targetLabel}.sendMessage failed:`, e2); }
    });

    return `Task submitted to agent '${agentName}'. The agent is working in a brand-new background session. Results will be delivered as a message via ${targetLabel} when complete.`;
  }

  private _resolveCharacterConfig(session?: AgentSession): Record<string, unknown> | null {
    if (!session) return null;
    return (session._digitalHuman?.['characterConfig'] ?? session._digitalHumanFrame?.['characterConfig'] ?? session._characterConfig) as Record<string, unknown> | null ?? null;
  }

  private _getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    if (!obj || !path) return undefined;
    let current: unknown = obj;
    for (const part of path.split('.')) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}

export default AgentTool;
