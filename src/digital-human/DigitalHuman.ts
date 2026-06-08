/**
 * DigitalHuman — Standalone ES module for virtual character rendering and AI session management.
 *
 * Responsibilities:
 *   1. Avatar rendering: Video / Live2D / WebP with lip sync
 *   2. AI Chat Session: Full lifecycle via KeepworkSDK's aiChat.createSession()
 *   3. Voice Chat: Real-time voice via AIChatRTC SDK class
 *
 * NOT responsible for: progress bar, game scoring, quick replies,
 * history dropdown, AI toolbox sidebar, file upload UI, inner thoughts display.
 *
 * Usage:
 *   import DigitalHuman from './libs/digitalhuman';
 *   const dh = new DigitalHuman({ sdk, container: document.getElementById('avatar-root') });
 *   await dh.initAvatar(videoActions);
 *   dh.on('message', ({ partialText }) => { ... });
 *   dh.on('bracketAction', ({ actionKey }) => dh.playAction(actionKey, 3));
 *   await dh.createSession({ system_prompt: '...', llm_model: 'keepwork-flash', tools: { fileOps: { enabled: true } } });
 *   await dh.send('Hello');
 *
 * initFromConfig (one-call setup from characterManager-style config):
 *   const dh = new DigitalHuman({ sdk, container });
 *   const info = await dh.initFromConfig({
 *     system_prompt: '你是一个友好的助手',
 *     llm_model: { model: 'keepwork-flash', temperature: 0.7, reasoning: false },
 *     videoActions: { '待机': { url: '...' }, '说话': { url: '...' } },
 *     bracketAction: { enabled: true, autoplay: true, duration: 3 },
 *     textToSpeech: { enabled: true, provider: 'speechRTC', voiceType: 'zh_female_cancan_mars_bigtts' },
 *     tools: { fileOps: { enabled: true, workspace: 'ws' }, web: { enabled: true } },
 *     avatar_only: false,
 *   });
 *   // bracketAction boolean => emit-only
 *   // bracketAction object  => emit + optional autoplay
 *   // info = { session, config }
 *   // Full config (character, quick_replies, etc.) available via dh.characterConfig
 *
 * videoActions format (supports pipe-separated aliases):
 *   {
 *     '待机': { url: 'https://cdn.../model.model3.json' },
 *     'talk': { url: 'https://cdn.../talk.mp4' },
 *     '高兴|happy': { url: 'https://cdn.../happy.mp4' },
 *     '难过|sad':   { url: 'https://cdn.../sad.mp4' },
 *   }
 *   Built-in aliases (always available): you can specify either '待机' or 'idle' or '0' for the idle action, 
 *     and '说话' or 'talk' or '1' for the talk action.
 *
 * playAction(actionKey, duration):
 *   dh.playAction('happy', 5);   // play for 5s then back to idle
 *   dh.playAction('talk', -1);   // play indefinitely
 *   dh.playAction(0);            // switch to idle (via alias)
 *   Repeated calls with the same key reset the timer without restarting the action.
 *
 * loadConfig (one-call setup from a config URL, JSON string, or object):
 *   // Load from a .md file (YAML frontmatter = config, body = system_prompt):
 *   await dh.loadConfig('https://example.com/character.md');
 *   // Load from a .json or .yml URL:
 *   await dh.loadConfig('https://example.com/character.json');
 *   // Load from an inline JSON string:
 *   await dh.loadConfig('{"system_prompt":"Hi","llm_model":"keepwork-flash"}');
 *   // Load from a plain object (equivalent to initFromConfig):
 *   await dh.loadConfig({ system_prompt: 'Hi', llm_model: 'keepwork-flash' });
 *
 *   Supported .md format (YAML frontmatter + markdown body as system_prompt):
 *   ---
 *   llm_model: keepwork-flash
 *   videoActions:
 *     待机:
 *       url: "https://cdn.../model.model3.json"
 *   tools:
 *     fileOps:
 *       enabled: true
 *       workspace: myWorkspace
 *   bracketAction:
 *     enabled: true
 *     autoplay: true
 *   textToSpeech:
 *     enabled: true
 *     provider: speechRTC
 *     voiceType: zh_female_cancan_mars_bigtts
 *   voiceChat:
 *     appId: "..."
 *   ---
 *   你是拉拉，一个友善的AI角色。请用简短、口语化的中文回复用户。
 */

// ============================================================================
// Constants
// ============================================================================

const DEEP_IDLE_DEBOUNCE_MS = 5000;
const DEFAULT_VOICE_HEARTBEAT_TIMEOUT_MS = 30000;
const DEFAULT_VOICE_HEARTBEAT_MAX_COUNT = 3;
const DEFAULT_VOICE_HEARTBEAT_COOLDOWN_MS = 60000;

const LIVE2D_SCRIPTS = [
  'https://cdn.keepwork.com/digitalhuman/live2d/pixi-7.4.3.min.js',
  'https://cdn.keepwork.com/digitalhuman/live2d/live2dcubismcore.min.js',
  'https://cdn.keepwork.com/digitalhuman/live2d/cubism4-lipsyncpatch-0.5.0-ls-8.min.js',
];

import { SummarizeAgent } from '../tools/SummarizeTool';
import AgentConfig from '../core/AgentConfig';
import AudioEngine from '../audio/AudioEngine';
import { autoFlushExternalContext, clearExternalContextDebounce, handleExternalContextMessage, stopPageRouterHeartbeat } from './DigitalHumanBridge';
import MinigameTools from '../tools/MinigameTools';
import DigitalHumanSubtitleOverlay, { DIGITAL_HUMAN_SUBTITLE_CSS } from './DigitalHumanSubtitleOverlay';
import {
  buildDigitalHumanSessionConfig,
  buildRestartToolConfig,
  markConfigSourceUrl,
  resolveEnabledToolCategories,
  resolveFileOpsConfig,
  resolveKeepHistoryConfig,
  resolveSearchPathEntries,
} from './DigitalHumanConfig';
import { createFrameMessages } from './DigitalHumanFrameMessages';
import { createEventEmitterMixin, parseDurationMs, parseHeartbeatMaxCount, parseIntervalToMs } from './DigitalHumanUtils';
import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('DigitalHuman');

// DigitalHuman 涉及头像渲染 / Live2D / PIXI / RTC / SDK 大量动态对象 + 字符串/数字基础值，
// 统一用 any 作为迁移期兜底类型（既覆盖对象也覆盖基础值，避免 Record 拒绝原始类型）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DHAny = any;

// 运行时全局（IIFE bundle 暴露在 window 上 / VolcEngine RTC SDK），TS 化时声明
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const AIChatRTC: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const VERTC: any;

const MOUTH_PARAM_ID = 'ParamMouthOpenY';
const BRACKET_ACTION_PARSE_WORD_LIMIT = 500;

const AVATAR_CSS = `
.dh-avatar-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.dh-avatar-root .dh-video-overlay {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  z-index: 1;
  transition: opacity 0.8s ease;
  opacity: 0;
  pointer-events: none;
}
.dh-avatar-root .dh-video-overlay.dh-visible { opacity: 1; }
.dh-avatar-root .dh-video-overlay.dh-hidden { opacity: 0; pointer-events: none; }
.dh-avatar-root .dh-video-talk { z-index: 2; }
.dh-avatar-root .dh-live2d-canvas {
  position: absolute;
  bottom: 0; left: 0;
  width: 100%; height: 100%;
  z-index: 1;
  pointer-events: none;
}
.dh-avatar-root .dh-live2d-canvas.dh-visible { opacity: 1; }
.dh-avatar-root .dh-live2d-canvas.dh-hidden { opacity: 0; pointer-events: none; }
.dh-avatar-root .dh-webp-img {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  object-fit: contain;
  z-index: 1;
  transition: opacity 0.5s ease;
  opacity: 0;
  pointer-events: none;
}
.dh-avatar-root .dh-webp-img.dh-visible { opacity: 1; }
.dh-avatar-root .dh-webp-img.dh-hidden { opacity: 0; pointer-events: none; }
.dh-avatar-root .dh-webp-talk { z-index: 2; }
`;

// ============================================================================
// EventEmitter Mixin
// ============================================================================

const EventEmitterMixin = createEventEmitterMixin({ label: 'DigitalHuman', logger: console });

// ============================================================================
// Helper: Load script once
// ============================================================================

const _loadedScripts = new Set();

function loadScript(src: DHAny) {
  if (_loadedScripts.has(src)) return Promise.resolve();
  if (document.querySelector(`script[src="${src}"]`)) {
    _loadedScripts.add(src);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { _loadedScripts.add(src); resolve(); };
    s.onerror = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(s);
  });
}

// ============================================================================
// Helper: Detect media type from URL
// ============================================================================

function detectMediaType(url: DHAny) {
  if (!url) return 'unknown';
  // Strip query string and fragment for extension detection
  const lower = url.split(/[?#]/)[0].toLowerCase();
  if (lower.endsWith('.model3.json')) return 'live2d';
  if (lower.endsWith('.webp')) return 'webp';
  return 'video';
}

/**
 * Parse layout params (scale, offsetY) from a URL's query string.
 * @param {string} url
 * @returns {{ scale: number|undefined, offsetY: number|undefined }}
 */
function parseLayoutParamsFromURL(url: DHAny) {
  const result: DHAny = {};
  if (!url) return result;
  try {
    const qIdx = url.indexOf('?');
    if (qIdx < 0) return result;
    const params = new URLSearchParams(url.slice(qIdx + 1));
    if (params.has('scale')) result.scale = Number(params.get('scale'));
    if (params.has('offsetY')) result.offsetY = Number(params.get('offsetY'));
  } catch (e: DHAny) { /* ignore parse errors */ }
  return result;
}

/**
 * Strip query string from a URL (for passing clean URLs to loaders).
 * @param {string} url
 * @returns {string}
 */
function stripQueryString(url: DHAny) {
  if (!url) return url;
  const qIdx = url.indexOf('?');
  return qIdx >= 0 ? url.slice(0, qIdx) : url;
}

/**
 * Extract complete English/Chinese parenthesized segments from text.
 * Nested brackets are ignored; only complete pairs are returned.
 * @param {string} text
 * @returns {{ raw: string, text: string, index: number, length: number }[]}
 */
function extractBracketSegments(text: DHAny) {
  if (typeof text !== 'string' || !text) return [];

  const matches = [];
  const regex = /\(([^()]+)\)|（([^（）]+)）/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const innerText = String(match[1] ?? match[2] ?? '').trim();
    if (!innerText) continue;
    matches.push({
      raw: match[0],
      text: innerText,
      index: match.index,
      length: match[0].length,
    });
  }

  return matches;
}

function stripBracketSegments(text: DHAny) {
  if (typeof text !== 'string' || !text) return '';

  return text
    .replace(/\([^()]*\)|（[^（）]*）/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripTrailingOpenBracketSegment(text: DHAny) {
  const content = String(text || '');
  if (!content) return '';

  const lastOpen = Math.max(content.lastIndexOf('('), content.lastIndexOf('（'));
  const lastClose = Math.max(content.lastIndexOf(')'), content.lastIndexOf('）'));
  if (lastOpen === -1 || lastOpen < lastClose) return content;
  return content.slice(0, lastOpen).trimEnd();
}

function computePCM16Level(bytes: DHAny) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2) return 0;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (!sampleCount) return 0;

  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index++) {
    const sample = view.getInt16(index * 2, true) / 32768;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms > 0.005 ? Math.min(1, rms * 4.5) : 0;
}

/**
 * Normalize text so alias matching works across spacing/case differences.
 * @param {string} text
 * @returns {string}
 */
function normalizeActionMatchText(text: DHAny) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s_\-()（）]+/g, '');
}

/**
 * Limit bracket-action parsing to the first N words of the text.
 * Uses Intl.Segmenter when available so CJK text is segmented more accurately.
 * @param {string} text
 * @param {number} [maxWords=BRACKET_ACTION_PARSE_WORD_LIMIT]
 * @returns {string}
 */
function limitTextToWordWindow(text: DHAny, maxWords = BRACKET_ACTION_PARSE_WORD_LIMIT) {
  if (typeof text !== 'string' || !text) return '';
  const limit = Number(maxWords);
  if (!Number.isFinite(limit) || limit <= 0) return '';

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    let wordCount = 0;
    let endIndex = text.length;

    for (const segment of segmenter.segment(text)) {
      if (!segment.isWordLike) continue;
      wordCount += 1;
      if (wordCount > limit) {
        endIndex = segment.index;
        break;
      }
    }

    return endIndex >= text.length ? text : text.slice(0, endIndex);
  }

  const wordRegex = /\S+/g;
  let wordCount = 0;
  let match;

  while ((match = wordRegex.exec(text)) !== null) {
    wordCount += 1;
    if (wordCount > limit) {
      return text.slice(0, match.index);
    }
  }

  return text;
}

// ============================================================================
// Helper: Inject CSS once
// ============================================================================

let _cssInjected = false;
function injectCSS() {
  if (_cssInjected) return;
  const style = document.createElement('style');
  style.textContent = `${AVATAR_CSS}\n${DIGITAL_HUMAN_SUBTITLE_CSS}`;
  document.head.appendChild(style);
  _cssInjected = true;
}

// ============================================================================
// DigitalHuman — Main Class
// ============================================================================

export default class DigitalHuman {
  // DigitalHuman 含上百个动态运行时字段，使用索引签名统一兜底类型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;

  /**
   * @param {Object} options
   * @param {Object} options.sdk - KeepworkSDK instance
   * @param {HTMLElement} [options.container] - Container element for avatar rendering
   * @param {Object} [options.config] - Initial configuration
   */
  constructor({ sdk, container, config, subtitle }: DHAny = {}) {
    if (!sdk) throw new Error('DigitalHuman requires a KeepworkSDK instance');
    this.sdk = sdk;
    this.container = container || null;
    this.config = config || {};
    this._subtitleOverlay = new DigitalHumanSubtitleOverlay(this, subtitle ?? this.config.subtitle);

    // Event emitter
    (EventEmitterMixin._initEvents as (this: DHAny) => void).call(this);

    // ── Avatar state ──
    this._avatarRoot = null;
    this._videoIdle = null;
    this._videoTalk = null;
    this._live2dCanvas = null;
    this._webpIdle = null;
    this._webpTalk = null;

    this.currentVideoType = null;
    this.isIdleVideoLoaded = false;
    this.isTalkVideoLoaded = false;
    this.isEnabled = false;
    this.idleMediaType = 'video';

    // Idle animation pool (idle2, idle3, …)
    this._idleVariants = [];       // Array of action config objects for idle2..idleN
    this._randomIdleTimer = null;  // Timer for scheduling random idle after debounce
    this._isPlayingRandomIdle = false; // Whether currently showing a random idle variant
    this._firstIdleLoadDone = false;   // True after the very first idle load completes

    // Timers
    this._hideTimeout = null;
    this._transitionTimeout = null;
    this._webpIdleDebounce = null;
    this._loadingPromises = new Map();

    // Live2D state
    this.live2dApp = null;
    this.live2dModel = null;
    this.live2dMode = false;
    this._live2dWebpOverlayActive = false;
    this._live2dLipSyncValue = 0;
    this._live2dLipSyncIds = [MOUTH_PARAM_ID];
    this._live2dLipSyncHandler = null;
    this._live2dResizeHandler = null;
    this._live2dViewportHandler = null;
    this._live2dResizeObserver = null;
    this._live2dRelayoutFrame = null;
    this._live2dRelayoutTimeout = null;
    this._live2dInitPromise = null;
    this.hostLive2DSessionActive = false;

    // Webp state
    this.webpMode = false;

    // Audio lip sync state
    this._ttsAudioCtx = null;
    this._ttsSource = null;
    this._lipSyncAnalyser = null;
    this._lipSyncRaf = null;
    this._audioResumeCleanups = [];

    // RTC lip sync (smooth interpolation)
    this._rtcLipSyncTarget = 0;
    this._rtcLipSyncValue = 0;
    this._rtcLipSyncFrameId = 0;

    // avatarOnlyMode flag (can be set externally)
    this.avatarOnlyMode = false;

    // ── AI session state ──
    this._aiChatSession = null;
    this._sessionConfig = null;
    this._textConnectionEpoch = 0;
    this._activeTextSends = new Set();
    this._queuedTextSends = [];
    this._textSendQueueRunning = false;

    // ── Voice chat state ──
    this._rtc = null;
    this._vcSession = null;
    this._lastVoiceChatPreset = null;

    // ── Text speech state ──
    this._textSpeechSession = null;
    this._textSpeechRequestId = 0;
    this._textSpeechQueue = [];
    this._textSpeechQueueRunning = false;
    this._textSpeechTurnId = 0;
    this._textSpeechPlaybackMeta = null;
    this._textSpeechStreamState = null;
    this._textSpeechStreamSilenceTimer = null;
    this._textSpeechStreamFailedTurnId = 0;
    this._textSpeechStartEmittedId = 0;

    // ── Mute-while-speaking state ──
    this._muteWhileSpeakingActive = false;
    this._muteWhileSpeakingTimer = null;

    // ── Unified session state ──
    // Queue user voice inputs and commit to text history only as IO pairs.
    this._vcQueuedUserInputs = [];
    this._vcDirectInputPending = [];

    // ── Summarize agent ──
    this._summarizeAgent = null;
    // Summarize queue: only one summarization runs at a time; subsequent calls are merged
    this._summarizing = false;
    this._pendingSummarize = null;
    this._summarizeAutoTriggerSignature = null;
    this._summarizeTimer = null;
    this._summarizeLastActivity = 0;

    // ── keepHistory state ──
    // When enabled, conversation rounds are persisted to history.md in the workspace.
    this._keepHistoryConfig = null;

    // ── Active / inactive runtime state ──
    this._active = false;
    this._logicalVoiceChatActive = false;
    this._inactiveVoiceStopTimer = null;
    this._voiceIdleTimer = null;
    this._voiceLifecycleConfig = null;
    this._voiceLifecycleState = 'idle';
    this._voiceLifecycleHiddenAt = 0;
    this._voiceLifecycleDisconnectedReason = '';
    this._voiceLifecycleVisibilityHandler = null;
    this._voiceLifecyclePagehideHandler = null;

    // ── Voice silence heartbeat state ──
    this._voiceHeartbeatConfig = null;
    this._voiceHeartbeatTimer = null;
    this._voiceHeartbeatToken = 0;
    this._voiceHeartbeatLastUserActivityAt = 0;
    this._voiceHeartbeatLastSentAt = 0;
    this._voiceHeartbeatCount = 0;
    this._voiceHeartbeatAgentState = 0;

    // ── Page router config (maps page names to agent configs) ──
    this._pageRouters = null;
    this._currentPage = null;
    this._pageRouterWakeupCalled = false;
    this._pageRouterHeartbeatTimer = null;
    this._pageRouterHeartbeatToken = 0;

    // ── External context debounce state (dh:send / dh:context from child iframes) ──
    this._externalContextDebounceTimer = null;
    this._externalContextSkipHistory = false;

    // Delayed empty-prompt restartAgent request, cancelled by explicit prompt restarts.
    this._restartAgentDebounce = null;
    this._restartAgentActiveKey = null;
    this._restartAgentRecent = null;

    // ── Slash command registry ──
    this._commands = {};
    this._registerBuiltinCommands();
    this._registerDigitalHumanTool();
    this._registerMinigameTool();

    this._bindAudioResumeTarget(this.container);
    this._authStateUnsubscribe = this.sdk?.onAuthStateChange?.((change: DHAny) => this.handleAuthStateChange(change)) || null;
  }

  // ── Mix in event emitter methods ──
  get on() { return (EventEmitterMixin.on as DHAny).bind(this); }
  get off() { return (EventEmitterMixin.off as DHAny).bind(this); }
  get emit() { return (EventEmitterMixin.emit as DHAny).bind(this); }

  // ========================================================================
  // SECTION 0.5: Slash Command Registry
  // ========================================================================

  /**
   * Register a slash command that can be intercepted by send().
   * @param {string} name - Command name (without leading /)
   * @param {Object} def
   * @param {string} def.description - Short help text
   * @param {boolean} [def.needsArg=true] - Whether the command requires an argument
   * @param {function(string, Object):void|Promise<void>} def.handler - Receives (argString, thisDigitalHuman)
   */
  registerCommand(name: DHAny, { description, needsArg = true, handler }: DHAny) {
    this._commands[name.toLowerCase()] = { description, needsArg, handler };
  }

  /**
   * Unregister a slash command.
   * @param {string} name
   */
  unregisterCommand(name: DHAny) {
    delete this._commands[name.toLowerCase()];
  }

  /**
   * List all registered slash commands.
   * @returns {Array<{ name: string, description: string, needsArg: boolean }>}
   */
  listCommands() {
    return (Object.entries(this._commands as DHAny) as [string, DHAny][]).map(([name, { description, needsArg }]) => ({ name, description, needsArg }));
  }

  /**
   * Try to dispatch a slash command from a user message string.
   * @param {string} text
   * @returns {{ handled: boolean, name?: string, result?: * }}
   */
  tryCommand(text: DHAny) {
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

  /** @private */
  _registerBuiltinCommands() {
    this.registerCommand('context', {
      description: 'Send background context to the LLM (no reply)',
      handler(arg: DHAny, dh: DHAny) { dh.sendContext(arg); },
    });
    this.registerCommand('contextWithHistory', {
      description: 'Send background context and persist as a Q/A pair in history',
      handler(arg: DHAny, dh: DHAny) { dh.sendContext(arg, { insertToHistory: true }); },
    });
    this.registerCommand('tts', {
      description: 'Send text to TTS (works in both voice and text modes)',
      handler(arg: DHAny, dh: DHAny) { dh.sendTTS(arg); },
    });
    this.registerCommand('action', {
      description: 'Play an avatar action by key',
      handler(arg: DHAny, dh: DHAny) { dh.playAction(arg, 3); },
    });
    this.registerCommand('summarize', {
      description: 'Force trigger a conversation summary',
      needsArg: false,
      handler(_arg: DHAny, dh: DHAny) {
        dh.summarize({ trigger: 'manual', onlyWhenNeeded: false });
        return { triggered: true };
      },
    });
    this.registerCommand('help', {
      description: 'List available commands',
      needsArg: false,
      handler(_arg: DHAny, dh: DHAny) {
        return dh.listCommands();
      },
    });
  }

  // ========================================================================
  // SECTION 1: Avatar DOM Creation & CSS Injection
  // ========================================================================

  /**
   * Create the avatar DOM elements inside the container.
   * @param {HTMLElement} [container] - Override container
   */
  _createAvatarDOM(container?: DHAny) {
    injectCSS();

    const root = document.createElement('div');
    root.className = 'dh-avatar-root';
    this._avatarRoot = root;

    // Video idle
    const videoIdle = document.createElement('video');
    videoIdle.className = 'dh-video-overlay dh-video-idle dh-hidden';
    videoIdle.setAttribute('playsinline', '');
    videoIdle.setAttribute('loop', '');
    videoIdle.muted = true;
    videoIdle.defaultMuted = true;
    const sourceIdle = document.createElement('source');
    sourceIdle.type = 'video/mp4';
    videoIdle.appendChild(sourceIdle);
    root.appendChild(videoIdle);
    this._videoIdle = videoIdle;

    // Video talk
    const videoTalk = document.createElement('video');
    videoTalk.className = 'dh-video-overlay dh-video-talk dh-hidden';
    videoTalk.setAttribute('playsinline', '');
    videoTalk.setAttribute('loop', '');
    videoTalk.muted = true;
    videoTalk.defaultMuted = true;
    const sourceTalk = document.createElement('source');
    sourceTalk.type = 'video/mp4';
    videoTalk.appendChild(sourceTalk);
    root.appendChild(videoTalk);
    this._videoTalk = videoTalk;

    // Live2D canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'dh-live2d-canvas dh-hidden';
    root.appendChild(canvas);
    this._live2dCanvas = canvas;

    // Webp idle
    const webpIdle = document.createElement('img');
    webpIdle.className = 'dh-webp-img dh-webp-idle dh-hidden';
    webpIdle.alt = '';
    root.appendChild(webpIdle);
    this._webpIdle = webpIdle;

    // Webp talk
    const webpTalk = document.createElement('img');
    webpTalk.className = 'dh-webp-img dh-webp-talk dh-hidden';
    webpTalk.alt = '';
    root.appendChild(webpTalk);
    this._webpTalk = webpTalk;

    (container || this.container).appendChild(root);
    this._bindAudioResumeTarget(root);
    this._subtitleOverlay.attachRoot(root);
  }

  setSubtitleConfig(config: DHAny = {}) {
    return this._subtitleOverlay.setConfig(config);
  }

  getSubtitleConfig() {
    return this._subtitleOverlay.getConfig();
  }

  clearSubtitle(options?: DHAny) {
    void options;
    this._subtitleOverlay.clear();
  }

  showSubtitle(text: DHAny, options: DHAny = {}) {
    this._subtitleOverlay.updateAssistant(text, { definite: true, paragraph: true, ...options });
  }

  _getAudioEngine() {
    return this.sdk?.audioEngine || AudioEngine.getShared();
  }

  _bindAudioResumeTarget(target: DHAny) {
    if (!target) return;
    const cleanup = this._getAudioEngine().bindUserGesture(target);
    if (typeof cleanup === 'function') {
      this._audioResumeCleanups.push(cleanup);
    }
  }

  _clearAudioResumeBindings() {
    while (this._audioResumeCleanups.length) {
      const cleanup = this._audioResumeCleanups.pop();
      try {
        cleanup();
      } catch (_: DHAny) {}
    }
  }

  // ========================================================================
  // SECTION 2: Avatar Rendering — Init & Mode Detection
  // ========================================================================

  // ── Default videoActions (Live2D femalewaiter) ──
  static DEFAULT_VIDEO_ACTIONS = {
    '待机': { url: 'https://cdn.keepwork.com/digitalhuman/live2d/assets/femalewaiter/femalewaiter.model3.json' },
  };

  // ── Built-in action aliases ──
  // '待机'/'idle'/0 and '说话'/'talk'/1 are always recognized.
  // Canonical internal values are 'idle' and 'talk'.
  static BUILTIN_ALIASES: DHAny = {
    '待机': 'idle', 'idle': 'idle', '0': 'idle',
    '说话': 'talk', 'talk': 'talk', '1': 'talk',
    'speak': 'talk', 'speaking': 'talk', 'talking': 'talk', 'say': 'talk', 'saying': 'talk',
  };

  /**
   * Normalize videoActions: expand pipe-separated keys into individual entries
   * and merge built-in aliases. Returns a new flat object.
   * @param {Object} raw - e.g. { '待机|idle|0': { url }, '高兴|happy': { url } }
   * @returns {Object} Normalized map keyed by every alias
   */
  _normalizeVideoActions(raw: DHAny) {
    const normalized: DHAny = {};
    for (const compositeKey of Object.keys(raw)) {
      const value = raw[compositeKey];
      const parts = String(compositeKey).split('|').map(s => s.trim()).filter(Boolean);
      for (const alias of parts) {
        normalized[alias] = value;
      }
    }
    // Ensure built-in aliases all point to the same config.
    // First, resolve each canonical key from any existing alias.
    const canonicalConfigs: DHAny = {};
    for (const [alias, canonical] of Object.entries(DigitalHuman.BUILTIN_ALIASES) as [string, DHAny][]) {
      if (normalized[alias] && !canonicalConfigs[canonical]) {
        canonicalConfigs[canonical] = normalized[alias];
      }
    }
    // Then propagate canonical config to all aliases that lack one.
    for (const [alias, canonical] of Object.entries(DigitalHuman.BUILTIN_ALIASES) as [string, DHAny][]) {
      if (!normalized[alias] && canonicalConfigs[canonical]) {
        normalized[alias] = canonicalConfigs[canonical];
      }
    }
    return normalized;
  }

  /**
   * Resolve an action key through aliases to its config object.
   * @param {string|number} key
   * @returns {Object|undefined} The action config { url, ... }
   */
  _resolveAction(key: DHAny) {
    if (!this._videoActions) return undefined;
    // Direct hit
    if (this._videoActions[key]) return this._videoActions[key];
    // Try built-in alias
    const canonical = DigitalHuman.BUILTIN_ALIASES[key];
    if (canonical && this._videoActions[canonical]) return this._videoActions[canonical];
    return undefined;
  }

  /**
   * Collect idle variant configs (idle2, idle3, …) from _videoActions.
   * These are used for random idle animations when voice mode is off.
   */
  _collectIdleVariants() {
    this._idleVariants = [];
    if (!this._videoActions) return;
    const mainIdleConfig = this._resolveAction('idle');
    const talkConfig = this._resolveAction('talk');
    // Match keys like 'idle2', 'idle3', etc.
    const idlePattern = /^idle(\d+)$/i;
    const seen = new Set();
    for (const [key, config] of Object.entries(this._videoActions)) {
      if (idlePattern.test(key) && config !== mainIdleConfig && config !== talkConfig && !seen.has(config)) {
        seen.add(config);
        this._idleVariants.push(config);
      }
    }
    if (this._idleVariants.length > 0) {
      console.log(`[DigitalHuman] Found ${this._idleVariants.length} idle variant(s)`);
    }
  }

  /**
   * Schedule a random idle variant to play after a debounce period.
   * Called from switchToIdle() when conditions are met:
  *   - voice chat is NOT active, or DigitalHuman is inactive
   *   - there are idle variants available
   * The main idle plays immediately; after DEEP_IDLE_DEBOUNCE_MS a random variant is picked.
   * @param {number} [delayMs] - Override debounce duration (0 for immediate, e.g. on first load)
   */
  _scheduleRandomIdle(delayMs?: DHAny) {
    this._cancelRandomIdle();
    if (this._idleVariants.length === 0) return;
    if (this.isVoiceChatActive && this._active) return;

    const delay = delayMs !== undefined ? delayMs : DEEP_IDLE_DEBOUNCE_MS;
    // console.log(`[DigitalHuman] Scheduling random idle in ${delay}ms`);
    this._randomIdleTimer = setTimeout(() => {
      this._randomIdleTimer = null;
      if (!this.isEnabled) { console.log('[DigitalHuman] Random idle skipped: not enabled'); return; }
      if (this.isVoiceChatActive && this._active) { console.log('[DigitalHuman] Random idle skipped: voice chat active'); return; }
      if (this._currentPlayAction && this._currentPlayAction !== 'idle') {
        console.log(`[DigitalHuman] Random idle skipped: custom action '${this._currentPlayAction}' active`);
        return;
      }
      // console.log(`[DigitalHuman] Random idle timer fired, variants=${this._idleVariants.length}`);
      this._playRandomIdleVariant();
    }, delay);
  }

  /**
   * Cancel any pending random idle scheduling.
   */
  _cancelRandomIdle() {
    if (this._randomIdleTimer) {
      console.log('[DigitalHuman] Cancelling random idle timer', new Error().stack?.split('\n')[2]?.trim());
      clearTimeout(this._randomIdleTimer);
      this._randomIdleTimer = null;
    }
    this._isPlayingRandomIdle = false;
  }

  /**
   * Pick and play a random idle variant from the pool.
   */
  _playRandomIdleVariant() {
    if (this._idleVariants.length === 0) return;
    const idx = Math.floor(Math.random() * this._idleVariants.length);
    const variant = this._idleVariants[idx];
    if (!variant?.url) return;

    // console.log(`[DigitalHuman] Playing random idle variant ${idx + 2} (${variant.url.split('/').pop()})`);
    this._isPlayingRandomIdle = true;

    if (this.live2dMode) {
      if (detectMediaType(variant.url) === 'webp') {
        this._playLive2DWebpOverlay(variant.url);
      } else {
        this.playMotion(['Tap', 'TapBody'], 2);
      }
      this.currentVideoType = 'idle';
    } else if (this.webpMode) {
      this._playWebpAction(variant.url);
      this.currentVideoType = 'idle';
    } else {
      this._playActionVideo(variant.url);
      this.currentVideoType = 'idle';
    }
  }

  /**
   * Get all available actions as pipe-joined alias strings.
   * Each entry is a string like 'idle|待机' or '写字|记录|writing'.
   * Built-in alias keys are included for idle/talk entries.
   * idle and talk entries (if present) are returned first.
   * @returns {string[]}
   */
  getActions() {
    if (!this._videoActions) return [];

    const builtinKeys = new Set(Object.keys(DigitalHuman.BUILTIN_ALIASES).map(String));
    const configToKeys = new Map();

    // Collect all keys per config, separating builtin from user-defined
    for (const [key, config] of Object.entries(this._videoActions)) {
      if (!configToKeys.has(config)) configToKeys.set(config, []);
      configToKeys.get(config).push(key);
    }

    // Deduplicate: keep unique non-numeric keys per config
    const idleConfig = this._resolveAction('idle');
    const talkConfig = this._resolveAction('talk');
    const top = [];
    const rest = [];

    for (const [config, keys] of configToKeys) {
      // Filter out numeric keys and deduplicate
      const unique = [...new Set(keys.filter((k: DHAny) => !/^\d+$/.test(k)))];
      if (unique.length === 0) continue;
      const str = unique.join('|');
      if (config === idleConfig || config === talkConfig) top.push(str);
      else rest.push(str);
    }
    return [...top, ...rest];
  }

  /**
   * Resolve normalized bracket-action options from request/session/config state.
   * Boolean `true` enables event emission only; object form can also enable autoplay.
    * Supported object keys: enabled, autoplay/autoPlay, duration/playDuration.
    * Bracket scanning is always limited to the first 500 words of the text.
   * @param {Object} [options]
   * @returns {{ enabled: boolean, autoplay: boolean, duration: number }}
   */
  _getBracketActionOptions(options: DHAny) {
    const sources = [
      options?.bracketAction,
      options?.autoBracketAction,
      this._sessionConfig?.bracketAction,
      this._sessionConfig?.autoBracketAction,
      this.characterConfig?.bracketAction,
      this.characterConfig?.autoBracketAction,
      this.config?.bracketAction,
      this.config?.autoBracketAction,
    ];

    for (const source of sources) {
      if (source === undefined || source === null) continue;

      if (typeof source === 'object') {
        const durationValue = source.duration ?? source.playDuration;
        const parsedDuration = Number(durationValue);
        return {
          enabled: source.enabled !== false,
          autoplay: source.autoplay === true || source.autoPlay === true,
          duration: Number.isFinite(parsedDuration) ? parsedDuration : 3,
        };
      }

      return {
        enabled: !!source,
        autoplay: false,
        duration: 3,
      };
    }

    return {
      enabled: false,
      autoplay: false,
      duration: 3,
    };
  }

  /**
   * Whether LLM bracket-action scanning is enabled for the current request.
   * Priority: request options -> session config -> character config -> constructor config.
   * Supported keys: bracketAction / autoBracketAction.
   * @param {Object} [options]
   * @returns {boolean}
   */
  _isBracketActionEnabled(options: DHAny) {
    return this._getBracketActionOptions(options).enabled;
  }

  /**
   * Resolve summarization options from request/session/config state.
   * Priority: request options -> summarizeAgent config -> session config -> character config -> constructor config.
    *
    * These options drive all DigitalHuman-owned summarization entry points:
    * - manual `summarize()` calls
    * - post-send auto checks (`trigger: 'auto'`)
    * - idle timer checks (`trigger: 'silentTick'`)
    *
    * Startup history restore via keepHistory is intentionally excluded. Existing
    * history is loaded into the session, but summarization is not auto-triggered
    * just because restored messages already exceed the thresholds.
   *
   * Supported shapes:
   *  - `true`  => enable with defaults (maxRounds=20, maxTextLength=8000, keepRecentRounds=3)
   *  - `{ enabled: true, maxRounds, maxTextLength, keepRecentRounds, prompt, model, enableTools }`
   *  - `summarizeAgent` config: presence implies enabled=true; thresholds and mode are read from it
   *
   * @param {Object} [options]
   * @returns {{ enabled: boolean, maxRounds: number, maxTextLength: number, keepRecentRounds: number, prompt: string|undefined, model: string|undefined, enableTools: string[]|undefined, mode: string, async: boolean, silentTickInterval: number }}
   */
  _getSummarizationOptions(options?: DHAny) {
    // Check summarizeAgent config first — its presence implies enabled
    const agentSources = [
      options?.summarizeAgent,
      this._sessionConfig?.summarizeAgent,
      this.characterConfig?.summarizeAgent,
      this.config?.summarizeAgent,
    ];
    for (const agent of agentSources) {
      if (agent && typeof agent === 'object') {
        return {
          enabled: true,
          maxRounds: Number(agent.maxRounds) || 20,
          maxTextLength: Number(agent.maxTextLength) || 8000,
          keepRecentRounds: Number(agent.keepRecentRounds) || 3,
          prompt: undefined,
          model: undefined,
          enableTools: undefined,
          mode: agent.mode || 'append',
          async: agent.async !== false,
          silentTickInterval: Number(agent.silentTickInterval) || 0,
        };
      }
    }

    const sources = [
      options?.summarization,
      this._sessionConfig?.summarization,
      this.characterConfig?.summarization,
      this.config?.summarization,
    ];

    for (const source of sources) {
      if (source === undefined || source === null) continue;

      if (typeof source === 'object') {
        return {
          enabled: source.enabled !== false,
          maxRounds: Number(source.maxRounds) || 20,
          maxTextLength: Number(source.maxTextLength) || 8000,
          keepRecentRounds: Number(source.keepRecentRounds) || 3,
          prompt: source.prompt || undefined,
          model: source.model || undefined,
          enableTools: Array.isArray(source.enableTools) ? source.enableTools : (source.enableTools ? [source.enableTools] : undefined),
          mode: source.mode || 'replace',
          async: source.async !== false,
          silentTickInterval: Number(source.silentTickInterval) || 0,
        };
      }

      return {
        enabled: !!source,
        maxRounds: 20,
        maxTextLength: 8000,
        keepRecentRounds: 3,
        prompt: undefined,
        model: undefined,
        enableTools: undefined,
        mode: 'replace',
        async: true,
        silentTickInterval: 0,
      };
    }

    return {
      enabled: false,
      maxRounds: 20,
      maxTextLength: 8000,
      keepRecentRounds: 3,
      prompt: undefined,
      model: undefined,
      enableTools: undefined,
      mode: 'replace',
      async: true,
      silentTickInterval: 0,
    };
  }

  // ── Summarize Agent ──

  /**
   * Load and initialize a dedicated summarize agent from a config source.
   * Delegates to the SummarizeAgent instance for session creation and CopilotTools override.
   * @param {string|Object} source - Config URL, JSON string, or config object
   * @returns {Promise<Object>} The parsed agent config
   */
  async loadSummarizeAgentConfig(source: DHAny) {
    if (!source) return null;

    const config = typeof source === 'object' && !Array.isArray(source)
      ? source
      : await DigitalHuman.fetchConfig(source);

    if (this._summarizeAgent) {
      await this._summarizeAgent.loadConfig(config);
    } else {
      console.warn('[DigitalHuman] _summarizeAgent is null — createSession may not have been called yet');
    }

    return config;
  }

  /**
   * Send background context to both the text ChatSession and the voice RTC session.
   * In text mode, context is queued via ChatSession.sendContext() and flushed
   * automatically on the next ChatSession.send() or voice-to-text mirror commit.
   * In voice mode, context is also sent immediately via the RTC binary channel.
   *
   * When `insertToHistory` is true, a fake user/assistant pair is also written
   * into the session message list and persisted to the keepHistory files.
   * The user message is the context text and the assistant reply is "(OK)".
   * This pair is excluded from dialog summarization.
   * @param {string} text - Context text to inject
   * @param {Object} [options]
   * @param {boolean} [options.insertToHistory=false] - Also persist as a Q/A pair in history
   */
  sendContext(text: DHAny, options: DHAny = {}) {
    if (!text) return;
    const str = String(text);

    // Always queue on the text ChatSession (consumed on next send/mirror commit)
    if (this._aiChatSession) {
      this._aiChatSession.sendContext(str);
    }

    // If voice chat is active, also send immediately via RTC binary channel
    if (this._vcSession?.isActive) {
      try {
        this._vcSession.sendContext(str);
      } catch (e: DHAny) {
        console.warn('[DigitalHuman] sendContext to voice failed:', e.message);
      }
    }

    // Optionally persist as a fake Q/A pair in history (skips summarization)
    if (options?.insertToHistory && this._aiChatSession?.messages && this._keepHistoryConfig?.enabled) {
      const ts = Date.now();
      const wrappedContent = str;
      this._aiChatSession.messages.push(
        { role: 'user', content: wrappedContent, _ts: ts, _contextOnly: true },
        { role: 'assistant', content: '(OK)', _ts: ts, _contextOnly: true },
      );
      void this._saveKeepHistory();
    }
  }

  /**
   * Handle an external send message. Optionally interrupts current speech/response,
   * then sends the message through the normal send() flow.
   * @private
   * @param {Object} msg - { type: 'dh:send', text: string, interrupt?: boolean, options?: object }
   */
  async _handleExternalSend(msg: DHAny) {
    const text = String(msg.text || '').trim();
    if (!text) return;

    try {
      // Interrupt current speech/response (default: true)
      const interrupt = msg.interrupt !== false;
      if (interrupt) {
        await this._stopTextSpeechPlayback();
      }
      // Flush any buffered context before sending the real message
      this._flushExternalContext();
      // Send the message
      await this.send(text, msg.options || {});
    } catch (e: DHAny) {
      console.warn('[DigitalHuman] External send failed:', e.message);
      this.emit('error', { error: e, stage: 'externalSend' });
    }
  }

  /**
   * Handle an external context message. Buffers context and optionally starts
   * a debounce timer. Default debounce is Infinity (context only sent with
   * next user message). Finite debounce auto-sends with "(continue)" after
   * the specified milliseconds.
   * @private
   * @param {Object} msg - { type: 'dh:context', text: string, debounce?: number }
   */
  _handleExternalContext(msg: DHAny) {
    handleExternalContextMessage(this as unknown as Parameters<typeof handleExternalContextMessage>[0], msg);
  }

  /**
   * Auto-flush buffered context by sending a "(continue)" user message.
   * @private
   */
  async _autoFlushExternalContext() {
    try {
      await autoFlushExternalContext(this as unknown as Parameters<typeof autoFlushExternalContext>[0]);
    } catch (e: DHAny) {
      console.warn('[DigitalHuman] External context auto-flush failed:', e.message);
    }
  }

  /** Flush buffered context (cancel debounce timer, context already queued). @private */
  _flushExternalContext() {
    clearExternalContextDebounce(this as unknown as Parameters<typeof clearExternalContextDebounce>[0]);
    this._externalContextSkipHistory = false;
  }

  /** @private */
  _normalizeVoiceHeartbeatConfig(value: DHAny, fallback: DHAny = {}) {
    if (value === false) return { ...fallback, enabled: false };
    const hasExplicitConfig = value !== undefined && value !== null;
    if (value === true || value === undefined || value === null) value = {};
    if (typeof value !== 'object') value = {};

    const base = {
      enabled: false,
      silenceTimeoutMs: DEFAULT_VOICE_HEARTBEAT_TIMEOUT_MS,
      silenceMaxCount: DEFAULT_VOICE_HEARTBEAT_MAX_COUNT,
      cooldownMs: DEFAULT_VOICE_HEARTBEAT_COOLDOWN_MS,
      silenceText: '',
      silencePrompt: '',
      sendOptions: null,
      ...fallback,
      ...value,
    };

    base.silenceTimeoutMs = parseDurationMs(base.silenceTimeoutMs, DEFAULT_VOICE_HEARTBEAT_TIMEOUT_MS);
    base.cooldownMs = parseDurationMs(base.cooldownMs, DEFAULT_VOICE_HEARTBEAT_COOLDOWN_MS);

    const rawMaxCount = Number(base.silenceMaxCount ?? base.maxCount ?? DEFAULT_VOICE_HEARTBEAT_MAX_COUNT);
    base.silenceMaxCount = Number.isFinite(rawMaxCount) && rawMaxCount >= 0
      ? Math.floor(rawMaxCount)
      : DEFAULT_VOICE_HEARTBEAT_MAX_COUNT;

    const hasPrompt = Boolean(String(base.silenceText || base.silencePrompt || '').trim());
    base.enabled = hasPrompt && (base.enabled === true || (base.enabled !== false && hasExplicitConfig));
    return base;
  }

  /** @private */
  _resolveVoiceHeartbeatConfig(preset: DHAny = {}, options: DHAny = {}) {
    const defaults = this._normalizeVoiceHeartbeatConfig(this.config?.voiceHeartbeat);
    const fromCharacterVoiceChat = this._normalizeVoiceHeartbeatConfig(this.characterConfig?.voiceChat?.voiceHeartbeat, defaults);
    const fromCharacter = this._normalizeVoiceHeartbeatConfig(this.characterConfig?.voiceHeartbeat, fromCharacterVoiceChat);
    const fromPresetVoiceChat = this._normalizeVoiceHeartbeatConfig(preset?.voiceChat?.voiceHeartbeat, fromCharacter);
    const fromPreset = this._normalizeVoiceHeartbeatConfig(preset?.voiceHeartbeat, fromPresetVoiceChat);
    return this._normalizeVoiceHeartbeatConfig(options?.voiceHeartbeat, fromPreset);
  }

  /** @private */
  _setupVoiceHeartbeat(config: DHAny) {
    this._clearVoiceHeartbeat({ resetCount: true });
    this._voiceHeartbeatConfig = config?.enabled ? config : null;
    this._voiceHeartbeatAgentState = 0;
    this._voiceHeartbeatLastUserActivityAt = Date.now();
    this._voiceHeartbeatLastSentAt = 0;
    this._voiceHeartbeatCount = 0;
  }

  /** @private */
  _clearVoiceHeartbeat(options: DHAny = {}) {
    this._voiceHeartbeatToken += 1;
    if (this._voiceHeartbeatTimer) {
      clearTimeout(this._voiceHeartbeatTimer);
      this._voiceHeartbeatTimer = null;
    }
    if (options.resetCount) {
      this._voiceHeartbeatCount = 0;
      this._voiceHeartbeatLastSentAt = 0;
    }
  }

  /** @private */
  _isVoiceHeartbeatAgentIdle() {
    const AGENT_STATE = typeof AIChatRTC !== 'undefined' ? AIChatRTC.AGENT_STATE
      : (window as DHAny).AIChatRTC?.AGENT_STATE || ({} as DHAny);
    return this._voiceHeartbeatAgentState === AGENT_STATE.LISTENING
      || this._voiceHeartbeatAgentState === AGENT_STATE.FINISHED
      || this._voiceHeartbeatAgentState === AGENT_STATE.INTERRUPTED;
  }

  /** @private */
  _canRunVoiceHeartbeat(config = this._voiceHeartbeatConfig) {
    return Boolean(
      config?.enabled
      && this._active
      && this._logicalVoiceChatActive
      && this._vcSession?.isActive
      && this._voiceLifecycleState !== 'standby'
      && this._voiceLifecycleState !== 'disconnected'
      && !this._isDocumentHidden()
      && this._isVoiceHeartbeatAgentIdle()
    );
  }

  /** @private */
  _scheduleVoiceHeartbeat() {
    this._clearVoiceHeartbeat();
    const config = this._voiceHeartbeatConfig;
    if (!config?.enabled || !this._canRunVoiceHeartbeat()) return;
    if (config.silenceMaxCount <= 0 || this._voiceHeartbeatCount >= config.silenceMaxCount) return;

    const elapsed = Date.now() - (this._voiceHeartbeatLastUserActivityAt || Date.now());
    const delayMs = Math.max(0, config.silenceTimeoutMs - elapsed);
    const token = this._voiceHeartbeatToken;
    this._voiceHeartbeatTimer = setTimeout(() => {
      this._voiceHeartbeatTimer = null;
      if (token !== this._voiceHeartbeatToken) return;
      void this._onVoiceHeartbeatTimeout();
    }, delayMs);
  }

  /** @private */
  _scheduleVoiceHeartbeatAfter(delayMs: DHAny) {
    this._clearVoiceHeartbeat();
    const config = this._voiceHeartbeatConfig;
    if (!config?.enabled || !this._canRunVoiceHeartbeat()) return;
    const token = this._voiceHeartbeatToken;
    this._voiceHeartbeatTimer = setTimeout(() => {
      this._voiceHeartbeatTimer = null;
      if (token !== this._voiceHeartbeatToken) return;
      void this._onVoiceHeartbeatTimeout();
    }, Math.max(0, delayMs));
  }

  /** @private */
  _resetVoiceHeartbeatActivity() {
    this._voiceHeartbeatLastUserActivityAt = Date.now();
    this._scheduleVoiceHeartbeat();
  }

  /** @private */
  _formatVoiceHeartbeatText(rawText: DHAny, meta: DHAny) {
    return String(rawText || '')
      .replaceAll('{{silenceMs}}', String(meta.silenceMs))
      .replaceAll('{{silenceSec}}', String(meta.silenceSec))
      .replaceAll('{{count}}', String(meta.count))
      .replaceAll('{{maxCount}}', String(meta.maxCount));
  }

  /**
   * Trigger the voice heartbeat path immediately from app code.
   * This is useful when the app already knows the current business state and
   * wants to avoid asking the LLM to inspect the page with read_app.
   * @param {string|Object} input - Explicit heartbeat text, or { text, reason, context, data }.
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async triggerVoiceHeartbeat(input: DHAny = {}, options: DHAny = {}) {
    const payload = typeof input === 'string' ? { text: input } : (input && typeof input === 'object' ? input : {});
    const explicitText = payload.text ?? payload.silenceText ?? payload.silencePrompt ?? payload.prompt ?? '';
    const contextText = payload.context ? String(payload.context) : '';
    const rawText = [explicitText, contextText].filter((item) => String(item || '').trim()).join('\n');
    const page = payload.page || payload.currentPage || this._currentPage || '';
    const trigger = payload.reason || payload.type || 'app';
    const {
      text, silenceText, silencePrompt, prompt, context, options: payloadOptions,
      reason, type, page: payloadPage, currentPage: payloadCurrentPage,
      ...extraMeta
    } = payload;

    return this._sendVoiceHeartbeat({
      trigger,
      rawText,
      meta: {
        source: 'app',
        currentPage: page,
        appReason: trigger,
        ...extraMeta,
      },
      options: {
        ...(payloadOptions && typeof payloadOptions === 'object' ? payloadOptions : {}),
        ...(options && typeof options === 'object' ? options : {}),
      },
    });
  }

  /** @private */
  async _sendVoiceHeartbeat({ trigger = 'silence', rawText = '', meta = {}, options = {} }: DHAny = {}) {
    const fallbackConfig = rawText
      ? this._normalizeVoiceHeartbeatConfig({ enabled: true, silenceText: rawText })
      : null;
    const config = this._voiceHeartbeatConfig || fallbackConfig;
    const now = Date.now();
    const silenceMs = now - (this._voiceHeartbeatLastUserActivityAt || now);
    const eventMeta = {
      type: trigger,
      trigger,
      silenceMs,
      silenceSec: Math.round(silenceMs / 1000),
      count: this._voiceHeartbeatCount + 1,
      maxCount: config?.silenceMaxCount || 0,
      agentState: this._voiceHeartbeatAgentState,
      voiceLifecycleState: this._voiceLifecycleState,
      currentPage: this._currentPage || '',
      timestamp: now,
      ...meta,
    };

    const {
      ignoreCooldown = false,
      ignoreMaxCount = false,
      countTowardMax = true,
      updateCooldown = true,
      resetSilenceTimer = false,
      sendOptions = null,
      ...extraSendOptions
    } = options || {};

    if (!config?.enabled || !this._canRunVoiceHeartbeat(config)) {
      this.emit('voiceHeartbeat', { ...eventMeta, sent: false, skipped: true, reason: 'notReady' });
      return { ok: true, ...eventMeta, sent: false, skipped: true, reason: 'notReady' };
    }
    if (!ignoreMaxCount && this._voiceHeartbeatCount >= config.silenceMaxCount) {
      this.emit('voiceHeartbeat', { ...eventMeta, sent: false, skipped: true, reason: 'maxCount' });
      return { ok: true, ...eventMeta, sent: false, skipped: true, reason: 'maxCount' };
    }
    if (!ignoreCooldown && this._voiceHeartbeatLastSentAt && now - this._voiceHeartbeatLastSentAt < config.cooldownMs) {
      this.emit('voiceHeartbeat', { ...eventMeta, sent: false, skipped: true, reason: 'cooldown' });
      if (trigger === 'silence') {
        this._scheduleVoiceHeartbeatAfter(config.cooldownMs - (now - this._voiceHeartbeatLastSentAt));
      }
      return { ok: true, ...eventMeta, sent: false, skipped: true, reason: 'cooldown' };
    }

    const configuredText = config.silenceText || config.silencePrompt || '';
    const text = this._formatVoiceHeartbeatText(rawText || configuredText, eventMeta).trim();
    if (!text) {
      this.emit('voiceHeartbeat', { ...eventMeta, sent: false, skipped: true, reason: 'emptyText' });
      return { ok: true, ...eventMeta, sent: false, skipped: true, reason: 'emptyText' };
    }

    try {
      const response = await this.send(text, {
        runCode: true,
        skipHistory: true,
        skipIfMessageTextEmpty: true,
        ...(config.sendOptions && typeof config.sendOptions === 'object' ? config.sendOptions : {}),
        ...(sendOptions && typeof sendOptions === 'object' ? sendOptions : {}),
        ...extraSendOptions,
      });
      if (countTowardMax !== false) this._voiceHeartbeatCount += 1;
      if (updateCooldown !== false) this._voiceHeartbeatLastSentAt = now;
      if (resetSilenceTimer) {
        this._voiceHeartbeatLastUserActivityAt = Date.now();
        this._scheduleVoiceHeartbeat();
      }
      this.emit('voiceHeartbeat', { ...eventMeta, sent: true, skipped: false, text, data: response });
      return { ok: true, ...eventMeta, sent: true, skipped: false, text, data: response };
    } catch (error: DHAny) {
      console.warn('[DigitalHuman] Voice heartbeat failed:', error.message);
      this.emit('voiceHeartbeat', { ...eventMeta, sent: false, skipped: true, reason: 'error', error: error.message });
      return { ok: false, ...eventMeta, sent: false, skipped: true, reason: 'error', error: error.message };
    }
  }

  /** @private */
  async _onVoiceHeartbeatTimeout() {
    await this._sendVoiceHeartbeat({ trigger: 'silence' });
  }

  /** @private */
  _emitActiveState(reason = '') {
    const payload = {
      active: this._active,
      reason,
      logicalVoiceChatActive: this._logicalVoiceChatActive,
      voiceChatConnected: Boolean(this._vcSession?.isActive),
      page: this._currentPage || null,
      timestamp: Date.now(),
    };
    this.emit('activeChanged', payload);
    this.emit(this._active ? 'active' : 'inactive', payload);
  }

  /** @private */
  _clearInactiveVoiceStopTimer() {
    if (this._inactiveVoiceStopTimer) {
      clearTimeout(this._inactiveVoiceStopTimer);
      this._inactiveVoiceStopTimer = null;
    }
  }

  /** @private */
  _clearVoiceIdleTimer() {
    if (this._voiceIdleTimer) {
      clearTimeout(this._voiceIdleTimer);
      this._voiceIdleTimer = null;
    }
  }

  /** @private */
  _resetVoiceIdleTimer() {
    this._clearVoiceIdleTimer();
    if (!this._active || !this._logicalVoiceChatActive || !this._vcSession?.isActive) return;

    this._voiceIdleTimer = setTimeout(() => {
      this._voiceIdleTimer = null;
      if (this._active && this._logicalVoiceChatActive) {
        this.setActive(false, { reason: 'voiceIdleTimeout' }).catch((e) => {
          console.warn('[DigitalHuman] auto inactive failed:', e.message);
        });
      }
    }, 60000);
  }

  /** @private */
  _normalizeVoiceLifecycleConfig(value: DHAny, fallback: DHAny = {}) {
    if (value === false) return { ...fallback, enabled: false };
    if (value === true || value === undefined || value === null) value = {};
    if (typeof value !== 'object') value = {};
    const base = {
      enabled: true,
      visibilityStandby: true,
      disconnectAfterMs: 60000,
      autoReconnect: false,
      interruptOnHidden: true,
      muteOnHidden: true,
      clearSubtitleOnHidden: true,
      historyPolicy: 'complete-only',
      ...fallback,
      ...value,
    };
    base.enabled = base.enabled !== false;
    base.visibilityStandby = base.visibilityStandby !== false;
    base.disconnectAfterMs = parseDurationMs(base.disconnectAfterMs, 60000);
    base.autoReconnect = base.autoReconnect === true;
    return base;
  }

  /** @private */
  _resolveVoiceLifecycleConfig(preset: DHAny = {}, options: DHAny = {}) {
    const defaults = this._normalizeVoiceLifecycleConfig(this.config?.voiceLifecycle);
    const fromCharacter = this._normalizeVoiceLifecycleConfig(this.characterConfig?.voiceLifecycle, defaults);
    const fromPreset = this._normalizeVoiceLifecycleConfig(preset?.voiceLifecycle, fromCharacter);
    return this._normalizeVoiceLifecycleConfig(options?.voiceLifecycle, fromPreset);
  }

  /** @private */
  _isDocumentHidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  /** @private */
  _emitVoiceLifecycleState(state: DHAny, extra: DHAny = {}) {
    const payload = {
      state,
      active: this._active,
      logicalVoiceChatActive: this._logicalVoiceChatActive,
      voiceChatConnected: Boolean(this._vcSession?.isActive),
      hiddenAt: this._voiceLifecycleHiddenAt || null,
      timestamp: Date.now(),
      ...extra,
    };
    this.emit('voiceLifecycle', payload);
    this.emit('voiceChatLifecycle', payload);
  }

  /** @private */
  _setupVoiceLifecycleHandlers(config: DHAny) {
    this._clearVoiceLifecycleHandlers();
    this._voiceLifecycleConfig = config;
    if (!config?.enabled || !config.visibilityStandby || typeof document === 'undefined' || typeof window === 'undefined') return;

    this._voiceLifecycleVisibilityHandler = () => {
      if (this._isDocumentHidden()) {
        void this._enterVoiceLifecycleStandby('visibilityHidden');
      } else {
        void this._resumeVoiceLifecycleFromStandby('visibilityVisible');
      }
    };
    this._voiceLifecyclePagehideHandler = () => {
      void this._enterVoiceLifecycleStandby('pagehide');
    };

    document.addEventListener('visibilitychange', this._voiceLifecycleVisibilityHandler);
    window.addEventListener('pagehide', this._voiceLifecyclePagehideHandler);
  }

  /** @private */
  _clearVoiceLifecycleHandlers() {
    if (this._voiceLifecycleVisibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._voiceLifecycleVisibilityHandler);
    }
    if (this._voiceLifecyclePagehideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._voiceLifecyclePagehideHandler);
    }
    this._voiceLifecycleVisibilityHandler = null;
    this._voiceLifecyclePagehideHandler = null;
  }

  /** @private */
  async _enterVoiceLifecycleStandby(reason = 'pageHidden') {
    const config = this._voiceLifecycleConfig;
    if (!config?.enabled || !config.visibilityStandby) return;
    if (!this._logicalVoiceChatActive && !this._vcSession?.isActive) return;
    if (this._voiceLifecycleState === 'standby') return;

    this._voiceLifecycleState = 'standby';
    this._voiceLifecycleHiddenAt = Date.now();
    this._voiceLifecycleDisconnectedReason = '';
    this._emitVoiceLifecycleState('standby', { reason, disconnectAfterMs: config.disconnectAfterMs });

    if (config.clearSubtitleOnHidden && this._subtitleOverlay?.config?.clearOnStandby !== false) {
      this.clearSubtitle();
    }
    this._clearVoiceHeartbeat();
    if (config.interruptOnHidden && this._vcSession?.isActive) {
      try { await this._vcSession.interrupt?.({ resetAudio: true }); } catch (_: DHAny) {}
    }
    if (config.muteOnHidden && this._vcSession?.isActive) {
      try { this._vcSession.mute?.(); } catch (_: DHAny) {}
    }
    await this.setActive(false, {
      reason: 'pageHiddenStandby',
      inactiveStopDelayMs: config.disconnectAfterMs,
      inactiveStopReason: 'pageHiddenTimeout',
    });
  }

  /** @private */
  async _resumeVoiceLifecycleFromStandby(reason = 'pageVisible') {
    const config = this._voiceLifecycleConfig;
    if (!config?.enabled || !config.visibilityStandby) return;
    if (this._voiceLifecycleDisconnectedReason) {
      const disconnectedReason = this._voiceLifecycleDisconnectedReason;
      this._voiceLifecycleState = 'disconnected';
      this._clearInactiveVoiceStopTimer();
      this._emitVoiceLifecycleState('disconnected', {
        reason,
        disconnectedReason,
        autoReconnect: false,
        needsManualStart: true,
      });
      return;
    }
    if (this._voiceLifecycleState !== 'standby') return;

    this._voiceLifecycleState = 'active';
    this._clearInactiveVoiceStopTimer();
    if (this._vcSession?.isActive) {
      try { this._vcSession.unmute?.(); } catch (_: DHAny) {}
      await this.setActive(true, { reason: 'pageVisibleResume', skipVoiceResume: true });
      this._resetVoiceHeartbeatActivity();
      this._emitVoiceLifecycleState('resumed', { reason });
    } else {
      this._voiceLifecycleDisconnectedReason = 'connectionMissing';
      this._logicalVoiceChatActive = false;
      this._emitVoiceLifecycleState('disconnected', {
        reason,
        disconnectedReason: this._voiceLifecycleDisconnectedReason,
        autoReconnect: false,
        needsManualStart: true,
      });
    }
  }

  /** @private */
  async _stopVoiceConnectionForInactive(reason = 'inactiveTimeout') {
    const session = this._vcSession;
    if (!session) return;

    if (session.isActive) {
      await session.stop();
    }

    this._stopRtcLipSync();
    this._muteWhileSpeakingStop();
    this._clearVoiceHeartbeat({ resetCount: true });
    this._voiceHeartbeatConfig = null;
    if (this._vcIdleDebounce) { clearTimeout(this._vcIdleDebounce); this._vcIdleDebounce = null; }
    if (this._vcSession === session) this._vcSession = null;
    this._vcQueuedUserInputs = [];
    this._vcDirectInputPending = [];
    if (reason === 'pageHiddenTimeout') {
      this._logicalVoiceChatActive = false;
      this._voiceLifecycleDisconnectedReason = reason;
      this._emitVoiceLifecycleState('disconnected', {
        reason,
        autoReconnect: false,
        needsManualStart: true,
      });
    }
    this.emit('voiceChatStopped', { reason, logicalVoiceChatActive: this._logicalVoiceChatActive });
  }

  /** @private */
  _scheduleInactiveVoiceStop(options: DHAny = {}) {
    this._clearInactiveVoiceStopTimer();
    if (!this._logicalVoiceChatActive || !this._vcSession?.isActive) return;
    const delayMs = parseDurationMs(options.delayMs, 5000);
    const reason = options.reason || 'inactiveTimeout';

    this._inactiveVoiceStopTimer = setTimeout(() => {
      this._inactiveVoiceStopTimer = null;
      if (this._active || !this._logicalVoiceChatActive) return;
      this._stopVoiceConnectionForInactive(reason).catch((e) => {
        console.warn('[DigitalHuman] inactive voice stop failed:', e.message);
      });
    }, delayMs);
  }

  /** @private */
  async _sendCurrentPageRouterWakeupIfNeeded() {
    if (!this._active || this._pageRouterWakeupCalled) return false;
    const page = String(this._currentPage || '').trim();
    const routerEntry = page ? this._pageRouters?.[page] : null;
    const wakeupText = routerEntry?.wakeupText;
    if (!wakeupText) return false;

    // If voice chat is active, wait for the RTC agent to be ready before
    // sending the wakeup text. Without this, the ExternalTextToLLM message
    // arrives at the server before the agent has finished initialising and
    // gets silently dropped.
    if (this._vcSession?.isActive) {
      const ready = await this.waitUntilVoiceReady(8000);
      if (!ready) {
        console.warn('[DigitalHuman] pageRouter wakeup skipped: voice agent not ready in time');
        return false;
      }
      // Re-check guards after the async wait
      if (!this._active || this._pageRouterWakeupCalled) return false;
    }

    await this.send(wakeupText, { runCode: true, skipHistory: true });
    this._pageRouterWakeupCalled = true;
    return true;
  }

  /** @private */
  _switchToInactiveIdle() {
    if (!this.isEnabled) return;

    this.switchToIdle();
    this._scheduleRandomIdle(0);
  }

  /**
   * Set whether the digital human is actively listening/speaking.
   * This does not switch text/voice mode. Starting voice mode activates it;
   * stopping voice mode makes it inactive.
   * @param {boolean} active
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async setActive(active = true, options: DHAny = {}) {
    const nextActive = active !== false;
    const reason = options.reason || (nextActive ? 'setActive' : 'setInactive');
    const changed = this._active !== nextActive;

    this._active = nextActive;

    if (nextActive) {
      this._clearInactiveVoiceStopTimer();
      if (this._logicalVoiceChatActive) {
        if (!this._vcSession?.isActive && !options.skipVoiceResume) {
          const preset = this._lastVoiceChatPreset || {};
          await this.startVoiceChat(preset, { skipSetActive: true });
        }
        try { this._vcSession?.unmute?.(); } catch (_: DHAny) {}
        this._resetVoiceIdleTimer();
      }
      if (changed) this._emitActiveState(reason);
      await this._sendCurrentPageRouterWakeupIfNeeded();
      return { ok: true, active: this._active, changed };
    }

    this._clearVoiceIdleTimer();
    stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);
    this._clearVoiceHeartbeat();
    this._switchToInactiveIdle();
    if (this._logicalVoiceChatActive && this._vcSession?.isActive && !options.skipVoiceStop) {
      try { this._vcSession.mute(); } catch (_: DHAny) {}
      this._scheduleInactiveVoiceStop({
        delayMs: options.inactiveStopDelayMs,
        reason: options.inactiveStopReason,
      });
    }
    if (changed) this._emitActiveState(reason);
    return { ok: true, active: this._active, changed };
  }

  /** @private */
  _startPageRouterHeartbeat(page: DHAny, routerEntry: DHAny) {
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
        } catch (e: DHAny) {
          console.warn('[DigitalHuman] Page router heartbeat failed:', e.message);
          this.emit('error', { error: e, stage: 'pageRouterHeartbeat', page });
        } finally {
          scheduleNext();
        }
      }, delayMs);
    };

    scheduleNext();
  }

  /**
   * Immediately send heartbeat text. If text is omitted, use the active
   * page router heartbeatText; if that is unavailable, send "[heartbeat]".
   * @param {string} [text] - Explicit heartbeat text to send.
  * @param {Object} [options] - send() options. Defaults keep heartbeat out of history and skips empty runCode output.
   * @returns {Promise<Object>} Result metadata plus the send() response.
   */
  async sendHeartbeat(text: DHAny, options: DHAny = {}) {
    if (!this._active) {
      return { ok: true, sent: false, skipped: true, reason: 'inactive', page: this._currentPage || null };
    }

    const { page, restartTimer = true, ...sendOptions } = options || {};
    const targetPage = String(page || this._currentPage || '').trim();
    const routerEntry = targetPage ? this._pageRouters?.[targetPage] : null;
    const hasExplicitText = typeof text === 'string' && text.trim();
    const heartbeatText = hasExplicitText ? text : (routerEntry?.heartbeatText || '[heartbeat]');

    const response = await this.send(heartbeatText, {
      runCode: true,
      skipHistory: true,
      skipIfMessageTextEmpty: true,
      ...sendOptions,
    });

    if (restartTimer && this._currentPage === targetPage) {
      this._startPageRouterHeartbeat(targetPage, routerEntry);
    }

    this.emit('pageRouterHeartbeat', { page: targetPage || null, forced: true });
    return { ok: true, sent: true, page: targetPage || null, text: heartbeatText, data: response };
  }

  /**
   * Handle an AppPageOpened message. Looks up the page in _pageRouters,
   * restarts the agent / sends wakeup text if configured, and manages
   * page-scoped heartbeat text.
   * @private
   * @param {Object} msg - { type: 'dh:app-page-opened', page: string }
   */
  async _handleAppPageOpened(msg: DHAny) {
    const page = String(msg.page || '').trim();
    if (!page) return;

    // Track current page
    const pageChanged = page !== this._currentPage;
    this._currentPage = page;
    if (pageChanged) this._pageRouterWakeupCalled = false;
    this.emit('appPageOpened', { page });

    stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);

    if (!this._pageRouters) {
      this.emit('pageRouterOpen', {
        page,
        matched: false,
        reason: 'noPageRouters',
        timestamp: Date.now(),
      });
      return;
    }

    const routerEntry = this._pageRouters[page];
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

      // Clear active prompt file so the idempotency check in AgentTool
      // doesn't block same-file restarts from repeated page navigation
      const sandbox = this._aiChatSession?.sandbox;
      if (sandbox) {
        sandbox._activePromptFile = null;
      }
      // restartAgent: empty/null agent → default agent, otherwise load specified prompt
      const restartOptions: DHAny = { autoContinue: false };
      if (routerEntry.tools && typeof routerEntry.tools === 'object') {
        restartOptions.toolsOverride = routerEntry.tools;
      }
      const restartResult = await this.restartAgent(agent || undefined, undefined, restartOptions);
      const skipWakeupText = restartResult?.skipped === true && restartResult?.reason === 'cooldown';

      const wakeupText = routerEntry.wakeupText;
      if (this._active && wakeupText && !skipWakeupText && !this._pageRouterWakeupCalled) {
        // Wait for voice agent readiness before sending wakeup (same guard as
        // _sendCurrentPageRouterWakeupIfNeeded) to avoid the message being
        // dropped by an agent that hasn't finished initialising yet.
        if (this._vcSession?.isActive) {
          const ready = await this.waitUntilVoiceReady(8000);
          if (!ready || !this._active || this._pageRouterWakeupCalled) {
            if (!ready) console.warn('[DigitalHuman] pageRouter wakeup skipped (appPageOpened): voice agent not ready in time');
          } else {
            await this.send(wakeupText, { runCode: true, skipHistory: true });
            this._pageRouterWakeupCalled = true;
          }
        } else {
          await this.send(wakeupText, { runCode: true, skipHistory: true });
          this._pageRouterWakeupCalled = true;
        }
      }

      if (this._active) this._startPageRouterHeartbeat(page, routerEntry);
    } catch (e: DHAny) {
      console.warn('[DigitalHuman] AppPageOpened handler failed:', e.message);
      this.emit('error', { error: e, stage: 'appPageOpened', page });
    }
  }

  /**
   * Trigger conversation summarization.
   * This is the single DigitalHuman entry point for both manual and automatic
   * summarization requests. Automatic callers can set `trigger` and
   * `onlyWhenNeeded` to reuse the same queueing and threshold checks as manual
   * summaries.
   * Routes to the dedicated SummarizeAgent if configured, otherwise falls back
   * to the built-in SummarizeTool. Returns immediately. Only one summarization
   * runs at a time; subsequent calls are queued and merged so the latest
   * options win.
    *
    * Behavior summary:
    * - fire-and-forget: this method does not return the summary result
    * - result delivery: listen for the `summarized` event
    * - manual trigger: call `summarize()` with no gating flags
    * - automatic trigger: call with `onlyWhenNeeded: true`; threshold checks are
    *   evaluated against the current session message history
    * - duplicate suppression: automatic requests in the same threshold bucket are
    *   skipped until the conversation grows into a new bucket
    * - queue merging: if a run is already active, a later request replaces the
    *   pending request so only the latest queued options are kept
    * - startup behavior: restoring keepHistory content does not call summarize()
    *   automatically
    *
   * Listen for the 'summarized' event to receive the result.
   * @param {Object} [options]
   * @param {number} [options.keepRecentRounds=3] - Number of recent user+assistant pairs to preserve
   * @param {string} [options.mode] - 'replace' (compress in place) or 'append' (return summary only)
    * @param {string} [options.trigger='manual'] - Event trigger label such as 'manual', 'auto', or 'silentTick'
   * @param {boolean} [options.onlyWhenNeeded=false] - Gate execution by maxRounds/maxTextLength thresholds
   */
  summarize(options: DHAny = {}) {
    const isSilentTick = options.trigger === 'silentTick';
    if (!this._summarizeAgent) {
      if (!isSilentTick) {
        this.emit('summarized', { status: 'skipped', reason: 'no agent' });
      }
      return;
    }

    const request = {
      trigger: options.trigger || 'manual',
      ...options,
    };

    if (request.onlyWhenNeeded && !this._shouldRunSummarize(request)) {
      if (!isSilentTick) {
        this.emit('summarized', { status: 'skipped', reason: 'thresholds not met' });
      }
      return;
    }

    if (this._summarizing) {
      this._pendingSummarize = { ...this._pendingSummarize, ...request };
      return;
    }
    this._summarizing = true;
    this._pendingSummarize = null;

    this._runSummarize(request);
  }

  /**
   * Collect summarization metrics from the live text session.
   * System messages are excluded. `roundCount` is based on user messages only.
   * `totalTextLength` counts string message content currently stored in the
   * session and is used together with `maxTextLength` for auto-trigger gating.
   * @returns {{ roundCount: number, totalTextLength: number }|null}
   */
  _collectSummarizeMetrics() {
    const messages = this._aiChatSession?.messages;
    if (!Array.isArray(messages)) return null;

    let roundCount = 0;
    let totalTextLength = 0;
    for (const message of messages) {
      if (!message || message.role === 'system') continue;
      if (message._contextOnly) continue;
      if (message.role === 'user') roundCount += 1;
      if (typeof message.content === 'string') totalTextLength += message.content.length;
    }

    return { roundCount, totalTextLength };
  }

  /**
   * Build a stable auto-trigger signature for the current threshold bucket.
   * Automatic summarization requests are skipped while the session remains in
   * the same bucket, which prevents repeated summaries after every send or idle
   * tick without new conversation growth.
   * @param {{ roundCount: number, totalTextLength: number }|null} metrics
   * @param {Object} [options]
   * @returns {string|null}
   */
  _getSummarizeAutoTriggerSignature(metrics: DHAny, options: DHAny = {}) {
    if (!metrics) return null;

    const roundThreshold = Math.max(1, Number(options.maxRounds) || 1);
    const textThreshold = Math.max(1, Number(options.maxTextLength) || 1);
    const roundBucket = Math.floor(metrics.roundCount / roundThreshold);
    const textBucket = Math.floor(metrics.totalTextLength / textThreshold);
    return `${roundBucket}:${textBucket}`;
  }

  /**
   * Decide whether a threshold-gated summarization request should run.
   *
   * This is only used when callers pass `onlyWhenNeeded: true`. Manual calls
   * bypass this method and always attempt to summarize.
   *
   * Returns false when:
   * - summarization is disabled by resolved config
   * - there is no active AI session/message list
   * - both `maxRounds` and `maxTextLength` thresholds are still below target
   * - the current conversation is still in the same auto-trigger bucket as the
   *   last completed/attempted gated request
   *
   * Returns true once the conversation crosses into a new threshold bucket.
   * @param {Object} [options]
   * @returns {boolean}
   */
  _shouldRunSummarize(options: DHAny = {}) {
    const resolved = this._getSummarizationOptions(options);
    if (!resolved.enabled) {
      this._summarizeAutoTriggerSignature = null;
      return false;
    }

    const metrics = this._collectSummarizeMetrics();
    if (!metrics) return false;

    const { roundCount, totalTextLength } = metrics;
    const isSilentTick = options.trigger === 'silentTick';
    if (roundCount < resolved.maxRounds && totalTextLength < resolved.maxTextLength) {
      this._summarizeAutoTriggerSignature = null;
      return false;
    }

    const signature = this._getSummarizeAutoTriggerSignature(metrics, resolved);
    if (signature && this._summarizeAutoTriggerSignature === signature) {
      return false;
    }

    this._summarizeAutoTriggerSignature = signature;
    return true;
  }

  /**
   * Start the DigitalHuman-owned silent-tick summarization timer.
   *
   * The timer does not summarize immediately on each tick. Instead it waits for
   * `silentTickInterval` seconds of inactivity, then calls `summarize()` with
   * `trigger: 'silentTick'` and `onlyWhenNeeded: true` so the same threshold
   * gating and queue semantics are reused.
   */
  _startSummarizeTimer() {
    this._stopSummarizeTimer();

    const options = this._getSummarizationOptions();
    const interval = Number(options.silentTickInterval) || 0;
    if (!options.enabled || interval <= 0) return;

    this._resetSummarizeActivity();
    this._summarizeTimer = setInterval(() => {
      if (Date.now() - this._summarizeLastActivity < interval * 1000) return;
      this.summarize({
        trigger: 'silentTick',
        onlyWhenNeeded: true,
      });
    }, interval * 1000);
  }

  /** Stop the DigitalHuman-owned silent-tick summarization timer. */
  _stopSummarizeTimer() {
    if (this._summarizeTimer) {
      clearInterval(this._summarizeTimer);
      this._summarizeTimer = null;
    }
  }

  /** Record the latest user/assistant activity time for silent-tick checks. */
  _resetSummarizeActivity() {
    this._summarizeLastActivity = Date.now();
  }

  /**
   * Execute one summarization request and then drain any merged pending request.
   *
   * Result handling:
   * - emits `summarized` on success or error
   * - preserves the caller-provided `trigger` in the event payload
   * - forwards the returned summary into `sendContext()` when available so later
   *   turns can reuse the compressed context
   * - updates keepHistory cutoff state when the summarizer reports
   *   `summarizeBeginTime`
   *
   * This method is internal. External callers should always use `summarize()`.
   * @private
   */
  async _runSummarize(options: DHAny) {
    try {
      const agent = this._summarizeAgent;
      if (!agent) { console.warn('[DigitalHuman] _runSummarize aborted: _summarizeAgent gone'); return; }

      const opts = agent._getOptions(options);
      const trigger = options.trigger || 'manual';
      const hasConfig = !!agent.config;
      let result;

      if (agent.config) {
        result = await agent.run(options);
      } else {
        result = await agent._tool.summarize(agent.session, {
          keepRecentRounds: options.keepRecentRounds ?? opts.keepRecentRounds ?? 3,
          prompt: opts.prompt,
          model: opts.model,
          enableTools: opts.enableTools,
          mode: options.mode || opts.mode,
          async: false,
        });
      }

      const mode = result?.mode || options.mode || opts.mode || 'append';

      // Update keepHistory cutoff
      if (result?.summarizeBeginTime) {
        this._onSummarizeComplete(result);
      }

      // Always emit summarized event so callers know the operation completed
      this.emit('summarized', {
        summary: result?.summary || '',
        removedCount: result?.removedCount || 0,
        remainingCount: result?.remainingCount ?? 0,
        trigger,
        mode,
        summarizeBeginTime: result?.summarizeBeginTime,
      });

      // Send summary as background context (voice: RTC binary channel, text: queued for next send)
      if (result?.summary) {
        try {
          this.sendContext(`[对话整理] ${result.summary}`);
        } catch (e: DHAny) {
          console.warn('[DigitalHuman] Failed to sync summary context:', e.message);
        }
      }
    } catch (err: DHAny) {
      console.error('[DigitalHuman] summarize error:', err);
      this.emit('summarized', {
        trigger: options.trigger || 'manual',
        status: 'error',
        error: err.message,
      });
    } finally {
      this._summarizing = false;
      if (this._pendingSummarize) {
        const next = this._pendingSummarize;
        this._pendingSummarize = null;
        this.summarize(next);
      }
    }
  }

  /**
   * Resolve non-RTC text-to-speech options from request/session/config state.
   * Supported shapes:
    * - `true` => enable SpeechRTC with defaults
    * - `{ enabled: true, provider: 'speechRTC'|'speech', voiceType: '...' }`
    * - `{ speechRTC: { voiceType: '...' } }`
    * - `{ speech: { voiceType: '...' } }`
   * Priority: request options -> session config -> character config -> constructor config.
   * @param {Object} [options]
   * @returns {{ enabled: boolean, provider: string, sessionOptions: Object }}
   */
  _getTextToSpeechOptions(options: DHAny) {
    const sources = [
      options?.textToSpeech,
      this._sessionConfig?.textToSpeech,
      this.characterConfig?.nonVoiceChat?.textToSpeech,
      this.characterConfig?.textChat?.textToSpeech,
      this.characterConfig?.chat?.textToSpeech,
      this.characterConfig?.textToSpeech,
      this.config?.textToSpeech,
    ];

    for (const source of sources) {
      if (source === undefined || source === null) continue;

      if (typeof source === 'boolean') {
        return {
          enabled: source,
          provider: source ? 'speechrtc' : '',
          sessionOptions: {},
        };
      }

      if (typeof source === 'object') {
        const speechRTCOptions = source.speechRTC && typeof source.speechRTC === 'object'
          ? { ...source.speechRTC }
          : {};
        const speechOptions = source.speech && typeof source.speech === 'object'
          ? { ...source.speech }
          : {};
        const flatOptions = { ...source };
        delete flatOptions.enabled;
        delete flatOptions.provider;
        delete flatOptions.engine;
        delete flatOptions.useSpeechRTC;
        delete flatOptions.useSpeech;
        delete flatOptions.autoReadReply;
        delete flatOptions.autoRead;
        delete flatOptions.speechRTC;
        delete flatOptions.speech;

        const provider = String(
          source.provider
          || source.engine
          || (source.useSpeechRTC === true || source.speechRTC ? 'speechRTC'
            : (source.useSpeech === true || source.speech ? 'speech' : 'speechRTC'))
        ).toLowerCase();

        const nestedOptions = provider === 'speech' ? speechOptions : speechRTCOptions;

        return {
          enabled: source.enabled !== false,
          provider,
          sessionOptions: { ...flatOptions, ...nestedOptions },
        };
      }

      return {
        enabled: !!source,
        provider: source ? 'speechrtc' : '',
        sessionOptions: {},
      };
    }

    return {
      enabled: false,
      provider: '',
      sessionOptions: {},
    };
  }

  _normalizeAutoReadReplyValue(value: DHAny) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized) return undefined;
      if (normalized === 'false' || normalized === '0' || normalized === '-1' || normalized === 'off' || normalized === 'disabled' || normalized === 'none') {
        return false;
      }
      if (normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'enabled') {
        return true;
      }
    }
    return !!value;
  }

  _getAutoReadReplySources(options: DHAny) {
    return [
      options?.autoReadReply,
      options?.autoRead,
      options?.textToSpeech?.autoReadReply,
      options?.textToSpeech?.autoRead,
      this._sessionConfig?.autoReadReply,
      this._sessionConfig?.autoRead,
      this._sessionConfig?.textToSpeech?.autoReadReply,
      this._sessionConfig?.textToSpeech?.autoRead,
      this.characterConfig?.nonVoiceChat?.autoReadReply,
      this.characterConfig?.nonVoiceChat?.autoRead,
      this.characterConfig?.nonVoiceChat?.textToSpeech?.autoReadReply,
      this.characterConfig?.nonVoiceChat?.textToSpeech?.autoRead,
      this.characterConfig?.textChat?.autoReadReply,
      this.characterConfig?.textChat?.autoRead,
      this.characterConfig?.textChat?.textToSpeech?.autoReadReply,
      this.characterConfig?.textChat?.textToSpeech?.autoRead,
      this.characterConfig?.chat?.autoReadReply,
      this.characterConfig?.chat?.autoRead,
      this.characterConfig?.chat?.textToSpeech?.autoReadReply,
      this.characterConfig?.chat?.textToSpeech?.autoRead,
      this.characterConfig?.autoReadReply,
      this.characterConfig?.autoRead,
      this.characterConfig?.textToSpeech?.autoReadReply,
      this.characterConfig?.textToSpeech?.autoRead,
      this.config?.autoReadReply,
      this.config?.autoRead,
      this.config?.textToSpeech?.autoReadReply,
      this.config?.textToSpeech?.autoRead,
    ];
  }

  _isAutoReadReplyEnabled(options: DHAny = {}) {
    for (const source of this._getAutoReadReplySources(options)) {
      const resolved = this._normalizeAutoReadReplyValue(source);
      if (resolved !== undefined) return resolved;
    }
    return true;
  }

  /**
   * Build SpeechRTC options for non-RTC text reply playback.
   * Defaults to mp3 + manual playback so DigitalHuman can reuse lip sync.
    * When bracketAction is enabled, bracketed action hints are excluded from
    * spoken text unless the caller explicitly disables it via
    * `textToSpeech.ignoreBracketText = false`.
   * @param {Object} [options]
   * @returns {Object}
   */
  _buildTextSpeechRTCOptions(options: DHAny = {}) {
    const voiceChatTts = this.characterConfig?.voiceChat?.config?.TTSConfig;
    const voiceChatAudio = voiceChatTts?.AudioConfig?.audio || voiceChatTts?.audio || {};
    const voiceType = options.voiceType
      || options.speaker
      || voiceChatAudio.voice_type
      || voiceChatAudio.voiceType;

    const resolved = {
      ...options,
      audioFormat: options.audioFormat || options.format || 'mp3',
      autoPlay: options.autoPlay ?? false,
    };

    if (voiceType && !resolved.voiceType && !resolved.speaker) {
      resolved.voiceType = voiceType;
    }

    return resolved;
  }

  _buildStreamingTextSpeechRTCOptions(options: DHAny = {}) {
    const resolved = this._buildTextSpeechRTCOptions(options);
    if (options.audioFormat === undefined && options.format === undefined) {
      resolved.audioFormat = 'pcm';
    }
    if (options.autoPlay === undefined) {
      resolved.autoPlay = true;
    }
    return resolved;
  }

  _resolveTextSpeechContent(text: DHAny, options: DHAny = {}, sessionOptions: DHAny = {}) {
    const rawContent = String(text || '').trim();
    if (!rawContent) return '';

    const bracketActionOptions = this._getBracketActionOptions(options);
    const shouldIgnoreBracketText = sessionOptions.ignoreBracketText !== undefined
      ? sessionOptions.ignoreBracketText !== false
      : bracketActionOptions.enabled;

    return shouldIgnoreBracketText ? stripBracketSegments(rawContent) : rawContent;
  }

  _resolveStreamingTextSpeechContent(text: DHAny, options: DHAny = {}, sessionOptions: DHAny = {}) {
    const content = this._resolveTextSpeechContent(text, options, sessionOptions);
    if (!content) return '';

    const bracketActionOptions = this._getBracketActionOptions(options);
    const shouldIgnoreBracketText = sessionOptions.ignoreBracketText !== undefined
      ? sessionOptions.ignoreBracketText !== false
      : bracketActionOptions.enabled;

    return shouldIgnoreBracketText ? stripTrailingOpenBracketSegment(content) : content;
  }

  _buildSpeechAudioUrl(result: DHAny, options: DHAny = {}) {
    const audioData = result?.data?.audioBase64;
    if (!audioData) return null;

    const encoding = String(options.encoding || this.sdk?.speech?.ttsService?.encoding || 'mp3').toLowerCase();
    let mimeType = 'audio/mpeg';
    if (encoding === 'wav') mimeType = 'audio/wav';
    else if (encoding === 'ogg' || encoding === 'ogg_opus') mimeType = 'audio/ogg';

    return `data:${mimeType};base64,${audioData}`;
  }

  // ========================================================================
  // Mute-While-Speaking
  // ========================================================================

  /**
   * Resolve muteWhileSpeaking options from request/session/config state.
   * When enabled, the mic is automatically muted while the avatar speaks
   * (text TTS or voice chat remote audio) and unmuted when speech ends.
   * A safety timer (`maxDuration`) guarantees the mic is never muted longer
   * than the configured ceiling (default 5 s).
   *
   * Supported shapes:
   *  - `true`  => enabled with defaults (maxDuration=5)
   *  - `{ enabled: true, maxDuration: 8 }`
   *
   * Priority: request options -> session config -> character config -> constructor config.
   * @param {Object} [options]
   * @returns {{ enabled: boolean, maxDuration: number }}
   */
  _getMuteWhileSpeakingOptions(options: DHAny) {
    const sources = [
      options?.muteWhileSpeaking,
      this._sessionConfig?.muteWhileSpeaking,
      this.characterConfig?.muteWhileSpeaking,
      this.config?.muteWhileSpeaking,
    ];

    for (const source of sources) {
      if (source === undefined || source === null) continue;

      if (typeof source === 'object') {
        return {
          enabled: source.enabled !== false,
          maxDuration: Number(source.maxDuration) || 5,
        };
      }

      return {
        enabled: !!source,
        maxDuration: 5,
      };
    }

    return { enabled: false, maxDuration: 5 };
  }

  /**
   * Mute the microphone because the avatar started speaking.
   * Does nothing if muteWhileSpeaking is disabled or already active.
   * Starts a safety timer that auto-unmutes after maxDuration seconds.
   * @param {Object} [options]
   */
  _muteWhileSpeakingStart(options?: DHAny) {
    const opts = this._getMuteWhileSpeakingOptions(options);
    if (!opts.enabled) return;
    if (this._muteWhileSpeakingActive) return;

    const session = this._vcSession;
    if (!session) return;

    this._muteWhileSpeakingActive = true;
    try { session.mute(); } catch (_: DHAny) {}

    // Safety ceiling — forcefully unmute after maxDuration
    if (this._muteWhileSpeakingTimer) clearTimeout(this._muteWhileSpeakingTimer);
    this._muteWhileSpeakingTimer = setTimeout(() => {
      this._muteWhileSpeakingStop();
    }, opts.maxDuration * 1000);
  }

  /**
   * Unmute the microphone because the avatar stopped speaking.
   * Does nothing if not currently auto-muted.
   */
  _muteWhileSpeakingStop() {
    if (!this._muteWhileSpeakingActive) return;
    this._muteWhileSpeakingActive = false;

    if (this._muteWhileSpeakingTimer) {
      clearTimeout(this._muteWhileSpeakingTimer);
      this._muteWhileSpeakingTimer = null;
    }

    const session = this._vcSession;
    if (!session) return;
    try { session.unmute(); } catch (_: DHAny) {}
  }

  _getComfortMessageForTool(toolName: DHAny) {
    const fnName = String(toolName || '');
    if (!fnName) return '';
    return fnName.includes('replace_string')
      ? '(记录中...)'
      : '(查询中...)';
  }

  _isAssistantTextSpeechPlaying() {
    return this._textSpeechPlaybackMeta?.kind === 'assistant';
  }

  async _triggerComfortMessage(toolName: DHAny, options: DHAny = {}, sentTypes: DHAny, pendingMessages: DHAny) {
    const comfortMsg = this._getComfortMessageForTool(toolName);
    if (!comfortMsg) return;
    if (sentTypes?.has(comfortMsg)) return;

    sentTypes?.add(comfortMsg);

    if (this._isAssistantTextSpeechPlaying()) {
      return;
    }

    this.emit('comfortMessage', {
      text: comfortMsg,
      toolName,
      source: 'textChat',
    });

    if (Array.isArray(pendingMessages)) {
      pendingMessages.push({ text: comfortMsg, toolName });
    }
  }

  async _startTextSpeechTurn() {
    this._textSpeechTurnId += 1;
    this._textSpeechQueue = [];
    this._textSpeechStreamFailedTurnId = 0;
    this._textSpeechStartEmittedId = 0;
    await this._stopTextSpeechPlayback();
    return this._textSpeechTurnId;
  }

  _queueTextSpeech(text: DHAny, options: DHAny = {}, meta: DHAny = {}) {
    const content = String(text || '').trim();
    if (!content || this.isVoiceChatActive) return false;

    const textToSpeech = this._getTextToSpeechOptions(options);
    if (!textToSpeech.enabled) return false;
    if (meta.kind !== 'tts' && !this._isAutoReadReplyEnabled(options)) return false;

    this._textSpeechQueue.push({
      text: content,
      options: { ...options },
      meta: { ...meta, textToSpeech },
      turnId: meta.turnId ?? this._textSpeechTurnId,
    });
    void this._drainTextSpeechQueue();
    return true;
  }

  async _drainTextSpeechQueue() {
    if (this._textSpeechQueueRunning) return;
    this._textSpeechQueueRunning = true;

    try {
      while (this._textSpeechQueue.length > 0) {
        const item = this._textSpeechQueue.shift();
        if (!item) continue;
        if (item.turnId !== this._textSpeechTurnId || this.isVoiceChatActive) continue;

        if (item.meta?.kind === 'comfort') {
          const bracketActionOptions = this._getBracketActionOptions(item.options);
          if (bracketActionOptions.enabled) {
            this._emitBracketActionEvents(item.text, new Set(), {
              source: 'toolCallInfo',
              toolName: item.meta.toolName,
              comfortMessage: true,
            }, bracketActionOptions);
          }
        }

        await this._speakTextResponseNow(item.text, item.options, item.meta);
      }
    } finally {
      this._textSpeechQueueRunning = false;
      if (this._textSpeechQueue.length > 0 && !this.isVoiceChatActive) {
        void this._drainTextSpeechQueue();
      }
    }
  }

  _restoreIdleAfterTextSpeech(requestId: DHAny) {
    if (requestId !== this._textSpeechRequestId) return;
    if (this.isVoiceChatActive) return;
    this._textSpeechPlaybackMeta = null;

    const hasCustomAction = this._currentPlayAction
      && this._currentPlayAction !== 'talk'
      && this._currentPlayAction !== 'idle';
    if (!hasCustomAction && this.isEnabled) {
      this.switchToIdle();
    }

    this.emit('textSpeechEnd', { requestId });
    this._subtitleOverlay.markFinal();
    this._muteWhileSpeakingStop();
  }

  async _stopTextSpeechPlayback() {
    const requestId = ++this._textSpeechRequestId;
    this._textSpeechPlaybackMeta = null;
    this._textSpeechStreamState = null;
    if (this._textSpeechStreamSilenceTimer) {
      clearTimeout(this._textSpeechStreamSilenceTimer);
      this._textSpeechStreamSilenceTimer = null;
    }
    this.stopAudioLipSync();
    this._stopRtcLipSync();

    if (!this._textSpeechSession) return;

    this.emit('textSpeechCanceled', { requestId });
    this._muteWhileSpeakingStop();

    const session = this._textSpeechSession;
    this._textSpeechSession = null;

    try {
      await session.interrupt({ resetAudio: true });
    } catch (_: DHAny) {
      try {
        await session.stop({ finish: false, closeConnection: false });
      } catch (_: DHAny) {}
    }

    this._restoreIdleAfterTextSpeech(requestId);
  }

  _isStreamingTextSpeechEnabled(options: DHAny = {}) {
    const textToSpeech = this._getTextToSpeechOptions(options);
    if (!textToSpeech.enabled || textToSpeech.provider !== 'speechrtc') return false;
    if (!this._isAutoReadReplyEnabled(options)) return false;
    if (textToSpeech.sessionOptions?.streaming === false) return false;
    return !!this.sdk?.speechRTC?.createTextStream;
  }

  _setStreamingTextSpeechSpeaking(isSpeaking: DHAny, requestId: DHAny) {
    if (requestId !== this._textSpeechRequestId || this.isVoiceChatActive) return;
    this._textSpeechPlaybackMeta = isSpeaking ? { kind: 'assistant' } : null;
    if (isSpeaking && this._textSpeechStartEmittedId !== requestId) {
      this._textSpeechStartEmittedId = requestId;
      this.emit('textSpeechStart', { requestId });
      this._muteWhileSpeakingStart();
    }

    const hasCustomAction = this._currentPlayAction
      && this._currentPlayAction !== 'talk'
      && this._currentPlayAction !== 'idle';
    if (hasCustomAction || !this.isEnabled) return;

    if (this.live2dMode) {
      if (isSpeaking) {
        this._startRtcLipSync();
      } else {
        this._stopRtcLipSync();
      }
      return;
    }

    if (isSpeaking) {
      this.playAction('talk', -1);
    } else {
      this.switchToIdle();
    }
  }

  _handleStreamingTextSpeechAudioChunk(bytes: DHAny, requestId: DHAny) {
    if (requestId !== this._textSpeechRequestId || this.isVoiceChatActive) return;

    this._setStreamingTextSpeechSpeaking(true, requestId);
    if (!this.live2dMode) return;

    this._rtcLipSyncTarget = computePCM16Level(bytes);
    this._startRtcLipSync();

    if (this._textSpeechStreamSilenceTimer) {
      clearTimeout(this._textSpeechStreamSilenceTimer);
    }
    this._textSpeechStreamSilenceTimer = setTimeout(() => {
      if (requestId !== this._textSpeechRequestId) return;
      this._rtcLipSyncTarget = 0;
    }, 120);
  }

  _createStreamingTextSpeechState(options: DHAny = {}, meta: DHAny = {}) {
    const textToSpeech = meta.textToSpeech || this._getTextToSpeechOptions(options);
    if (!textToSpeech.enabled || textToSpeech.provider !== 'speechrtc') return null;

    const speechRTC = this.sdk?.speechRTC;
    if (!speechRTC?.createTextStream) return null;

    const requestId = ++this._textSpeechRequestId;
    const sessionOptions = this._buildStreamingTextSpeechRTCOptions(textToSpeech.sessionOptions || {});
    const stream = speechRTC.createTextStream(sessionOptions);
    const shouldEmitError = options?.silentTextToSpeechErrors !== true;

    const state: DHAny = {
      requestId,
      turnId: meta.turnId ?? this._textSpeechTurnId,
      stream,
      sessionOptions,
      options: { ...options },
      textToSpeech,
      rawText: '',
      spokenText: '',
      appendChain: Promise.resolve(),
      closing: false,
      finalized: false,
      shouldEmitError,
      cleanup: () => {},
      handleError: ({ error }: DHAny) => {
        console.warn('[DigitalHuman] SpeechRTC streaming text playback failed:', error);
        this._textSpeechStreamFailedTurnId = state.turnId;
        state.cleanup();
        if (shouldEmitError) {
          this.emit('error', { error, source: 'textToSpeech' });
        }
        if (this._textSpeechSession === stream) {
          this._textSpeechSession = null;
        }
        if (this._textSpeechStreamState === state) {
          this._textSpeechStreamState = null;
        }
        this._restoreIdleAfterTextSpeech(requestId);
      },
    };

    state.handleAudioChunk = ({ bytes }: DHAny) => {
      this._handleStreamingTextSpeechAudioChunk(bytes, requestId);
    };
    state.handleAudioPlaybackEnded = () => {
      if (requestId !== this._textSpeechRequestId) return;
      state.cleanup();
      if (this._textSpeechSession === stream) {
        this._textSpeechSession = null;
      }
      if (this._textSpeechStreamState === state) {
        this._textSpeechStreamState = null;
      }
      this._restoreIdleAfterTextSpeech(requestId);
    };
    state.handleSessionFinished = () => {
      if (requestId !== this._textSpeechRequestId) return;
      if (this._textSpeechStreamState === state) {
        this._textSpeechStreamState = null;
      }
      // If no audio sources are left, finish now; otherwise audioPlaybackEnded will handle it.
      const remaining = typeof stream.getRemainingPlaybackTime === 'function'
        ? stream.getRemainingPlaybackTime() : 0;
      if (remaining <= 0.05) {
        state.handleAudioPlaybackEnded();
      }
    };
    state.handleSessionCanceled = () => {
      state.cleanup();
      if (this._textSpeechSession === stream) {
        this._textSpeechSession = null;
      }
      if (this._textSpeechStreamState === state) {
        this._textSpeechStreamState = null;
      }
      this._restoreIdleAfterTextSpeech(requestId);
    };
    state.cleanup = () => {
      stream.off('error', state.handleError);
      stream.off('audioChunk', state.handleAudioChunk);
      stream.off('audioPlaybackEnded', state.handleAudioPlaybackEnded);
      stream.off('sessionFinished', state.handleSessionFinished);
      stream.off('sessionCanceled', state.handleSessionCanceled);
    };

    stream.on('error', state.handleError);
    stream.on('audioChunk', state.handleAudioChunk);
    stream.on('audioPlaybackEnded', state.handleAudioPlaybackEnded);
    stream.on('sessionFinished', state.handleSessionFinished);
    stream.on('sessionCanceled', state.handleSessionCanceled);

    this._textSpeechSession = stream;
    this._textSpeechStreamState = state;
    return state;
  }

  async _appendStreamingTextSpeech(text: DHAny, options: DHAny = {}, meta: DHAny = {}) {
    if (!text || this.isVoiceChatActive) return false;

    const turnId = meta.turnId ?? this._textSpeechTurnId;
    if (this._textSpeechStreamFailedTurnId === turnId) return false;

    const textToSpeech = meta.textToSpeech || this._getTextToSpeechOptions(options);
    if (!textToSpeech.enabled || textToSpeech.provider !== 'speechrtc') return false;

    let state = this._textSpeechStreamState;
    if (!state || state.turnId !== turnId || state.closing) {
      state = this._createStreamingTextSpeechState(options, { ...meta, textToSpeech });
    }
    if (!state) return false;

    state.rawText = String(text || '');
    const nextContent = this._resolveStreamingTextSpeechContent(state.rawText, state.options, state.sessionOptions);
    if (!nextContent) return false;
    if (nextContent === state.spokenText) return true;
    if (!nextContent.startsWith(state.spokenText)) return false;

    const delta = nextContent.slice(state.spokenText.length);
    if (!delta) return true;
    state.spokenText = nextContent;

    state.appendChain = state.appendChain.then(async () => {
      if (state.requestId !== this._textSpeechRequestId || this._textSpeechSession !== state.stream) return;
      this._setStreamingTextSpeechSpeaking(true, state.requestId);
      await state.stream.appendText(delta);
    }).catch((error: DHAny) => {
      state.handleError({ error });
    });

    await state.appendChain;
    return true;
  }

  async _finishStreamingTextSpeech(text: DHAny, options: DHAny = {}, meta: DHAny = {}) {
    const turnId = meta.turnId ?? this._textSpeechTurnId;
    if (this._textSpeechStreamFailedTurnId === turnId) return null;

    const state = this._textSpeechStreamState;
    if (!state || state.turnId !== turnId || state.finalized) return null;

    state.finalized = true;
    if (text) {
      await this._appendStreamingTextSpeech(text, state.options, { ...meta, textToSpeech: state.textToSpeech });
    }

    state.closing = true;
    try {
      await state.appendChain;
      return await state.stream.finish({ close: false });
    } catch (error: DHAny) {
      state.handleError({ error });
      return null;
    }
  }

  async _playAudioWithLipSyncUntilEnded(audioUrl: DHAny, callbacks: DHAny = {}) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: DHAny) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const finish = (cb: DHAny) => {
        if (settled) return;
        settled = true;
        try {
          if (typeof cb === 'function') cb();
          resolve();
        } catch (error: DHAny) {
          reject(error);
        }
      };

      this.playAudioWithLipSync(audioUrl, {
        onStart: callbacks.onStart,
        onEnded: () => finish(callbacks.onEnded),
      }).catch(fail);
    });
  }

  async _speakTextResponseWithSpeechRTC(text: DHAny, options: DHAny = {}) {
    if (!text || this.isVoiceChatActive) return null;

    const textToSpeech = this._getTextToSpeechOptions(options);
    if (!textToSpeech.enabled || textToSpeech.provider !== 'speechrtc') return null;

    const speechRTC = this.sdk?.speechRTC;
    if (!speechRTC?.createTextStream) {
      console.warn('[DigitalHuman] textToSpeech enabled but sdk.speechRTC is unavailable');
      return null;
    }

    const sessionOptions = this._buildTextSpeechRTCOptions(textToSpeech.sessionOptions);
    const content = this._resolveTextSpeechContent(text, options, sessionOptions);
    if (!content) return null;

    const requestId = ++this._textSpeechRequestId;
    const stream = speechRTC.createTextStream(sessionOptions);
    this._textSpeechSession = stream;
    const shouldEmitError = options?.silentTextToSpeechErrors !== true;

    const handleSpeechError = ({ error }: DHAny) => {
      console.warn('[DigitalHuman] SpeechRTC text playback failed:', error);
      if (shouldEmitError) {
        this.emit('error', { error, source: 'textToSpeech' });
      }
      this._restoreIdleAfterTextSpeech(requestId);
    };

    stream.on('error', handleSpeechError);

    try {
      const result = await stream.synthesize(content, { close: false });
      if (requestId !== this._textSpeechRequestId) return result;

      if (result?.audioUrl) {
        await this._playAudioWithLipSyncUntilEnded(result.audioUrl, {
          onStart: () => {
            if (requestId !== this._textSpeechRequestId || this.isVoiceChatActive) return;
            this._textSpeechPlaybackMeta = { kind: 'assistant' };
            if (this.isEnabled) this.switchToTalking();
            if (this._textSpeechStartEmittedId !== requestId) {
              this._textSpeechStartEmittedId = requestId;
              this.emit('textSpeechStart', { requestId });
              this._muteWhileSpeakingStart();
            }
          },
          onEnded: () => {
            this._restoreIdleAfterTextSpeech(requestId);
          },
        });
      } else if (sessionOptions.autoPlay === false) {
        this._restoreIdleAfterTextSpeech(requestId);
      }

      return result;
    } catch (error: DHAny) {
      handleSpeechError({ error });
      return null;
    } finally {
      stream.off('error', handleSpeechError);
      if (this._textSpeechSession === stream) {
        this._textSpeechSession = null;
      }
      try {
        await stream.stop({ finish: false, closeConnection: false });
      } catch (_: DHAny) {}
    }
  }

  async _speakTextResponseWithSpeech(text: DHAny, options: DHAny = {}) {
    if (!text || this.isVoiceChatActive) return null;

    const textToSpeech = this._getTextToSpeechOptions(options);
    if (!textToSpeech.enabled || textToSpeech.provider !== 'speech') return null;

    const speech = this.sdk?.speech;
    if (!speech?.synthesizeAudio) {
      console.warn('[DigitalHuman] textToSpeech enabled but sdk.speech is unavailable');
      return null;
    }

    const speechOptions = { ...textToSpeech.sessionOptions };
    const content = this._resolveTextSpeechContent(text, options, speechOptions);
    if (!content) return null;

    const requestId = ++this._textSpeechRequestId;
    const shouldEmitError = options?.silentTextToSpeechErrors !== true;

    try {
      const result = await speech.synthesizeAudio(content, speechOptions);
      if (requestId !== this._textSpeechRequestId) return result;

      const audioUrl = this._buildSpeechAudioUrl(result, speechOptions);
      if (audioUrl) {
        await this._playAudioWithLipSyncUntilEnded(audioUrl, {
          onStart: () => {
            if (requestId !== this._textSpeechRequestId || this.isVoiceChatActive) return;
            this._textSpeechPlaybackMeta = { kind: 'assistant' };
            if (this.isEnabled) this.switchToTalking();
            if (this._textSpeechStartEmittedId !== requestId) {
              this._textSpeechStartEmittedId = requestId;
              this.emit('textSpeechStart', { requestId });
              this._muteWhileSpeakingStart();
            }
          },
          onEnded: () => {
            this._restoreIdleAfterTextSpeech(requestId);
          },
        });
      } else {
        this._restoreIdleAfterTextSpeech(requestId);
      }

      return audioUrl ? { ...result, audioUrl } : result;
    } catch (error: DHAny) {
      console.warn('[DigitalHuman] Speech text playback failed:', error);
      if (shouldEmitError) {
        this.emit('error', { error, source: 'textToSpeech' });
      }
      this._restoreIdleAfterTextSpeech(requestId);
      return null;
    }
  }

  async _speakTextResponseNow(text: DHAny, options: DHAny = {}, meta: DHAny = {}) {
    const textToSpeech = meta.textToSpeech || this._getTextToSpeechOptions(options);
    if (!textToSpeech.enabled) return null;
    const silentOptions = {
      ...options,
      silentTextToSpeechErrors: true,
    };

    if (textToSpeech.provider === 'speech') {
      return this._speakTextResponseWithSpeech(text, silentOptions);
    }

    return this._speakTextResponseWithSpeechRTC(text, silentOptions);
  }

  async _speakTextResponse(text: DHAny, options: DHAny = {}) {
    this._queueTextSpeech(text, options, { kind: 'assistant' });
    return null;
  }

  /**
   * Find the best matching custom action alias for a bracketed LLM phrase.
   * Matching is symmetric substring matching after lightweight normalization.
   * Built-in idle/talk actions are ignored to avoid false positives.
   * @param {string} bracketText
   * @returns {{ actionKey: string, matchedAlias: string }|null}
   */
  _findBracketActionMatch(bracketText: DHAny) {
    if (!this._videoActions || !bracketText) return null;

    const normalizedBracketText = normalizeActionMatchText(bracketText);
    if (!normalizedBracketText) return null;

    const idleConfig = this._resolveAction('idle');
    const talkConfig = this._resolveAction('talk');
    let bestMatch = null;

    for (const [alias, config] of Object.entries(this._videoActions)) {
      if (!alias || /^\d+$/.test(alias)) continue;
      if (config === idleConfig || config === talkConfig) continue;

      const normalizedAlias = normalizeActionMatchText(alias);
      if (!normalizedAlias) continue;

      const isMatch = normalizedBracketText.includes(normalizedAlias)
        || normalizedAlias.includes(normalizedBracketText);
      if (!isMatch) continue;

      if (!bestMatch || normalizedAlias.length > bestMatch.aliasLength) {
        bestMatch = {
          actionKey: alias,
          matchedAlias: alias,
          aliasLength: normalizedAlias.length,
        };
      }
    }

    return bestMatch
      ? { actionKey: bestMatch.actionKey, matchedAlias: bestMatch.matchedAlias }
      : null;
  }

  /**
   * Scan text for bracketed action hints and emit a deduplicated bracketAction event.
   * Only the first 500 words of the text are scanned.
   * @param {string} text
   * @param {Set<string>} seenMatches
   * @param {Object} [meta]
   * @param {{ enabled?: boolean, autoplay?: boolean, duration?: number }} [options]
   */
  _emitBracketActionEvents(text: DHAny, seenMatches: DHAny, meta: DHAny = {}, options: DHAny = {}) {
    if (!this._videoActions || typeof text !== 'string' || !text) return;

    const parseText = limitTextToWordWindow(text, BRACKET_ACTION_PARSE_WORD_LIMIT);
    if (!parseText) return;

    const autoplay = options.autoplay === true;
    const duration = Number.isFinite(Number(options.duration)) ? Number(options.duration) : 3;

    for (const segment of extractBracketSegments(parseText)) {
      const match = this._findBracketActionMatch(segment.text);
      if (!match) continue;

      const eventKey = `${segment.index}:${segment.length}:${match.actionKey}`;
      if (seenMatches?.has(eventKey)) continue;
      if (seenMatches) seenMatches.add(eventKey);

      if (autoplay) {
        this.playAction(match.actionKey, duration);
      }

      this.emit('bracketAction', {
        actionKey: match.actionKey,
        actionName: match.actionKey,
        matchedAlias: match.matchedAlias,
        bracketText: segment.text,
        bracketRaw: segment.raw,
        index: segment.index,
        messageText: text,
        autoPlayed: autoplay,
        playDuration: duration,
        ...meta,
      });
    }
  }

  /**
   * Initialize avatar rendering with the given video actions.
   * Keys may contain pipe-separated aliases, e.g. '待机|idle|0': { url }.
   * @param {Object} videoActions - { "待机|idle|0": { url }, "说话|talk|1": { url } }
   * @param {Object} [options]
   * @param {boolean} [options.avatarOnlyMode] - Full screen mode (no chat overlay)
   */
  async initAvatar(videoActions: DHAny, options: DHAny = {}) {
    if (!this.container) throw new Error('No container set for avatar rendering');
    if (!videoActions) return;
    this._lastAvatarInit = { videoActions, options: { ...options } };

    if (options.avatarOnlyMode !== undefined) {
      this.avatarOnlyMode = options.avatarOnlyMode;
    }

    // Create DOM if needed
    if (!this._avatarRoot) {
      this._createAvatarDOM();
    }

    const hasExistingAvatarState = this.isEnabled
      || this.currentVideoType
      || this.live2dApp
      || this.live2dModel
      || this.isIdleVideoLoaded
      || this.isTalkVideoLoaded;

    if (hasExistingAvatarState) {
      this.cleanupAvatar();
    }

    // Normalize aliases
    const actions = this._normalizeVideoActions(videoActions);

    // Determine idle media type
    const idleAction = actions['idle'];
    if (idleAction && idleAction.url) {
      this.idleMediaType = detectMediaType(idleAction.url);
    }

    // Validate actions
    if (!this._checkVideoActionsAvailable(actions)) {
      console.log('[DigitalHuman] Video actions not available');
      return;
    }

    this._videoActions = actions;
    this.isEnabled = true;
    this._avatarRoot.style.display = '';

    // Collect idle variants (idle2, idle3, …)
    this._collectIdleVariants();

    console.log(`[DigitalHuman] Initializing avatar (mode: ${this.idleMediaType})`);

    // Branch by media type
    if (this.idleMediaType === 'live2d') {
      this.live2dMode = true;
      this.webpMode = false;
      if (!this._live2dInitPromise && !this.live2dModel) {
        this._live2dInitPromise = this._initializeLive2D().finally(() => {
          this._live2dInitPromise = null;
        });
      }
    } else if (this.idleMediaType === 'webp') {
      this.webpMode = true;
      this.live2dMode = false;
      this._initializeWebp();
    } else {
      this.live2dMode = false;
      this.webpMode = false;
      await this._initializeVideos();
    }

    // Register playAction tool if custom actions exist (beyond idle/talk)
    this._registerDigitalHumanTool();

    this.emit('avatarReady', { mode: this.idleMediaType });
  }

  /**
   * Get custom action alias groups, excluding idle/talk and numeric aliases.
   * @returns {string[][]}
   */
  _getCustomActionAliasGroups() {
    if (!this._videoActions) return [];

    const idleConfig = this._resolveAction('idle');
    const talkConfig = this._resolveAction('talk');
    const idleVariantSet = new Set(this._idleVariants || []);
    const seenConfigs = new Set();
    const groups = [];

    for (const [key, config] of Object.entries(this._videoActions)) {
      if (config === idleConfig || config === talkConfig) continue;
      if (idleVariantSet.has(config)) continue;
      if (/^\d+$/.test(key) || seenConfigs.has(config)) continue;
      seenConfigs.add(config);

      const aliases = Object.entries(this._videoActions)
        .filter(([, candidateConfig]) => candidateConfig === config)
        .map(([alias]) => alias)
        .filter(alias => !/^\d+$/.test(alias));

      const uniqueAliases = [...new Set(aliases)];
      if (uniqueAliases.length > 0) groups.push(uniqueAliases);
    }

    return groups;
  }

  /**
   * Normalize action list language filter.
   * @param {string} lang
   * @returns {'en'|'zh'|null}
   */
  _normalizeActionListLang(lang: DHAny) {
    if (lang === undefined || lang === null || lang === '') return null;

    const normalized = String(lang).trim().toLowerCase();
    const mapping: DHAny = {
      enus: 'en',
      en: 'en',
      english: 'en',
      zhcn: 'zh',
      zh: 'zh',
      cn: 'zh',
      chinese: 'zh',
    };

    return mapping[normalized] || null;
  }

  /**
   * Get comma-separated custom action aliases, optionally filtered by language.
   * Supported language filters: enUS|zhCN|en|cn|English|Chinese.
   * @param {string} [lang]
   * @returns {string}
   */
  _getActionList(lang: DHAny) {
    const normalizedLang = this._normalizeActionListLang(lang);
    if (lang !== undefined && lang !== null && lang !== '' && !normalizedLang) {
      throw new Error('Unsupported lang. Supported values: enUS, zhCN, en, zh, cn, English, Chinese');
    }

    const containsEnglish = /[A-Za-z]/;
    const containsChinese = /[\u3400-\u9FFF]/;
    const aliases = this._getCustomActionAliasGroups().flat();
    const filteredAliases = aliases.filter(alias => {
      if (!normalizedLang) return true;
      if (normalizedLang === 'en') return containsEnglish.test(alias);
      return containsChinese.test(alias);
    });

    return [...new Set(filteredAliases)].join(', ');
  }

  /**
   * Register the 'digitalhuman' tool category on construction, then refresh
   * its definitions after avatar actions become available.
   */
  _registerDigitalHumanTool() {
    const copilotTools = this.sdk?.copilotTools;
    if (!copilotTools) return;

    const customActionGroups = this._getCustomActionAliasGroups();
    const customActions = customActionGroups.map(group => group.join('|'));
    const supportedLangs = ['enUS', 'zhCN', 'en', 'zh', 'cn', 'English', 'Chinese'];

    const dh = this;
    const definitions: DHAny[] = [{
      type: 'function',
      function: {
        name: 'getActionList',
        description: `Get comma-separated custom digital human action words/aliases, excluding idle and talk. Optionally filter the list by language. Supported lang values: ${supportedLangs.join(', ')}.`,
        parameters: {
          type: 'object',
          properties: {
            lang: {
              type: 'string',
              enum: supportedLangs,
              description: 'Optional language filter for action words.',
            },
          },
          required: [],
        },
      },
    }];

    if (customActions.length > 0) {
      const actionEnum = customActionGroups.map(group => group[0]);
      definitions.unshift({
        type: 'function',
        function: {
          name: 'playAction',
          description: `Play digital human avatar action/animation for the current assistant for a given duration, then return to idle. 
Use duration -1 for looped/indefinite playback. you do not need to play talk/speak animations, they are auto played when assistant replies. 
You only need to play idle animation if you are looping in indefinite loop of another animation and want to return to idle.`,
          parameters: {
            type: 'object',
            properties: {
              actionName: {
                type: 'string',
                enum: actionEnum,
                description: `The action to play. Available: ${customActions.join(', ')}`,
              },
              duration: {
                type: 'number',
                description: 'Duration in seconds. Default 5. Use -1 for looped/indefinite playback.',
                default: 5,
              },
            },
            required: ['actionName'],
          },
        },
      });
    }

    copilotTools.registerToolCategory('digitalhuman', {
      definitions,
      executor: async (fnName: DHAny, fnArgs: DHAny) => {
        if (fnName === 'playAction') {
          const duration = fnArgs.duration ?? 5;
          dh.playAction(fnArgs.actionName, duration);
          return { ok: true, action: fnArgs.actionName, duration };
        }
        if (fnName === 'getActionList') {
          return dh._getActionList(fnArgs?.lang);
        }
        return { error: `Unknown digitalhuman tool: ${fnName}` };
      },
    });

    console.log('[DigitalHuman] Registered digitalhuman tools with actions:', customActions);
  }

  /**
   * Auto-register the `minigame` copilot tool category (idempotent per SDK) and
   * subscribe this DigitalHuman to iframe events. Default `gameFinished` handling:
   *   1. Emit a `minigameEvent` event with the raw iframe data.
   *   2. Restart the agent so the LLM picks up any workspace changes made by the game.
   * Hosts can override via `this.on('minigameEvent', handler)` or by setting
   * `characterConfig.minigame.autoRestartAgent = false` to disable the restart.
   */
  _registerMinigameTool() {
    const sdk = this.sdk;
    if (!sdk?.copilotTools) return;

    MinigameTools.register(sdk);
    const tools = sdk.__minigameTools;
    if (!tools) return;

    const listener = async (data: DHAny) => {
      // Emit event for host integrations
      try { this.emit('minigameEvent', data); } catch (e: DHAny) { /* ignore */ }

      if (data?.type !== 'gameFinished' && data?.type !== 'gameClosed') return;
      // Respect opt-out in character config
      if (this.characterConfig?.minigame?.autoRestartAgent === false) return;
      try {
        console.log(`[DigitalHuman] minigame ${data.type} → restarting agent`);
        await this.restartAgent(undefined, undefined, { debounceMs: 3000 });
      } catch (e: DHAny) {
        console.warn(`[DigitalHuman] restartAgent after ${data.type} failed:`, e);
      }
    };
    this._minigameUnsubscribe = tools.addEventListener(listener);
  }

  /**
   * Close the minigame iframe overlay (if open) and restart the agent to default.
   * @param {Object} [options]
   * @param {string} [options.reason='user'] - Close reason passed to MinigameTools.close()
   * @param {boolean} [options.restartAgent=true] - Whether to restart the agent after closing
   * @returns {Promise<void>}
   */
  async closeMinigame(options: DHAny = {}) {
    const tools = this.sdk?.__minigameTools;
    if (tools) {
      tools.close({ reason: options.reason || 'user' });
    }
    if (options.restartAgent !== false) {
      try {
        await this.restartAgent(undefined, undefined, { debounceMs: 3000 });
      } catch (e: DHAny) {
        console.warn('[DigitalHuman] restartAgent after closeMinigame failed:', e);
      }
    }
  }

  /** Forward user ASR subtitles into the active minigame iframe. */
  _forwardUserVoiceInputToMinigame(data: DHAny = {}) {
    if (this._forwardUserVoiceInputViaParentFrame) return;
    if (!data?.isUser || !data.text || !String(data.text).trim()) return;
    const tools = this.sdk?.__minigameTools;
    if (!tools?.postMessageToMinigame) return;
    tools.postMessageToMinigame({
      type: 'dh:userVoiceInput',
      text: String(data.text),
      definite: !!data.definite,
      paragraph: !!data.paragraph,
      source: 'DigitalHuman.subtitle',
      subtitle: data,
    });
  }

  _checkVideoActionsAvailable(videoActions: DHAny) {
    const idleAction = videoActions?.['idle'];
    const talkAction = videoActions?.['talk'];
    const hasIdle = idleAction && idleAction.url && idleAction.url !== '';

    if (!hasIdle) return false;

    const idleType = detectMediaType(idleAction.url);
    if (idleType === 'live2d' || idleType === 'webp') return true;

    // For video mode, both idle and talk are required
    return !!(talkAction && talkAction.url && talkAction.url !== '');
  }

  // ========================================================================
  // SECTION 3: Video Mode
  // ========================================================================

  async _initializeVideos() {
    try {
      await this._loadIdleVideo();
      this._preloadTalkVideo().catch(error => {
        console.warn('[DigitalHuman] Talk video preload failed:', error);
      });
    } catch (error: DHAny) {
      console.error('[DigitalHuman] Failed to initialize videos:', error);
    }
  }

  async _loadIdleVideo() {
    if (!this.isEnabled || this.isIdleVideoLoaded) return;

    const idleAction = this._resolveAction('idle');
    if (!idleAction?.url) return;

    if (this._loadingPromises.has('idle')) {
      return this._loadingPromises.get('idle');
    }

    const loadPromise = new Promise<void>((resolve, reject) => {
      const source = this._videoIdle.querySelector('source');
      source.src = idleAction.url;

      this._videoIdle.onloadeddata = () => {
        this.isIdleVideoLoaded = true;
        this._videoIdle.muted = true;
        this._videoIdle.defaultMuted = true;
        this._videoIdle.play().then(() => {
          this.currentVideoType = 'idle';
          this._videoIdle.classList.remove('dh-hidden');
          this._videoIdle.classList.add('dh-visible');
          this._loadingPromises.delete('idle');
          const firstLoad = !this._firstIdleLoadDone;
          this._firstIdleLoadDone = true;
          this._scheduleRandomIdle(firstLoad ? 0 : undefined);
          resolve();
        }).catch((error: DHAny) => {
          this._loadingPromises.delete('idle');
          reject(error);
        });
      };

      this._videoIdle.onerror = () => {
        this._loadingPromises.delete('idle');
        reject(new Error('Idle video load failed'));
      };

      this._videoIdle.load();
    });

    this._loadingPromises.set('idle', loadPromise);
    return loadPromise;
  }

  async _preloadTalkVideo() {
    if (!this.isEnabled || this.isTalkVideoLoaded) return;

    const talkAction = this._resolveAction('talk');
    if (!talkAction?.url) return;

    if (this._loadingPromises.has('talk')) {
      return this._loadingPromises.get('talk');
    }

    const loadPromise = new Promise<void>((resolve, reject) => {
      const source = this._videoTalk.querySelector('source');
      source.src = talkAction.url;

      this._videoTalk.onloadeddata = () => {
        this.isTalkVideoLoaded = true;
        this._videoTalk.muted = true;
        this._videoTalk.defaultMuted = true;
        this._loadingPromises.delete('talk');
        resolve();
      };

      this._videoTalk.onerror = () => {
        this._loadingPromises.delete('talk');
        reject(new Error('Talk video preload failed'));
      };

      this._videoTalk.load();
    });

    this._loadingPromises.set('talk', loadPromise);
    return loadPromise;
  }

  // ========================================================================
  // SECTION 4: Webp Mode
  // ========================================================================

  _initializeWebp() {
    const idleAction = this._resolveAction('idle');
    if (!idleAction?.url) return;

    this._webpIdle.src = idleAction.url;
    this._webpIdle.onload = () => {
      this._webpIdle.classList.remove('dh-hidden');
      this._webpIdle.classList.add('dh-visible');
      this.isIdleVideoLoaded = true;
      this.currentVideoType = 'idle';
      const firstLoad = !this._firstIdleLoadDone;
      this._firstIdleLoadDone = true;
      this._scheduleRandomIdle(firstLoad ? 0 : undefined);
    };
    this._webpIdle.onerror = () => {
      console.error('[DigitalHuman] Failed to load webp idle image');
    };

    // Preload talk webp
    const talkAction = this._resolveAction('talk');
    if (talkAction?.url && talkAction.url.toLowerCase().endsWith('.webp')) {
      this._webpTalk.src = talkAction.url;
      this._webpTalk.onload = () => { this.isTalkVideoLoaded = true; };
      this._webpTalk.onerror = () => {
        console.error('[DigitalHuman] Failed to load webp talk image');
      };
    }
  }

  /**
   * Show a custom webp action by swapping the talk image source.
   * @param {string} url - Webp image URL
   */
  _playWebpAction(url: DHAny) {
    if (!this._webpTalk) return;
    if (this._webpIdleDebounce) {
      clearTimeout(this._webpIdleDebounce);
      this._webpIdleDebounce = null;
    }
    const gen = this._webpActionGen = (this._webpActionGen || 0) + 1;
    this._webpTalk.src = url;
    this._webpTalk.onload = () => {
      // Skip if a newer switchToIdle or action has invalidated this load
      if (this._webpActionGen !== gen) return;
      this._webpTalk.classList.remove('dh-hidden');
      this._webpTalk.classList.add('dh-visible');
      if (this._webpIdle) {
        this._webpIdle.classList.remove('dh-visible');
        this._webpIdle.classList.add('dh-hidden');
      }
    };
  }

  /**
   * Compute the Live2D model's rendered screen-space rectangle.
   * @returns {{ x: number, y: number, width: number, height: number, padding: number } | null}
   */
  _getLive2DModelScreenRect() {
    if (!this.live2dModel || !this.live2dApp) return null;
    const bounds = this.live2dModel.getLocalBounds();
    if (!bounds.width || !bounds.height) return null;

    const { scale: userScale, offsetY: offsetYFrac } = this._getIdleLayoutParams();

    const viewport = this._getLive2DViewportSize();
    const isFullscreen = this.avatarOnlyMode;
    const widthRatio = isFullscreen ? 0.92 : 0.8;
    const heightRatio = isFullscreen ? 0.92 : 0.85;
    const padding = isFullscreen ? 8 : Math.max(24, Math.min(viewport.width, viewport.height) * 0.04);
    const availableWidth = Math.max(1, viewport.width * widthRatio);
    const availableHeight = Math.max(1, viewport.height * heightRatio);
    const baseScale = Math.max(0.01, Math.min(availableWidth / bounds.width, availableHeight / bounds.height));
    const scale = baseScale * userScale;
    const offsetYPx = offsetYFrac * viewport.height;

    const modelWidth = bounds.width * scale;
    const modelHeight = bounds.height * scale;
    const modelX = viewport.width / 2 - (bounds.x + bounds.width / 2) * scale;
    const modelTopX = modelX + bounds.x * scale;
    let modelTopY;
    if (isFullscreen) {
      const modelCenterY = viewport.height / 2 - (bounds.y + bounds.height / 2) * scale + offsetYPx;
      modelTopY = modelCenterY + bounds.y * scale;
    } else {
      const modelBottomEdgeY = viewport.height - padding + offsetYPx;
      modelTopY = modelBottomEdgeY - modelHeight;
    }

    return { x: modelTopX, y: modelTopY, width: modelWidth, height: modelHeight, padding };
  }

  /**
   * Show a webp overlay on top of the Live2D canvas for custom actions.
   * Uses the Live2D model's actual rendered rect (which already includes
   * scale/offsetY) to size and position the webp to match.
   * @param {string} url - Webp image URL
   */
  _playLive2DWebpOverlay(url: DHAny) {
    if (!this._webpTalk) return;
    this._webpTalk.src = url;
    this._webpTalk.onload = () => {
      const rect = this._getLive2DModelScreenRect();
      if (rect) {
        const viewport = this._getLive2DViewportSize();
        const containerH = viewport.height;
        // Clamp: if model rect exceeds container, shrink to fit and bottom-align
        const clampedHeight = Math.min(rect.height, containerH);
        const top = rect.height > containerH
          ? 0                        // model overflows top — pin webp to top edge
          : rect.y;                  // model fits — use computed top
        const s = this._webpTalk.style;
        s.width = 'auto';
        s.height = `${clampedHeight}px`;
        s.objectFit = 'unset';
        s.top = `${top}px`;
        s.left = '50%';
        s.transform = 'translateX(-50%)';
        s.bottom = 'auto';
      }

      // Hide Live2D canvas, show webp overlay
      if (this._live2dCanvas) {
        this._live2dCanvas.classList.remove('dh-visible');
        this._live2dCanvas.classList.add('dh-hidden');
      }
      this._webpTalk.classList.remove('dh-hidden');
      this._webpTalk.classList.add('dh-visible');
      this._live2dWebpOverlayActive = true;
    };
  }

  /**
   * Hide the webp overlay and restore the Live2D canvas.
   */
  _hideLive2DWebpOverlay() {
    if (!this._live2dWebpOverlayActive) return;
    this._live2dWebpOverlayActive = false;
    if (this._webpTalk) {
      this._webpTalk.classList.remove('dh-visible');
      this._webpTalk.classList.add('dh-hidden');
      // Reset inline styles after the opacity transition ends to avoid a flash
      const el = this._webpTalk;
      const resetStyles = () => {
        const s = el.style;
        s.width = '';
        s.height = '';
        s.objectFit = '';
        s.top = '';
        s.left = '';
        s.transform = '';
        s.bottom = '';
      };
      el.addEventListener('transitionend', resetStyles, { once: true });
      // Fallback in case transitionend doesn't fire
      setTimeout(resetStyles, 600);
    }
    if (this._live2dCanvas) {
      this._live2dCanvas.classList.remove('dh-hidden');
      this._live2dCanvas.classList.add('dh-visible');
    }
  }

  // ========================================================================
  // SECTION 5: Live2D Mode
  // ========================================================================

  async _initializeLive2D() {
    if (this.live2dModel && this.live2dApp) return;

    const idleAction = this._resolveAction('idle');
    if (!idleAction?.url) return;

    console.log('[DigitalHuman] Loading Live2D model:', idleAction.url);
    try {
      await this._ensureLive2DScripts();
      const Live2DModel = (window as DHAny).PIXI?.live2d?.Live2DModel;
      if (!Live2DModel) throw new Error('Live2D bridge not found');

      const canvas = this._live2dCanvas;
      this.live2dApp = new (window as DHAny).PIXI.Application({
        view: canvas,
        autoStart: true,
        backgroundAlpha: 0,
      });

      this.live2dModel = await Live2DModel.from(stripQueryString(idleAction.url));
      this.live2dApp.stage.addChild(this.live2dModel);
      this._observeLive2DContainer();
      this._scheduleLive2DLayout(true);

      // Bind lip sync
      this._bindLive2DLipSync();

      // Show canvas
      canvas.classList.remove('dh-hidden');
      canvas.classList.add('dh-visible');
      this.isIdleVideoLoaded = true;
      this.currentVideoType = 'idle';

      // Handle resize
      this._live2dResizeHandler = () => this._scheduleLive2DLayout();
      this._live2dViewportHandler = () => this._scheduleLive2DLayout();
      window.addEventListener('resize', this._live2dResizeHandler);
      window.addEventListener('orientationchange', this._live2dResizeHandler);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this._live2dViewportHandler);
        window.visualViewport.addEventListener('scroll', this._live2dViewportHandler);
      }

      console.log('[DigitalHuman] Live2D model initialized');
    } catch (error: DHAny) {
      console.error('[DigitalHuman] Failed to initialize Live2D:', error);
    }
  }

  async _ensureLive2DScripts() {
    if ((window as DHAny)._live2dScriptsLoaded) return;
    for (const src of LIVE2D_SCRIPTS) {
      await loadScript(src);
    }
    (window as DHAny)._live2dScriptsLoaded = true;
  }

  _getLive2DLayoutTarget() {
    if (this.avatarOnlyMode) {
      return this._avatarRoot || this._live2dCanvas?.parentElement || this._live2dCanvas;
    }
    return this._live2dCanvas?.parentElement || this._avatarRoot || this._live2dCanvas;
  }

  _getLive2DViewportSize() {
    const target = this._getLive2DLayoutTarget();
    const rect = target?.getBoundingClientRect?.();
    let width = Math.round(rect?.width || 0);
    let height = Math.round(rect?.height || 0);

    if (this.avatarOnlyMode) {
      width = Math.max(width, Math.round(window.visualViewport?.width || window.innerWidth || 0));
      height = Math.max(height, Math.round(window.visualViewport?.height || window.innerHeight || 0));
    }

    if ((width <= 0 || height <= 0) && this._avatarRoot?.getBoundingClientRect) {
      const fallbackRect = this._avatarRoot.getBoundingClientRect();
      width = Math.max(width, Math.round(fallbackRect.width || 0));
      height = Math.max(height, Math.round(fallbackRect.height || 0));
    }

    if (width <= 0) width = Math.round(window.visualViewport?.width || window.innerWidth || 0);
    if (height <= 0) height = Math.round(window.visualViewport?.height || window.innerHeight || 0);

    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  _syncLive2DViewport(force: DHAny) {
    if (!this.live2dApp || !this._live2dCanvas) return false;

    const size = this._getLive2DViewportSize();
    if (!size.width || !size.height) return false;

    const widthChanged = this.live2dApp.screen.width !== size.width;
    const heightChanged = this.live2dApp.screen.height !== size.height;

    if (force || widthChanged || heightChanged) {
      this.live2dApp.renderer.resize(size.width, size.height);
      this._live2dCanvas.style.width = `${size.width}px`;
      this._live2dCanvas.style.height = `${size.height}px`;
    }
    return true;
  }

  _scheduleLive2DLayout(force?: DHAny) {
    if (!this.live2dApp || !this.live2dModel) return;

    if (this._live2dRelayoutFrame) cancelAnimationFrame(this._live2dRelayoutFrame);
    if (this._live2dRelayoutTimeout) clearTimeout(this._live2dRelayoutTimeout);

    const relayout = (shouldForce: DHAny) => {
      if (!this._syncLive2DViewport(shouldForce)) return;
      this._layoutLive2D();
    };

    this._live2dRelayoutFrame = requestAnimationFrame(() => {
      this._live2dRelayoutFrame = null;
      relayout(force);
    });

    this._live2dRelayoutTimeout = setTimeout(() => {
      this._live2dRelayoutTimeout = null;
      relayout(true);
    }, 120);
  }

  _observeLive2DContainer() {
    if (this._live2dResizeObserver) {
      this._live2dResizeObserver.disconnect();
      this._live2dResizeObserver = null;
    }
    if (typeof ResizeObserver !== 'function') return;

    const target = this._getLive2DLayoutTarget();
    if (!target) return;

    this._live2dResizeObserver = new ResizeObserver(() => this._scheduleLive2DLayout());
    this._live2dResizeObserver.observe(target);
    if (this._avatarRoot && this._avatarRoot !== target) {
      this._live2dResizeObserver.observe(this._avatarRoot);
    }
  }

  /**
   * Get merged layout params (scale, offsetY) from idle action config + URL query.
   * URL query params override config object props.
   * offsetY is a fraction of viewport height (e.g. 0.2 = 20%).
   * @returns {{ scale: number, offsetY: number }}
   */
  _getIdleLayoutParams() {
    const idleAction = this._resolveAction('idle');
    const urlParams = parseLayoutParamsFromURL(idleAction?.url);
    const scale = (Number.isFinite(urlParams.scale) ? urlParams.scale : Number(idleAction?.scale)) || 1;
    const offsetY = (Number.isFinite(urlParams.offsetY) ? urlParams.offsetY : Number(idleAction?.offsetY)) || 0;
    return { scale, offsetY };
  }

  _layoutLive2D() {
    if (!this.live2dApp || !this.live2dModel) return;
    const bounds = this.live2dModel.getLocalBounds();
    if (!bounds.width || !bounds.height) return;

    const { scale: userScale, offsetY: offsetYFrac } = this._getIdleLayoutParams();

    const viewport = this._getLive2DViewportSize();
    const isFullscreen = this.avatarOnlyMode;
    const widthRatio = isFullscreen ? 0.92 : 0.8;
    const heightRatio = isFullscreen ? 0.92 : 0.85;
    const padding = isFullscreen ? 8 : Math.max(24, Math.min(viewport.width, viewport.height) * 0.04);
    const availableWidth = Math.max(1, viewport.width * widthRatio);
    const availableHeight = Math.max(1, viewport.height * heightRatio);
    const baseScale = Math.max(0.01, Math.min(availableWidth / bounds.width, availableHeight / bounds.height));
    const scale = baseScale * userScale;
    const offsetYPx = offsetYFrac * viewport.height;

    this.live2dModel.scale.set(scale);
    this.live2dModel.x = viewport.width / 2 - (bounds.x + bounds.width / 2) * scale;
    if (isFullscreen) {
      this.live2dModel.y = viewport.height / 2 - (bounds.y + bounds.height / 2) * scale + offsetYPx;
    } else {
      this.live2dModel.y = viewport.height - padding - (bounds.y + bounds.height) * scale + offsetYPx;
    }
  }

  // ========================================================================
  // SECTION 6: Lip Sync — Live2D Binding
  // ========================================================================

  _bindLive2DLipSync() {
    const internalModel = this.live2dModel?.internalModel;
    if (!internalModel?.on) return;

    const motionManagerIds = this.live2dModel?.internalModel?.motionManager?.lipSyncIds;
    const settingsIds = this.live2dModel?.internalModel?.settings?.getLipSyncParameters?.();
    this._live2dLipSyncIds =
      (Array.isArray(motionManagerIds) && motionManagerIds.length) ? motionManagerIds
      : (Array.isArray(settingsIds) && settingsIds.length) ? settingsIds
      : [MOUTH_PARAM_ID];

    if (this._live2dLipSyncHandler && internalModel.off) {
      internalModel.off('beforeModelUpdate', this._live2dLipSyncHandler);
    }

    this._live2dLipSyncHandler = () => {
      const coreModel = this.live2dModel?.internalModel?.coreModel;
      if (!coreModel) return;
      const v = Math.max(0, Math.min(1, this._live2dLipSyncValue));
      const ids = this._live2dLipSyncIds || [MOUTH_PARAM_ID];
      if (typeof coreModel.addParameterValueById === 'function') {
        ids.forEach((id: DHAny) => coreModel.addParameterValueById(id, v, 1));
      } else if (typeof coreModel.setParameterValueById === 'function') {
        ids.forEach((id: DHAny) => coreModel.setParameterValueById(id, v));
      }
    };
    internalModel.on('beforeModelUpdate', this._live2dLipSyncHandler);
  }

  /**
   * Set mouth open value (0-1) for lip sync.
   * @param {number} value - 0 (closed) to 1 (fully open)
   */
  setMouthOpen(value: DHAny) {
    this._live2dLipSyncValue = Math.max(0, Math.min(1, value));
  }

  // ========================================================================
  // SECTION 7: Lip Sync — Audio Analysis (TTS)
  // ========================================================================

  /**
   * Play audio via Web Audio API with lip sync analysis.
   * @param {string} audioUrl - URL of the audio to play
   * @param {Function|Object} [callbacks] - Callback or { onStart, onEnded }
   * @returns {Promise<AudioBufferSourceNode>}
   */
  async playAudioWithLipSync(audioUrl: DHAny, callbacks: DHAny) {
    this.stopAudioLipSync();

    const onEnded = typeof callbacks === 'function' ? callbacks : callbacks?.onEnded;
    const onStart = typeof callbacks === 'function' ? null : callbacks?.onStart;

    this._ttsAudioCtx = await this._getAudioEngine().resume();

    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this._ttsAudioCtx.decodeAudioData(arrayBuffer);

    const source = this._ttsAudioCtx.createBufferSource();
    source.buffer = audioBuffer;

    const analyser = this._ttsAudioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    analyser.connect(this._ttsAudioCtx.destination);

    this._lipSyncAnalyser = analyser;
    this._ttsSource = source;

    // RMS-based lip sync loop
    const dataArray = new Uint8Array(analyser.fftSize);
    const update = () => {
      if (!this._lipSyncAnalyser) return;
      analyser.getByteTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      this.setMouthOpen(Math.min(1, rms * 4.5));
      this._lipSyncRaf = requestAnimationFrame(update);
    };
    this._lipSyncRaf = requestAnimationFrame(update);

    // Play a talk motion
    this.playMotion(['Tap', 'TapBody'], 2);

    source.addEventListener('ended', () => {
      this.stopAudioLipSync();
      if (onEnded) onEnded();
    });
    if (onStart) onStart();
    source.start(0);

    return source;
  }

  /** Stop audio-driven lip sync. */
  stopAudioLipSync() {
    if (this._lipSyncRaf) {
      cancelAnimationFrame(this._lipSyncRaf);
      this._lipSyncRaf = null;
    }
    this.setMouthOpen(0);
    this._lipSyncAnalyser = null;
    if (this._ttsSource) {
      try { this._ttsSource.stop(); } catch (e: DHAny) { /* already stopped */ }
      this._ttsSource = null;
    }
  }

  // ========================================================================
  // SECTION 8: Lip Sync — RTC Volume Interpolation
  // ========================================================================

  /** Start smooth RTC lip sync animation loop. */
  _startRtcLipSync() {
    if (this._rtcLipSyncFrameId) return;
    const update = () => {
      const speed = this._rtcLipSyncTarget > this._rtcLipSyncValue ? 0.35 : 0.18;
      this._rtcLipSyncValue += (this._rtcLipSyncTarget - this._rtcLipSyncValue) * speed;
      if (this._rtcLipSyncValue < 0.01) this._rtcLipSyncValue = 0;
      this.setMouthOpen(this._rtcLipSyncValue);
      this._rtcLipSyncFrameId = requestAnimationFrame(update);
    };
    update();
  }

  /** Stop RTC lip sync animation loop. */
  _stopRtcLipSync() {
    if (this._rtcLipSyncFrameId) {
      cancelAnimationFrame(this._rtcLipSyncFrameId);
      this._rtcLipSyncFrameId = 0;
    }
    this._rtcLipSyncTarget = 0;
    this._rtcLipSyncValue = 0;
    this.setMouthOpen(0);
  }

  // ========================================================================
  // SECTION 9: Avatar State Switching
  // ========================================================================

  /** Switch avatar to idle state. */
  switchToIdle() {
    if (!this.isEnabled) return;

    // If a timed custom action (not talk/idle) is still playing, don't interrupt it.
    // The action's own timeout will call switchToIdle() when it expires.
    if (this._playActionTimeout && this._currentPlayAction
        && this._currentPlayAction !== 'talk' && this._currentPlayAction !== 'idle') {
      return;
    }

    this._cancelRandomIdle();
    // Clear playAction state — we're returning to idle
    this._currentPlayAction = null;
    if (this._playActionTimeout) {
      clearTimeout(this._playActionTimeout);
      this._playActionTimeout = null;
    }

    if (this.live2dMode) {
      this._hideLive2DWebpOverlay();
      this.currentVideoType = 'idle';
      this._scheduleRandomIdle();
      return;
    }

    if (this.webpMode) {
      if (this._webpIdleDebounce) return;
      // Cancel any pending webp action onload to prevent stale callbacks
      this._webpActionGen = (this._webpActionGen || 0) + 1;
      this._webpIdleDebounce = setTimeout(() => {
        this._webpIdleDebounce = null;
        this.currentVideoType = 'idle';
        if (this._webpIdle) {
          this._webpIdle.classList.remove('dh-hidden');
          this._webpIdle.classList.add('dh-visible');
        }
        if (this._webpTalk) {
          this._webpTalk.onload = null;
          this._webpTalk.classList.remove('dh-visible');
          this._webpTalk.classList.add('dh-hidden');
        }
        this._scheduleRandomIdle();
      }, 500);
      return;
    }

    // Video mode
    if (this._transitionTimeout) { clearTimeout(this._transitionTimeout); this._transitionTimeout = null; }
    if (this._pauseTimeout) { clearTimeout(this._pauseTimeout); this._pauseTimeout = null; }

    if (!this.isIdleVideoLoaded) {
      this._loadIdleVideo().catch(e => console.error('[DigitalHuman] Error loading idle video:', e));
      return;
    }

    this._videoIdle.muted = true;
    this._videoIdle.defaultMuted = true;
    this._videoIdle.currentTime = 0;

    this._videoIdle.play().then(() => {
      this._videoIdle.classList.remove('dh-hidden');
      this._videoIdle.classList.add('dh-visible');

      this._transitionTimeout = setTimeout(() => {
        this._transitionTimeout = null;
        this._videoTalk.classList.remove('dh-visible');
        this._videoTalk.classList.add('dh-hidden');
        this._pauseTimeout = setTimeout(() => {
          this._videoTalk.pause();
          this._pauseTimeout = null;
        }, 800);
      }, 100);

      this.currentVideoType = 'idle';
      this._scheduleRandomIdle();
    }).catch((e: DHAny) => console.error('[DigitalHuman] Error playing idle video:', e));
  }

  /** Switch avatar to talking state. */
  // Cancel any random idle when transitioning to talk or other active states
  switchToTalking() {
    if (!this.isEnabled) return;
    this._cancelRandomIdle();

    if (this.live2dMode) {
      this._hideLive2DWebpOverlay();
      this.playMotion(['Tap', 'TapBody'], 2);
      this.currentVideoType = 'talk';
      return;
    }

    if (this.webpMode) {
      if (this._webpIdleDebounce) {
        clearTimeout(this._webpIdleDebounce);
        this._webpIdleDebounce = null;
      }
      if (this.currentVideoType === 'talk') return;
      this.currentVideoType = 'talk';
      if (this._webpTalk) {
        // Restore talk URL in case _playWebpAction changed it
        const talkAction = this._resolveAction('talk');
        if (talkAction?.url && !this._webpTalk.src.endsWith(talkAction.url) && this._webpTalk.src !== new URL(talkAction.url, location.href).href) {
          this._webpTalk.src = talkAction.url;
        }
        this._webpTalk.classList.remove('dh-hidden');
        this._webpTalk.classList.add('dh-visible');
        if (this._webpIdle) {
          this._webpIdle.classList.remove('dh-visible');
          this._webpIdle.classList.add('dh-hidden');
        }
      }
      return;
    }

    // Video mode
    if (!this.isTalkVideoLoaded) {
      this._preloadTalkVideo().then(() => this._performTalkTransition()).catch(() => this.switchToIdle());
    } else {
      this._performTalkTransition();
    }
  }

  _performTalkTransition() {
    if (this._transitionTimeout) { clearTimeout(this._transitionTimeout); this._transitionTimeout = null; }
    if (this._pauseTimeout) { clearTimeout(this._pauseTimeout); this._pauseTimeout = null; }

    this._videoTalk.muted = true;
    this._videoTalk.defaultMuted = true;
    this._videoTalk.currentTime = 0;

    this._videoTalk.play().then(() => {
      this._videoTalk.classList.remove('dh-hidden');
      this._videoTalk.classList.add('dh-visible');
      this.currentVideoType = 'talk';
    }).catch((error: DHAny) => {
      console.error('[DigitalHuman] Error playing talk video:', error);
      this.switchToIdle();
    });
  }

  /**
   * Switch avatar to a named state. Supports aliases (e.g. 'idle', 'talk', 0, 1).
   * @param {string|number} type
   */
  switchVideo(type: DHAny) {
    if (!this.isEnabled) return;
    const resolved = DigitalHuman.BUILTIN_ALIASES[type] || String(type);

    if (this.live2dMode) {
      this._hideLive2DWebpOverlay();
      if (resolved === 'talk') this.playMotion(['Tap', 'TapBody'], 2);
      this.currentVideoType = resolved;
      return;
    }

    if (resolved === 'talk') this.switchToTalking();
    else this.switchToIdle();
  }

  /**
   * Play a Live2D motion.
   * @param {string[]} [preferredGroups=['Tap','TapBody','Idle']]
   * @param {number} [priority=2]
   */
  playMotion(preferredGroups: DHAny, priority: DHAny) {
    if (!this.live2dModel?.motion) return;
    const motions = this.live2dModel.internalModel?.settings?.motions || {};
    const availableGroups = Object.keys(motions);
    const group = (preferredGroups || ['Tap', 'TapBody', 'Idle']).find((g: DHAny) => availableGroups.includes(g)) || availableGroups[0];
    if (group) this.live2dModel.motion(group, undefined, priority || 2, { sound: '' });
  }

  /**
   * Play a named action from videoActions for a given duration, then return to idle.
   * Supports aliases: '待机'/0 → 'idle', '说话'/1 → 'talk', plus any pipe-defined aliases.
   * If called again with the same resolved action, only the duration timer is reset.
   * @param {string|number} actionKey - Key in videoActions (e.g. '高兴', 'happy', 'talk', '说话', 1)
   * @param {number} [duration=3] - Seconds to hold the action. -1 = stay indefinitely.
   */
  playAction(actionKey: DHAny, duration = 3) {
    if (!this.isEnabled) return;

    // Resolve alias to canonical key
    const resolved = DigitalHuman.BUILTIN_ALIASES[actionKey] || String(actionKey);

    // Cancel random idle when playing a non-idle action
    if (resolved !== 'idle') this._cancelRandomIdle();

    // Clear any previous playAction timer
    if (this._playActionTimeout) {
      clearTimeout(this._playActionTimeout);
      this._playActionTimeout = null;
    }

    // If same action is already playing, just reset the timer
    const sameAction = this._currentPlayAction === resolved && this.currentVideoType === resolved;

    if (!sameAction) {
      this._currentPlayAction = resolved;

      // Built-in states
      if (resolved === 'talk') { this.switchToTalking(); }
      else if (resolved === 'idle') { this.switchToIdle(); this._currentPlayAction = null; return; }
      else if (this.live2dMode) {
        // Live2D: check if the action has a webp URL for overlay
        const actionConfig = this._resolveAction(resolved);
        if (actionConfig?.url && detectMediaType(actionConfig.url) === 'webp') {
          this._playLive2DWebpOverlay(actionConfig.url);
        } else {
          this.playMotion(['Tap', 'TapBody'], 2);
        }
        this.currentVideoType = resolved;
      } else if (this.webpMode) {
        // Webp: swap talk image to the action's webp URL
        const actionConfig = this._resolveAction(resolved);
        if (actionConfig?.url) {
          this._playWebpAction(actionConfig.url);
          this.currentVideoType = resolved;
        } else {
          this.switchToTalking();
        }
      } else {
        // Video mode: load and play the action video if available
        const actionConfig = this._resolveAction(resolved);
        if (actionConfig?.url) {
          this._playActionVideo(actionConfig.url);
          this.currentVideoType = resolved;
        } else {
          // Fallback to talk
          this.switchToTalking();
        }
      }
    }

    // Schedule return to idle
    if (duration !== -1) {
      this._playActionTimeout = setTimeout(() => {
        this._playActionTimeout = null;
        this._currentPlayAction = null;
        this.switchToIdle();
      }, duration * 1000);
    }
  }

  /**
   * Load and play a one-off action video on the talk video element.
   * @param {string} url - Video URL
   */
  _playActionVideo(url: DHAny) {
    if (!this._videoTalk) return;
    if (this._transitionTimeout) { clearTimeout(this._transitionTimeout); this._transitionTimeout = null; }
    if (this._pauseTimeout) { clearTimeout(this._pauseTimeout); this._pauseTimeout = null; }

    const source = this._videoTalk.querySelector('source');
    source.src = url;
    this._videoTalk.muted = true;
    this._videoTalk.defaultMuted = true;
    this._videoTalk.load();

    this._videoTalk.onloadeddata = () => {
      this._videoTalk.currentTime = 0;
      this._videoTalk.play().then(() => {
        this._videoTalk.classList.remove('dh-hidden');
        this._videoTalk.classList.add('dh-visible');
        this._videoIdle.classList.remove('dh-visible');
        this._videoIdle.classList.add('dh-hidden');
      }).catch((e: DHAny) => console.error('[DigitalHuman] Action video play failed:', e));
    };
  }

  // ========================================================================
  // SECTION 10: Host Control API (for iframe interop)
  // ========================================================================

  /** Get current avatar control state for host. */
  getAvatarStatus() {
    return {
      enabled: Boolean(this.isEnabled),
      idleMediaType: this.idleMediaType || 'unknown',
      live2dMode: Boolean(this.live2dMode),
      live2dReady: Boolean(this.live2dModel),
      currentVideoType: this.currentVideoType || '',
      mouthOpen: Number((this._live2dLipSyncValue || 0).toFixed(3)),
      hostSessionActive: Boolean(this.hostLive2DSessionActive),
    };
  }

  getSession() {
      return this._aiChatSession;
  }

  /**
   * Manually send the configured boot message through the text chat session.
   * The boot input itself is excluded from keepHistory, while the assistant
   * reply remains in the session like any other reply.
   * @param {string} [bootMessage] - Override message; defaults to characterConfig.initial.bootMessage
   * @param {Object} [options]
   * @returns {Promise<{ finalText: string, parsedResponse: Object, mode: 'text', skipped?: boolean, reason?: string }>}
   */
  async sendBootMessage(bootMessage: DHAny, options: DHAny = {}) {
    const resolvedBootMessage = bootMessage ?? this.characterConfig?.initial?.bootMessage;
    if (!resolvedBootMessage) {
      return {
        finalText: '',
        parsedResponse: null,
        mode: 'text',
        skipped: true,
        reason: 'no-boot-message',
      };
    }
    return this.send(resolvedBootMessage, {
      runCode: true,
      skipHistory: true,
      ...options,
    });
  }

  // ========================================================================
  // SECTION 10.1: Remote Control API
  // ========================================================================
  
  /**
   * Enable remote control via postMessage. Listens for messages and calls methods on this instance.
   * @param {Object} options
   * @param {string} options.msgPrefix - Prefix for message types
   * @param {Function} options.postToParent - Function to send messages back
   * @param {Function} [options.setupToolProxy] - Optional hook to modify config before init
   * @param {boolean} [options.forwardUserVoiceInputViaParentFrame] - Let the parent DigitalHumanFrame forward user voice text to minigames.
   */
  enableRemoteControl(options: DHAny = {}) {
      const { msgPrefix, postToParent, setupToolProxy } = options;
      this._forwardUserVoiceInputViaParentFrame = options.forwardUserVoiceInputViaParentFrame === true;
      
        const MSG = createFrameMessages(msgPrefix);

      // Wire all events to parent
      const events = [
        'message', 'complete', 'error', 'reasoning', 'toolCall', 'toolResult', 'bracketAction', 'restartAgent',
        'avatarReady', 'voiceChatStarted', 'voiceChatStopped', 'voiceChatState',
        'subtitle', 'welcome', 'audioLevel', 'autoplayFailed', 'summarized', 'comfortMessage',
        'command', 'textSpeechStart', 'textSpeechEnd', 'textSpeechCanceled',
        'userMessage', 'pageRouterOpen', 'pageRouterHeartbeat', 'voiceHeartbeat',
        'activeChanged', 'active', 'inactive',
      ];

      for (const evt of events) {
        this.on(evt, (data: DHAny) => {
          // postMessage 无法克隆函数/类实例，需要安全序列化
          let safeData;
          try {
            safeData = data != null ? JSON.parse(JSON.stringify(data)) : data;
          } catch {
            safeData = null;
          }
          postToParent({ type: MSG.EVENT, event: evt, data: safeData });
        });
      }

      window.addEventListener('message', async (e) => {
          const msg = e.data;
          if (msg && msg.is_agent_router) return;
          if (!msg || typeof msg.type !== 'string') return;

          // Handle dh:send / dh:context / dh:app-page-opened from child iframes (any source)
          if (msg.type === 'dh:send') { this._handleExternalSend(msg); return; }
          if (msg.type === 'dh:context') { this._handleExternalContext(msg); return; }
          if (msg.type === 'dh:app-page-opened') { this._handleAppPageOpened(msg); return; }

          if (!msg.type.startsWith(msgPrefix)) return;

          const { type, callId } = msg;

          try {
            let result;

            switch (type) {
              case MSG.INIT_AVATAR:
                await this.initAvatar(msg.videoActions, msg.options || {});
                result = { ok: true };
                break;
              case MSG.INIT_FROM_CONFIG:
                const cfgInit = msg.config || {};
                if (setupToolProxy) setupToolProxy(cfgInit);
                const info = await this.initFromConfig(cfgInit);
                // initFromConfig returns { session, config }; extract character fields from config
                const cfg = info.config || cfgInit;
                result = {
                  ok: true, config: cfg, character: cfg.character,
                  initial_message: cfg.initial?.message || cfg.initial_message,
                  quick_replies: cfg.quick_replies,
                  objective: cfg.objective, completion_messages: cfg.completion_messages,
                  voiceChat: cfg.voiceChat,
                };
                break;
              case MSG.CREATE_SESSION:
                const cfgSess = msg.config || {};
                if (setupToolProxy) setupToolProxy(cfgSess);
                await this.createSession(cfgSess);
                result = { ok: true };
                break;
              case MSG.SEND:
                const sendRes = await this.send(msg.userMessage, msg.options);
                result = { ok: true, data: sendRes };
                break;
              case MSG.SEND_MESSAGE:
                const res = await this.sendMessage(msg.userMessage, msg.options);
                result = { ok: true, data: res };
                break;
              case MSG.CANCEL_SEND:
                const canceledCount = await this._cancelActiveTextSends(msg.reason || 'barge-in');
                this._clearQueuedTextSends(msg.reason || 'barge-in');
                result = { ok: true, data: { canceledCount } };
                break;
              case MSG.SEND_BOOT_MESSAGE:
                const bootRes = await this.sendBootMessage(msg.bootMessage, msg.options);
                result = { ok: true, data: bootRes };
                break;
              case MSG.PLAY_ACTION:
                this.playAction(msg.actionKey, msg.duration);
                result = { ok: true };
                break;
              case MSG.SWITCH_VIDEO:
                this.switchVideo(msg.videoType);
                result = { ok: true };
                break;
              case MSG.SWITCH_TO_IDLE:
                this.switchToIdle();
                result = { ok: true };
                break;
              case MSG.SWITCH_TO_TALKING:
                this.switchToTalking();
                result = { ok: true };
                break;
              case MSG.SET_MOUTH_OPEN:
                this.setMouthOpen(msg.value);
                result = { ok: true };
                break;
              case MSG.PLAY_MOTION:
                this.playMotion(msg.preferredGroups, msg.priority);
                result = { ok: true };
                break;
              case MSG.GET_ACTIONS:
                result = { ok: true, actions: this.getActions() };
                break;
              case MSG.GET_ACTION_LIST:
                result = { ok: true, actionList: this._getActionList(msg.lang) };
                break;
              case MSG.GET_AVATAR_STATUS:
                result = { ok: true, status: this.getAvatarStatus() };
                break;
              case MSG.GET_SESSION:
                const session = this.getSession();
                result = { ok: true, session: session ? { messages: session.messages } : null };
                break;
              case MSG.START_VOICE_CHAT:
                const vcPreset = msg.preset || {};
                if (setupToolProxy) {
                  // 用临时对象获取 toolProxy 配置，避免覆盖 preset.tools（RTC 期望数组）
                  // Pass _parentToolDefs/_proxyCategories so setupToolProxy registers custom categories
                  const tempCfg: DHAny = {};
                  if (vcPreset._parentToolDefs) tempCfg._parentToolDefs = vcPreset._parentToolDefs;
                  if (vcPreset._proxyCategories) tempCfg._proxyCategories = vcPreset._proxyCategories;
                  setupToolProxy(tempCfg);
                  vcPreset.toolProxy = tempCfg.tools?.toolProxy || null;
                  // toolProxy handles execution routing — all proxied categories
                  // can be called locally without being exposed to the LLM.
                  // LLM-visible tools are strictly controlled by the `tools:` config
                  // resolved in _buildVoiceChatPreset → _buildEnableTools.
                  // Do NOT merge proxy categories into enabledToolCategories here.
                  // Clean internal transport props from preset
                  delete vcPreset._parentToolDefs;
                  delete vcPreset._proxyCategories;
                }
                await this.startVoiceChat(vcPreset, msg.options || {});
                result = { ok: true };
                break;
              case MSG.STOP_VOICE_CHAT:
                await this.stopVoiceChat();
                result = { ok: true };
                break;
              case MSG.SEND_VOICE_TEXT:
                this.sendText(msg.text);
                result = { ok: true };
                break;
              case MSG.SEND_CONTEXT:
                this.sendContext(msg.text, msg.options || {});
                result = { ok: true };
                break;
              case MSG.SEND_TTS:
                this.sendTTS(msg.text, msg.options || {});
                result = { ok: true };
                break;
              case MSG.MUTE_MICROPHONE:
                const vcSession = this.getVoiceChatSession();
                if (vcSession) {
                   if (msg.muted) vcSession.mute();
                   else vcSession.unmute();
                }
                result = { ok: true };
                break;
              case MSG.UPDATE_VOICE_CHAT:
                const ucSession = this.getVoiceChatSession();
                if (ucSession) {
                  const resp = await ucSession.updateVoiceChat(msg.command, msg.options || {});
                  result = { ok: true, data: resp };
                } else {
                  result = { ok: false, error: 'No active voice chat session' };
                }
                break;
              case MSG.RESTART_VOICE_CHAT:
                result = { ok: true, data: await this.restartVoiceChat(msg.config || {}) };
                break;
              case MSG.RESTART_AGENT:
                result = { ok: true, data: await this.restartAgent(msg.promptFile, msg.tools, msg.options || {}) };
                break;
              case MSG.SEND_HEARTBEAT:
                result = { ok: true, data: await this.sendHeartbeat(msg.text, msg.options || {}) };
                break;
              case MSG.TRIGGER_VOICE_HEARTBEAT:
                result = { ok: true, data: await this.triggerVoiceHeartbeat(msg.input || {}, msg.options || {}) };
                break;
              case MSG.SET_ACTIVE:
                result = await this.setActive(msg.active, msg.options || {});
                break;
              case MSG.SET_SUBTITLE_CONFIG:
                result = { ok: true, config: this.setSubtitleConfig(msg.config || {}) };
                break;
              case MSG.GET_SUBTITLE_CONFIG:
                result = { ok: true, config: this.getSubtitleConfig() };
                break;
              case MSG.CLEAR_SUBTITLE:
                this.clearSubtitle(msg.options || {});
                result = { ok: true };
                break;
              case MSG.EXPAND_INLINE_SYSTEM_PROMPT:
                result = {
                  ok: true,
                  text: await this.expandInlineSystemPrompt(msg.text),
                };
                break;
              case MSG.DESTROY:
                await this.destroy();
                result = { ok: true };
                break;
              case MSG.LOAD_SUMMARIZE_AGENT_CONFIG:
                await this.loadSummarizeAgentConfig(msg.config);
                result = { ok: true };
                break;
              case MSG.SUMMARIZE:
                // summarize() is fire-and-forget with internal queue/merge.
                // Result is delivered via the 'summarized' event.
                this.summarize(msg.options || {});
                result = { ok: true };
                break;
              case MSG.SET_TOKEN:
                // Parent pushed an updated auth token; sync it to the iframe SDK
                // so subsequent requests authenticate as the latest user.
                if (this.sdk && typeof this.sdk.setToken === 'function') {
                  this.sdk.setToken(msg.token || null);
                }
                result = { ok: true };
                break;
              default:
                return;
            }

            if (callId) {
              postToParent({ type: MSG.RESPONSE, callId, result });
            }
          } catch (err: DHAny) {
            console.error('DigitalHuman remote control error:', err);
            if (callId) {
              postToParent({ type: MSG.RESPONSE, callId, result: { ok: false, error: err.message } });
            }
          }
      });
  }

  _normalizeHostMouthValue(payload: DHAny) {
    if (!payload || typeof payload !== 'object') return null;
    const rawValue = payload.mouthOpen ?? payload.volume ?? payload.audioLevel ?? payload.level;
    if (rawValue == null) return null;
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) return null;
    if (numericValue <= 1) return Math.max(0, Math.min(1, numericValue));
    return Math.max(0, Math.min(1, numericValue / 128));
  }

  /** Ensure Live2D model is ready (initializes if needed). */
  async ensureLive2DReady() {
    if (!this._videoActions) throw new Error('Avatar not initialized');

    const idleAction = this._resolveAction('idle');
    if (!idleAction?.url) throw new Error('No idle action configured');

    const mediaType = detectMediaType(idleAction.url);
    if (mediaType !== 'live2d') throw new Error('Current avatar is not Live2D');

    this.idleMediaType = mediaType;
    this.live2dMode = true;
    this.webpMode = false;

    if (!this.isEnabled) {
      await this.initAvatar(this._videoActions);
    }

    if (this.live2dModel) return this.getAvatarStatus();

    if (!this._live2dInitPromise) {
      this._live2dInitPromise = this._initializeLive2D().finally(() => {
        this._live2dInitPromise = null;
      });
    }
    await this._live2dInitPromise;

    if (!this.live2dModel) throw new Error('Live2D model init failed');
    return this.getAvatarStatus();
  }

  async startHostLive2DCall(payload: DHAny = {}) {
    await this.ensureLive2DReady();
    this.hostLive2DSessionActive = true;
    this.stopAudioLipSync();

    const motionGroups = Array.isArray(payload.motionGroups) ? payload.motionGroups.filter(Boolean)
      : payload.motion ? [payload.motion] : ['Tap', 'TapBody'];
    const priority = Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 2;
    const mouthValue = this._normalizeHostMouthValue(payload);
    const speaking = payload.speaking !== false;

    if (speaking) {
      this.switchToTalking();
      if (motionGroups.length > 0) this.playMotion(motionGroups, priority);
    } else {
      this.switchToIdle();
    }

    if (mouthValue !== null) this.setMouthOpen(mouthValue);
    else if (!speaking) this.setMouthOpen(0);

    return this.getAvatarStatus();
  }

  async updateHostLive2DCall(payload: DHAny = {}) {
    await this.ensureLive2DReady();
    this.hostLive2DSessionActive = true;

    const state = typeof payload.state === 'string' ? payload.state.toLowerCase() : '';
    const explicitSpeaking = typeof payload.speaking === 'boolean' ? payload.speaking : null;
    const mouthValue = this._normalizeHostMouthValue(payload);
    const shouldStop = state === 'stop' || state === 'idle' || explicitSpeaking === false;

    if (shouldStop) {
      this.setMouthOpen(0);
      this.switchToIdle();
      return this.getAvatarStatus();
    }

    if (explicitSpeaking === true || (mouthValue !== null && mouthValue > 0) || state === 'talk' || state === 'speaking') {
      this.switchToTalking();
    }

    const motionGroups = Array.isArray(payload.motionGroups) ? payload.motionGroups.filter(Boolean)
      : payload.motion ? [payload.motion] : [];
    if (motionGroups.length > 0) {
      const priority = Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 2;
      this.playMotion(motionGroups, priority);
    }

    if (mouthValue !== null) this.setMouthOpen(mouthValue);
    return this.getAvatarStatus();
  }

  stopHostLive2DCall() {
    this.hostLive2DSessionActive = false;
    this.stopAudioLipSync();
    this.setMouthOpen(0);

    if (this.isEnabled) this.switchToIdle();
    else this.currentVideoType = 'idle';

    return this.getAvatarStatus();
  }

  // ========================================================================
  // SECTION 10.5: initFromConfig — One-Call Setup from Character Config
  // ========================================================================

  /**
   * Initialize the DigitalHuman from a characterManager-style config object.
   * This is a convenience method that sets up avatar, AI session, and stores
   * all character metadata in one call.
   *
   * The config object mirrors the format produced by characterManager's
   * `buildCharacterConfig`, with the same nested structure:
   *
   * @param {Object} config - characterManager-style config (all fields stored in dh.characterConfig)
   * @param {string}  [config.system_prompt]        - System prompt for LLM
   * @param {boolean} [config.enable_system_prompt] - Whether system prompt is active (default true)
   * @param {string|Object} [config.llm_model]      - Model name string or { model, temperature, knowledgeUsername, knowledgeBaseCodes, reasoning }
   * @param {Object}  [config.videoActions]         - { '待机': { url }, '说话': { url }, ... }
  * @param {Object}  [config.tools]                - { fileOps: { enabled, workspace, ... }, web: { enabled }, ... }
  * @param {Array}   [config.searchPaths]           - Search paths for readFile URL fallback: [{ prefix, baseUrl }]
  * @param {boolean|Object} [config.bracketAction] - `true` emits bracketAction events; object form also supports autoplay/duration; parsing is limited to the first 500 words
    * @param {boolean|Object} [config.textToSpeech] - Non-RTC assistant reply speech; `true` enables SpeechRTC defaults, object form accepts `speechRTC` or `speech` provider options. Set `autoReadReply: false` to keep manual TTS available but stop automatically reading assistant replies.
   * @param {Object}  [config.initial]              - Initial greeting config
   * @param {string}  [config.initial.message]       - Static welcome message (displayed directly)
  * @param {string}  [config.initial.bootMessage]   - Boot message template; call sendBootMessage() manually after restoring any history
   * @param {boolean} [config.avatar_only]          - Avatar-only display mode
  * @param {boolean|Object} [config.keepHistory]    - Persist rounds to history.md; `true` or `{ historyLength, fileName, keepFullHistory }`
  * @param {boolean} [config.keepFullHistory]        - Also persist full daily history to history/history_YYYYMMDD.md
   * @param {Object}  [config.summarizeAgent]        - Dedicated summarize agent config
   * @param {string}  [config.summarizeAgent.config]  - URL or path to the agent's config file (YAML/JSON/MD)
   * @param {number}  [config.summarizeAgent.silentTickInterval] - Periodic summarization interval in seconds
   * @param {number}  [config.summarizeAgent.maxRounds]          - Threshold: max conversation rounds before triggering
   * @param {number}  [config.summarizeAgent.maxTextLength]      - Threshold: max total text length before triggering
   * @param {number}  [config.summarizeAgent.keepRecentRounds]   - Number of recent rounds to preserve
   * @param {string}  [config.summarizeAgent.mode]               - 'replace' (compress history) or 'append' (return summary only)
   *
   * @returns {Promise<Object>} { session, config, bootResponse? }
   */
  async initFromConfig(config: DHAny = {}) {
    // Store the full config (consumers can access character, quick_replies, etc. from here)
    this.characterConfig = config;
    if (Object.prototype.hasOwnProperty.call(config, 'subtitle')) {
      this.setSubtitleConfig(config.subtitle);
    }

    // Save original config on first call for restartAgent fallback
    if (!this._originalCharacterConfig) {
      this._originalCharacterConfig = JSON.parse(JSON.stringify(config));
    }

    // Avatar-only mode
    if (config.avatar_only) {
      this.avatarOnlyMode = true;
    }

    // Initialize avatar if videoActions are provided and container exists
    const videoActions = config.videoActions || DigitalHuman.DEFAULT_VIDEO_ACTIONS;
    if (videoActions && this.container) {
      const hasAnyUrl = Object.values(videoActions).some((a: DHAny) => a && a.url);
      if (hasAnyUrl) {
        await this.initAvatar(videoActions, { avatarOnlyMode: this.avatarOnlyMode });
      }
    }

    // Build session config for createSession (only fields it actually uses)
    const sessionConfig = buildDigitalHumanSessionConfig(config);

    // Create AI session
    const session = await this.createSession(sessionConfig);

    // Load summarize agent config if specified
    if (config.summarizeAgent) {
      const agentSource = config.summarizeAgent.config || config.summarizeAgent;
      try {
        await this.loadSummarizeAgentConfig(agentSource);
      } catch (e: DHAny) {
        console.warn('[DigitalHuman] Failed to load summarize agent config:', e);
      }
    }

    // Store page routers config for AppPageOpened handling
    if (config.pageRouters) {
      this._pageRouters = config.pageRouters;
    }

    return { session, config };
  }

  // ========================================================================
  // SECTION 10.6: loadConfig — Load from URL / JSON string / object
  // ========================================================================

  /**
   * Detect format of a URL by extension (stripping query/fragment).
   * @deprecated Use AgentConfig.detectFormat() instead.
   */
  static _detectConfigFormat(url: DHAny) {
    return AgentConfig.detectFormat(url);
  }

  /**
   * Normalize a parsed config object.
   * @deprecated Use AgentConfig.normalize() instead.
   */
  static _normalizeConfig(config: DHAny) {
    return AgentConfig.normalize(config);
  }

  /**
   * Fetch and parse a DigitalHuman config from a URL, JSON string, or object.
   * Delegates to AgentConfig.fetch().
   *
   * @param {string|Object} source - URL string, JSON string, or config object
   * @returns {Promise<Object>} Parsed and normalized config object
   */
  static async fetchConfig(source: DHAny) {
    return AgentConfig.fetch(source);
  }

  /**
   * Load a DigitalHuman config from a URL (JSON / YML / MD), inline JSON string, or object,
   * then initialize the avatar and AI session in one call.
   *
   * This is the simplest way to set up a DigitalHuman — just point it at a config file:
   *   await dh.loadConfig('https://example.com/character.md');
   *
   * Equivalent to:
   *   const config = await DigitalHuman.fetchConfig(source);
   *   await dh.initFromConfig(config);
   *
   * @param {string|Object} source - URL string, JSON string, or config object
   * @returns {Promise<Object>} Result of initFromConfig: { session, config }
   */
  async loadConfig(source: DHAny) {
    const config = await DigitalHuman.fetchConfig(source);
    markConfigSourceUrl(config, source);
    console.log('[DigitalHuman] Config loaded:', Object.keys(config).join(', '));
    const result = await this.initFromConfig(config);
    // Track the initial config source as active prompt file
    if (config._configSourceUrl && this._aiChatSession?.sandbox) {
      this._aiChatSession.sandbox._activePromptFile = config._configSourceUrl;
    }
    return result;
  }

  // ========================================================================
  // SECTION 11: AI Chat Session Management
  // ========================================================================

  /**
   * Build LLM configuration from session config.
   * @param {Object} [config] - Override config
  * @returns {Object} LLM config for sdk.aiChat.createSession()
   */
  _getLLMConfig(config: DHAny) {
    const cfg = config || this._sessionConfig || {};

    if (typeof cfg.llm_model === 'string') {
      return { model: cfg.llm_model };
    }

    const llmConfig: DHAny = { model: cfg.llm_model?.model || 'keepwork-flash' };

    if (cfg.llm_model?.temperature !== undefined) llmConfig.temperature = cfg.llm_model.temperature;
    if (cfg.llm_model?.knowledgeUsername) llmConfig.knowledgeUsername = cfg.llm_model.knowledgeUsername;
    if (cfg.llm_model?.knowledgeBaseCodes) llmConfig.knowledgeBaseCodes = cfg.llm_model.knowledgeBaseCodes;
    llmConfig.reasoning = cfg.llm_model?.reasoning ?? false;

    return llmConfig;
  }

  /**
   * Apply FileOps workspace/pathPrefix configuration to a session.
   * @param {Object} session - ChatSession
   * @param {Object} [config] - Override config
   */
  _applyFileOpsConfig(session: DHAny, config: DHAny) {
    const cfg = config || this._sessionConfig || {};
    const { fileOps, workspace, mountFolder, pathPrefix } = resolveFileOpsConfig(cfg);

    if (workspace) {
      if (session?.setWorkspace) session.setWorkspace(workspace);
    }
    if (mountFolder) {
      if (session?.setMountFolder) session.setMountFolder(mountFolder);
    }
    if (pathPrefix && this.sdk?.copilotTools) {
      this.sdk.copilotTools.setToolConfig('fileOps', { pathPrefix });
    }

    const searchPathEntries = resolveSearchPathEntries(cfg, this.characterConfig);
    if (fileOps && searchPathEntries.length && this.sdk?.personalPageStore) {
      const store = this.sdk.personalPageStore;
      for (const entry of searchPathEntries) {
        store.addSearchPath(entry.prefix, entry.baseUrl);
        if (!this._registeredSearchPaths) this._registeredSearchPaths = [];
        this._registeredSearchPaths.push(entry.prefix);
        console.log(`[DigitalHuman] Registered search path: "${entry.prefix}" → "${entry.baseUrl}"`);
      }
    }
  }

  /**
   * Pass summarization YAML config to the CopilotTools `summarize` category
   * so that `summarize_conversation` tool calls receive the configured prompt,
   * model, enableTools, keepRecentRounds, and mode.
   * @param {Object} [config]
   */
  _applySummarizationToolConfig(config: DHAny) {
    const cfg = config || this._sessionConfig || {};
    const sumConfig = cfg.summarization;
    if (!sumConfig || typeof sumConfig !== 'object') return;
    if (!this.sdk?.copilotTools) return;

    this.sdk.copilotTools.setToolConfig('summarize', {
      summarizationPrompt: sumConfig.prompt || undefined,
      summarizationModel: sumConfig.model || undefined,
      summarizationEnableTools: Array.isArray(sumConfig.enableTools) ? sumConfig.enableTools : undefined,
      keepRecentRounds: Number(sumConfig.keepRecentRounds) || 3,
    });
  }

  // ── keepHistory: persist conversation rounds to history.md ──

  /**
   * Build daily full-history file path: history/history_YYYYMMDD.md
   * @param {Date} [date]
   * @returns {string}
   */
  _getKeepHistoryDailyFileName(date = new Date()) {
    const pad = (n: DHAny) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    return `history/history_${y}${m}${d}`;
  }

  /**
   * Read a file via the session sandbox (respects tool proxy), falling back to direct store access.
   * @param {string} fileName
   * @returns {Promise<string>}
   */
  async _keepHistoryReadFile(fileName: DHAny) {
    const sandbox = this._aiChatSession?.sandbox;
    if (!sandbox?.execute) return '';
    return await sandbox.execute('read_file', { filePath: fileName });
  }

  /**
   * Create/overwrite a file via the session sandbox (respects tool proxy), falling back to direct store access.
   * @param {string} fileName
   * @param {string} content
   * @returns {Promise<string>}
   */
  async _keepHistoryCreateFile(fileName: DHAny, content: DHAny) {
    const sandbox = this._aiChatSession?.sandbox;
    if (!sandbox?.execute) return '';
    return await sandbox.execute('create_file', { filePath: fileName, content });
  }

  /**
   * Format a timestamp as local wall-clock time for history comments.
   * @param {number|Date|string} value
   * @returns {string}
   */
  _formatKeepHistoryTimestamp(value: DHAny) {
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    const pad = (n: DHAny) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * Normalize timestamp values from history comments or in-memory message fields.
   * @param {number|Date|string} value
   * @returns {number|null}
   */
  _parseKeepHistoryTimestamp(value: DHAny) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) {
      const time = value.getTime();
      return isNaN(time) ? null : time;
    }
    if (typeof value !== 'string') return null;

    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const parsed = new Date(normalized).getTime();
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Convert messages into markdown blocks with per-message timestamps.
   * @param {Array<Object>} targetMessages
   * @returns {{ content: string, entries: Array<{ timestamp: number|null, markdown: string }> }}
   */
  _buildKeepHistoryMarkdown(targetMessages: DHAny) {
    const entries = [];
    const lines = [];
    const contextBlockRegex = /\(context_begin\)[\s\S]*?\(context_end\)\s*/g;

    for (const msg of targetMessages) {
      if (msg.role === 'user') {
        let content = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((c: DHAny) => c.type === 'text').map((c: DHAny) => c.text).join(' ')
            : '';
        content = content.replace(contextBlockRegex, '').trim();
        content = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, '');
        if (!content) continue;

        const timestampValue = this._parseKeepHistoryTimestamp(msg._ts);
        const timestamp = this._formatKeepHistoryTimestamp(timestampValue ?? Date.now());
        const markdown = `## User\n<!-- ts:${timestamp} -->\n${content}\n`;
        entries.push({ timestamp: timestampValue, markdown });
        lines.push(markdown);
      } else if (msg.role === 'assistant' && msg.content) {
        const markdown = `## Assistant\n${msg.content}\n`;
        entries.push({ timestamp: null, markdown });
        lines.push(markdown);
      }
    }

    return { content: lines.join('\n'), entries };
  }

  /**
   * Read timestamped user blocks from a history markdown file.
   * @param {string} md
   * @returns {Array<{ timestamp: number|null, markdown: string }>}
   */
  _parseKeepHistoryEntries(md: DHAny) {
    if (!md || !md.trim()) return [];

    const entries = [];
    const parts = md.split(/(?=^## )/m).filter(Boolean);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const markdown = trimmed + '\n';
      const tsMatch = trimmed.match(/^## User\s+<!--\s*ts:\s*(.+?)\s*-->/m);
      entries.push({
        timestamp: tsMatch ? this._parseKeepHistoryTimestamp(tsMatch[1]) : null,
        markdown,
      });
    }
    return entries;
  }

  /**
   * Initialize keepHistory on createSession. Reads existing history.md,
    * parses it back into user/assistant messages, and injects them into the
    * session.
    *
    * Important behavior: this only restores prior context. It does not call
    * `summarize()` automatically, even if the restored conversation already
    * exceeds summarization thresholds.
   * @param {Object} config - createSession config
   */
  async _initKeepHistory(config: DHAny) {
    const khSource = config.keepHistory
      ?? this.characterConfig?.keepHistory
      ?? this.config?.keepHistory;
    this._keepHistoryConfig = resolveKeepHistoryConfig(khSource);

    const keepFullHistory = config.keepFullHistory
      ?? (typeof khSource === 'object' ? khSource.keepFullHistory : undefined)
      ?? this.characterConfig?.keepFullHistory
      ?? this.config?.keepFullHistory;
    if (this._keepHistoryConfig) {
      this._keepHistoryConfig.keepFullHistory = keepFullHistory === true;
    }

    if (!this._keepHistoryConfig?.enabled) return;

    // When restartAgent is running with a valid prompt file, chat history is
    // intentionally cleared — do NOT reload prior messages from history.md.
    if (this._restartAgentClearHistory) {
      console.log('[DigitalHuman] keepHistory: skip restore (restartAgent clearing history)');
      return;
    }

    const fileName = this._keepHistoryConfig.fileName;
    try {
      const existing = await this._keepHistoryReadFile(fileName);
      if (!existing || !existing.trim()) return;

      console.log(`[DigitalHuman] keepHistory: found existing ${fileName}.md (${existing.length} chars), loading into session...`);

      // Parse history.md back into messages (with timestamp prefixing for old msgs)
      const parsed = this._parseHistoryMd(existing);
      if (!parsed.length) return;

      // Inject parsed messages into the session after system messages
      if (this._aiChatSession?.messages) {
        const systemMessages = this._aiChatSession.messages.filter((m: DHAny) => m.role === 'system');
        const nonSystem = this._aiChatSession.messages.filter((m: DHAny) => m.role !== 'system');
        this._aiChatSession.messages = [...systemMessages, ...parsed, ...nonSystem];
        console.log(`[DigitalHuman] keepHistory: injected ${parsed.length} messages from history`);
      }

    } catch (e: DHAny) {
      console.warn('[DigitalHuman] keepHistory: failed to load history:', e);
    }
  }

  /**
  * Parse history.md markdown back into session messages.
  * Expects `<!-- ts:YYYY-MM-DD HH:mm:ss -->` timestamps before ## User sections.
   * If a message pair is older than 2 hours, the user message content is
   * prefixed with `[YYYY-MM-DD HH:mm]` so the LLM has temporal context.
   * @param {string} md - Raw markdown content
  * @returns {Array<{ role: string, content: string, _ts?: number }>}
   */
  _parseHistoryMd(md: DHAny) {
    const messages = [];
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();

    // Split into sections; keep the delimiter info
    const sections = md.split(/^## /m).filter(Boolean);
    let currentTimestamp = null;

    for (const section of sections) {
      const newlineIdx = section.indexOf('\n');
      if (newlineIdx === -1) continue;
      const header = section.slice(0, newlineIdx).trim();
      let body = section.slice(newlineIdx + 1).trim();
      if (!body) continue;

      // Extract timestamp comment if present at the start of the body
      const tsMatch = body.match(/^<!--\s*ts:\s*(.+?)\s*-->\s*/);
      if (tsMatch) {
        currentTimestamp = tsMatch[1];
        body = body.slice(tsMatch[0].length).trim();
        if (!body) continue;
      }

      if (header === 'User') {
        const messageTimestamp = currentTimestamp
          ? this._parseKeepHistoryTimestamp(currentTimestamp)
          : null;
        // Prefix with datetime if the message is older than 2 hours
        if (messageTimestamp != null) {
          if ((now - messageTimestamp) > TWO_HOURS_MS) {
            const dt = new Date(messageTimestamp);
            const pad = (n: DHAny) => String(n).padStart(2, '0');
            const label = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
            body = `[${label}] ${body}`;
          }
        }
        messages.push(messageTimestamp != null
          ? { role: 'user', content: body, _ts: messageTimestamp }
          : { role: 'user', content: body });
      } else if (header === 'Assistant') {
        const messageTimestamp = currentTimestamp
          ? this._parseKeepHistoryTimestamp(currentTimestamp)
          : null;
        messages.push(messageTimestamp != null
          ? { role: 'assistant', content: body, _ts: messageTimestamp }
          : { role: 'assistant', content: body });
      }
      // Tool Result sections are skipped — they were previews only
    }
    return messages;
  }

  /**
   * Save current conversation messages to history.md in the workspace.
   * Called after each message round completes.
   * Only saves the most recent `historyLength` rounds (user+assistant pairs).
   * @param {Object} [options]
   * @param {boolean} [options.skipDailyFile=false] - Skip daily file writes (used after summarization)
   */
  async _saveKeepHistory(options: DHAny = {}) {
    if (!this._keepHistoryConfig?.enabled) return;
    if (!this._aiChatSession?.messages) return;

    const messages = this._aiChatSession.messages;
    const maxRounds = this._keepHistoryConfig.historyLength;

    // Collect non-system, non-tool messages; skip tool_calls-only assistant msgs
    const conversationMsgs = messages.filter((m: DHAny) => {
      if (m.role === 'system') return false;
      if (m.role === 'tool') return false;
      if (m.role === 'assistant' && m.tool_calls?.length > 0 && !m.content) return false;
      // Skip messages already processed by summarization (no _ts = pre-timestamp, treat as old)
      if (this._keepHistorySummarizedUpTo) {
        if (!m._ts || m._ts < this._keepHistorySummarizedUpTo) return false;
      }
      return true;
    });

    // For trimmed history, exclude _fullHistoryOnly messages (e.g. virtual world interactions)
    // so they don't pollute the recent conversation history loaded on restart
    const trimmedSourceMsgs = conversationMsgs.filter((m: DHAny) => !m._fullHistoryOnly);

    // Count rounds (each user message = 1 round) and trim to historyLength
    let roundCount = 0;
    let startIdx = 0;
    for (let i = trimmedSourceMsgs.length - 1; i >= 0; i--) {
      if (trimmedSourceMsgs[i].role === 'user') {
        roundCount++;
        if (roundCount >= maxRounds) {
          startIdx = i;
          break;
        }
      }
    }
    const trimmed = trimmedSourceMsgs.slice(startIdx);

    const trimmedHistory = this._buildKeepHistoryMarkdown(trimmed);
    const fullHistory = this._keepHistoryConfig.keepFullHistory
      ? this._buildKeepHistoryMarkdown(conversationMsgs)
      : null;

    const fileName = this._keepHistoryConfig.fileName;
    const writeJobs = [
      this._keepHistoryCreateFile(fileName, trimmedHistory.content),
    ];

    // Auto-summarize when history.md content exceeds threshold
    const contentSize = new Blob([trimmedHistory.content]).size;
    const summarizeThreshold = this._keepHistoryConfig.autoSummarizeContentThreshold;
    if (contentSize >= summarizeThreshold) {
      // Fire-and-forget; summarize will call _onSummarizeComplete which rewrites history.md
      void this.summarize({ trigger: 'keepHistory', onlyWhenNeeded: false });
    }
    if (this._keepHistoryConfig.keepFullHistory && !options.skipDailyFile) {
      const dailyFileName = this._getKeepHistoryDailyFileName();
      const deltaFileName = dailyFileName + '_delta';
      const deltaThreshold = this._keepHistoryConfig.dailyDeltaThreshold;
      writeJobs.push((async () => {
        // Initialize cache on first call or date rollover
        if (!this._keepHistoryDailyCache || this._keepHistoryDailyCache.fileName !== dailyFileName) {
          const existingMain = await this._keepHistoryReadFile(dailyFileName);
          const mainContent = (existingMain && existingMain.trim()) || '';
          const mainSize = new Blob([mainContent]).size;
          console.log(`[DigitalHuman] keepHistory: ${dailyFileName} chars=${mainContent.length}, bytes=${mainSize}`);
          // Skip delta read if main is under threshold — delta would have been merged already
          let deltaContent = '';
          if (mainSize >= deltaThreshold) {
            const existingDelta = await this._keepHistoryReadFile(deltaFileName);
            deltaContent = (existingDelta && existingDelta.trim()) || '';
          }
          // Determine lastTimestamp from delta if it has content, otherwise from main
          const parseSource = deltaContent || mainContent;
          const parsedEntries = parseSource ? this._parseKeepHistoryEntries(parseSource) : [];
          // If delta has content, we also need main's last timestamp for merge decisions
          const mainEntries = deltaContent && mainContent ? this._parseKeepHistoryEntries(mainContent) : [];
          const allEntries = deltaContent ? [...mainEntries, ...parsedEntries] : parsedEntries;
          this._keepHistoryDailyCache = {
            fileName: dailyFileName,
            mainContent: mainContent,
            mainSize: mainSize,
            deltaContent: deltaContent,
            deltaSize: deltaContent ? new Blob([deltaContent]).size : 0,
            lastTimestamp: allEntries.reduce((max, entry) => {
              if (entry.timestamp == null) return max;
              return Math.max(max, entry.timestamp);
            }, -Infinity),
          };
        }

        const cache = this._keepHistoryDailyCache;
        let appendStartIndex = 0;
        if (cache.lastTimestamp !== -Infinity) {
          appendStartIndex = fullHistory!.entries.findIndex((entry: DHAny) => (
            entry.timestamp != null && entry.timestamp > cache.lastTimestamp
          ));
          if (appendStartIndex === -1) return;
        }

        const newEntries = fullHistory!.entries.slice(appendStartIndex);
        if (!newEntries.length) return;

        const appendedContent = newEntries.map(entry => entry.markdown).join('\n');

        // Update lastTimestamp from new entries
        const lastNewTimestamp = newEntries.reduce((max, entry) => {
          if (entry.timestamp == null) return max;
          return Math.max(max, entry.timestamp);
        }, cache.lastTimestamp);

        // Append to delta buffer
        const newDelta = cache.deltaContent
          ? `${cache.deltaContent}\n\n${appendedContent}`
          : appendedContent;
        const newDeltaSize = new Blob([newDelta]).size;

        // If main file is small (under threshold), write directly to main
        if (cache.mainSize < deltaThreshold) {
          const mergedContent = cache.mainContent
            ? `${cache.mainContent}\n\n${newDelta}`
            : newDelta;
          await this._keepHistoryCreateFile(dailyFileName, mergedContent);
          // Clear delta file if it existed
          if (cache.deltaContent) {
            await this._keepHistoryCreateFile(deltaFileName, '');
          }
          cache.mainContent = mergedContent;
          cache.mainSize = new Blob([mergedContent]).size;
          cache.deltaContent = '';
          cache.deltaSize = 0;
        }
        // If delta exceeds threshold, merge into main and clear delta
        else if (newDeltaSize >= deltaThreshold) {
          const mergedContent = cache.mainContent
            ? `${cache.mainContent}\n\n${newDelta}`
            : newDelta;
          await Promise.all([
            this._keepHistoryCreateFile(dailyFileName, mergedContent),
            this._keepHistoryCreateFile(deltaFileName, ''),
          ]);
          cache.mainContent = mergedContent;
          cache.mainSize = new Blob([mergedContent]).size;
          cache.deltaContent = '';
          cache.deltaSize = 0;
        }
        // Otherwise just write to delta file (small write)
        else {
          await this._keepHistoryCreateFile(deltaFileName, newDelta);
          cache.deltaContent = newDelta;
          cache.deltaSize = newDeltaSize;
        }

        cache.lastTimestamp = lastNewTimestamp;
      })());
    }

    try {
      await Promise.all(writeJobs);
    } catch (e: DHAny) {
      console.warn('[DigitalHuman] keepHistory: failed to save history:', e);
    }
  }

  /**
   * Called when any summarization completes (manual, auto, silentTick).
   * Updates the keepHistory cutoff so _saveKeepHistory won't re-save
   * messages that the summarize agent has already processed.
   * Also trims history.md to remove already-summarized content.
   * @param {Object} result - Summarization result with summarizeBeginTime
   */
  _onSummarizeComplete(result: DHAny) {
    if (!result?.summarizeBeginTime) return;
    if (!this._keepHistoryConfig?.enabled) return;

    // Update cutoff — take the max in case multiple summarizations overlap
    this._keepHistorySummarizedUpTo = Math.max(
      this._keepHistorySummarizedUpTo || 0,
      result.summarizeBeginTime
    );

    // Rewrite history.md with only post-cutoff messages.
    // Skip daily file — dated history files (history_YYYYMMDD) are append-only
    // and must never be cleared or rewritten by summarization.
    void this._saveKeepHistory({ skipDailyFile: true });
  }

  /**
   * Keep exactly one system message at the start of the chat history.
   * This avoids losing the configured prompt when sessions are recreated or
   * when callers mix pre-seeded messages with DigitalHuman-managed prompts.
   * @param {string} prompt
   */
  _syncSessionSystemPrompt(prompt: DHAny) {
    if (!this._aiChatSession) return;

    const messages = Array.isArray(this._aiChatSession.messages)
      ? this._aiChatSession.messages
      : (this._aiChatSession.messages = []);
    const nonSystemMessages = messages.filter((message: DHAny) => message?.role !== 'system');

    messages.length = 0;
    if (prompt) {
      messages.push({ role: 'system', content: prompt });
    }
    messages.push(...nonSystemMessages);
  }

  /**
   * Create a new AI chat session.
   * @param {Object} config - Session configuration
   * @param {string} [config.system_prompt] - System prompt
   * @param {string|Object} [config.llm_model] - LLM model name or config object
  * @param {Object} [config.tools] - Tool configuration { fileOps: { enabled, workspace }, ... }
  * @param {boolean|Object} [config.bracketAction] - `true` emits bracketAction events; object form also supports autoplay/duration; parsing is limited to the first 500 words
    * @param {boolean|Object} [config.textToSpeech] - Non-RTC assistant reply speech; `true` enables SpeechRTC defaults, object form accepts `speechRTC` or `speech` provider options
  * @param {boolean|Object} [config.keepHistory] - Persist conversation to history.md in workspace; `true` or `{ historyLength, fileName, keepFullHistory }`
  * @param {boolean} [config.keepFullHistory] - Also persist full daily history to history/history_YYYYMMDD.md
   * @returns {Promise<Object>} The created ChatSession
   */
  async createSession(config: DHAny = {}) {
    this._sessionConfig = config;

    if (!this.sdk?.aiChat) throw new Error('SDK aiChat not available');

    const llmConfig = this._getLLMConfig(config);
    const enableTools = resolveEnabledToolCategories(config, {
      resolveEnabledCategories: this.sdk?.copilotTools?.resolveEnabledCategories?.bind(this.sdk?.copilotTools),
    });

    this._aiChatSession = this.sdk.aiChat.createSession({
      ...llmConfig,
      stream: true,
      reasoning: false,
      enableTools,
      skipHistory: true,
      toolProxy: config.tools?.toolProxy || null,
      historyLength: config.historyLength || 0,
      workspace: config.workspace || config.tools?.fileOps?.workspace || undefined,
      mountFolder: config.mountFolder || config.tools?.fileOps?.mountFolder || undefined,
    });

    this._applyFileOpsConfig(this._aiChatSession, config);
    this._applySummarizationToolConfig(config);

    // Create SummarizeAgent for this session
    this._summarizeAgent = new SummarizeAgent({
      session: this._aiChatSession,
      sdk: this.sdk,
      getOptions: (opts) => this._getSummarizationOptions(opts),
      getRtcSession: () => this._vcSession,
      onEvent: (name, data) => {
        // Update keepHistory cutoff when auto/silentTick summarization completes
        if (name === 'summarized' && (data as DHAny)?.summarizeBeginTime) {
          this._onSummarizeComplete(data);
        }
        this.emit(name, data);
      },
    });
    this._startSummarizeTimer();

    // If summarizeAgent config is already resolved (e.g. pre-fetched by DigitalHumanFrame),
    // load it now so a standalone createSession() call doesn't lose the agent config.
    const saConfig = config.summarizeAgent?.config || config.summarizeAgent;
    if (saConfig && typeof saConfig === 'object' && !Array.isArray(saConfig) && saConfig.system_prompt) {
      try {
        await this._summarizeAgent.loadConfig(saConfig);
      } catch (e: DHAny) {
        console.warn('[DigitalHuman] Failed to load summarize agent config in createSession:', e);
      }
    }

    // Store raw system prompt — template expansion is deferred to sendMessage()
    // so that ${copilot.getActionList(...)} resolves after initAvatar() sets _videoActions
    const sysPrompt = config.system_prompt || this.characterConfig?.system_prompt;
    if (sysPrompt) {
      this._syncSessionSystemPrompt(sysPrompt);
    }

    // Tag session with back-reference so tools (e.g. restartAgent) can detect the owning DigitalHuman
    this._aiChatSession._digitalHuman = this;

    console.log('[DigitalHuman] New AI session created, tools:', enableTools,
      'messages:', this._aiChatSession.messages.length);

    // ── keepHistory: load previous history into the new session ──
    await this._initKeepHistory(config);

    return this._aiChatSession;
  }

  /**
   * Unified send — auto-routes to voice or text session.
   *
   * When voice chat is active, sends via the RTC voice channel by default and
   * also records the user message into the canonical text ChatSession so history
   * stays unified. When voice chat is inactive, sends through the text AIChat
   * session (identical to the legacy sendMessage behaviour).
   *
   * @param {string|Array} userMessage - Text or multimodal content
   * @param {Object}  [options]
   * @param {boolean} [options.voice]         - Force voice (true) or text (false); auto-detect if omitted
   * @param {boolean} [options.awaitResponse] - Voice mode only: if true, wait for the assistant's complete subtitle turn before resolving
  * @param {boolean} [options.skipHistory]   - Skip session/keepHistory persistence for this message round
   * @param {Array}   [options.tools]         - Additional tool definitions (text mode)
   * @param {string}  [options.model]         - Override model (text mode)
  * @param {boolean} [options.skipIfMessageTextEmpty] - Text mode: skip when runCode resolves to an empty string
  * @param {boolean|Object} [options.textToSpeech] - Override non-RTC assistant reply speech; object form accepts `speechRTC` or `speech` provider options. Set `autoReadReply: false` to disable automatic reply playback for this send.
   * @param {boolean|Object} [options.bracketAction] - Bracket action config
   * @returns {Promise<{ finalText: string, parsedResponse?: Object, mode: 'voice'|'text' }>}
   */
  async send(userMessage: DHAny, options: DHAny = {}) {
    // Intercept slash commands
    if (typeof userMessage === 'string' && userMessage.startsWith('/')) {
      const cmd = this.tryCommand(userMessage);
      if (cmd.handled) {
        this.emit('command', { name: cmd.name, error: cmd.error, result: cmd.result });
        return { finalText: '', mode: 'command', command: cmd };
      }
    }

    const useVoice = options.voice !== undefined
      ? options.voice
      : this.isVoiceChatActive;

    if (useVoice && this._vcSession?.isActive) {
      return this._sendViaVoice(userMessage, options);
    }
    return this._sendViaText(userMessage, options);
  }

  _getUserMessageText(userMessage: DHAny) {
    if (Array.isArray(userMessage)) {
      const text = userMessage.filter(m => m.type === 'text').map(m => m.text).join(' ');
      if (text) return text;
      return userMessage.some(m => m.type === 'image_url') ? '(image)' : '';
    }
    return String(userMessage ?? '');
  }

  _emitUserMessage(userMessage: DHAny, mode = 'text', extra: DHAny = {}) {
    const text = this._getUserMessageText(userMessage);
    if (!text) return;
    this.emit('userMessage', { text, timestamp: extra.timestamp || Date.now(), mode, key: extra.key || '' });
  }

  /**
   * Send a message through the voice RTC session.
   * Also mirrors the user message into the text ChatSession for unified history.
   * @private
   */
  async _sendViaVoice(userMessage: DHAny, options: DHAny = {}) {
    if (!this._vcSession?.isActive) {
      throw new Error('Voice chat session not active');
    }
    this._resetSummarizeActivity();

    // Extract text and image from multimodal content
    let text = '';
    let imageBase64 = null;
    const shouldProcessTemplate = options.runCode === true && typeof userMessage === 'string';
    if (Array.isArray(userMessage)) {
      text = userMessage.filter(m => m.type === 'text').map(m => m.text).join(' ');
      const imageItem = userMessage.find(m => m.type === 'image_url');
      if (imageItem?.image_url?.url) {
        const dataUrl = imageItem.image_url.url;
        // Strip data URI prefix (data:image/...;base64,) to get raw base64
        const commaIdx = dataUrl.indexOf(',');
        imageBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      }
    } else {
      text = String(userMessage ?? '');
    }

    if (shouldProcessTemplate) {
      const sandbox = this._vcSession?._ensureSandbox
        ? this._vcSession._ensureSandbox()
        : (this._vcSession?.sandbox || this._aiChatSession?.sandbox);
      text = sandbox?.processTemplate
        ? await sandbox.processTemplate(userMessage)
        : text;
      text = String(text ?? '');
      console.log(`[DigitalHuman] Voice runCode resolved userMessage=${text.length > 200 ? text.slice(0, 200) + '...' : text}`);
    }

    if (!text && !imageBase64) {
      const skipped = shouldProcessTemplate && options.skipIfMessageTextEmpty === true;
      return { finalText: '', mode: 'voice', skipped, reason: skipped ? 'emptyRunCodeResult' : undefined };
    }

    this._resetVoiceIdleTimer();

    this._emitUserMessage(shouldProcessTemplate ? text : userMessage, 'voice');

    // Queue direct user input; commit only when assistant reply arrives.
    this._mirrorVoiceToTextSession('user', text || '(image)', { source: 'direct', skipHistory: options.skipHistory === true });

    // Send through the RTC voice channel — use image path when available
    if (imageBase64) {
      // Auto-restart voice chat with VisionConfig enabled if currently disabled
      const visionEnabled = this._lastVoiceChatPreset?.config?.LLMConfig?.VisionConfig?.Enable;
      if (!visionEnabled) {
        console.log('[DigitalHuman] Image detected but VisionConfig.Enable is false — restarting voice chat with vision enabled');
        await this.restartVoiceChat({ config: { LLMConfig: { VisionConfig: { Enable: true } } } });
      }

      const imgCfg = options.imageConfig
        ?? this._sessionConfig?.imageConfig
        ?? this.characterConfig?.imageConfig
        ?? {};
      const maxBytes = imgCfg.maxImageBytes ?? undefined;
      await this._vcSession.sendImageWithText(imageBase64, text || '', maxBytes ? { maxBytes } : {});
    } else {
      this._vcSession.sendText(text);
    }

    // If caller wants to wait for the full assistant response
    if (options.awaitResponse) {
      const assistantText = await new Promise((resolve) => {
        const onSubtitle = (data: DHAny) => {
          if (!data.isUser && data.definite && data.paragraph) {
            this.off('subtitle', onSubtitle);
            resolve(data.text);
          }
        };
        this.on('subtitle', onSubtitle);
      });
      return { finalText: assistantText, mode: 'voice' };
    }

    return { finalText: text, mode: 'voice' };
  }

  _beginTextSend() {
    const state = {
      epoch: this._textConnectionEpoch,
      session: this._aiChatSession,
      abortController: typeof AbortController === 'function' ? new AbortController() : null,
      canceled: false,
      reason: '',
    };
    this._activeTextSends.add(state);
    return state;
  }

  _finishTextSend(state: DHAny) {
    if (!state) return;
    this._activeTextSends.delete(state);
  }

  _isCurrentTextSend(state: DHAny) {
    return !!state
      && !state.canceled
      && state.epoch === this._textConnectionEpoch
      && state.session === this._aiChatSession;
  }

  async _cancelActiveTextSends(reason = 'restart-agent') {
    this._textConnectionEpoch += 1;
    const states: DHAny[] = Array.from(this._activeTextSends || []);
    this._activeTextSends?.clear?.();

    for (const state of states) {
      state.canceled = true;
      state.reason = reason;
      try {
        if (state.abortController && !state.abortController.signal?.aborted) {
          state.abortController.abort();
        }
      } catch (_: DHAny) {}
    }

    this._textSpeechTurnId += 1;
    this._textSpeechQueue = [];
    await this._stopTextSpeechPlayback();
    return states.length;
  }

  _isTextSendAbort(error: DHAny) {
    const abortCode = typeof DOMException !== 'undefined' ? DOMException.ABORT_ERR : 20;
    return error?.name === 'AbortError'
      || error?.code === abortCode
      || /abort/i.test(error?.message || '');
  }

  _clearQueuedTextSends(reason = 'canceled') {
    const queued = this._queuedTextSends.splice(0);
    for (const item of queued) {
      item.resolve({
        finalText: '',
        parsedResponse: null,
        mode: 'text',
        skipped: true,
        reason,
      });
    }
    return queued.length;
  }

  _sendViaText(userMessage: DHAny, options: DHAny = {}) {
    if (options._bypassTextQueue) {
      return this._sendViaTextNow(userMessage, options);
    }

    return new Promise<void>((resolve, reject) => {
      this._queuedTextSends.push({
        userMessage,
        options: { ...options },
        resolve,
        reject,
      });
      void this._drainTextSendQueue();
    });
  }

  async _drainTextSendQueue() {
    if (this._textSendQueueRunning) return;
    this._textSendQueueRunning = true;

    try {
      while (this._queuedTextSends.length > 0) {
        const item = this._queuedTextSends.shift();
        if (!item) continue;

        try {
          const result = await this._sendViaTextNow(item.userMessage, item.options);
          item.resolve(result);
        } catch (error: DHAny) {
          item.reject(error);
        }
      }
    } finally {
      this._textSendQueueRunning = false;
      if (this._queuedTextSends.length > 0) {
        void this._drainTextSendQueue();
      }
    }
  }

  /**
   * Send a message through the text AIChat session (the full streaming path).
   * @private
   */
  async _sendViaTextNow(userMessage: DHAny, options: DHAny = {}): Promise<DHAny> {
    if (!this._aiChatSession) throw new Error('AI session not created');
    const textSendState = this._beginTextSend();
    const isCurrentTextSend = () => this._isCurrentTextSend(textSendState);
    this._resetSummarizeActivity();

    const initialMessages = this._aiChatSession.messages.slice();

    const config = this._sessionConfig || {};

    // Update system prompt if present (expand ${...} template expressions via sandbox)
    // Skip template expansion after a restart — the prompt was already loaded by restartAgent
    // and re-expanding would trigger the same restartAgent signal again
    const rawSystemPrompt = config.system_prompt || this.characterConfig?.system_prompt;
    if (rawSystemPrompt && !options._afterRestart) {
      const sandbox = this._aiChatSession.sandbox;
      try {
        const prompt = sandbox?.processTemplate
          ? await sandbox.processTemplate(rawSystemPrompt)
          : rawSystemPrompt;
        this._syncSessionSystemPrompt(prompt);
      } catch (sig: DHAny) {
        if (sig && sig.isRestartAgentSignal) {
          console.log(`[DigitalHuman] RestartAgentSignal caught in _sendViaText, restarting with '${sig.promptFile}'`);
          await this.restartAgent(sig.promptFile, sig.tools, { ...(sig.options || {}), autoContinue: false });
          // After restart with a prompt file, send "(continue)" instead of the
          // original user message so the new agent starts fresh without history.
          const restartMsg = this._aiChatSession?._restartedWithPromptFile ? '(continue)' : userMessage;
          this._finishTextSend(textSendState);
          return this._sendViaTextNow(restartMsg, { ...options, _afterRestart: true, _bypassTextQueue: true });
        }
        throw sig;
      }
    } else if (rawSystemPrompt && options._afterRestart) {
      // Just sync the raw prompt without template expansion
      this._syncSessionSystemPrompt(rawSystemPrompt);
    }

    // Pending contexts are flushed automatically by ChatSession.send()

    const enableTools = resolveEnabledToolCategories(config, {
      resolveEnabledCategories: this.sdk?.copilotTools?.resolveEnabledCategories?.bind(this.sdk?.copilotTools),
    });
    const hasImages = Array.isArray(userMessage) && userMessage.some(m => m.type === 'image_url');
    const bracketActionOptions = this._getBracketActionOptions(options);
    const bracketActionEnabled = bracketActionOptions.enabled;
    const seenBracketActions = bracketActionEnabled ? new Set() : null;
    const comfortSentTypes = new Set();
    const pendingComfortMessages: DHAny[] = [];
    const textSpeechTurnId = await this._startTextSpeechTurn();
    const textSpeechOptions = {
      ...options,
      silentTextToSpeechErrors: true,
    };
    const streamingTextSpeech = this._isStreamingTextSpeechEnabled(textSpeechOptions);

    let accumulatedText = '';
    let parsedResponse = null;

    // Resolve imageConfig: options > session config > character config
    const imageConfig = options.imageConfig
      ?? config.imageConfig
      ?? this.characterConfig?.imageConfig
      ?? undefined;

    let finalText;
    try {
    finalText = await this._aiChatSession.send(userMessage, {
      abortController: textSendState.abortController,
      tools: options.tools,
      enableTools,
      runCode: options.runCode,
      skipIfMessageTextEmpty: options.skipIfMessageTextEmpty,
      imageConfig,
      model: options.model || (this._getLLMConfig(config).model),
      onUserMessage: (message: DHAny) => {
        if (!isCurrentTextSend()) return;
        const content = message?.content ?? userMessage;
        const text = this._getUserMessageText(content);
        this._emitUserMessage(content, 'text', {
          timestamp: message?._ts,
          key: message?._ts && text ? `session:user:${message._ts}:${text}` : '',
        });
      },
      onMessage: (partialText: DHAny, fullResponse: DHAny) => {
        if (!isCurrentTextSend()) return;
        if (fullResponse?.reasoning_content) {
          this.emit('reasoning', { text: fullResponse.reasoning_content });
        }
        if (partialText !== undefined && partialText !== null) {
          accumulatedText = partialText;
          if (bracketActionEnabled) {
            this._emitBracketActionEvents(partialText, seenBracketActions, {
              source: 'message',
              fullResponse,
            }, bracketActionOptions);
          }
          if (streamingTextSpeech) {
            void this._appendStreamingTextSpeech(partialText, textSpeechOptions, {
              kind: 'assistant',
              turnId: textSpeechTurnId,
            });
          }
          this._subtitleOverlay.updateAssistant(partialText, { source: 'text' });
          this.emit('message', { partialText, fullResponse });
        }
      },
      onToolCall: async (toolCall: DHAny) => {
        if (!isCurrentTextSend()) {
          return { error: 'Ignored stale tool call from canceled text send' };
        }
        const fnName = toolCall.function.name;
        const rawArgs = toolCall.function.arguments;
        let fnArgs = rawArgs;
        try {
          fnArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        } catch (_: DHAny) {
          fnArgs = rawArgs;
        }
        console.log(`[DigitalHuman] Tool call: ${fnName}`, typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs));
        this._subtitleOverlay.showThinking();
        this.emit('toolCall', { name: fnName, toolCallId: toolCall.id || '', args: fnArgs });
        await this._triggerComfortMessage(fnName, options, comfortSentTypes, pendingComfortMessages);
        return { error: `Tool '${fnName}' not handled by CopilotTools` };
      },
      onToolResult: (data: DHAny) => {
        if (!isCurrentTextSend()) return;
        const resultPreview = typeof data.result === 'string' ? data.result.slice(0, 500) : JSON.stringify(data.result).slice(0, 500);
        console.log(`[DigitalHuman] Tool result: ${data.name || data.toolCallId || '?'}`, resultPreview);
        this.emit('toolResult', data);
      },
      onComplete: (finalText: DHAny, fullResponse: DHAny) => {
        if (!isCurrentTextSend()) return;
        parsedResponse = finalText;
        const hasPendingToolCalls = fullResponse?.tool_calls?.length > 0;
        if (streamingTextSpeech) {
          void this._finishStreamingTextSpeech(finalText, textSpeechOptions, {
            kind: 'assistant',
            turnId: textSpeechTurnId,
          });
        } else if (finalText) {
          this._queueTextSpeech(finalText, options, {
            kind: 'assistant',
            turnId: textSpeechTurnId,
          });
        }
        if (hasPendingToolCalls) {
          for (const comfort of pendingComfortMessages.splice(0)) {
            this._queueTextSpeech(comfort.text, options, {
              kind: 'comfort',
              toolName: comfort.toolName,
              turnId: textSpeechTurnId,
            });
          }
          this.emit('complete', {
            finalText,
            fullResponse,
            pendingToolCalls: true,
            intermediate: true,
          });
          return;
        }
        if (bracketActionEnabled) {
          this._emitBracketActionEvents(finalText, seenBracketActions, {
            source: 'complete',
            fullResponse,
          }, bracketActionOptions);
        }
        this._subtitleOverlay.markTextComplete();
        this.emit('complete', {
          finalText,
          fullResponse,
          pendingToolCalls: false,
          intermediate: false,
        });
      },
      onError: (error: DHAny) => {
        if (!isCurrentTextSend()) return;
        if (streamingTextSpeech) {
          void this._stopTextSpeechPlayback();
        }
        this._subtitleOverlay.hideThinking();
        this.emit('error', { error });
        throw error;
      },
    });
    } catch (sig: DHAny) {
      if (!isCurrentTextSend() || this._isTextSendAbort(sig)) {
        this._finishTextSend(textSendState);
        return { finalText: '', parsedResponse: null, mode: 'text', skipped: true, reason: textSendState.reason || 'canceled' };
      }
      if (sig && sig.isRestartAgentSignal) {
        if (options._afterRestart) {
          console.log(`[DigitalHuman] RestartAgentSignal suppressed in tool (already restarted)`);
          if (this._aiChatSession) {
            this._aiChatSession._restartSignal = null;
            // Clear prompt markers so a future send can re-trigger restart to this file
            const sandboxes = [this._aiChatSession?.sandbox, this._vcSession?.sandbox].filter(Boolean);
            for (const sb of sandboxes) {
              sb._activePromptFile = null;
              sb._templateSourceFile = null;
            }
          }
        } else {
          console.log(`[DigitalHuman] RestartAgentSignal caught in _sendViaText (tool), restarting with '${sig.promptFile}'`);
          this._aiChatSession._restartSignal = null;
          await this.restartAgent(sig.promptFile, sig.tools, { ...(sig.options || {}), autoContinue: false });
          const restartMsg2 = this._aiChatSession?._restartedWithPromptFile ? '(continue)' : userMessage;
          this._finishTextSend(textSendState);
          return this._sendViaTextNow(restartMsg2, { ...options, _afterRestart: true, _bypassTextQueue: true });
        }
      } else {
        this._finishTextSend(textSendState);
        throw sig;
      }
    }

    this._finishTextSend(textSendState);

    if (!isCurrentTextSend()) {
      return { finalText: '', parsedResponse: null, mode: 'text', skipped: true, reason: textSendState.reason || 'stale' };
    }

    // Check if _restartSignal was set during tool execution (flag-based fallback)
    const restartSig = this._aiChatSession?._restartSignal;
    if (restartSig) {
      if (options._afterRestart) {
        console.log(`[DigitalHuman] _restartSignal suppressed (already restarted)`);
        this._aiChatSession._restartSignal = null;
        // Clear prompt markers so a future send can re-trigger restart to this file
        const sandboxes = [this._aiChatSession?.sandbox, this._vcSession?.sandbox].filter(Boolean);
        for (const sb of sandboxes) {
          sb._activePromptFile = null;
          sb._templateSourceFile = null;
        }
      } else {
        console.log(`[DigitalHuman] _restartSignal detected after send, restarting with '${restartSig.promptFile}'`);
        this._aiChatSession._restartSignal = null;
        await this.restartAgent(restartSig.promptFile, restartSig.tools, { ...(restartSig.options || {}), autoContinue: false });
        const restartMsg3 = this._aiChatSession?._restartedWithPromptFile ? '(continue)' : userMessage;
        return this._sendViaTextNow(restartMsg3, { ...options, _afterRestart: true, _bypassTextQueue: true });
      }
    }

    const responseText = finalText || accumulatedText;

    if (options.skipHistory) {
      this._aiChatSession.messages = initialMessages;
    }

    // fullHistoryOnly: keep messages in session but mark them so they are
    // excluded from the trimmed history.md while still written to the daily file.
    if (options.fullHistoryOnly && this._aiChatSession?.messages) {
      const newMsgs = this._aiChatSession.messages.slice(initialMessages.length);
      for (const m of newMsgs) m._fullHistoryOnly = true;
    }

    // Check auto-summarization thresholds after the send completes
    void this.summarize({
      ...options,
      trigger: 'auto',
      onlyWhenNeeded: true,
    });
    this._resetSummarizeActivity();

    // Persist conversation to history.md when keepHistory is enabled
    if (!options.skipHistory) void this._saveKeepHistory();

    return { finalText: responseText, parsedResponse, mode: 'text' };
  }

  /**
   * Send a message via the text AI chat session with streaming callbacks emitted as events.
   * Backward-compatible alias — always uses the text path regardless of voice state.
   * @param {string|Array} userMessage - Text or multimodal content
   * @param {Object} [options]
   * @param {Array} [options.tools] - Additional tool definitions
  * @param {string} [options.model] - Override model for this request
  * @param {boolean} [options.runCode] - Process userMessage as template text, expanding ${...} expressions via sandbox
  * @param {boolean} [options.skipHistory] - Skip session/keepHistory persistence for this message round
  * @param {boolean|Object} [options.textToSpeech] - Override non-RTC assistant reply speech; object form accepts `speechRTC` or `speech` provider options
  * @param {boolean|Object} [options.bracketAction] - Override bracketAction behavior for this request; object form supports autoplay/duration; parsing is limited to the first 500 words
   * @returns {Promise<{ finalText: string, parsedResponse: Object }>}
   */
  async sendMessage(userMessage: DHAny, options: DHAny = {}) {
    return this._sendViaText(userMessage, options);
  }

  /**
   * Expand an inline system prompt using the iframe session's sandbox.
   * This ensures preview/debug views resolve ${...} the same way as the
   * actual in-iframe DigitalHuman session.
   * @param {string} text
   * @returns {Promise<string>}
   */
  async expandInlineSystemPrompt(text: DHAny) {
    const rawText = String(text || '').trim();
    if (!rawText) return '';

    const sandbox = this._aiChatSession?.sandbox || this.getSession()?.sandbox;
    if (!sandbox?.processTemplate) {
      return rawText;
    }

    return await sandbox.processTemplate(rawText);
  }

  // ========================================================================
  // SECTION 12: Voice Chat via AIChatRTC
  // ========================================================================

  /**
   * @returns {boolean} Whether voice chat is currently active
   */
  get isActive() {
    return this._active;
  }

  /**
   * @returns {boolean} Whether voice chat is logically enabled, even if the RTC connection is paused while inactive
   */
  get isVoiceChatModeActive() {
    return this._logicalVoiceChatActive;
  }

  get isVoiceChatActive() {
    return !!this._vcSession?.isActive;
  }

  /**
   * Start voice chat using AIChatRTC.
   * @param {Object} preset - Voice chat preset config (see AIChatRTC.createSession)
   * @param {string} preset.appId - VolcEngine AppId
   * @param {Object} [preset.agentConfig] - Agent config
   * @param {Object} [preset.config] - ASR/LLM/TTS/S2S config
    * @param {boolean|Object} [preset.bracketAction] - Apply bracketAction matching to AI messages; parsing is limited to the first 500 words
   * @param {string[]} [preset.enabledToolCategories] - Tool categories
   * @param {string} [preset.workspace] - Tool workspace
   * @returns {Promise<Object>} The RTC session
   */
  /**
   * Default ASR/LLM/TTS config for voice chat (asr_llm_tts mode).
   * Used when `preset.config` is not provided in `startVoiceChat()`.
   */
  static DEFAULT_VOICE_CHAT_CONFIG = {
    appId: '69883f4ae00f9e017600b901',
    agentUserId: 'ChatBot01',
    agentConfig: {
      UserId: 'ChatBot01',
      EnableConversationStateCallback: true,
    },
    config: {
      ASRConfig: {
        Provider: 'volcano',
        ProviderParams: {
          Mode: 'bigmodel',
          AppId: '3065448513',
          ApiResourceId: 'volc.bigasr.sauc.duration',
        },
      },
      TTSConfig: {
        Provider: 'volcano_bidirection',
        ProviderParams: {
          app: { appid: '3065448513', },
          audio: { voice_type: 'zh_female_tianmeiyueyue_moon_bigtts', speech_rate: 0 },
          ResourceId: 'volc.service_type.10029',
        },
      },
      LLMConfig: {
        Mode: 'ArkV3',
        EndPointId: 'ep-20260315160200-s6fg7',
        VisionConfig: { Enable: false },
        ThinkingType: 'disabled',
        Tools: [],
      },
      SubtitleConfig: { SubtitleMode: 1 },
      InterruptMode: 0,
    },
  };

  /**
   * Build a complete voice chat preset by merging caller-supplied high-level
   * params (system_prompt, llm_model, workspace, tools, etc.) onto the
   * DEFAULT_VOICE_CHAT_CONFIG.  If the caller already supplies `preset.config`
   * the default config block is skipped entirely so existing call-sites keep working.
   * @param {Object} preset - Caller-supplied preset
   * @returns {Object} Merged preset ready for AIChatRTC.createSession()
   */
  _buildVoiceChatPreset(preset: DHAny) {
    // Merge characterConfig.voiceChat as a base layer so config-file
    // voice settings are used without the caller repeating them.
    const vcBase = this.characterConfig?.voiceChat;
    if (vcBase && typeof vcBase === 'object') {
      preset = { ...vcBase, ...preset };
    }

    const defaults = DigitalHuman.DEFAULT_VOICE_CHAT_CONFIG;
    const hasExplicitConfig = !!preset.config;

    // Use caller/config-file config block when present, otherwise build from defaults.
    const config = hasExplicitConfig
      ? preset.config
      : JSON.parse(JSON.stringify(defaults.config));

    // Inject system_prompt into LLMConfig.SystemMessages.
    // When preset.system_prompt is explicitly provided (e.g. after restartAgent
    // updated characterConfig), always override — even if SystemMessages already
    // has content from an earlier buildVoiceChatPreset call that used the old config.
    if (config.LLMConfig) {
      if (preset.system_prompt) {
        config.LLMConfig.SystemMessages = [preset.system_prompt];
      } else if (!config.LLMConfig.SystemMessages?.length) {
        const sysPrompt = this._sessionConfig?.system_prompt
          ?? this.characterConfig?.system_prompt;
        if (sysPrompt) {
          config.LLMConfig.SystemMessages = [sysPrompt];
        }
      }
    }


    // Inject prior conversation history as UserPrompts (recommended by VolcEngine).
    // Always assign (including an empty array) so that a reused preset — e.g. on
    // restartVoiceChat() after restartAgent() cleared the text session — does
    // NOT leak stale UserPrompts from the previous voice-chat start.
    if (config.LLMConfig) {
      const userPrompts = this._buildUserPromptsForVoice(
        config.LLMConfig.HistoryLength
        || preset.historyLength
        || this._sessionConfig?.historyLength
        || this.characterConfig?.historyLength
        || 3
      );
      if (userPrompts && userPrompts.length) {
        config.LLMConfig.UserPrompts = userPrompts;
      } else {
        config.LLMConfig.UserPrompts = [];
      }
    }

    // Map high-level llm_model to LLMConfig.EndPointId when it looks like an endpoint id
    if (!hasExplicitConfig) {
      const llmModel = preset.llm_model ?? this._sessionConfig?.llm_model ?? this.characterConfig?.llm_model;
      if (typeof llmModel === 'string' && llmModel.startsWith('ep-')) {
        config.LLMConfig.EndPointId = llmModel;
      } else if (typeof llmModel === 'object' && llmModel?.model?.startsWith('ep-')) {
        config.LLMConfig.EndPointId = llmModel.model;
      }
    }

    // Derive enabledToolCategories from high-level tools map if not explicitly given
    const resolveToolsMap = (src: DHAny) => src?.tools && !Array.isArray(src.tools) ? src.tools : null;
    const toolsMap = resolveToolsMap(preset) || resolveToolsMap(this._sessionConfig) || resolveToolsMap(this.characterConfig);
    let enabledCats = preset.enabledToolCategories;
    if (!enabledCats && toolsMap) {
      enabledCats = resolveEnabledToolCategories({ tools: toolsMap }, {
        resolveEnabledCategories: this.sdk?.copilotTools?.resolveEnabledCategories?.bind(this.sdk?.copilotTools),
      });
    }

    // Resolve workspace: explicit > session > character config
    const workspace = preset.workspace
      ?? this._sessionConfig?.workspace
      ?? this.characterConfig?.workspace
      ?? '';

    // Resolve mountFolder: explicit > session tools > character config tools
    const mountFolder = preset.mountFolder
      ?? this._sessionConfig?.tools?.fileOps?.mountFolder
      ?? this.characterConfig?.tools?.fileOps?.mountFolder
      ?? null;

    // Auto-populate WelcomeMessage from initial.message if not explicitly set.
    // When initial.bootMessage is present, skip the static welcome — the LLM handles greeting.
    // Also skip when the text session already has user messages (e.g. switching to voice mid-conversation).
    const agentConfig = preset.agentConfig || { ...defaults.agentConfig };
    const hasExistingUserMessages = this._aiChatSession?.messages?.some((m: DHAny) => m.role === 'user');
    if (!agentConfig.WelcomeMessage && !this.characterConfig?.initial?.bootMessage && !hasExistingUserMessages) {
      const welcomeMsg = this.characterConfig?.initial?.message;
      if (welcomeMsg) agentConfig.WelcomeMessage = welcomeMsg;
    }
    // Clear explicit WelcomeMessage when conversation already has user turns
    if (hasExistingUserMessages && agentConfig.WelcomeMessage) {
      agentConfig.WelcomeMessage = '';
    }

    return {
      ...preset,
      appId: preset.appId || defaults.appId,
      agentUserId: preset.agentUserId || defaults.agentUserId,
      agentConfig,
      config,
      enabledToolCategories: enabledCats || ['fileOps', 'agent'],
      workspace,
      mountFolder,
    };
  }

  async startVoiceChat(preset: DHAny = {}, options: DHAny = {}): Promise<DHAny> {
    const voiceLifecycle = this._resolveVoiceLifecycleConfig(preset, options);
    const voiceHeartbeat = this._resolveVoiceHeartbeatConfig(preset, options);
    if (this._vcSession?.isActive) {
      console.warn('[DigitalHuman] Voice chat already active');
      this._logicalVoiceChatActive = true;
      this._voiceLifecycleState = 'active';
      this._voiceLifecycleDisconnectedReason = '';
      this._setupVoiceLifecycleHandlers(voiceLifecycle);
      this._setupVoiceHeartbeat(voiceHeartbeat);
      if (!options.skipSetActive) {
        await this.setActive(true, { reason: 'startVoiceChat', skipVoiceResume: true });
      }
      return this._vcSession;
    }

    this._cancelRandomIdle();
    await this._stopTextSpeechPlayback();

    // Pre-expand system prompt via the text session's sandbox so both
    // text and voice sessions always receive the identical resolved prompt.
    if (this._aiChatSession?.sandbox?.processTemplate) {
      const rawPrompt = preset.system_prompt
        ?? this._sessionConfig?.system_prompt
        ?? this.characterConfig?.system_prompt;
      if (rawPrompt) {
        try {
          preset = { ...preset };
          preset.system_prompt = await this._aiChatSession.sandbox.processTemplate(rawPrompt);
        } catch (sig: DHAny) {
          if (sig && sig.isRestartAgentSignal) {
            console.log(`[DigitalHuman] RestartAgentSignal caught in startVoiceChat, restarting with '${sig.promptFile}'`);
            await this.restartAgent(sig.promptFile, sig.tools, { ...(sig.options || {}), autoContinue: false });
            return this.startVoiceChat(this._lastVoiceChatPreset || preset);
          }
          throw sig;
        }
      }
    }

    // Build a complete preset with default ASR/LLM/TTS config when not explicitly provided
    preset = this._buildVoiceChatPreset(preset);

    // Store preset for potential restart (e.g. after keepHistory summarization)
    this._lastVoiceChatPreset = preset;

    // Default VolcEngine appId if not provided
    if (!preset.appId) {
      preset.appId = '69883f4ae00f9e017600b901';
    }

    // Ensure AIChatRTC is available
    if (!this._rtc) {
      if (typeof AIChatRTC === 'undefined' && !window.AIChatRTC) {
        throw new Error('AIChatRTC not available. Load the KeepworkSDK first.');
      }
      const RTC = typeof AIChatRTC !== 'undefined' ? AIChatRTC : window.AIChatRTC;
      this._rtc = new RTC(this.sdk);
    }

    // Auto-inject TTSConfig.IgnoreBracketText when bracket actions are enabled,
    // so TTS skips reading out parenthesized action hints like (微笑) or (wave).
    const bracketOpts = this._getBracketActionOptions({
      bracketAction: preset.bracketAction ?? preset.autoBracketAction,
    });
    if (bracketOpts.enabled && preset.config) {
      const tts = preset.config.TTSConfig;
      if (tts && !tts.IgnoreBracketText) {
        // 1:（）, 2: (), 3:【】, 4: [], 5: {}
        tts.IgnoreBracketText = [1, 2, 3, 4, 5];
      }
    }

    // Strip non-array `tools` (high-level config map) so RTCChatSession
    // doesn't receive an object where it expects an array or undefined.
    const toolProxy = preset.toolProxy || preset.tools?.toolProxy
      || this._sessionConfig?.tools?.toolProxy
      || this.characterConfig?.tools?.toolProxy
      || null;
    if (preset.tools && !Array.isArray(preset.tools)) {
      delete preset.tools;
    }

    this._vcSession = this._rtc.createSession({
      ...preset,
      toolProxy,
    });

    // Tag voice session with back-reference so tools (e.g. restartAgent) can detect the owning DigitalHuman
    this._vcSession._digitalHuman = this;

    // Wire events
    const vcBracketActionOptions = bracketOpts;
    this._wireVCSessionEvents(this._vcSession, vcBracketActionOptions);

    await this._vcSession.start();
    this._logicalVoiceChatActive = true;
    this._voiceLifecycleState = 'active';
    this._voiceLifecycleDisconnectedReason = '';
    this._setupVoiceLifecycleHandlers(voiceLifecycle);
    this._setupVoiceHeartbeat(voiceHeartbeat);

    // Propagate _activePromptFile from the text sandbox to the new voice sandbox
    // so the voice session uses the same prompt file loaded by a prior restartAgent.
    // Must run after start() because the sandbox is lazily created in _ensureSandbox().
    const textSandbox = this._aiChatSession?.sandbox;
    const voiceSandbox = this._vcSession?.sandbox;
    if (textSandbox && voiceSandbox && textSandbox._activePromptFile) {
      voiceSandbox._activePromptFile = textSandbox._activePromptFile;
      voiceSandbox._templateSourceFile = textSandbox._templateSourceFile;
    }

    // Attach volume-based lip sync
    this._attachVolumeLipSync(this._vcSession);
    this._startRtcLipSync();

    // Forward any pending text-session contexts to the RTC voice channel
    if (this._aiChatSession?._pendingContexts?.length > 0) {
      for (const ctx of this._aiChatSession._pendingContexts) {
        try {
          this._vcSession.sendContext(String(ctx));
        } catch (e: DHAny) {
          console.warn('[DigitalHuman] flushContext to voice failed:', e.message);
        }
      }
    }

    this.emit('voiceChatStarted', { session: this._vcSession });
    if (!options.skipSetActive) {
      await this.setActive(true, { reason: 'startVoiceChat', skipVoiceResume: true });
    }
    if (this._isDocumentHidden()) {
      void this._enterVoiceLifecycleStandby('startWhileHidden');
    }
    return this._vcSession;
  }

  /**
   * Stop voice chat.
   * @returns {Promise<void>}
   */
  async stopVoiceChat() {
    this._logicalVoiceChatActive = false;
    this._voiceLifecycleState = 'idle';
    this._voiceLifecycleDisconnectedReason = '';
    this._clearVoiceLifecycleHandlers();
    this._clearVoiceHeartbeat({ resetCount: true });
    this._voiceHeartbeatConfig = null;
    this.clearSubtitle();
    await this.setActive(false, { reason: 'stopVoiceChat', skipVoiceStop: true });

    if (!this._vcSession) return;

    if (this._vcSession.isActive) {
      await this._vcSession.stop();
    }

    this._stopRtcLipSync();
    this._muteWhileSpeakingStop();
    if (this._vcIdleDebounce) { clearTimeout(this._vcIdleDebounce); this._vcIdleDebounce = null; }
    this._vcSession = null;
    this._vcQueuedUserInputs = [];
    this._vcDirectInputPending = [];
    
    const hasCustomAction = this._currentPlayAction
      && this._currentPlayAction !== 'talk'
      && this._currentPlayAction !== 'idle';
    if (!hasCustomAction) {
      this.switchToIdle();
    }

    this.emit('voiceChatStopped', {});
  }

  async handleAuthStateChange(change: DHAny = {}) {
    return this.reloadForAuthChange(change);
  }

  async reloadForAuthChange(change?: DHAny) {
    void change;
    if (this._authReloadPromise) return this._authReloadPromise;

    this._authReloadPromise = (async () => {
      const config = this.characterConfig || this._originalCharacterConfig;
      const avatarInit = this._lastAvatarInit;
      if (!config && !avatarInit) return { reloaded: false, reason: 'noConfig' };

      const previousOriginalConfig = this._originalCharacterConfig;
      if (this._summarizeAgent) {
        this._summarizeAgent.destroy();
        this._summarizeAgent = null;
      }
      this._stopSummarizeTimer();
      stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);
      if (this._vcSession?.isActive) {
        try { await this._vcSession.stop(); } catch (e: DHAny) { /* ignore */ }
      }
      await this._stopTextSpeechPlayback();
      this._vcSession = null;
      this._rtc = null;
      this._textSpeechSession = null;
      this._aiChatSession = null;
      this._sessionConfig = null;

      if (this._registeredSearchPaths?.length && this.sdk?.personalPageStore) {
        for (const prefix of this._registeredSearchPaths) {
          this.sdk.personalPageStore.removeSearchPath(prefix);
        }
        this._registeredSearchPaths = null;
      }

      this.cleanupAvatar();
      if (this._avatarRoot && this._avatarRoot.parentNode) {
        this._avatarRoot.parentNode.removeChild(this._avatarRoot);
      }
      this._avatarRoot = null;
      this._videoIdle = null;
      this._videoTalk = null;
      this._live2dCanvas = null;
      this._webpIdle = null;
      this._webpTalk = null;
      this._vcQueuedUserInputs = [];
      this._vcDirectInputPending = [];
      this._keepHistoryConfig = null;

      if (config) {
        this._originalCharacterConfig = previousOriginalConfig;
        await this.initFromConfig(config);
        this._originalCharacterConfig = previousOriginalConfig || this._originalCharacterConfig;
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
   * Restart the voice chat session with optional config overrides.
   * When possible, updates the active RTC agent in place via UpdateVoiceChat
   * so the room connection is kept alive. Falls back to a full restart if the
   * update API is unavailable or fails. Useful when the system prompt,
   * LLM config, or conversation history has changed (e.g. after
   * summarize-agent completes in replace mode, or when enabling vision).
   *
   * @param {Object} [configOverrides] - Partial preset overrides to deep-merge
   *   into `_lastVoiceChatPreset`.  Nested objects under `config` are merged
   *   recursively; all other top-level keys are shallow-merged.
   * @returns {Promise<Object>} The new RTC session
   */
  async restartVoiceChat(configOverrides: DHAny = {}) {
    if (!this._lastVoiceChatPreset) {
      throw new Error('No previous voice chat preset to restart from');
    }

    let preset = { ...this._lastVoiceChatPreset, ...configOverrides };

    // Deep-merge the nested `config` block so callers can patch individual
    // sub-keys (e.g. LLMConfig.VisionConfig) without replacing the whole tree.
    if (configOverrides.config) {
      preset.config = JSON.parse(JSON.stringify(this._lastVoiceChatPreset.config || {}));
      const merge = (target: DHAny, source: DHAny) => {
        for (const key of Object.keys(source)) {
          if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
              && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            merge(target[key], source[key]);
          } else {
            target[key] = source[key];
          }
        }
      };
      merge(preset.config, configOverrides.config);
    }

    preset = this._buildVoiceChatPreset(preset);
    this._lastVoiceChatPreset = preset;

    if (this._vcSession?.isActive && typeof this._vcSession.updateParameters === 'function') {
      console.log('[DigitalHuman] Updating voice chat with overrides:', Object.keys(configOverrides).join(', '));

      const toolProxy = preset.toolProxy || preset.tools?.toolProxy
        || this._sessionConfig?.tools?.toolProxy
        || this.characterConfig?.tools?.toolProxy
        || null;
      const nextTools = Array.isArray(preset.tools) ? preset.tools : [];
      if (preset.tools && !Array.isArray(preset.tools)) {
        delete preset.tools;
      }

      const previousSessionState = {
        options: this._vcSession.options,
        agentConfig: this._vcSession.agentConfig,
        voiceChatConfig: this._vcSession.voiceChatConfig,
        workspace: this._vcSession.workspace,
        mountFolder: this._vcSession.mountFolder,
        enabledToolCategories: this._vcSession.enabledToolCategories,
        customTools: this._vcSession.customTools,
        toolProxy: this._vcSession.toolProxy,
        model: this._vcSession.model,
        sandboxWorkspace: this._vcSession.sandbox?.workspace,
        sandboxMountFolder: this._vcSession.sandbox?.mountFolder,
        sandboxEnabledCategories: this._vcSession.sandbox?.enabledCategories,
        sandboxToolProxy: this._vcSession.sandbox?._toolProxy,
      };

      this._vcSession.options = { ...this._vcSession.options, ...preset, tools: nextTools, toolProxy };
      this._vcSession.agentConfig = preset.agentConfig || {};
      this._vcSession.workspace = preset.workspace || '';
      this._vcSession.mountFolder = preset.mountFolder || null;
      this._vcSession.enabledToolCategories = preset.enabledToolCategories || ['fileOps', 'agent'];
      this._vcSession.customTools = nextTools;
      this._vcSession.toolProxy = toolProxy;
      this._vcSession.model = preset.model || preset.config?.LLMConfig?.Model || this._vcSession.model;
      if (this._vcSession.sandbox) {
        this._vcSession.sandbox.workspace = this._vcSession.workspace;
        this._vcSession.sandbox.mountFolder = this._vcSession.mountFolder;
        this._vcSession.sandbox.enabledCategories = this._vcSession.enabledToolCategories;
        this._vcSession.sandbox._toolProxy = toolProxy;
        this._vcSession.sandbox._cachedDefinitions = null;
      }

      try {
        // Force high-priority interrupt so the server stops the current
        // agent action (speaking / thinking) before applying new params.
        const updateConfig = { ...preset.config, InterruptMode: 1 };
        await this._vcSession.updateParameters(updateConfig);
        this.emit('voiceChatUpdated', { session: this._vcSession, preset });
        return this._vcSession;
      } catch (error: DHAny) {
        console.warn('[DigitalHuman] updateVoiceChat failed, falling back to full restart:', error.message);
        this._vcSession.options = previousSessionState.options;
        this._vcSession.agentConfig = previousSessionState.agentConfig;
        this._vcSession.voiceChatConfig = previousSessionState.voiceChatConfig;
        this._vcSession.workspace = previousSessionState.workspace;
        this._vcSession.mountFolder = previousSessionState.mountFolder;
        this._vcSession.enabledToolCategories = previousSessionState.enabledToolCategories;
        this._vcSession.customTools = previousSessionState.customTools;
        this._vcSession.toolProxy = previousSessionState.toolProxy;
        this._vcSession.model = previousSessionState.model;
        if (this._vcSession.sandbox) {
          this._vcSession.sandbox.workspace = previousSessionState.sandboxWorkspace;
          this._vcSession.sandbox.mountFolder = previousSessionState.sandboxMountFolder;
          this._vcSession.sandbox.enabledCategories = previousSessionState.sandboxEnabledCategories;
          this._vcSession.sandbox._toolProxy = previousSessionState.sandboxToolProxy;
          this._vcSession.sandbox._cachedDefinitions = null;
        }
      }
    }

    console.log('[DigitalHuman] Restarting voice chat with overrides:', Object.keys(configOverrides).join(', '));
    await this.stopVoiceChat();
    // Delay to let the VolcEngine server finish tearing down the previous session
    await new Promise(r => setTimeout(r, 500));
    return this.startVoiceChat(preset);
  }

  /** @private */
  _resolveRestartAgentPromptFile(promptFile: DHAny) {
    if (typeof promptFile === 'string' && promptFile.trim()) {
      return promptFile.trim();
    }

    const page = String(this._currentPage || '').trim();
    const routerEntry = page ? this._pageRouters?.[page] : null;
    const routerAgent = routerEntry?.agent;
    if (typeof routerAgent === 'string' && routerAgent.trim()) {
      return routerAgent.trim();
    }

    return null;
  }

  /** @private */
  _cancelRestartAgentDebounce(result: DHAny = {}) {
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

  /** @private */
  _getRestartAgentDedupeMs(options: DHAny = {}) {
    const raw = options?.dedupeMs ?? options?.cooldownMs;
    if (raw === false || raw === null) return 0;
    const value = raw === undefined ? 10000 : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /** @private */
  _getRestartAgentDedupeKey(promptFile: DHAny, tools: DHAny[] = []) {
    if (!promptFile || typeof promptFile !== 'string' || !promptFile.trim()) return null;
    const normalizedTools = Array.isArray(tools)
      ? tools.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).sort()
      : [];
    return `${promptFile.trim()}\n${normalizedTools.join('\n')}`;
  }

  /** @private */
  _buildRestartAgentSkippedResult(promptFile: DHAny, tools: DHAny, reason: DHAny, extra: DHAny = {}) {
    const mode = this.isVoiceChatActive ? 'voice' : 'text';
    const result = {
      configSource: promptFile || 'default',
      mode,
      skipped: true,
      duplicate: true,
      reason,
      ...extra,
    };
    this.emit('restartAgent', {
      stage: 'skipped',
      promptFile: promptFile || '',
      tools,
      result,
      timestamp: Date.now(),
    });
    return result;
  }

  /**
   * Restart the agent session with an optional prompt file.
   * Handles both voice and text chat modes — stops voice if active,
   * re-initializes via initFromConfig, then restarts voice if it was active.
   *
   * @param {string} [promptFile] - URL or path to an agent config file (.json/.yml/.yaml/.md).
   *   If empty, uses the current pageRouters entry agent first, then falls back to the current characterConfig.
   * @param {string[]} [tools] - Optional tool category override. Empty means inherit defaults.
   * @param {Object} [options]
   * @param {number} [options.debounceMs=0] - Delay empty-prompt restarts; cancelled by any later explicit prompt restart.
  * @param {boolean} [options.autoContinue=true] - Automatically send "(continue)" after a prompt-file restart.
   * @returns {Promise<Object>} { configSource, mode }
   */
  async restartAgent(promptFile: DHAny, tools: DHAny, options: DHAny = {}) {
    const trimmedFile = (promptFile && typeof promptFile === 'string') ? promptFile.trim() : null;
    const debounceMs = Number(options?.debounceMs) || 0;
    const shouldDebounce = !trimmedFile && debounceMs > 0;

    if (trimmedFile) {
      this._cancelRestartAgentDebounce({ configSource: trimmedFile, cancelledBy: 'promptFile' });
    } else if (this._restartAgentDebounce) {
      this._cancelRestartAgentDebounce({ cancelledBy: shouldDebounce ? 'superseded' : 'immediate' });
    }

    if (shouldDebounce) {
      return new Promise<DHAny>((resolve, reject) => {
        const timer = setTimeout(async () => {
          if (this._restartAgentDebounce?.timer !== timer) return;
          this._restartAgentDebounce = null;
          try {
            resolve(await this.restartAgent(promptFile, tools, { ...options, debounceMs: 0 }));
          } catch (e: DHAny) {
            reject(e);
          }
        }, debounceMs);

        this._restartAgentDebounce = { timer, resolve, reject };
      });
    }

    const resolvedPromptFile = this._resolveRestartAgentPromptFile(promptFile);
    const normalizedTools = Array.isArray(tools) ? tools.filter((t) => typeof t === 'string' && t.trim()) : [];
    const dedupeMs = this._getRestartAgentDedupeMs(options);
    const dedupeKey = this._getRestartAgentDedupeKey(resolvedPromptFile, normalizedTools);
    const now = Date.now();
    if (dedupeKey && this._restartAgentRunning && this._restartAgentActiveKey === dedupeKey) {
      return this._buildRestartAgentSkippedResult(resolvedPromptFile, normalizedTools, 'inProgress', { dedupeMs });
    }
    if (dedupeKey && dedupeMs > 0 && this._restartAgentRecent?.key === dedupeKey) {
      const ageMs = now - this._restartAgentRecent.timestamp;
      if (ageMs >= 0 && ageMs < dedupeMs) {
        return this._buildRestartAgentSkippedResult(resolvedPromptFile, normalizedTools, 'cooldown', {
          dedupeMs,
          ageMs,
        });
      }
    }

    const clearedTextSends = this._clearQueuedTextSends('restart-agent');
    if (clearedTextSends > 0) {
      console.log(`[DigitalHuman] restartAgent: cleared ${clearedTextSends} queued text send(s)`);
    }
    // Prevent re-entrant calls (e.g. template expansion inside the loaded prompt triggers another restartAgent)
    if (this._restartAgentRunning) {
      // Do not drop restart requests during an ongoing restart.
      // Keep the latest request and run it right after current restart completes.
      this._pendingRestartRequest = {
        promptFile: resolvedPromptFile,
        tools: normalizedTools,
        options: { ...options },
      };
      console.log(`[DigitalHuman] restartAgent queued — already in progress, next=${this._pendingRestartRequest.promptFile || 'default'}`);
      this.emit('restartAgent', {
        stage: 'queued',
        promptFile: this._pendingRestartRequest.promptFile || '',
        tools: normalizedTools,
        mode: this.isVoiceChatActive ? 'voice' : 'text',
        timestamp: Date.now(),
      });
      return {
        configSource: resolvedPromptFile || 'default',
        mode: this.isVoiceChatActive ? 'voice' : 'text',
        skipped: true,
        queued: true,
      };
    }
    this._restartAgentRunning = true;
    this._restartAgentActiveKey = dedupeKey;

    try {
      const result = await this._restartAgentImpl(resolvedPromptFile, normalizedTools, options);
      if (dedupeKey) {
        this._restartAgentRecent = {
          key: dedupeKey,
          timestamp: Date.now(),
          result,
        };
      }
      this.emit('restartAgent', {
        stage: 'complete',
        promptFile: resolvedPromptFile || '',
        tools: normalizedTools,
        result,
        timestamp: Date.now(),
      });
      return result;
    } catch (error: DHAny) {
      this.emit('restartAgent', {
        stage: 'failed',
        promptFile: resolvedPromptFile || '',
        tools: normalizedTools,
        error: error?.message || String(error),
        timestamp: Date.now(),
      });
      throw error;
    } finally {
      this._restartAgentRunning = false;
      this._restartAgentActiveKey = null;

      // If another restart was requested while running, execute it now.
      if (this._pendingRestartRequest !== undefined) {
        const nextRequest = this._pendingRestartRequest;
        this._pendingRestartRequest = undefined;
        try {
          const nextPrompt = nextRequest?.promptFile || null;
          const nextTools = Array.isArray(nextRequest?.tools) ? nextRequest.tools : [];
          const nextOptions = nextRequest?.options && typeof nextRequest.options === 'object'
            ? nextRequest.options
            : {};
          console.log(`[DigitalHuman] restartAgent draining queued request next=${nextPrompt || 'default'}`);
          await this.restartAgent(nextPrompt, nextTools, { ...nextOptions, debounceMs: 0 });
        } catch (e: DHAny) {
          console.error('[DigitalHuman] restartAgent queued request failed:', e.message);
          this.emit('error', { error: e, stage: 'restartAgent-queued' });
        }
      }
    }
  }

  /** @private */
  async _restartAgentImpl(promptFile: DHAny, tools: DHAny, options: DHAny = {}) {
    const wasVoiceActive = this.isVoiceChatActive;
    console.log(`[DigitalHuman] restartAgent promptFile=${promptFile || '(none)'} voiceActive=${wasVoiceActive}`);
    const canceledTextSends = await this._cancelActiveTextSends('restart-agent');
    if (canceledTextSends > 0) {
      console.log(`[DigitalHuman] restartAgent: canceled ${canceledTextSends} active text send(s)`);
    }
    const normalizedTools = Array.isArray(tools) ? tools.filter((t) => typeof t === 'string' && t.trim()) : [];
    this.emit('restartAgent', {
      stage: 'start',
      promptFile: (promptFile && typeof promptFile === 'string') ? promptFile : '',
      tools: normalizedTools,
      voiceActive: wasVoiceActive,
      mode: wasVoiceActive ? 'voice' : 'text',
      timestamp: Date.now(),
    });

    // Load new config from prompt file if provided
    let loadedConfig = null;
    if (promptFile && typeof promptFile === 'string' && promptFile.trim()) {
      const trimmedFile = promptFile.trim();
      const isURL = /^https?:\/\//i.test(trimmedFile);

      // Workspace-relative path — read via CopilotTools.read_file (supports search paths and proxy to parent frame)
      if (!isURL && this._aiChatSession?.sandbox) {
        try {
          const sandbox = this._aiChatSession.sandbox;
          // Mark this file as the active prompt BEFORE template expansion so that any
          // inline `${await copilot.restartAgent('thisfile')}` inside the prompt is
          // recognized as a duplicate of the in-progress restart and returns ''
          // (see AgentTool.js idempotency check). Without this, the inline call
          // throws RestartAgentSignal, breaking the sandbox read.
          sandbox._activePromptFile = trimmedFile;
          sandbox._templateSourceFile = trimmedFile;
          const content = await sandbox.copilot.read_file(trimmedFile, 1, -1, true);
          if (content && typeof content === 'string') {
            loadedConfig = { system_prompt: content };
            console.log(`[DigitalHuman] restartAgent loaded from sandbox '${trimmedFile}' (${content.length} chars)`);
          }
        } catch (e: DHAny) {
          console.warn(`[DigitalHuman] restartAgent sandbox read failed for '${trimmedFile}': ${e.message}`);
        }
      }

      // Fallback: fetch as URL
      if (!loadedConfig) {
        try {
          loadedConfig = await DigitalHuman.fetchConfig(trimmedFile);
          console.log(`[DigitalHuman] restartAgent loaded config from '${promptFile}'`);
        } catch (e: DHAny) {
          console.warn(`[DigitalHuman] restartAgent failed to load '${promptFile}': ${e.message}`);
        }
      }
    }

    // Always start from original config (from first initFromConfig/loadConfig)
    const baseConfig = JSON.parse(JSON.stringify(this._originalCharacterConfig || {}));
    const hasPromptFile = !!(promptFile && typeof promptFile === 'string' && promptFile.trim());

    if (loadedConfig) {
      // Override system_prompt from loaded config
      if (loadedConfig.system_prompt || loadedConfig.systemPrompt) {
        baseConfig.system_prompt = loadedConfig.system_prompt || loadedConfig.systemPrompt;
      }
      // Apply other explicit settings temporarily (only if present in loaded config)
      if (loadedConfig.llm_model) baseConfig.llm_model = loadedConfig.llm_model;
      if (loadedConfig.workspace) baseConfig.workspace = loadedConfig.workspace;
      if (loadedConfig.mountFolder) baseConfig.mountFolder = loadedConfig.mountFolder;
      if (loadedConfig.tools) baseConfig.tools = { ...baseConfig.tools, ...loadedConfig.tools };
      if (loadedConfig.historyLength !== undefined) baseConfig.historyLength = loadedConfig.historyLength;
    }

    // Optional caller override: non-empty tools list replaces default/tool-file tools.
    if (normalizedTools.length > 0) {
      baseConfig.tools = buildRestartToolConfig(normalizedTools, baseConfig.tools, {
        registry: this.sdk?.copilotTools?._registry || {},
      });
    }

    // PageRouter-level tools override (object config, merged last so it wins).
    if (options.toolsOverride && typeof options.toolsOverride === 'object') {
      baseConfig.tools = { ...(baseConfig.tools || {}), ...options.toolsOverride };
    }

    const configDetails = {
      loaded: !!loadedConfig,
      configSource: loadedConfig ? promptFile : 'default',
      workspace: baseConfig.workspace || baseConfig.tools?.fileOps?.workspace || '',
      mountFolder: baseConfig.mountFolder || baseConfig.tools?.fileOps?.mountFolder || '',
      toolCategories: baseConfig.tools && typeof baseConfig.tools === 'object'
        ? Object.keys(baseConfig.tools)
        : [],
    };

    // Save current session history before creating a new session.
    // When restarting with a valid prompt file, chat history is cleared by default
    // — both LLM context and summarizer reference are dropped so the new agent
    // truly starts fresh. When restarting without a prompt file (back to default
    // character), any previously saved messages are still restored.
    let savedMessages = null;
    if (hasPromptFile && loadedConfig && this._aiChatSession) {
      const dropCount = this._aiChatSession.messages.filter((m: DHAny) => m.role !== 'system').length;
      if (dropCount > 0) {
        console.log(`[DigitalHuman] restartAgent: clearing ${dropCount} chat history messages (default)`);
      }
    } else if (!hasPromptFile && this._aiChatSession?._savedMessages) {
      savedMessages = this._aiChatSession._savedMessages;
      console.log(`[DigitalHuman] restartAgent: will restore ${savedMessages.length} saved history messages`);
    }

    // ── Always restart the text session (config + history) ──
    const savedOriginal = this._originalCharacterConfig;
    // Signal _initKeepHistory to skip restoring history.md when this restart
    // is loading a fresh prompt file (history is being cleared by design).
    this._restartAgentClearHistory = !!(hasPromptFile && loadedConfig);
    try {
      await this.initFromConfig(baseConfig);
    } finally {
      this._restartAgentClearHistory = false;
    }
    this._originalCharacterConfig = savedOriginal;

    // History messages are cleared on prompt-file restart by default.
    // The new agent always starts fresh with only its system prompt.
    if (this._aiChatSession) {
      if (hasPromptFile && loadedConfig) {
        // Clear any previously saved messages too — full reset
        this._aiChatSession._savedMessages = null;
        this._aiChatSession._restartedWithPromptFile = true;
        console.log(`[DigitalHuman] restartAgent: chat history cleared`);
      } else if (!hasPromptFile && savedMessages) {
        // Returning to default — clear saved messages, agent starts fresh
        this._aiChatSession._savedMessages = null;
        this._aiChatSession._restartedWithPromptFile = false;
        console.log(`[DigitalHuman] restartAgent: cleared ${savedMessages.length} saved history messages (not sent to LLM)`);
      }
    }

    // Track the active prompt file on both text/voice sandboxes for idempotency.
    // Voice tools run in RTCChatSession.sandbox, so only updating text sandbox is insufficient.
    const sandboxes = [this._aiChatSession?.sandbox, this._vcSession?.sandbox].filter(Boolean);
    for (const sb of sandboxes) {
      if (hasPromptFile) {
        sb._activePromptFile = promptFile;
        sb._templateSourceFile = promptFile;
      } else {
        // When returning to default, clear both fields so a future restart to the same file works
        sb._activePromptFile = null;
        sb._templateSourceFile = null;
      }
    }

    // ── Always restart the voice session config + history ──
    // Update the stored preset so future startVoiceChat uses the new config
    if (this._lastVoiceChatPreset) {
      const newSystemPrompt = baseConfig.system_prompt
        || this.characterConfig?.system_prompt || null;
      if (newSystemPrompt && this._lastVoiceChatPreset.config?.LLMConfig?.SystemMessages) {
        this._lastVoiceChatPreset.config.LLMConfig.SystemMessages = [newSystemPrompt];
      }
      if (newSystemPrompt) {
        this._lastVoiceChatPreset.system_prompt = newSystemPrompt;
      }
      // Explicitly recompute enabledToolCategories from the new baseConfig.tools
      // so that _buildVoiceChatPreset uses them directly instead of falling back
      // to stale values from characterConfig.voiceChat or the previous preset.
      if (baseConfig.tools && typeof baseConfig.tools === 'object') {
        const newEnabledTools = resolveEnabledToolCategories({ tools: baseConfig.tools }, {
          resolveEnabledCategories: this.sdk?.copilotTools?.resolveEnabledCategories?.bind(this.sdk?.copilotTools),
        });
        this._lastVoiceChatPreset.enabledToolCategories = newEnabledTools.length > 0 ? newEnabledTools : undefined;
      } else {
        delete this._lastVoiceChatPreset.enabledToolCategories;
      }
      // Also propagate workspace/mountFolder which may have changed via the loaded config.
      if (baseConfig.workspace !== undefined) {
        this._lastVoiceChatPreset.workspace = baseConfig.workspace;
      }
      if (baseConfig.mountFolder !== undefined) {
        this._lastVoiceChatPreset.mountFolder = baseConfig.mountFolder;
      }
    }
    // Clear RTCChatSession history even if voice is not active right now
    if (this._vcSession) {
      this._vcSession.clear();
      if (typeof this._vcSession._cleanupChildSessions === 'function') {
        this._vcSession._cleanupChildSessions();
      }
    }

    const shouldAutoContinue = options.autoContinue !== false;
    const shouldSendAutoContinue = shouldAutoContinue && this._aiChatSession?._restartedWithPromptFile;

    if (wasVoiceActive) {
      // Update the active voice chat with the new system prompt and history.
      // restartVoiceChat falls back to stop/start only when UpdateParameters fails.
      await this.restartVoiceChat({});

      // Send "(continue)" so the new agent starts responding.
      if (shouldSendAutoContinue) {
        const voiceReady = await this.waitUntilVoiceReady();
        if (this._vcSession?.isActive) {
          console.log(`[DigitalHuman] restartAgent: sending "(continue)" via voice mode (ready=${voiceReady})`);
          this.sendText('(continue)');
        } else {
          console.warn('[DigitalHuman] restartAgent: voice session not active after restart, skipping "(continue)"');
        }
      }
    } else if (shouldSendAutoContinue) {
      console.log('[DigitalHuman] restartAgent: sending "(continue)" via text mode');
      void this.send('(continue)', { voice: false, _afterRestart: true }).catch((e) => {
        console.warn('[DigitalHuman] restartAgent: text auto "(continue)" failed:', e?.message || e);
      });
    }

    if (!shouldAutoContinue && this._aiChatSession?._restartedWithPromptFile) {
      console.log('[DigitalHuman] restartAgent: auto "(continue)" skipped by caller');
    }

    const mode = wasVoiceActive ? 'voice' : 'text';
    return { ...configDetails, mode };
  }

  /**
   * Send text during voice chat.
   * Also mirrors the user message into the canonical text ChatSession.
   * @param {string} text
   */
  sendText(text: DHAny) {
    if (!this._vcSession?.isActive) {
      console.warn('[DigitalHuman] Cannot sendText: voice chat not active');
      return;
    }
    this._resetVoiceIdleTimer();
    this._emitUserMessage(text, 'voice');
    // Queue direct user input; commit only when assistant reply arrives.
    this._mirrorVoiceToTextSession('user', text, { source: 'direct' });
    this._vcSession.sendText(text);
  }

  /**
   * Send text to TTS (text-to-speech) and play it through the avatar.
   * - Voice chat active: delegates to RTCChatSession.sendTTS (binary/REST).
   * - Text mode: queues the text through the text-mode speech pipeline
   *   (same as assistant responses) so the avatar speaks it out.
   * @param {string} text
   * @param {Object} [options]
   * @param {boolean} [options.useREST=false] - Voice mode only: use REST API instead of binary channel
   * @param {number} [options.interruptMode] - Voice mode only: REST interrupt priority
   */
  sendTTS(text: DHAny, options: DHAny = {}) {
    if (!text) return;
    if (this._vcSession?.isActive) {
      return this._vcSession.sendTTS(text, options);
    }
    // Text mode: use the text-mode speech pipeline
    this._queueTextSpeech(text, options, { kind: 'tts' });
  }

  /**
   * Get the current RTC voice chat session (for advanced control).
   * @returns {Object|null}
   */
  getVoiceChatSession() {
    return this._vcSession;
  }

  /**
   * Wait until the voice chat session has received its first state event
   * (UNKNOWN/0 or higher). Resolves immediately if already ready, or if
   * no voice session is active.
   * @param {number} [timeout=10000] - Max milliseconds to wait
   * @returns {Promise<boolean>} true if ready, false if timed out or no session
   */
  async waitUntilVoiceReady(timeout = 10000) {
    const vc = this._vcSession;
    if (!vc?.isActive) return false;
    // State 0 (UNKNOWN) emitted by the server already means the session is connected.
    if (vc._stateEventReceived) return true;
    console.log('[DigitalHuman] waitUntilVoiceReady: waiting for first state event...');
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: DHAny) => {
        if (settled) return;
        settled = true;
        this.off('voiceChatState', onState);
        clearTimeout(timer);
        clearInterval(poller);
        resolve(result);
      };
      const timer = setTimeout(() => {
        console.warn('[DigitalHuman] waitUntilVoiceReady: timed out');
        done(false);
      }, timeout);
      const onState = () => {
        done(true);
      };
      this.on('voiceChatState', onState);
      // Poll to handle race where state event fired before listener was registered
      const poller = setInterval(() => {
        if (vc._stateEventReceived) done(true);
      }, 200);
      // Immediate re-check after listener is registered
      if (vc._stateEventReceived) done(true);
    });
  }

  // ── Voice ↔ Text Session Mirroring ──

  /**
   * Mirror a voice chat turn into the canonical text ChatSession's messages array.
   * This keeps the text session as the single source of truth for conversation history.
   * User messages are committed only in IO pairs:
   * - queue one or more user inputs
   * - on assistant reply, merge queued user inputs into one message, then append assistant message
   * @param {'user'|'assistant'} role
   * @param {string} content
   * @param {Object} [extras] - Optional: { tool_calls, tool_call_id, source, skipHistory }
   */
  _mirrorVoiceToTextSession(role: DHAny, content: DHAny, extras: DHAny = {}) {
    if (!this._aiChatSession) return;
    const messages = this._aiChatSession.messages;

    if (extras.tool_calls) {
      const queuedUserText = this._vcQueuedUserInputs.filter(Boolean).join('\n');
      if (queuedUserText) {
        this._aiChatSession.addUserMessage(queuedUserText);
        this._vcQueuedUserInputs = [];
        this._vcDirectInputPending = [];
      }
      // Assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: extras.tool_calls,
      });
      return;
    }

    if (extras.tool_call_id) {
      // Tool result message
      messages.push({
        role: 'tool',
        tool_call_id: extras.tool_call_id,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      });
      return;
    }

    if (role === 'user') {
      const text = typeof content === 'string' ? content.trim() : '';
      if (!text) return;
      const source = extras.source || 'subtitle';

      // Direct input (send/sendText): queue now, defer commit until assistant reply.
      if (source === 'direct') {
        this._vcDirectInputPending.push({ text, skipHistory: extras.skipHistory === true });
        if (!extras.skipHistory) {
          this._vcQueuedUserInputs.push(text);
        }
        return;
      }

      // Subtitle input: if it echoes a direct input we already queued, consume dedupe token.
      if (this._vcDirectInputPending.length > 0 && text === this._vcDirectInputPending[0]?.text) {
        this._vcDirectInputPending.shift();
        return;
      }

      // ASR-only user input path.
      this._vcQueuedUserInputs.push(text);
      return;
    }

    if (role === 'assistant') {
      const assistantText = typeof content === 'string' ? content.trim() : '';
      const queuedUserText = this._vcQueuedUserInputs.filter(Boolean).join('\n');
      const shouldSkipRoundHistory = !queuedUserText
        && this._vcDirectInputPending.length > 0
        && this._vcDirectInputPending.every((item: DHAny) => item?.skipHistory === true);

      // Commit exactly one merged user message before assistant reply.
      if (queuedUserText) {
        this._aiChatSession.addUserMessage(queuedUserText);
      }

      if (assistantText && !shouldSkipRoundHistory) {
        this._aiChatSession.addAssistantMessage(assistantText);
      }

      this._vcQueuedUserInputs = [];
      this._vcDirectInputPending = [];
      this._resetSummarizeActivity();
    }
  }


  /**
   * Build UserPrompts for LLMConfig from normalized text-session history.
   * The result is always strict user/assistant pairs. If the sequence starts
   * with an assistant message, an empty user turn is inserted ahead of it.
   * Consecutive same-role turns are merged before pairing.
   * @param {number} historyLength - Number of user/assistant pairs to include
   * @returns {Array<{ Role: string, Content: string }>}
   */
  _buildUserPromptsForVoice(historyLength = 3) {
    if (!this._aiChatSession) return [];
    const messages = this._aiChatSession.messages;
    const turns = messages
      .filter((m: DHAny) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m: DHAny) => ({ Role: m.role, Content: m.content }));

    if (!turns.length) return [];

    const normalizedTurns = [];
    for (const turn of turns) {
      const previous = normalizedTurns[normalizedTurns.length - 1];
      if (previous && previous.Role === turn.Role) {
        previous.Content += `\n${turn.Content}`;
      } else {
        normalizedTurns.push({ ...turn });
      }
    }

    if (!normalizedTurns.length) return [];

    if (normalizedTurns[0].Role !== 'user') {
      normalizedTurns.unshift({ Role: 'user', Content: '(boot)' });
    }

    const pairs = [];
    for (let i = 0; i < normalizedTurns.length - 1; i += 2) {
      const userTurn = normalizedTurns[i];
      const assistantTurn = normalizedTurns[i + 1];
      if (userTurn?.Role !== 'user' || assistantTurn?.Role !== 'assistant') continue;
      pairs.push(userTurn, assistantTurn);
    }

    const pairCount = Math.max(1, historyLength);
    return pairs.slice(-2 * pairCount);
  }

  /** Wire RTCChatSession events to DigitalHuman events. */
  _wireVCSessionEvents(session: DHAny, bracketActionOptions: DHAny = {}) {
    const AGENT_STATE = typeof AIChatRTC !== 'undefined' ? AIChatRTC.AGENT_STATE
      : (window as DHAny).AIChatRTC?.AGENT_STATE || ({} as DHAny);

    let lastUserText = '';
    let lastAIText = '';
    let seenSubtitleBracketActions = bracketActionOptions.enabled ? new Set() : null;

    session.on('subtitle', (data: DHAny) => {
      if (data.isUser && data.text && String(data.text).trim()) {
        this._resetVoiceIdleTimer();
        this._resetVoiceHeartbeatActivity();
      }

      // Debounce identical streaming text to save CPU/UI updates, but always emit finals
      if (!data.definite) {
        if (data.isUser) {
          if (data.text === lastUserText) return;
          lastUserText = data.text;
        } else {
          if (data.text === lastAIText) return;
          lastAIText = data.text;
        }
      } else if (!data.isUser) {
        lastAIText = data.text;
      }

      // Process bracket actions only from definite (final) AI subtitles
      // to avoid repeatedly firing actions on each streaming update
      if (bracketActionOptions.enabled && data.definite && !data.isUser && data.text) {
        this._emitBracketActionEvents(data.text, seenSubtitleBracketActions, {
          source: 'subtitle',
          subtitleData: data,
        }, bracketActionOptions);
      }

      this._subtitleOverlay.updateSubtitle(data);
      this.emit('subtitle', data);
      this._forwardUserVoiceInputToMinigame(data);

      // Mirror definite paragraph turns into the canonical text ChatSession
      if (data.definite && data.paragraph && data.text) {
        const role = data.isUser ? 'user' : 'assistant';
        this._mirrorVoiceToTextSession(role, data.text);
        // Save history after assistant reply completes in voice mode
        if (!data.isUser) {
          void this._saveKeepHistory();
        }
      }
    });

    session.on('message', (data: DHAny) => {
      this.emit('message', { text: data.text, messageData: data });
    });

    session.on('state', (data: DHAny) => {
      const previousHeartbeatAgentState = this._voiceHeartbeatAgentState;
      this._voiceHeartbeatAgentState = data?.code;
      this._subtitleOverlay.handleVoiceState(data, AGENT_STATE);
      this.emit('voiceChatState', data);

      if (data?.code === AGENT_STATE.LISTENING
        || data?.code === AGENT_STATE.FINISHED
        || data?.code === AGENT_STATE.INTERRUPTED) {
        if (previousHeartbeatAgentState === AGENT_STATE.THINKING || previousHeartbeatAgentState === AGENT_STATE.SPEAKING) {
          this._voiceHeartbeatLastUserActivityAt = Date.now();
        }
        this._scheduleVoiceHeartbeat();
      } else if (data?.code === AGENT_STATE.THINKING || data?.code === AGENT_STATE.SPEAKING) {
        this._clearVoiceHeartbeat();
      }

      // Emit textSpeech events so voice-chat consumers get the same lifecycle as text mode
      if (data.code === AGENT_STATE.SPEAKING) {
        this.emit('textSpeechStart', { source: 'voiceChat' });
      } else if (data.code === AGENT_STATE.FINISHED || data.code === AGENT_STATE.INTERRUPTED) {
        this.emit('textSpeechEnd', { source: 'voiceChat' });
      }

      // Reset avatar when interrupted or finished
      if (data.code === AGENT_STATE.INTERRUPTED || data.code === AGENT_STATE.FINISHED) {
        this.setMouthOpen(0);
        const hasCustomAction = this._currentPlayAction
          && this._currentPlayAction !== 'talk'
          && this._currentPlayAction !== 'idle';
        if (!hasCustomAction) {
          this.switchToIdle();
        }
      }
    });

    session.on('welcome', (data: DHAny) => {
      this.emit('welcome', data);
    });

    session.on('functionCallInfo', (data: DHAny) => {
      this._subtitleOverlay.showThinking();
      this.emit('toolCall', { name: data.name, toolCallId: data.toolCallId || '', source: 'voiceChat' });
    });

    // Mirror tool calls from voice into the canonical text session
    session.on('functionCall', (data: DHAny) => {
      if (data.toolCalls?.length) {
        const toolCalls = data.toolCalls.map((tc: DHAny) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function?.name || 'unknown',
            arguments: typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || {}),
          },
        }));
        for (const toolCall of toolCalls) {
          let args = toolCall.function.arguments;
          try {
            args = typeof args === 'string' ? JSON.parse(args) : args;
          } catch (_: DHAny) {
            args = toolCall.function.arguments;
          }
          this.emit('toolCall', {
            name: toolCall.function.name,
            toolCallId: toolCall.id,
            args,
            source: 'voiceChat',
          });
          this._subtitleOverlay.showThinking();
        }
        this._mirrorVoiceToTextSession('assistant', null, { tool_calls: toolCalls });
      }
    });

    session.on('functionCallResult', (data: DHAny) => {
      // Mirror tool result into the canonical text session
      const content = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
      this._mirrorVoiceToTextSession('tool', content, { tool_call_id: data.toolCallId });
      this.emit('toolResult', data);
    });

    session.on('autoplayFailed', () => {
      this.emit('autoplayFailed', {});
    });

    session.on('remoteAudioLevel', ({ speaking, linearVolume }: DHAny) => {
      // Live2D: drive lip sync from normalized volume (0–1)
      if (this.live2dMode && linearVolume !== undefined) {
        this._rtcLipSyncTarget = linearVolume;
      }

      // Skip talk↔idle management if a custom action (not talk/idle) is playing
      const hasCustomAction = this._currentPlayAction
        && this._currentPlayAction !== 'talk'
        && this._currentPlayAction !== 'idle';

      // Video/Webp: debounce talk↔idle switching
      if (!this.live2dMode && !hasCustomAction) {
        if (speaking) {
          if (this._vcIdleDebounce) { clearTimeout(this._vcIdleDebounce); this._vcIdleDebounce = null; }
          if (this.currentVideoType !== 'talk') this.playAction('talk', -1);
        } else {
          if (!this._vcIdleDebounce) {
            this._vcIdleDebounce = setTimeout(() => {
              this._vcIdleDebounce = null;
              const isCustomActionActive = this._currentPlayAction
                && this._currentPlayAction !== 'talk'
                && this._currentPlayAction !== 'idle';
              if (!isCustomActionActive) {
                this.playAction('idle');
              }
            }, 300);
          }
        }
      }

      // Mute-while-speaking: mute mic when avatar starts speaking, unmute when stops
      if (speaking) {
        this._muteWhileSpeakingStart();
      } else {
        this._muteWhileSpeakingStop();
      }

      this.emit('audioLevel', { speaking, linearVolume });
    });

    session.on('error', (data: DHAny) => {
      this.emit('error', data);
    });
  }

  /** Attach volume-based lip sync to the RTC engine for smooth mouth animation. */
  _attachVolumeLipSync(session: DHAny) {
    if (!session.rtcEngine || typeof VERTC === 'undefined') return;

    session.rtcEngine.on(VERTC.events.onRemoteAudioPropertiesReport, (reports: DHAny) => {
      if (!session.isActive) return;
      let maxVol = 0;
      for (const report of (reports || [])) {
        const vol = report.audioPropertiesInfo?.linearVolume || 0;
        if (vol > maxVol) maxVol = vol;
      }
      this._rtcLipSyncTarget = maxVol > 0.005 ? Math.min(1, maxVol * 4.5) : 0;
    });
  }

  // ========================================================================
  // SECTION 13: Cleanup & Destroy
  // ========================================================================

  /** Clean up avatar state (reusable — does not remove DOM). */
  cleanupAvatar() {
    if (this._hideTimeout) { clearTimeout(this._hideTimeout); this._hideTimeout = null; }
    if (this._transitionTimeout) { clearTimeout(this._transitionTimeout); this._transitionTimeout = null; }
    if (this._pauseTimeout) { clearTimeout(this._pauseTimeout); this._pauseTimeout = null; }
    if (this._webpIdleDebounce) { clearTimeout(this._webpIdleDebounce); this._webpIdleDebounce = null; }
    if (this._playActionTimeout) { clearTimeout(this._playActionTimeout); this._playActionTimeout = null; }
    this._cancelRandomIdle();
    this._idleVariants = [];
    this._currentPlayAction = null;

    this._loadingPromises.clear();

    // Video cleanup
    if (this._videoIdle) {
      this._videoIdle.onloadeddata = null;
      this._videoIdle.onerror = null;
      this._videoIdle.pause();
      this._videoIdle.classList.remove('dh-visible');
      this._videoIdle.classList.add('dh-hidden');
      const source = this._videoIdle.querySelector('source');
      if (source) source.src = '';
      this._videoIdle.removeAttribute('src');
      this._videoIdle.load();
    }
    if (this._videoTalk) {
      this._videoTalk.onloadeddata = null;
      this._videoTalk.onerror = null;
      this._videoTalk.pause();
      this._videoTalk.classList.remove('dh-visible');
      this._videoTalk.classList.add('dh-hidden');
      const source = this._videoTalk.querySelector('source');
      if (source) source.src = '';
      this._videoTalk.removeAttribute('src');
      this._videoTalk.load();
    }

    // Live2D cleanup
    this.stopAudioLipSync();
    this._stopRtcLipSync();

    if (this.live2dModel) {
      const internalModel = this.live2dModel?.internalModel;
      if (this._live2dLipSyncHandler && internalModel?.off) {
        internalModel.off('beforeModelUpdate', this._live2dLipSyncHandler);
      }
      this._live2dLipSyncHandler = null;
    }
    if (this.live2dApp) {
      // destroy(false) keeps the canvas in the DOM so we can replace it below.
      // destroy(true) would remove the canvas, making parentNode null and
      // preventing the fresh-canvas swap — causing a dead-context error on reinit.
      this.live2dApp.destroy(false);
      this.live2dApp = null;
      this.live2dModel = null;
      // Replace canvas — PIXI.destroy kills the WebGL context,
      // so the old canvas cannot be reused for a new PIXI.Application.
      if (this._live2dCanvas && this._live2dCanvas.parentNode) {
        const fresh = document.createElement('canvas');
        fresh.className = this._live2dCanvas.className;
        this._live2dCanvas.parentNode.replaceChild(fresh, this._live2dCanvas);
        this._live2dCanvas = fresh;
      }
    }
    if (this._live2dResizeObserver) {
      this._live2dResizeObserver.disconnect();
      this._live2dResizeObserver = null;
    }
    if (this._live2dResizeHandler) {
      window.removeEventListener('resize', this._live2dResizeHandler);
      window.removeEventListener('orientationchange', this._live2dResizeHandler);
      this._live2dResizeHandler = null;
    }
    if (this._live2dViewportHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._live2dViewportHandler);
      window.visualViewport.removeEventListener('scroll', this._live2dViewportHandler);
      this._live2dViewportHandler = null;
    }
    if (this._live2dRelayoutFrame) {
      cancelAnimationFrame(this._live2dRelayoutFrame);
      this._live2dRelayoutFrame = null;
    }
    if (this._live2dRelayoutTimeout) {
      clearTimeout(this._live2dRelayoutTimeout);
      this._live2dRelayoutTimeout = null;
    }
    if (this._live2dCanvas) {
      this._live2dCanvas.classList.remove('dh-visible');
      this._live2dCanvas.classList.add('dh-hidden');
    }

    // Webp cleanup
    if (this._webpIdle) {
      this._webpIdle.onload = null;
      this._webpIdle.onerror = null;
      this._webpIdle.classList.remove('dh-visible');
      this._webpIdle.classList.add('dh-hidden');
      this._webpIdle.src = '';
    }
    if (this._webpTalk) {
      this._webpTalk.onload = null;
      this._webpTalk.onerror = null;
      this._webpTalk.classList.remove('dh-visible');
      this._webpTalk.classList.add('dh-hidden');
      this._webpTalk.src = '';
    }

    this.currentVideoType = null;
    this.isIdleVideoLoaded = false;
    this.isTalkVideoLoaded = false;
    this.live2dMode = false;
    this.webpMode = false;
    this._live2dInitPromise = null;
    this.hostLive2DSessionActive = false;
    this.isEnabled = false;
  }

  /** Fully destroy the DigitalHuman instance. */
  async destroy() {
    if (typeof this._authStateUnsubscribe === 'function') {
      this._authStateUnsubscribe();
      this._authStateUnsubscribe = null;
    }
    // Stop summarize agent
    if (this._summarizeAgent) {
      this._summarizeAgent.destroy();
      this._summarizeAgent = null;
    }
    this._stopSummarizeTimer();
    stopPageRouterHeartbeat(this as unknown as Parameters<typeof stopPageRouterHeartbeat>[0]);
    this._clearVoiceHeartbeat({ resetCount: true });
    this._clearInactiveVoiceStopTimer();
    this._clearVoiceIdleTimer();
    this._clearVoiceLifecycleHandlers();
    this._subtitleOverlay.destroy();

    // Stop voice chat
    if (this._vcSession?.isActive) {
      try { await this._vcSession.stop(); } catch (e: DHAny) { /* ignore */ }
    }
    await this._stopTextSpeechPlayback();
    this._vcSession = null;
    this._rtc = null;
    this._textSpeechSession = null;

    // Cleanup avatar
    this.cleanupAvatar();

    // Remove DOM
    if (this._avatarRoot && this._avatarRoot.parentNode) {
      this._avatarRoot.parentNode.removeChild(this._avatarRoot);
    }
    this._avatarRoot = null;
    this._videoIdle = null;
    this._videoTalk = null;
    this._live2dCanvas = null;
    this._webpIdle = null;
    this._webpTalk = null;

    // Clear session
    this._clearQueuedTextSends('destroy');
    this._aiChatSession = null;
    this._sessionConfig = null;

    // Remove registered search paths
    if (this._registeredSearchPaths?.length && this.sdk?.personalPageStore) {
      for (const prefix of this._registeredSearchPaths) {
        this.sdk.personalPageStore.removeSearchPath(prefix);
      }
      this._registeredSearchPaths = null;
    }

    // Clear listeners
    this._clearAudioResumeBindings();
    clearExternalContextDebounce(this as unknown as Parameters<typeof clearExternalContextDebounce>[0]);
    if (this._minigameUnsubscribe) {
      try { this._minigameUnsubscribe(); } catch (e: DHAny) { /* ignore */ }
      this._minigameUnsubscribe = null;
    }
    this._listeners = {};
  }
}

// Also expose on window for non-module usage
if (typeof window !== 'undefined') {
  window.DigitalHuman = DigitalHuman;
}
