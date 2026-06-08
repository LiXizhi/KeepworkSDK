/**
 * DigitalHumanFrame — Renders a DigitalHuman avatar inside an iframe (via srcdoc),
 * exposing the same public API as DigitalHuman. AI tool calls inside the iframe
 * are automatically delegated to the parent frame's AIChatSession via AgentRouter
 * and the SandboxToolEnv toolProxy mechanism.
 *
 * Why iframe?
 *   - Process isolation: Live2D / heavy video rendering won't block the parent page.
 *   - Style isolation: Avatar CSS and PIXI globals don't leak into the host page.
 *   - Easy teardown: destroying the iframe reclaims all resources.
 *
 * Architecture (AgentRouter based tool delegation):
 *   1. Parent creates a local proxy session for resolving tool calls and registers it
 *      with the AgentRouter as \`parentToolAgent_\${frameId}\`.
 *   2. Iframe runs a full KeepworkSDK and owns the REAL AI Session.
 *   3. Iframe configures its session with a \`toolProxy\` that maps all
 *      tool categories to the \`parentToolAgent_\${frameId}\` agent.
 *   4. When the Iframe AI wants to call a tool (e.g. \`read_file\`), the iframe's
 *      SandboxToolEnv intercepts it and uses AgentRouter.submitTask({ toolCallOnly: true })
 *      to send the execution command to the Parent.
 *   5. Parent's AgentRouter receives it, maps it to the local proxy session,
 *      which then delegates back to the Parent's real \`sdk.copilotTools.execute()\`.
 *
 * Usage:
 *   const dhf = new DigitalHumanFrame({ sdk, container: document.getElementById('avatar-root') });
 *   await dhf.initFromConfig(config);       // same config as DigitalHuman, including textToSpeech.autoReadReply
 *   dhf.on('message', ({ partialText }) => { ... });
 *   await dhf.send('Hello');
 *   dhf.playAction('happy', 5);
 */

import MinigameTools from '../tools/MinigameTools';
import { autoFlushExternalContext, clearExternalContextDebounce, handleExternalContextMessage, stopPageRouterHeartbeat } from './DigitalHumanBridge';
import { extractDigitalHumanFrameState, markConfigSourceUrl, resolveFileOpsConfig, resolveSearchPathEntries } from './DigitalHumanConfig';
import { FRAME_MSG_PREFIX, MSG } from './DigitalHumanFrameMessages';
import { createEventEmitterMixin, parseHeartbeatMaxCount, parseIntervalToMs } from './DigitalHumanUtils';
import AgentConfig from '../core/AgentConfig';
import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('DigitalHumanFrame');

// ============================================================================
// EventEmitter Mixin
// ============================================================================

const EventEmitterMixin = createEventEmitterMixin({ label: 'DigitalHumanFrame', logger: console });

// ============================================================================
// Utility
// ============================================================================

let _idCounter = 0;
function nextId(): string { return `dhf_${++_idCounter}_${Date.now()}`; }

// DigitalHumanFrame 涉及 iframe / postMessage / SDK 大量动态对象，统一用宽松类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DHFAny = Record<string, any>;

/**
 * Detect WeChat iOS browser where iframe srcdoc is not supported.
 * Falls back to a static DigitalHumanFrame.html loaded via src attribute.
 */
function isWeChatIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /micromessenger/i.test(ua) && /iphone|ipad|ipod/i.test(ua);
}

function escapeHtmlAttribute(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// Build the srcdoc HTML that runs inside the iframe
// ============================================================================

function buildSrcdoc(sdkSrc: string, parentAgentName: string, useLocalSdk: boolean, parentToken: string, parentUserApiKey: string, parentBaseURL: string): string {
  // The iframe loads keepworkSDK.iife.js (which includes DigitalHuman).
  // It configures the toolProxy to punt all tools to the parent.
  const sdkScriptTag = useLocalSdk 
    ? `<script type="module" src="${sdkSrc}"></script>` 
    : `<script src="${sdkSrc}"></script>`;
  const escapedToken = parentToken ? parentToken.replace(/'/g, "\\'") : '';
  const escapedApiKey = parentUserApiKey ? parentUserApiKey.replace(/'/g, "\\'") : '';
  const escapedBaseURL = parentBaseURL ? parentBaseURL.replace(/'/g, "\\'") : '';

  // Propagate parent SDKLogger config into iframe so logs stay suppressed
  const logConfigTag = !(SDKLogger as DHFAny)._globalEnabled
    ? `<script>window.__sdkLogConfig={globalEnabled:false};</script>\n`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${logConfigTag}${sdkScriptTag}
<style>
html, body {
  margin: 0; padding: 0;
  width: 100%; height: 100%;
  overflow: hidden;
  background: transparent;
}
#dh-container {
  width: 100%; height: 100%;
}
</style>
</head>
<body>
<div id="dh-container"></div>
<script>
(function() {
const MSG_PREFIX = '${FRAME_MSG_PREFIX}';
const PARENT_AGENT = '${parentAgentName}';
const PARENT_TOKEN = '${escapedToken}';
const PARENT_USER_API_KEY = '${escapedApiKey}';
const PARENT_BASE_URL = '${escapedBaseURL}';
let dh = null;
let sdk = null;

// ── PostMessage bridge (iframe side) ──

function postToParent(msg) {
  window.parent.postMessage(msg, '*');
}

// Intercept tool execution logs
function proxyConsole() {
  const origLog = console.log;
  console.log = function(...args) {
    origLog.apply(console, args);
  };
}
proxyConsole();

function waitForSdkGlobals(timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (typeof window.KeepworkSDK === 'function' && typeof window.DigitalHuman === 'function') {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error('DigitalHumanFrame iframe bootstrap timed out waiting for SDK globals'));
        return;
      }
      setTimeout(check, 30);
    };
    check();
  });
}

async function createDH() {
  await waitForSdkGlobals();

  const DigitalHuman = window.DigitalHuman;
  const KeepworkSDK = window.KeepworkSDK;
  if (typeof DigitalHuman !== 'function' || typeof KeepworkSDK !== 'function') {
    throw new Error('DigitalHumanFrame iframe bootstrap failed: SDK globals unavailable');
  }

  if (!window.keepwork) {
     window.keepwork = new KeepworkSDK();
  }
  if (PARENT_TOKEN) {
     window.keepwork.setToken(PARENT_TOKEN);
  }
  if (PARENT_USER_API_KEY && window.keepwork.setUserApiKey) {
     window.keepwork.setUserApiKey(PARENT_USER_API_KEY);
  }
  if (PARENT_BASE_URL) {
     window.keepwork.baseURL = PARENT_BASE_URL;
  }
  sdk = window.keepwork;
  
  dh = new DigitalHuman({
    sdk,
    container: document.getElementById('dh-container'),
  });

  dh.enableRemoteControl({
    msgPrefix: MSG_PREFIX,
    postToParent: postToParent,
    setupToolProxy: setupToolProxy,
    forwardUserVoiceInputViaParentFrame: true
  });
}

function setupToolProxy(cfg) {
    if (!cfg.tools) cfg.tools = {};
    
    // Register parent-provided custom tool definitions in the iframe's CopilotTools
    // so that the LLM sees them and _fnNameToCategory can resolve proxy routes.
    const parentDefs = cfg._parentToolDefs;
    if (parentDefs && sdk?.copilotTools) {
        for (const [catName, defs] of Object.entries(parentDefs)) {
            if (!sdk.copilotTools._registry[catName]) {
                sdk.copilotTools.registerToolCategory(catName, {
                    definitions: defs,
                    executor: async () => { throw new Error('Tool proxied to parent'); }
                });
            }
        }
    }
    
    // Build proxy map — use parent-specified list or fall back to built-in defaults.
    // Always include 'read' and 'edit' so that internal keepHistory file operations
    // (sandbox.execute('read_file'/'create_file')) are proxied to the parent.
    const cats = cfg._proxyCategories || ['read', 'edit', 'search', 'app', 'execute', 'web', 'mqtt', 'personalPage', 'agent', 'minigame'];
    const proxyCats = new Set(cats);
    // keepHistory requires read/edit proxy even if the caller omitted them
    proxyCats.add('read');
    proxyCats.add('edit');
    // minigame overlay always lives on the parent window
    proxyCats.add('minigame');
    
    const proxyCategories = {};
    proxyCats.forEach(c => {
        proxyCategories[c] = { agent: PARENT_AGENT };
    });
    
    // Do NOT auto-enable proxy categories for the LLM here.
    // LLM-visible tools are strictly controlled by the user's tools config.
    // Proxy routing (toolProxy.categories) handles execution delegation
    // independently — a category can be proxied without being exposed to the LLM.
    // Custom categories registered by the parent are available in the iframe's
    // CopilotTools registry for execution; to make them LLM-visible the user
    
    cfg.tools = {
        ...cfg.tools,
        toolProxy: { categories: proxyCategories }
    };
    
    // Clean internal transport props
    delete cfg._parentToolDefs;
    delete cfg._proxyCategories;
}

(async () => {
  try {
    await createDH();
    postToParent({ type: '${MSG.READY}' });
  } catch (error) {
    console.error('[DigitalHumanFrame] iframe bootstrap failed:', error);
    postToParent({
      type: '${MSG.EVENT}',
      event: 'error',
      data: {
        stage: 'bootstrap',
        message: error?.message || String(error),
      },
    });
  }
})();
})();
<\/script>
</body>
</html>`;
}

// ============================================================================
// DigitalHumanFrame — Main Class
// ============================================================================

export default class DigitalHumanFrame {
  sdk: DHFAny;
  container: HTMLElement;
  workspace: unknown;
  frameId: string;
  parentToolAgentName: string;
  characterConfig: DHFAny | null = null;
  characterInfo: DHFAny | null = null;
  voiceChatConfig: DHFAny = {};
  _iframe: HTMLIFrameElement | null = null;
  _pendingCalls: Map<string, DHFAny> = new Map();
  _commands: Record<string, DHFAny> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;

  /**
   * @param {Object} options
   * @param {Object} options.sdk - KeepworkSDK instance (used for tool execution on parent side)
   * @param {HTMLElement} options.container - Container element for the iframe
   * @param {string} [options.sdkSrc] - URL to keepworkSDK.iife.js
   * @param {boolean} [options.useLocalSdk] - Set to true if sdkSrc is a local ES module instead of IIFE bundle
   */
  constructor({ sdk, container, sdkSrc, useLocalSdk, useExternalHtml, workspace, proxyCategories, subtitle }: DHFAny = {}) {
    if (!sdk) throw new Error('DigitalHumanFrame requires a KeepworkSDK instance');
    if (!container) throw new Error('DigitalHumanFrame requires a container element');

    this.sdk = sdk;
    this.container = container;
    this.workspace = workspace;

    // Auto-detect whether the SDK source is an ES module (dev) or IIFE bundle (prod).
    // Explicit `useLocalSdk` overrides; otherwise infer from the SDK's own flag.
    this._useLocalSdk = useLocalSdk !== undefined ? !!useLocalSdk : !!sdk.constructor.sourceIsModule;

    // When true, use the external DigitalHumanFrame.html via src attribute
    // instead of inline srcdoc. Useful for debugging or environments where
    // srcdoc is not supported (e.g. WeChat iOS).
    this._useExternalHtml = !!useExternalHtml;

    // Which tool categories to proxy from iframe to parent.
    // null/undefined = auto (all parent-registered categories).
    // Explicit array = only those categories.
    this._proxyCategories = proxyCategories || null;

    // Resolve script path: prefer explicit arg, then the SDK's own source URL, then CDN fallback
    this._sdkSrc = sdkSrc || sdk.constructor.source || 'https://cdn.keepwork.com/sdk/keepworkSDK.iife.js';

    // Event emitter
    (EventEmitterMixin._initEvents as (this: DHFAny) => void).call(this);

    // AgentRouter ID for Parent -> Iframe delegation
    this.frameId = nextId();
    this.parentToolAgentName = `parentToolProxy_${this.frameId}`;

    // iframe DOM
    this._iframe = null;
    this._iframeReady = false;
    this._readyPromise = null;
    this._readyResolve = null;

    // RPC tracking
    this._pendingCalls = new Map(); // callId → { resolve, reject }

    // Summarize queue: only one summarization runs at a time; subsequent calls are merged
    this._summarizing = false;
    this._pendingSummarize = null;

    // External context debounce state (dh:send / dh:context from child iframes)
    this._externalContextDebounceTimer = null;
    this._externalContextSkipHistory = false;

    // Page router state for parent-side AppPageOpened handling.
    this._active = false;
    this._currentPage = null;
    this._pageRouterWakeupCalled = false;
    this._pageRouterHeartbeatTimer = null;
    this._pageRouterHeartbeatToken = 0;
    this._lastVoiceChatStateCode = undefined;

    // Delayed empty-prompt restartAgent request, cancelled by explicit prompt restarts.
    this._restartAgentDebounce = null;

    // Slash command registry (parent-side, user-registered only;
    // built-in commands like /context, /tts, /action, /help are handled
    // by the iframe's DigitalHuman)
    this._commands = {};

    // Character metadata 
    this.characterConfig = null;
    this.characterInfo = null;
    this.initialMessage = '';
    this.quickReplies = [];
    this.objective = null;
    this.completionMessages = null;
    this.voiceChatConfig = {};
    this.subtitleConfig = subtitle;
    this.avatarOnlyMode = false;

    this._createProxySession();

    // Bind message handler
    this._onMessage = this._handleMessage.bind(this);
    window.addEventListener('message', this._onMessage);

    this._audioResumeCleanup = this.sdk?.audioEngine?.bindUserGesture(this.container) || null;

    this._registerMinigameTool();
    this._authStateUnsubscribe = this.sdk?.onAuthStateChange?.((change: DHFAny) => this.handleAuthStateChange(change)) || null;
  }

  // ── Mix in event emitter methods ──
  get on() { return (EventEmitterMixin.on as DHFAny).bind(this); }
  get off() { return (EventEmitterMixin.off as DHFAny).bind(this); }
  get emit() { return (EventEmitterMixin.emit as DHFAny).bind(this); }

  /**
   * Auto-register the `minigame` copilot tool category on the PARENT SDK and
   * subscribe this frame to iframe events. Because the inner DigitalHuman
   * proxies all LLM tool calls to the parent via AgentRouter, the minigame
   * overlay is always created in the containing window (not inside the
   * iframe). Default `gameFinished` handling:
   *   1. Emit `minigameEvent` for host integrations.
   *   2. Call `this.restartAgent()` so the inner DH picks up workspace changes.
   * Disable step 2 via characterConfig.minigame.autoRestartAgent = false.
   */
  _registerMinigameTool() {
    const sdk = this.sdk;
    if (!sdk?.copilotTools) return;

    MinigameTools.register(sdk as Parameters<typeof MinigameTools.register>[0]);
    const tools = sdk.__minigameTools;
    if (!tools) return;
    tools.setLaunchHost(this);

    const listener = async (data: DHFAny) => {
      try { this.emit('minigameEvent', data); } catch (e) { /* ignore */ }
      if (data?.type !== 'gameFinished' && data?.type !== 'gameClosed') return;
      const slot = data?._slot;
      const launchSession = tools.getLaunchSession(slot || 'default');
      if (launchSession) {
        await this._handleLaunchedMinigameClosed(data, launchSession);
        return;
      }
      if (slot && slot !== 'default') return;
      if (this.characterConfig?.minigame?.autoRestartAgent === false) return;
      try {
        console.log(`[DigitalHumanFrame] minigame ${data.type} → restarting agent`);
        await this.restartAgent(undefined, undefined, { debounceMs: 3000 });
      } catch (e) {
        console.warn(`[DigitalHumanFrame] restartAgent after ${data.type} failed:`, e);
      }
    };
    this._minigameUnsubscribe = tools.addEventListener(listener);
  }

  async launchSkill(promptFile?: string, options: DHFAny = {}) {
    const file = (promptFile || options.promptFile || options.skillPath || '').trim();
    if (!file) throw new Error('launchSkill requires a promptFile or skillPath');

    const minigameTools = this.sdk?.__minigameTools || MinigameTools.register(this.sdk as Parameters<typeof MinigameTools.register>[0]);
    minigameTools.setLaunchHost(this);

    const parentSlot = options.parentSlot || minigameTools.activeSlot || options.sourceSlot || 'default';
    const parentSession = minigameTools.getLaunchSession(parentSlot);
    const slot = options.slot || (options.root ? 'default' : undefined);
    const session = minigameTools.openSlotSession({
      ...options,
      slot,
      parentSlot: options.root ? null : parentSlot,
      promptFile: file,
      parentPromptFile: options.parentPromptFile || parentSession?.promptFile || this._activePromptFile || this.characterConfig?._configSourceUrl || '',
      parentTools: options.parentTools || parentSession?.tools,
    });
    minigameTools.setSlotForegroundElements?.(
      session.slot,
      options.foregroundElements || this.container,
      options.foregroundOptions,
    );

    try {
      const restartOptions = {
        ...(options.restartOptions || {}),
        minigameSlot: session.slot,
        autoContinue: options.autoContinue !== false,
      };
      const result = await this.restartAgent(file, options.tools, restartOptions);
      return { ok: true, slot: session.slot, restart: result, session };
    } catch (error) {
      minigameTools.finishSlotSession(session.slot);
      minigameTools.close({ slot: session.slot, reason: 'launchFailed' });
      if (session.parentSlot) minigameTools.restorePreviousActiveSlot(session.parentSlot);
      throw error;
    }
  }

  async preloadSkill(promptFile?: DHFAny, options: DHFAny = {}) {
    const file = (promptFile || options.promptFile || options.skillPath || '').trim();
    if (!file) throw new Error('preloadSkill requires a promptFile or skillPath');

    const minigameTools = this.sdk?.__minigameTools || MinigameTools.register(this.sdk as Parameters<typeof MinigameTools.register>[0]);
    minigameTools.setLaunchHost(this);

    const parentSlot = options.parentSlot || minigameTools.activeSlot || options.sourceSlot || 'default';
    const parentSession = minigameTools.getLaunchSession(parentSlot);
    const slot = options.slot || (options.root ? 'default' : undefined);
    const session = minigameTools.openSlotSession({
      ...options,
      preload: true,
      slot,
      parentSlot: options.root ? null : parentSlot,
      promptFile: file,
      parentPromptFile: options.parentPromptFile || parentSession?.promptFile || this._activePromptFile || this.characterConfig?._configSourceUrl || '',
      parentTools: options.parentTools || parentSession?.tools,
    });

    try {
      const restartOptions = {
        ...(options.restartOptions || {}),
        minigameSlot: session.slot,
        autoContinue: false,
      };
      const result = await this.restartAgent(file, options.tools, restartOptions);
      return { ok: true, slot: session.slot, restart: result, session, preloaded: true };
    } catch (error) {
      minigameTools.finishSlotSession(session.slot);
      minigameTools.close({ slot: session.slot, reason: 'preloadFailed' });
      if (session.parentSlot) minigameTools.restorePreviousActiveSlot(session.parentSlot);
      throw error;
    }
  }

  async showPreloadedSkill(options: DHFAny = {}) {
    const tools = this.sdk?.__minigameTools;
    if (!tools?.showSlot) return { ok: false, reason: 'minigameToolsUnavailable' };

    // Resolve slot: explicit > find a preloaded session > activeSlot > 'default'
    let slot = options.slot;
    if (!slot) {
      // Look for a slot that is actually in preloaded state
      for (const [name, session] of tools._slotSessions || []) {
        if (session && session.preload && !session.revealed) {
          slot = name;
          break;
        }
      }
    }
    if (!slot) slot = tools.activeSlot || 'default';

    const session = tools.getLaunchSession?.(slot) || null;
    if (!session || !session.preload) {
      return { ok: false, slot, session, reason: 'notPreloaded' };
    }

    const ok = tools.showSlot(slot, {
      ...(options.frameOptions || {}),
      foregroundElements: options.foregroundElements || this.container,
      foregroundOptions: options.foregroundOptions,
    });
    if (!ok) return { ok: false, slot, session, reason: 'slotNotFound' };

    // Trigger autoContinue if requested (agent starts talking after show)
    if (options.autoContinue !== false) {
      try {
        await this.send('', { runCode: true, skipHistory: true });
      } catch (e) {
        console.warn('[DigitalHumanFrame] showPreloadedSkill autoContinue failed:', e);
      }
    }

    return { ok: true, slot, session: tools.getLaunchSession?.(slot) || session };
  }

  async _handleLaunchedMinigameClosed(data: DHFAny, launchSession: DHFAny) {
    const tools = this.sdk?.__minigameTools;
    if (!tools || !launchSession) return;

    const slot = launchSession.slot || data?._slot || 'default';
    const session = tools.finishSlotSession(slot) || launchSession;

    if (session.root || session.closePolicy === 'emitOnly') return;

    if (session.parentSlot) {
      tools.restorePreviousActiveSlot(session.parentSlot);
    }

    if (session.restorePolicy === 'none') return;

    const parentPromptFile = session.parentPromptFile;
    if (session.restorePolicy === 'resumeParent' && parentPromptFile) {
      try {
        await this.restartAgent(parentPromptFile, session.parentTools, {
          autoContinue: false,
          minigameSlot: session.parentSlot || 'default',
        });
      } catch (error) {
        console.warn('[DigitalHumanFrame] restore parent agent failed:', error);
      }
    } else if (session.restorePolicy === 'restartDefault') {
      try {
        await this.restartAgent(undefined, undefined, { debounceMs: 0 });
      } catch (error) {
        console.warn('[DigitalHumanFrame] restart default agent failed:', error);
      }
    }

    const summary = this._formatMinigameResult(data, session);
    if (summary) {
      try {
        await this.send(summary, { skipHistory: true });
      } catch (error) {
        console.warn('[DigitalHumanFrame] send minigame result summary failed:', error);
      }
    }
  }

  _formatMinigameResult(data: DHFAny = {}, session: DHFAny = {}) {
    if (typeof session.resultText === 'string') return session.resultText;
    const result = data?.data || null;
    if (!result || typeof result !== 'object') {
      return data?.type === 'gameClosed' ? '子游戏已关闭，用户回到了上一段互动。' : '子游戏已结束，用户回到了上一段互动。';
    }
    const parts = [];
    if (result.correct != null || result.total != null) {
      parts.push(`正确${result.correct || 0}/${result.total || 0}`);
    }
    if (result.accuracy != null) parts.push(`准确率${result.accuracy}%`);
    if (result.comment) parts.push(`评价：${result.comment}`);
    return `子游戏已结束。结果：${parts.length ? parts.join('，') : JSON.stringify(result)}`;
  }

  _createProxySession() {
    this._proxySession = null;
    if (this.sdk.agentRouter && this.sdk.aiChat) {
      this._proxySession = this.sdk.aiChat.createSession({
        name: this.parentToolAgentName,
        backgroundAgent: true,
        workspace: this.workspace || this.sdk.workspaceName,
        enabledCategories: ['read', 'edit', 'search', 'app', 'execute', 'web', 'mqtt', 'personalPage', 'agent', 'minigame']
      });
      this._proxySession._digitalHumanFrame = this;
      this._registerDigitalHumanProxyAPIs();
    }
  }

  _registerDigitalHumanProxyAPIs() {
    const sandbox = this._proxySession?.sandbox;
    if (!sandbox?.registerAPI) return;

    sandbox.registerAPI('getActionList', async (...args: unknown[]) => {
      const firstArg = args[0] as DHFAny;
      const lang = firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)
        ? (firstArg.lang ?? firstArg.args?.[0])
        : firstArg;
      return this.getActionList(lang);
    });

    sandbox.registerAPI('playAction', async (...args: unknown[]) => {
      const firstArg = args[0] as DHFAny;
      const isObjectArg = firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg);
      const actionName = isObjectArg ? (firstArg.actionName ?? firstArg.args?.[0]) : firstArg;
      const duration = isObjectArg ? (firstArg.duration ?? firstArg.args?.[1] ?? 5) : (args[1] ?? 5);
      if (!actionName) return 'Failed: actionName is required';
      this.playAction(actionName, duration);
      return `Action played: ${actionName}`;
    });
  }

  _destroyProxySession() {
    if (this._proxySession?.unregisterAgent) {
      this._proxySession.unregisterAgent();
    } else if (this.sdk.agentRouter) {
      this.sdk.agentRouter.unregister(this.parentToolAgentName);
    }
    this._proxySession = null;
  }

  /**
   * Close a minigame iframe overlay (if open) and optionally restart the agent.
   * @param {Object} [options]
   * @param {string} [options.slot] - Slot to close. Defaults to active slot.
   * @param {string} [options.reason='user'] - Close reason passed to MinigameTools.close()
   * @param {boolean} [options.restartAgent=true] - Whether to restart the agent after closing
   * @returns {Promise<void>}
   */
  async closeMinigame(options: DHFAny = {}) {
    const tools = this.sdk?.__minigameTools;
    if (tools) {
      tools.close({ slot: options.slot, reason: options.reason || 'user' });
    }
    if (options.restartAgent !== false) {
      try {
        await this.restartAgent(undefined, undefined, { debounceMs: 3000 });
      } catch (e) {
        console.warn('[DigitalHumanFrame] restartAgent after closeMinigame failed:', e);
      }
    }
  }

  /** Forward user ASR subtitles from the DigitalHuman iframe into the active minigame. */
  _forwardUserVoiceInputToMinigame(data: DHFAny = {}) {
    if (!data?.isUser || !data.text || !String(data.text).trim()) return;
    const tools = this.sdk?.__minigameTools;
    if (!tools?.postMessageToMinigame) return;
    tools.postMessageToMinigame({
      type: 'dh:userVoiceInput',
      text: String(data.text),
      definite: !!data.definite,
      paragraph: !!data.paragraph,
      source: 'DigitalHumanFrame.subtitle',
      subtitle: data,
    });
  }

  _forwardAssistantSpeakingToMinigame(data: DHFAny = {}) {
    if (data?.isUser) return;
    const tools = this.sdk?.__minigameTools;
    if (!tools?.postMessageToMinigame) return;
    tools.postMessageToMinigame({
      type: 'keepwork:digitalHuman:speaking',
      speaking: !data.definite,
      definite: !!data.definite,
      text: data.text || '',
      source: 'DigitalHumanFrame.subtitle',
      subtitle: data,
    });
  }

  // ========================================================================
  // SECTION 0.5: Parent tool injection for iframe proxying
  // ========================================================================

  /**
   * Inject parent tool definitions and proxy category list into a config
   * before sending it to the iframe. The iframe's setupToolProxy reads these
   * to register unknown categories and build the proxy map dynamically.
   * @param {Object} config - The session/init config (mutated in place)
   */
  _injectParentToolInfo(config: DHFAny) {
    const copilotTools = this.sdk?.copilotTools;
    if (!copilotTools) return;

    // Resolve which categories to proxy
    const categories = this._proxyCategories || Object.keys(copilotTools._registry);

    // Built-in categories exist on both parent and iframe SDKs; only send
    // definitions for categories the iframe doesn't have natively.
    const BUILTIN = new Set(['read', 'edit', 'search', 'app', 'execute', 'web', 'mqtt', 'personalPage', 'agent']);
    const customDefs: DHFAny = {};
    for (const cat of categories) {
      if (!BUILTIN.has(cat) && copilotTools._registry[cat]) {
        customDefs[cat] = copilotTools._registry[cat].definitions;
      }
    }

    if (Object.keys(customDefs).length > 0) {
      config._parentToolDefs = customDefs;
    }
    config._proxyCategories = categories;
  }

  // ========================================================================
  // SECTION 1: iframe lifecycle
  // ========================================================================

  /** Create and inject the iframe into the container. */
  _ensureIframe() {
    if (this._iframe) return this._readyPromise;

    this._readyPromise = new Promise((resolve) => {
      this._readyResolve = resolve;
    });

    const useStaticHtml = this._useExternalHtml || isWeChatIOS();

    if (useStaticHtml) {
      // WeChat iOS does not support iframe srcdoc — use a static HTML file instead.
      // Determine whether the SDK source is an ES module or IIFE bundle for the iframe.
      // If the URL contains 'iife' (e.g. keepworkSDK.iife.js), treat as non-module
      // regardless of the parent's _useLocalSdk flag.
      const sdkIsModule = this._useLocalSdk && !/iife/i.test(this._sdkSrc);

      let htmlPath;
      if (sdkIsModule) {
        // Dev: resolve relative to the SDK source directory (not the origin root).
        // TypeScript source keeps the static frame under src/digital-human/.
        const sdkUrl = new URL(this._sdkSrc, window.location.href);
        htmlPath = new URL('src/digital-human/DigitalHumanFrame.html', sdkUrl).href;
      } else {
        // Prod / IIFE: HTML sits next to the bundle
        htmlPath = this._sdkSrc.replace(/\/[^/]*$/, '/DigitalHumanFrame.html');
      }
      const query = new URLSearchParams({ sdk: this._sdkSrc });
      const hashParts = [`parentAgent=${encodeURIComponent(this.parentToolAgentName)}`];
      if (sdkIsModule) hashParts.push('module=1');
      // Pass auth token so the iframe SDK can authenticate without cross-origin cookie access
      const parentToken = this.sdk && this.sdk.token;
      if (parentToken) hashParts.push(`token=${encodeURIComponent(parentToken)}`);
      const parentApiKey = this.sdk && this.sdk.userApiKey;
      if (parentApiKey) hashParts.push(`userApiKey=${encodeURIComponent(parentApiKey)}`);
      const parentBaseURL = this.sdk && this.sdk.baseURL;
      if (parentBaseURL) hashParts.push(`baseURL=${encodeURIComponent(parentBaseURL)}`);
      // Propagate SDKLogger suppression into the iframe
      if (!(SDKLogger as DHFAny)._globalEnabled) hashParts.push('sdklog=0');
      const frameSrc = `${htmlPath}?${query.toString()}#${hashParts.join('&')}`;
      this.container.insertAdjacentHTML(
        'beforeend',
        `<iframe style="width:100%;height:100%;border:none;background:transparent;display:block;" allow="autoplay; fullscreen; microphone; compute-pressure; unload" data-digitalhuman-frame src="${escapeHtmlAttribute(frameSrc)}"></iframe>`
      );
    } else {
      const srcdoc = buildSrcdoc(this._sdkSrc, this.parentToolAgentName, this._useLocalSdk, this.sdk && this.sdk.token, this.sdk && this.sdk.userApiKey, this.sdk && this.sdk.baseURL);
      this.container.insertAdjacentHTML(
        'beforeend',
        `<iframe style="width:100%;height:100%;border:none;background:transparent;display:block;" allow="autoplay; fullscreen; microphone; compute-pressure; unload" data-digitalhuman-frame srcdoc="${escapeHtmlAttribute(srcdoc)}"></iframe>`
      );
    }

    const iframe = this.container.lastElementChild;
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error('DigitalHumanFrame failed to create iframe element');
    }

    this._iframe = iframe;

    // Start agent sync immediately — _syncWithRetry will keep retrying
    // until the iframe's AgentRouter is ready to receive.
    if (this.sdk.agentRouter) {
      this.sdk.agentRouter.addChildWindow(iframe.contentWindow);
    }

    return this._readyPromise;
  }

  // ========================================================================
  // SECTION 2: postMessage RPC
  // ========================================================================

  /**
   * Send a command to the iframe and wait for a response.
   * @param {string} type - Message type
   * @param {Object} [payload] - Additional payload fields
   * @returns {Promise<Object>} The response result
   */
  async _rpc(type: string, payload: DHFAny = {}): Promise<DHFAny> {
    await this._ensureIframe();

    const callId = nextId();
    const promise = new Promise<DHFAny>((resolve, reject) => {
      this._pendingCalls.set(callId, { resolve, reject });
      // Timeout after 30s
      setTimeout(() => {
        if (this._pendingCalls.has(callId)) {
          this._pendingCalls.delete(callId);
          reject(new Error(`DigitalHumanFrame RPC timeout: ${type}`));
        }
      }, 30000);
    });

    this._iframe!.contentWindow!.postMessage({ type, callId, ...payload }, '*');
    return promise;
  }

  /** Send a fire-and-forget command to the iframe (no response expected). */
  _post(type: string, payload: DHFAny = {}) {
    if (!this._iframe?.contentWindow) return;
    this._iframe.contentWindow.postMessage({ type, ...payload }, '*');
  }

  // ========================================================================
  // SECTION 3: Message handler (parent side)
  // ========================================================================

  _handleMessage(e: MessageEvent) {
    if (e.data && e.data.is_agent_router) return;

    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;

    const isOwnIframeSource = !!(this._iframe?.contentWindow && e.source === this._iframe.contentWindow);
    const isExternalControlMessage = msg.type === 'dh:send'
      || msg.type === 'dh:context'
      || msg.type === 'dh:app-page-opened';

    // Handle dh:send / dh:context / dh:app-page-opened from any child iframe (not source-restricted)
    // but never echo messages emitted by our own DigitalHuman iframe back into itself.
    if (isExternalControlMessage) {
      if (isOwnIframeSource) return;
      if (msg.type === 'dh:send') { this._handleExternalSend(msg); return; }
      if (msg.type === 'dh:context') { this._handleExternalContext(msg); return; }
      if (msg.type === 'dh:app-page-opened') { this._handleAppPageOpened(msg); return; }
    }

    // Only accept dh-frame: messages from our own iframe
    if (!this._iframe || !isOwnIframeSource) return;
    if (!msg.type.startsWith(FRAME_MSG_PREFIX)) return;

    switch (msg.type) {
      case MSG.READY:
        this._iframeReady = true;
        if (this._readyResolve) {
          this._readyResolve();
          this._readyResolve = null;
        }
        break;

      case MSG.RESPONSE: {
        const pending = this._pendingCalls.get(msg.callId);
        if (pending) {
          this._pendingCalls.delete(msg.callId);
          if (msg.result?.ok === false && msg.result?.error) {
            pending.reject(new Error(msg.result.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        break;
      }

      case MSG.EVENT:
        // Drain summarize queue when the iframe signals completion
        if (msg.event === 'summarized') this._onSummarizeComplete();
        if (msg.event === 'voiceChatState') {
          this._lastVoiceChatStateCode = msg.data?.code;
        }
        if (msg.event === 'voiceChatStopped') {
          this._lastVoiceChatStateCode = undefined;
        }
        if (msg.event === 'activeChanged') {
          const wasActive = this._active;
          this._active = msg.data?.active === true;
          if (!this._active) {
            stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);
          } else if (!wasActive) {
            this._sendCurrentPageRouterWakeupIfNeeded().catch((e: DHFAny) => {
              console.warn('[DigitalHumanFrame] Page router wakeup on active failed:', (e as DHFAny).message);
            });
          }
        }
        // Relay iframe DigitalHuman events to parent listeners
        this.emit(msg.event, msg.data);
        if (msg.event === 'subtitle') {
          this._forwardUserVoiceInputToMinigame(msg.data);
          this._forwardAssistantSpeakingToMinigame(msg.data);
        }
        break;
    }
  }


  /**
   * Handle an external send message. Optionally interrupts, then forwards
   * to the iframe via the SEND RPC.
   * @private
   * @param {Object} msg - { type: 'dh:send', text: string, interrupt?: boolean, options?: object }
   */
  async _handleExternalSend(msg: DHFAny) {
    const text = String(msg.text || '').trim();
    if (!text) return;

    try {
      clearExternalContextDebounce(this as unknown as Parameters<typeof clearExternalContextDebounce>[0]);
      // interrupt defaults to true; pass through to options so DigitalHuman.send can handle it
      const interrupt = msg.interrupt !== false;
      await this.send(text, { ...msg.options, _interrupt: interrupt });
    } catch (e) {
      console.warn('[DigitalHumanFrame] External send failed:', (e as DHFAny).message);
      this.emit('error', { error: e, stage: 'externalSend' });
    }
  }

  /**
   * Handle an external context message. Sends context to the iframe and
   * optionally starts a debounce timer for auto-flush.
   * @private
   */
  _handleExternalContext(msg: DHFAny) {
    handleExternalContextMessage(this as unknown as Parameters<typeof handleExternalContextMessage>[0], msg);
  }

  /** @private */
  async _autoFlushExternalContext() {
    try {
      await autoFlushExternalContext(this as unknown as Parameters<typeof autoFlushExternalContext>[0]);
    } catch (e) {
      console.warn('[DigitalHumanFrame] External context auto-flush failed:', (e as DHFAny).message);
    }
  }

  /** @private */
  async _sendCurrentPageRouterWakeupIfNeeded() {
    if (!this._active || this._pageRouterWakeupCalled) return false;
    const page = String(this._currentPage || '').trim();
    const routerEntry = page ? this.characterConfig?.pageRouters?.[page] : null;
    const wakeupText = routerEntry?.wakeupText;
    if (!wakeupText) return false;

    // Wait for the inner voice agent to signal readiness before sending the
    // wakeup text. The RTC agent needs a moment after startVoiceChat returns
    // before it can process ExternalTextToLLM messages; without this delay
    // the wakeup is silently dropped.
    if (this._active) {
      const ready = await this._waitForVoiceReady(8000);
      if (!ready) {
        console.warn('[DigitalHumanFrame] pageRouter wakeup skipped: voice agent not ready in time');
        return false;
      }
      if (!this._active || this._pageRouterWakeupCalled) return false;
    }

    await this.send(wakeupText, { runCode: true, skipHistory: true });
    this._pageRouterWakeupCalled = true;
    return true;
  }

  /**
   * Wait for the inner voice agent to become ready by listening for the
   * first `voiceChatState` event relayed from the iframe.
   * @private
   * @param {number} [timeout=8000]
   * @returns {Promise<boolean>}
   */
  _waitForVoiceReady(timeout = 8000) {
    // If we already received a voiceChatState event, the agent is ready
    if (this._lastVoiceChatStateCode !== undefined) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const done = (result: boolean) => {
        if (settled) return;
        settled = true;
        this.off('voiceChatState', onState);
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => done(false), timeout);
      const onState = () => done(true);
      this.on('voiceChatState', onState);
      // Re-check after listener is registered to handle race
      if (this._lastVoiceChatStateCode !== undefined) done(true);
    });
  }

  /** @private */
  _startPageRouterHeartbeat(page: string, routerEntry: DHFAny) {
    stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);
    if (!this._active) return;

    const heartbeatText = routerEntry?.heartbeatText;
    const delayMs = parseIntervalToMs(routerEntry?.heartbeatInterval, 's');
    const maxCount = parseHeartbeatMaxCount(routerEntry?.heartbeatMaxCount, 3);
    if (!heartbeatText || delayMs <= 0) return;
    if (maxCount <= 0) return;

    const token = this._pageRouterHeartbeatToken;
    let sentCount = 0;
    const scheduleNext = () => {
      if (token !== this._pageRouterHeartbeatToken || this._currentPage !== page) return;
      if (sentCount >= maxCount) return;
      this._pageRouterHeartbeatTimer = setTimeout(async () => {
        this._pageRouterHeartbeatTimer = null;
        if (!this._active || token !== this._pageRouterHeartbeatToken || this._currentPage !== page) return;
        if (sentCount >= maxCount) return;

        try {
          sentCount += 1;
          await this.send(heartbeatText, { runCode: true, skipHistory: true, skipIfMessageTextEmpty: true });
        } catch (e) {
          console.warn('[DigitalHumanFrame] Page router heartbeat failed:', (e as DHFAny).message);
          this.emit('error', { error: e, stage: 'pageRouterHeartbeat', page });
        } finally {
          scheduleNext();
        }
      }, delayMs);
    };

    scheduleNext();
  }

  /**
   * Handle an AppPageOpened message. Forwards to the iframe DigitalHuman
   * which owns the pageRouters config and handles agent switching.
   * @private
   * @param {Object} msg - { type: 'dh:app-page-opened', page: string }
   */
  async _handleAppPageOpened(msg: DHFAny) {
    const page = String(msg.page || '').trim();
    if (!page) return;

    const pageChanged = page !== this._currentPage;
    this._currentPage = page;
    if (pageChanged) this._pageRouterWakeupCalled = false;
    this.emit('appPageOpened', { page });
    stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);

    const pageRouters = this.characterConfig?.pageRouters;
    if (pageRouters) {
      const routerEntry = pageRouters[page];
      if (!routerEntry) {
        this.emit('pageRouterOpen', {
          page,
          matched: false,
          reason: 'noMatchingRoute',
          timestamp: Date.now(),
        });
        return;
      }

      try {
        const agent = routerEntry.agent;
        this.emit('pageRouterOpen', {
          page,
          matched: true,
          agent: agent || '',
          hasWakeupText: Boolean(routerEntry.wakeupText),
          wakeupText: routerEntry.wakeupText || '',
          hasHeartbeatText: Boolean(routerEntry.heartbeatText),
          heartbeatInterval: routerEntry.heartbeatInterval || '',
          heartbeatMaxCount: parseHeartbeatMaxCount(routerEntry.heartbeatMaxCount, 3),
          wakeupCalled: this._pageRouterWakeupCalled,
          active: this._active,
          timestamp: Date.now(),
        });

        const restartOptions: DHFAny = { autoContinue: false };
        if (routerEntry.tools && typeof routerEntry.tools === 'object') {
          restartOptions.toolsOverride = routerEntry.tools;
        }
        const restartResult = await this.restartAgent(agent || undefined, undefined, restartOptions);
        const skipWakeupText = restartResult?.skipped === true && restartResult?.reason === 'cooldown';

        const wakeupText = routerEntry.wakeupText;
        if (this._active && wakeupText && !skipWakeupText && !this._pageRouterWakeupCalled) {
          const ready = await this._waitForVoiceReady(8000);
          if (ready && this._active && !this._pageRouterWakeupCalled) {
            await this.send(wakeupText, { runCode: true, skipHistory: true });
            this._pageRouterWakeupCalled = true;
          }
        }

        if (this._active) this._startPageRouterHeartbeat(page, routerEntry);
      } catch (e) {
        console.warn('[DigitalHumanFrame] AppPageOpened handler failed:', (e as DHFAny).message);
        this.emit('error', { error: e, stage: 'appPageOpened', page });
      }
      return;
    }

    // Forward to iframe — the inner DigitalHuman handles pageRouters lookup
    if (this._iframe?.contentWindow) {
      this._iframe.contentWindow.postMessage(msg, '*');
    }
  }

  // ========================================================================
  // SECTION 4.5: Slash Command Registry
  // ========================================================================

  /**
   * Register a slash command intercepted by send().
   * @param {string} name - Command name (without /)
   * @param {Object} def
   * @param {string} def.description - Short help text
   * @param {boolean} [def.needsArg=true] - Whether the command requires an argument
   * @param {function(string, DigitalHumanFrame):void|Promise<void>} def.handler
   */
  registerCommand(name: string, { description, needsArg = true, handler }: DHFAny) {
    this._commands[name.toLowerCase()] = { description, needsArg, handler };
  }

  unregisterCommand(name: string) { delete this._commands[name.toLowerCase()]; }

  listCommands() {
    return Object.entries(this._commands).map(([name, { description, needsArg }]) => ({ name, description, needsArg }));
  }

  tryCommand(text: string) {
    if (typeof text !== 'string' || !text.startsWith('/')) return { handled: false };
    const spaceIdx = text.indexOf(' ');
    const name = (spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1)).toLowerCase();
    const arg = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';
    const cmd = this._commands[name];
    if (!cmd) return { handled: false };
    if (cmd.needsArg && !arg) return { handled: true, name, error: 'requires argument' };
    const result = cmd.handler(arg, this);
    return { handled: true, name, result };
  }

  // ========================================================================
  // SECTION 5: Public API — mirrors DigitalHuman
  // ========================================================================

  async initAvatar(videoActions: DHFAny, options: DHFAny = {}) {
    this._lastAvatarInit = { videoActions, options: { ...options } };
    if (options.avatarOnlyMode !== undefined) {
      this.avatarOnlyMode = options.avatarOnlyMode;
    }
    await this._rpc(MSG.INIT_AVATAR, { videoActions, options });
  }

  /**
   * Shared pre-processing for configs sent to the iframe: sync workspace/mountFolder
   * to the parent proxy session, inject parent tool info, and pre-resolve
   * summarizeAgent.config URLs.
   * @param {Object} config - Mutated in place
   */
  async _prepareConfigForIframe(config: DHFAny) {
    const { workspace, mountFolder } = resolveFileOpsConfig(config);

    if (workspace && this._proxySession) {
        this.workspace = workspace;
        this._proxySession.workspace = workspace;
        if (this._proxySession.sandbox) {
            this._proxySession.sandbox.workspace = workspace;
        }
    }
    if (mountFolder && this._proxySession) {
        this.mountFolder = mountFolder;
        if (this._proxySession.setMountFolder) {
            this._proxySession.setMountFolder(mountFolder);
        } else if (this._proxySession.sandbox) {
            this._proxySession.sandbox.mountFolder = mountFolder;
        }
    }
    this._injectParentToolInfo(config);

    const searchPathEntries = resolveSearchPathEntries(config);
    if (searchPathEntries.length && this.sdk?.personalPageStore) {
      const store = this.sdk.personalPageStore;
      for (const entry of searchPathEntries) {
        store.addSearchPath(entry.prefix, entry.baseUrl);
        if (!this._registeredSearchPaths) this._registeredSearchPaths = [];
        this._registeredSearchPaths.push(entry.prefix);
        console.log(`[DigitalHumanFrame] Registered search path on parent: "${entry.prefix}" → "${entry.baseUrl}"`);
      }
    }

    // Pre-resolve summarizeAgent.config URL on the parent side so the iframe
    // (which has an about:srcdoc origin) doesn't need to fetch relative paths.
    if (config.summarizeAgent && typeof config.summarizeAgent.config === 'string') {
      try {
        const AC = typeof AgentConfig !== 'undefined' ? AgentConfig : (window as DHFAny).AgentConfig;
        if (AC?.fetch) {
          const resolved = await AC.fetch(config.summarizeAgent.config);
          config.summarizeAgent = { ...config.summarizeAgent, config: resolved };
          console.log('[DigitalHumanFrame] Pre-resolved summarizeAgent config');
        }
      } catch (e) {
        console.warn('[DigitalHumanFrame] Failed to pre-resolve summarizeAgent config:', e);
      }
    }
  }

  async initFromConfig(config: DHFAny = {}) {
    if (this.subtitleConfig !== undefined && !Object.prototype.hasOwnProperty.call(config, 'subtitle')) {
      config = { ...config, subtitle: this.subtitleConfig };
    }
    await this._prepareConfigForIframe(config);

    this.characterConfig = config;
    const frameState = extractDigitalHumanFrameState(config);
    this.characterInfo = frameState.characterInfo;
    this.initialMessage = frameState.initialMessage;
    this.quickReplies = frameState.quickReplies;
    this.objective = frameState.objective;
    this.completionMessages = frameState.completionMessages;
    this.voiceChatConfig = frameState.voiceChatConfig;
    this.subtitleConfig = frameState.subtitleConfig;
    if (frameState.avatarOnlyMode) this.avatarOnlyMode = true;

    const res = await this._rpc(MSG.INIT_FROM_CONFIG, { config });
    
    return {
      session: this._proxySession,
      config: res.config,
      character: res.character,
      initial_message: res.initial_message,
      quick_replies: res.quick_replies,
      objective: res.objective,
      completion_messages: res.completion_messages,
      voiceChat: res.voiceChat,
    };
  }

  /**
   * Load a DigitalHuman config from a URL (JSON / YML / MD), inline JSON string, or object,
   * then initialize the iframe avatar and AI session in one call.
   *
   * The config is fetched and parsed on the parent side (using DigitalHuman.fetchConfig),
   * then passed to the iframe via the existing initFromConfig RPC.
   *
   * @param {string|Object} source - URL string, JSON string, or config object
   * @returns {Promise<Object>} Result of initFromConfig
   */
  async loadConfig(source: DHFAny) {
    const AC = typeof AgentConfig !== 'undefined' ? AgentConfig : (window as DHFAny).AgentConfig;
    if (!AC?.fetch) {
      throw new Error('DigitalHumanFrame.loadConfig requires AgentConfig.fetch');
    }
    const config = await AC.fetch(source);
    markConfigSourceUrl(config, source, { allowInlineJson: true });
    console.log('[DigitalHumanFrame] Config loaded:', Object.keys(config).join(', '));
    return this.initFromConfig(config);
  }

  async createSession(config: DHFAny = {}) {
    await this._prepareConfigForIframe(config);
    await this._rpc(MSG.CREATE_SESSION, { config });
    return this._proxySession;
  }

  /**
   * Get the current session (parent-side proxy).
   * @returns {Object|null}
   */
  getSession() {
    return this._proxySession || null;
  }

  /**
   * Unified send — mirrors DigitalHuman.send().
    * Pass options.autoReadReply=false to suppress automatic text-mode reply playback.
   */
  async send(userMessage: string, options: DHFAny = {}) {
    // Intercept parent-side user-registered commands first
    if (typeof userMessage === 'string' && userMessage.startsWith('/')) {
      const cmd = this.tryCommand(userMessage);
      if (cmd.handled) {
        this.emit('command', { name: cmd.name, error: cmd.error, result: cmd.result });
        return { finalText: '', mode: 'command', command: cmd };
      }
    }
    // Forward to iframe — built-in /commands are handled by DigitalHuman there
    const result = await this._rpc(MSG.SEND, { userMessage, options });
    return result?.data || result;
  }

  /**
   * Send a message via the inner text AI session.
   */
  async sendMessage(userMessage: string, options: DHFAny = {}) {
    const result = await this._rpc(MSG.SEND_MESSAGE, { userMessage, options });
    return result?.data || result;
  }

  /**
   * Cancel any active/queued text sends (aborts in-flight LLM requests and stops TTS).
   * Useful for barge-in scenarios where a new user utterance should immediately
   * supersede the current response.
   * @param {string} [reason='barge-in'] - Reason label for logging/debugging
   * @returns {Promise<{canceledCount: number}>}
   */
  async cancelSend(reason: string = 'barge-in') {
    const result = await this._rpc(MSG.CANCEL_SEND, { reason });
    return result?.data || result;
  }

  /**
   * Expand an inline system prompt inside the iframe's own DigitalHuman session.
   * This avoids resolving ${...} against the parent proxy sandbox.
   * @param {string} text
   * @returns {Promise<string>}
   */
  async expandInlineSystemPrompt(text: string) {
    const rawText = String(text || '').trim();
    if (!rawText) return '';
    const result = await this._rpc(MSG.EXPAND_INLINE_SYSTEM_PROMPT, { text: rawText });
    return result?.text || rawText;
  }

  /**
   * Send the configured boot message explicitly after the caller finishes
   * restoring any prior history into the UI.
   */
  async sendBootMessage(bootMessage: string, options: DHFAny = {}) {
    const result = await this._rpc(MSG.SEND_BOOT_MESSAGE, { bootMessage, options });
    return result?.data || result;
  }

  /**
   * Immediately send heartbeat text in the inner DigitalHuman. If text is omitted,
   * the inner DigitalHuman uses the current page router heartbeatText, then
   * falls back to "[heartbeat]".
   * @param {string} [text]
   * @param {Object} [options] - send() options forwarded to DigitalHuman.
   * @returns {Promise<Object>}
   */
  async sendHeartbeat(text: string, options: DHFAny = {}) {
    if (!this._active) {
      return { ok: true, sent: false, skipped: true, reason: 'inactive', page: this._currentPage || null };
    }
    const result = await this._rpc(MSG.SEND_HEARTBEAT, { text, options });
    return result?.data || result;
  }

  /**
   * Trigger the voice heartbeat path immediately from the host app.
   * This uses the same RTC voice guards and event stream as automatic
   * silence heartbeat, but the app provides the current business context.
   * @param {string|Object} input - Explicit heartbeat text, or { text, reason, context, data }.
   * @param {Object} [options] - Heartbeat options forwarded to DigitalHuman.
   * @returns {Promise<Object>}
   */
  async triggerVoiceHeartbeat(input = {}, options: DHFAny = {}) {
    const result = await this._rpc(MSG.TRIGGER_VOICE_HEARTBEAT, { input, options });
    return result?.data || result;
  }

  /**
   * Set whether the framed DigitalHuman is actively listening/speaking.
   * This does not switch text/voice mode.
   * @param {boolean} active
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async setActive(active = true, options: DHFAny = {}) {
    const result = await this._rpc(MSG.SET_ACTIVE, { active, options });
    if (result?.active !== undefined) {
      const wasActive = this._active;
      this._active = result.active === true;
      if (!this._active) {
        stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);
      } else if (!wasActive) {
        await this._sendCurrentPageRouterWakeupIfNeeded();
      }
    }
    return result;
  }

  get isActive() {
    return this._active;
  }

  // ── Avatar control (delegated to iframe) ──

  playAction(actionKey: string, duration: number = 3) {
    this._post(MSG.PLAY_ACTION, { actionKey, duration });
  }

  switchVideo(type: string) {
    this._post(MSG.SWITCH_VIDEO, { videoType: type });
  }

  switchToIdle() {
    this._post(MSG.SWITCH_TO_IDLE);
  }

  switchToTalking() {
    this._post(MSG.SWITCH_TO_TALKING);
  }

  setMouthOpen(value: number) {
    this._post(MSG.SET_MOUTH_OPEN, { value });
  }

  playMotion(preferredGroups: DHFAny, priority?: number) {
    this._post(MSG.PLAY_MOTION, { preferredGroups, priority });
  }

  async getActions() {
    const result = await this._rpc(MSG.GET_ACTIONS);
    return result?.actions || [];
  }

  async getActionList(lang?: string) {
    const result = await this._rpc(MSG.GET_ACTION_LIST, { lang });
    return result?.actionList || '';
  }

  async getAvatarStatus() {
    const result = await this._rpc(MSG.GET_AVATAR_STATUS);
    return result?.status || null;
  }
  
  async getSessionData() {
      const result = await this._rpc(MSG.GET_SESSION);
      return result?.session || null;
  }

  // ========================================================================
  // Voice Chat (proxied to iframe)
  // ========================================================================

  async startVoiceChat(preset = {}, options: DHFAny = {}) {
    this._injectParentToolInfo(preset);
    await this._rpc(MSG.START_VOICE_CHAT, { preset, options });
  }

  async stopVoiceChat() {
    await this._rpc(MSG.STOP_VOICE_CHAT);
  }

  async setSubtitleConfig(config: DHFAny = {}) {
    const result = await this._rpc(MSG.SET_SUBTITLE_CONFIG, { config });
    this.subtitleConfig = result?.config || config;
    return this.subtitleConfig;
  }

  async getSubtitleConfig() {
    const result = await this._rpc(MSG.GET_SUBTITLE_CONFIG);
    return result?.config || null;
  }

  async clearSubtitle(options: DHFAny = {}) {
    return this._rpc(MSG.CLEAR_SUBTITLE, { options });
  }

  /**
   * Update an active voice chat session (REST API proxy).
   * @param {string} command - e.g. 'ExternalTextToSpeech', 'UpdateParameters', 'interrupt'
   * @param {Object} [options] - Additional fields (Message, InterruptMode, Parameters, etc.)
   * @returns {Promise<Object>}
   */
  async updateVoiceChat(command: string, options: DHFAny = {}) {
    return this._rpc(MSG.UPDATE_VOICE_CHAT, { command, options });
  }

  /**
   * Restart voice chat with optional config overrides (deep-merged into the last preset).
   * @param {Object} [configOverrides] - Partial preset overrides
   * @returns {Promise<Object>}
   */
  async restartVoiceChat(configOverrides: DHFAny = {}) {
    return this._rpc(MSG.RESTART_VOICE_CHAT, { config: configOverrides });
  }

  /** @private */
  _cancelRestartAgentDebounce(result: DHFAny = {}) {
    const pending = this._restartAgentDebounce;
    if (!pending) return false;

    clearTimeout(pending.timer);
    this._restartAgentDebounce = null;
    pending.resolve({
      configSource: 'default',
      skipped: true,
      debounced: true,
      cancelled: true,
      ...result,
    });
    return true;
  }

  /**
   * Restart the agent session with an optional prompt file.
   * Delegates to the iframe's DigitalHuman.restartAgent() via RPC.
   * @param {string} [promptFile] - URL or path to agent config file
   * @param {string[]} [tools] - Optional tool category override. Empty means inherit defaults.
   * @param {Object} [options]
  * @param {number} [options.debounceMs=0] - Delay empty-prompt restarts; cancelled by any later explicit prompt restart.
  * @param {boolean} [options.autoContinue=true] - Automatically send "(continue)" after a prompt-file restart.
   * @returns {Promise<Object>} { configSource, mode }
   */
  async restartAgent(promptFile?: string, tools?: DHFAny, options: DHFAny = {}): Promise<DHFAny> {
    // Mark the parent-side proxy session as in-restart so that any inline
    // `${await copilot.restartAgent('thisfile')}` inside the loaded prompt —
    // which runs in the parent frame during proxied template expansion —
    // is recognized as a duplicate of this in-progress restart and returns ''
    // (see AgentTool.js idempotency check). Without this, the inline call
    // throws RestartAgentSignal and breaks the read_file round trip.
    const trimmedFile = (promptFile && typeof promptFile === 'string') ? promptFile.trim() : null;
    const debounceMs = Number(options?.debounceMs) || 0;
    const shouldDebounce = !trimmedFile && debounceMs > 0;

    if (trimmedFile) {
      this._cancelRestartAgentDebounce({ configSource: trimmedFile, cancelledBy: 'promptFile' });
    } else if (this._restartAgentDebounce) {
      this._cancelRestartAgentDebounce({ cancelledBy: shouldDebounce ? 'superseded' : 'immediate' });
    }

    if (shouldDebounce) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
          if (this._restartAgentDebounce?.timer !== timer) return;
          this._restartAgentDebounce = null;
          try {
            resolve(await this.restartAgent(promptFile, tools, { ...options, debounceMs: 0 }));
          } catch (e) {
            reject(e);
          }
        }, debounceMs);

        this._restartAgentDebounce = { timer, resolve, reject };
      });
    }

    const sandbox = this._proxySession?.sandbox;
    const prevActive = sandbox ? sandbox._activePromptFile : undefined;
    const prevSource = sandbox ? sandbox._templateSourceFile : undefined;
    this._restartAgentRunning = true;
    if (sandbox && trimmedFile) {
      sandbox._activePromptFile = trimmedFile;
      sandbox._templateSourceFile = trimmedFile;
    }
    // Set minigame slot override on the PARENT SDK's MinigameTools so that
    // any load_minigame proxied from the inner DigitalHuman targets the
    // correct slot (e.g. 'subgame' instead of 'default').
    const minigameTools = this.sdk?.__minigameTools;
    const prevDefaultSlot = minigameTools?._defaultSlot;
    if (minigameTools && options.minigameSlot) {
      minigameTools._defaultSlot = options.minigameSlot;
    }
    try {
      const rpcOptions = { ...options, debounceMs: 0 };
      const result = await this._rpc(MSG.RESTART_AGENT, { promptFile, tools, options: rpcOptions });
      // Track the active custom prompt file so consumers can check whether
      // the agent is currently running a custom prompt (truthy) or default (null).
      this._activePromptFile = trimmedFile || null;
      return result;
    } finally {
      this._restartAgentRunning = false;
      if (minigameTools) minigameTools._defaultSlot = prevDefaultSlot;
      if (sandbox && trimmedFile) {
        sandbox._activePromptFile = prevActive;
        sandbox._templateSourceFile = prevSource;
      }
    }
  }

  async handleAuthStateChange(change: DHFAny = {}) {
    // Lightweight path: when only the auth token changed (same user / refresh),
    // push the new token to the existing iframe SDK instead of tearing down
    // and rebuilding the entire iframe.
    if (change && change.reason === 'tokenChanged') {
      try {
        if (this._iframe?.contentWindow) {
          this._post(MSG.SET_TOKEN, { token: change.token || null });
        }
      } catch (e) {
        console.warn('[DigitalHumanFrame] Failed to push token to iframe:', e);
      }
      return { reloaded: false, reason: 'tokenPushed' };
    }
    return this.reloadForAuthChange(change);
  }

  async reloadForAuthChange(change?: DHFAny) {
    void change;
    if (this._authReloadPromise) return this._authReloadPromise;

    this._authReloadPromise = (async () => {
      const config = this.characterConfig;
      const avatarInit = this._lastAvatarInit;
      if (!config && !avatarInit) return { reloaded: false, reason: 'noConfig' };

      await this._tearDownIframe('DigitalHumanFrame reloading after auth change');

      this._createProxySession();
      if (config) {
        await this.initFromConfig(config);
      } else if (avatarInit) {
        await this.initAvatar(avatarInit.videoActions, avatarInit.options || {});
      }
      this.emit('authReloaded', {});
      return { reloaded: true };
    })().finally(() => {
      this._authReloadPromise = null;
    });

    return this._authReloadPromise;
  }

  /**
   * Tear down the iframe, proxy session, registered search paths and pending RPCs.
   * Shared by destroy() and reloadForAuthChange(). Does NOT remove outer-instance
   * listeners (window message, auth, minigame, audio resume) since the DHF
   * instance may continue living after a reload.
   * @private
   * @param {string} [pendingRejectReason]
   */
  async _tearDownIframe(pendingRejectReason = 'DigitalHumanFrame iframe torn down') {
    if (this.sdk.agentRouter && this._iframe?.contentWindow) {
      this.sdk.agentRouter.removeChildWindow(this._iframe.contentWindow);
    }
    this._destroyProxySession();

    if (this._registeredSearchPaths?.length && this.sdk?.personalPageStore) {
      for (const prefix of this._registeredSearchPaths) {
        this.sdk.personalPageStore.removeSearchPath(prefix);
      }
      this._registeredSearchPaths = null;
    }

    try {
      if (this._iframe && this._iframeReady) {
        this._post(MSG.DESTROY);
      }
    } catch (e) { /* ignore */ }

    if (this._iframe && this._iframe.parentNode) {
      this._iframe.parentNode.removeChild(this._iframe);
    }
    this._iframe = null;
    this._iframeReady = false;
    this._readyPromise = null;
    this._readyResolve = null;

    for (const [, pending] of this._pendingCalls) {
      pending.reject(new Error(pendingRejectReason));
    }
    this._pendingCalls.clear();
    this._summarizing = false;
    this._pendingSummarize = null;
    stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);
    this._cancelRestartAgentDebounce({ cancelledBy: 'teardown' });
  }

  sendText(text: string) {
    this._post(MSG.SEND_VOICE_TEXT, { text });
  }

  sendVoiceText(text: string) {
    this.sendText(text);
  }

  /**
   * Send background context to the voice chat LLM via WebSocket (binary channel).
   * Does not trigger a reply — injected as context for the next response.
   * @param {string} text - Context text
   * @param {Object} [options]
   * @param {boolean} [options.insertToHistory=false] - Also persist as a Q/A pair in history
   */
  sendContext(text: string, options: DHFAny = {}) {
    this._post(MSG.SEND_CONTEXT, { text, options });
  }

  /**
   * Send text to the agent's TTS (text-to-speech) via the iframe voice chat session.
   * @param {string} text
   * @param {Object} [options]
   * @param {boolean} [options.useREST=false] - Use REST API instead of binary channel
   * @param {number} [options.interruptMode] - REST only: interrupt priority
   */
  sendTTS(text: string, options: DHFAny = {}) {
    this._post(MSG.SEND_TTS, { text, options });
  }

  /**
   * Load a dedicated summarize agent config.
   * The config is fetched on the parent side and sent to the iframe DigitalHuman.
   * @param {string|Object} source - Config URL, JSON string, or config object
   * @returns {Promise<void>}
   */
  async loadSummarizeAgentConfig(source: DHFAny) {
    const AC = typeof AgentConfig !== 'undefined' ? AgentConfig : (window as DHFAny).AgentConfig;
    let config;
    if (typeof source === 'object' && !Array.isArray(source)) {
      config = source;
    } else if (AC?.fetch) {
      config = await AC.fetch(source);
    } else {
      throw new Error('DigitalHumanFrame.loadSummarizeAgentConfig requires AgentConfig.fetch');
    }
    await this._rpc(MSG.LOAD_SUMMARIZE_AGENT_CONFIG, { config });
  }

  /**
   * Trigger conversation summarization in the iframe DigitalHuman.
   * Returns immediately. Only one summarization runs at a time; subsequent
   * calls are queued and merged so the latest options win.
   * Listen for the 'summarized' event to receive the result.
   * @param {Object} [options]
   * @param {number} [options.keepRecentRounds] - Recent pairs to preserve
   * @param {string} [options.mode] - 'replace' or 'append'
   */
  summarize(options: DHFAny = {}) {
    console.log('[DigitalHumanFrame] summarize() called, options:', JSON.stringify(options), '_summarizing:', this._summarizing);
    if (this._summarizing) {
      // Merge: later call's options override earlier ones
      console.log('[DigitalHumanFrame] summarize() queued (already in progress)');
      this._pendingSummarize = { ...this._pendingSummarize, ...options };
      return;
    }
    this._summarizing = true;
    this._pendingSummarize = null;
    // Fire-and-forget; result arrives via 'summarized' event.
    // Use _post so we don't block on a 30s RPC timeout.
    this._post(MSG.SUMMARIZE, { options });
  }

  /** @private Called when the iframe emits a 'summarized' event to drain the queue. */
  _onSummarizeComplete() {
    this._summarizing = false;
    if (this._pendingSummarize) {
      const next = this._pendingSummarize;
      this._pendingSummarize = null;
      this.summarize(next);
    }
  }

  muteMicrophone(muted: boolean) {
    this._post(MSG.MUTE_MICROPHONE, { muted });
  }

  // ========================================================================
  // SECTION 6: Cleanup & Destroy
  // ========================================================================

  async destroy() {
    if (typeof this._authStateUnsubscribe === 'function') {
      this._authStateUnsubscribe();
      this._authStateUnsubscribe = null;
    }

    await this._tearDownIframe('DigitalHumanFrame destroyed');

    // Remove message listeners
    window.removeEventListener('message', this._onMessage);
    clearExternalContextDebounce(this as unknown as Parameters<typeof clearExternalContextDebounce>[0]);
    if (this._minigameUnsubscribe) {
      try { this._minigameUnsubscribe(); } catch (_) {}
      this._minigameUnsubscribe = null;
    }
    if (typeof this._audioResumeCleanup === 'function') {
      try { this._audioResumeCleanup(); } catch (_) {}
      this._audioResumeCleanup = null;
    }

    this._listeners = {};
  }
}

// Expose on window for non-module usage
if (typeof window !== 'undefined') {
  window.DigitalHumanFrame = DigitalHumanFrame;
}

