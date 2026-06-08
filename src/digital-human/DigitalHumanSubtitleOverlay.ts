/**
 * DigitalHumanSubtitleOverlay.ts — DigitalHuman 字幕叠加层
 *
 * 在虚拟人头像容器上渲染助手/用户字幕气泡，支持打字机逐字显示、思考动画、
 * 括号动作文本剥离、自动隐藏等。被 DigitalHuman 主类使用。
 */

/** 字幕叠加层注入的 CSS（含助手/用户气泡样式与思考动画） */
export const DIGITAL_HUMAN_SUBTITLE_CSS = `
.dh-avatar-root .dh-subtitle-root {
  position: absolute;
  inset: 0;
  z-index: var(--dh-subtitle-z-index, 20);
  pointer-events: none;
  overflow: visible;
}
.dh-avatar-root .dh-subtitle-slot {
  position: absolute;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.24s ease;
  max-width: var(--dh-subtitle-max-width, 40%);
}
.dh-avatar-root .dh-subtitle-slot.dh-subtitle-visible { opacity: 1; }
.dh-avatar-root .dh-subtitle-assistant-slot {
  top: var(--dh-subtitle-assistant-top, 5%);
  left: var(--dh-subtitle-assistant-left, 3%);
}
.dh-avatar-root .dh-subtitle-user-slot {
  left: var(--dh-subtitle-user-left, 3%);
  bottom: var(--dh-subtitle-user-bottom, 10%);
  max-width: var(--dh-subtitle-user-max-width, 35%);
}
.dh-avatar-root .dh-subtitle-bubble {
  box-sizing: border-box;
  max-height: var(--dh-subtitle-max-height, 42vh);
  overflow: hidden;
  word-break: break-word;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  text-align: left;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  pointer-events: none;
  letter-spacing: 0;
}
.dh-avatar-root .dh-subtitle-assistant {
  background: var(--dh-subtitle-assistant-bg, rgba(255, 255, 255, 0.92));
  color: var(--dh-subtitle-assistant-color, #222);
  font-size: var(--dh-subtitle-assistant-font-size, clamp(14px, 3.4vw, 24px));
  line-height: 1.55;
  padding: var(--dh-subtitle-assistant-padding, 12px 16px);
  border-radius: var(--dh-subtitle-assistant-radius, 16px 16px 0 16px);
  box-shadow: var(--dh-subtitle-assistant-shadow, 0 4px 18px rgba(0, 0, 0, 0.14));
}
.dh-avatar-root .dh-subtitle-user {
  background: var(--dh-subtitle-user-bg, rgba(0, 0, 0, 0.66));
  color: var(--dh-subtitle-user-color, #fff);
  font-size: var(--dh-subtitle-user-font-size, clamp(12px, 2.8vw, 20px));
  line-height: 1.5;
  padding: var(--dh-subtitle-user-padding, 8px 14px);
  border-radius: var(--dh-subtitle-user-radius, 12px);
}
.dh-avatar-root .dh-subtitle-thinking {
  display: inline-block;
  background: linear-gradient(90deg, rgba(0,0,0,0.25), rgba(0,0,0,0.75), rgba(0,0,0,0.25));
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: dh-subtitle-thinking 1.2s linear infinite;
}
@keyframes dh-subtitle-thinking {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
`;

/** 字幕配置 */
export interface SubtitleConfig {
  enabled: boolean;
  showUser: boolean;
  showAssistant: boolean;
  showThinking: boolean;
  typewriter: boolean;
  charIntervalMs: number;
  autoHideDelayMs: number;
  userAutoHideDelayMs: number;
  stripBracketText: boolean;
  pointerEvents: 'none' | 'auto';
  dismissOnClick: boolean;
  clearOnStandby: boolean;
  thinkingText: string;
}

const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  enabled: false,
  showUser: true,
  showAssistant: true,
  showThinking: true,
  typewriter: true,
  charIntervalMs: 200,
  autoHideDelayMs: 3000,
  userAutoHideDelayMs: 3000,
  stripBracketText: true,
  pointerEvents: 'none',
  dismissOnClick: false,
  clearOnStandby: true,
  thinkingText: '思考中',
};

/** 字幕更新数据 */
export interface SubtitleUpdateData {
  text?: string;
  isUser?: boolean;
  roundId?: string | number;
  /** 用户字幕是否为最终结果（决定是否自动隐藏） */
  definite?: boolean;
  [key: string]: unknown;
}

/** DigitalHuman owner 需提供的最小接口 */
export interface SubtitleOwner {
  _avatarRoot?: HTMLElement | null;
  [key: string]: unknown;
}

/** Agent 状态码映射（由 DigitalHuman/AIChatRTC 传入） */
export interface AgentStateMap {
  SPEAKING?: number;
  FINISHED?: number;
  INTERRUPTED?: number;
  [key: string]: number | undefined;
}

/** 剥离成对括号片段（中英文括号），用空格替换并压缩空白 */
function stripBracketSegments(text: string): string {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\([^()]*\)|（[^（）]*）/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 剥离结尾未闭合的左括号片段（流式输出时尚未收到右括号） */
function stripTrailingOpenBracketSegment(text: string): string {
  const content = String(text || '');
  if (!content) return '';
  const lastOpen = Math.max(content.lastIndexOf('('), content.lastIndexOf('（'));
  const lastClose = Math.max(content.lastIndexOf(')'), content.lastIndexOf('）'));
  if (lastOpen === -1 || lastOpen < lastClose) return content;
  return content.slice(0, lastOpen).trimEnd();
}

export default class DigitalHumanSubtitleOverlay {
  owner: SubtitleOwner;
  root: HTMLDivElement | null = null;
  userSlot: HTMLDivElement | null = null;
  userText: HTMLDivElement | null = null;
  assistantSlot: HTMLDivElement | null = null;
  assistantText: HTMLDivElement | null = null;
  userHideTimer: ReturnType<typeof setTimeout> | null = null;
  assistantHideTimer: ReturnType<typeof setTimeout> | null = null;
  rafId = 0;
  revealStartTime = 0;
  targetText = '';
  displayText = '';
  revealIndex = 0;
  textCompleteReceived = false;
  thinkingVisible = false;
  lastRoundId = '';
  config: SubtitleConfig;

  constructor(owner: SubtitleOwner, config: Partial<SubtitleConfig> | boolean = {}) {
    this.owner = owner;
    this.config = { ...DEFAULT_SUBTITLE_CONFIG };
    this.setConfig(config);
  }

  /** 设置/合并字幕配置；true/false 作为 enabled 快捷开关 */
  setConfig(config: Partial<SubtitleConfig> | boolean = {}): SubtitleConfig {
    let next: Partial<SubtitleConfig>;
    if (config === true) next = { enabled: true };
    else if (config === false) next = { enabled: false };
    else if (!config || typeof config !== 'object') next = {};
    else next = config;

    this.config = { ...this.config, ...next };
    if (!this.config.enabled) {
      this.clear();
    } else if (this.owner?._avatarRoot) {
      this.attachRoot(this.owner._avatarRoot);
    }
    this._syncPointerEvents();
    return this.getConfig();
  }

  /** 获取当前配置副本 */
  getConfig(): SubtitleConfig {
    return { ...this.config };
  }

  /** 把字幕 DOM 挂载到头像容器 */
  attachRoot(avatarRoot: HTMLElement): void {
    if (!avatarRoot || !this.config.enabled) return;
    if (this.root && avatarRoot.contains(this.root)) return;
    this.destroyDom();

    this.root = document.createElement('div');
    this.root.className = 'dh-subtitle-root';

    this.assistantSlot = document.createElement('div');
    this.assistantSlot.className = 'dh-subtitle-slot dh-subtitle-assistant-slot';
    this.assistantText = document.createElement('div');
    this.assistantText.className = 'dh-subtitle-bubble dh-subtitle-assistant';
    this.assistantSlot.appendChild(this.assistantText);

    this.userSlot = document.createElement('div');
    this.userSlot.className = 'dh-subtitle-slot dh-subtitle-user-slot';
    this.userText = document.createElement('div');
    this.userText.className = 'dh-subtitle-bubble dh-subtitle-user';
    this.userSlot.appendChild(this.userText);

    this.root.appendChild(this.assistantSlot);
    this.root.appendChild(this.userSlot);
    avatarRoot.appendChild(this.root);
    this._syncPointerEvents();

    if (this.config.dismissOnClick) {
      this.assistantText.addEventListener('click', () => this.hideAssistant());
      this.userText.addEventListener('click', () => this.hideUser());
    }
  }

  /** 确保 DOM 已挂载，返回是否就绪 */
  private _ensure(): boolean {
    if (!this.config.enabled) return false;
    if (!this.owner?._avatarRoot) return false;
    this.attachRoot(this.owner._avatarRoot);
    return Boolean(this.root);
  }

  private _syncPointerEvents(): void {
    const value = this.config.pointerEvents === 'auto' || this.config.dismissOnClick ? 'auto' : 'none';
    if (this.root) this.root.style.pointerEvents = 'none';
    if (this.assistantText) this.assistantText.style.pointerEvents = value;
    if (this.userText) this.userText.style.pointerEvents = value;
  }

  /** 清理文本：剥离括号动作段 + 去除 `*` */
  private _cleanText(text: string): string {
    let content = String(text || '');
    if (this.config.stripBracketText !== false) {
      content = stripTrailingOpenBracketSegment(stripBracketSegments(content));
    }
    return content.replace(/\*/g, '').trim();
  }

  private _show(slot: HTMLElement | null): void {
    if (slot) slot.classList.add('dh-subtitle-visible');
  }

  private _hide(slot: HTMLElement | null): void {
    if (slot) slot.classList.remove('dh-subtitle-visible');
  }

  /** 显示"思考中"动画 */
  showThinking(): void {
    if (!this.config.enabled || this.config.showThinking === false) return;
    if (!this._ensure()) return;
    if (this.assistantHideTimer) {
      clearTimeout(this.assistantHideTimer);
      this.assistantHideTimer = null;
    }
    this._cancelReveal();
    this.thinkingVisible = true;
    this.targetText = '';
    this.displayText = '';
    this.revealIndex = 0;
    this.textCompleteReceived = false;
    if (this.assistantText) {
      this.assistantText.innerHTML = `<span class="dh-subtitle-thinking">${this.config.thinkingText || '...'}</span>`;
    }
    this._show(this.assistantSlot);
  }

  /** 隐藏思考动画 */
  hideThinking(): void {
    if (!this.thinkingVisible) return;
    this.thinkingVisible = false;
    if (!this.targetText) {
      this._scheduleAssistantHide(300);
    }
  }

  /** 统一字幕更新入口（按 isUser 分发） */
  updateSubtitle(data: SubtitleUpdateData = {}): void {
    if (!this.config.enabled) return;
    const text = data?.text || '';
    if (!text) return;
    if (data?.isUser) {
      this.updateUser(text, data);
    } else {
      this.updateAssistant(text, data);
    }
  }

  /** 更新用户字幕 */
  updateUser(text: string, data: SubtitleUpdateData = {}): void {
    if (this.config.showUser === false || !this._ensure()) return;
    const content = String(text || '').trim();
    if (!content) return;
    if (this.userHideTimer) {
      clearTimeout(this.userHideTimer);
      this.userHideTimer = null;
    }
    if (this.userText) {
      this.userText.textContent = content;
      this.userText.scrollTop = this.userText.scrollHeight;
    }
    this._show(this.userSlot);
    if (data.definite) {
      this.userHideTimer = setTimeout(() => {
        this.hideUser();
        this.userHideTimer = null;
      }, Number(this.config.userAutoHideDelayMs) || DEFAULT_SUBTITLE_CONFIG.userAutoHideDelayMs);
    }
  }

  /** 更新助手字幕（支持流式增量 + 打字机显示） */
  updateAssistant(text: string, data: SubtitleUpdateData = {}): void {
    if (this.config.showAssistant === false || !this._ensure()) return;
    if (this.thinkingVisible) this.hideThinking();

    const roundId = data?.roundId ? String(data.roundId) : '';
    if (roundId && this.lastRoundId && roundId !== this.lastRoundId) {
      this._resetAssistantText();
    }
    if (roundId) this.lastRoundId = roundId;

    if (text === this.targetText && this.revealIndex >= this.displayText.length) return;
    if (this.targetText && text !== this.targetText && this.targetText.includes(text)) return;

    if (this.assistantHideTimer) {
      clearTimeout(this.assistantHideTimer);
      this.assistantHideTimer = null;
    }
    this.textCompleteReceived = false;

    const nextDisplay = this._cleanText(text);
    if (!nextDisplay) return;

    const shouldReset = this.revealIndex > 0
      && !nextDisplay.startsWith(this.displayText.slice(0, Math.max(1, this.revealIndex)));
    if (shouldReset) this._resetAssistantText();

    this.targetText = String(text || '');
    this.displayText = nextDisplay;
    this._show(this.assistantSlot);
    this._startReveal();
  }

  private _resetAssistantText(): void {
    this._cancelReveal();
    this.targetText = '';
    this.displayText = '';
    this.revealIndex = 0;
    this.textCompleteReceived = false;
    if (this.assistantText) this.assistantText.textContent = '';
  }

  /** 启动打字机逐字揭示（基于 requestAnimationFrame） */
  private _startReveal(): void {
    if (!this.config.typewriter) {
      this._flushAssistant();
      return;
    }
    if (this.rafId) return;
    this.revealStartTime = performance.now()
      - (this.revealIndex * (Number(this.config.charIntervalMs) || DEFAULT_SUBTITLE_CONFIG.charIntervalMs));
    const tick = (now: number): void => {
      this.rafId = 0;
      const interval = Math.max(16, Number(this.config.charIntervalMs) || DEFAULT_SUBTITLE_CONFIG.charIntervalMs);
      const nextIndex = Math.min(this.displayText.length, Math.floor((now - this.revealStartTime) / interval) + 1);
      if (nextIndex > this.revealIndex) {
        this.revealIndex = nextIndex;
        if (this.assistantText) {
          this.assistantText.textContent = this.displayText.slice(0, this.revealIndex);
          this.assistantText.scrollTop = this.assistantText.scrollHeight;
        }
      }
      if (this.revealIndex < this.displayText.length) {
        this.rafId = requestAnimationFrame(tick);
      } else if (this.textCompleteReceived) {
        this._scheduleAssistantHide();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private _cancelReveal(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** 立即显示完整助手文本（非打字机模式或强制刷新） */
  private _flushAssistant(): void {
    this._cancelReveal();
    if (this.targetText) this.displayText = this._cleanText(this.targetText);
    this.revealIndex = this.displayText.length;
    if (this.assistantText) {
      this.assistantText.textContent = this.displayText;
      this.assistantText.scrollTop = this.assistantText.scrollHeight;
    }
    if (this.textCompleteReceived && this.displayText) this._scheduleAssistantHide();
  }

  /** 标记本轮文本已接收完毕 */
  markTextComplete(): void {
    this.textCompleteReceived = true;
    if (!this.rafId && this.revealIndex >= this.displayText.length && this.displayText) {
      this._scheduleAssistantHide();
    }
  }

  /** 标记最终态：立即刷完助手文本并调度用户字幕自动隐藏 */
  markFinal(): void {
    this.textCompleteReceived = true;
    this._flushAssistant();
    if (this.userSlot?.classList.contains('dh-subtitle-visible')) {
      if (this.userHideTimer) clearTimeout(this.userHideTimer);
      this.userHideTimer = setTimeout(() => {
        this.hideUser();
        this.userHideTimer = null;
      }, Number(this.config.userAutoHideDelayMs) || DEFAULT_SUBTITLE_CONFIG.userAutoHideDelayMs);
    }
  }

  /** 根据语音 Agent 状态码联动字幕（思考/最终态） */
  handleVoiceState(data: { code?: number } = {}, AGENT_STATE: AgentStateMap = {}): void {
    if (!this.config.enabled) return;
    if (data?.code === AGENT_STATE.SPEAKING || data?.code === AGENT_STATE.FINISHED) {
      this.hideThinking();
    }
    if (data?.code === AGENT_STATE.FINISHED || data?.code === AGENT_STATE.INTERRUPTED) {
      this.markFinal();
    }
  }

  private _scheduleAssistantHide(delayMs?: number): void {
    if (this.assistantHideTimer) clearTimeout(this.assistantHideTimer);
    const delay = Number(delayMs ?? this.config.autoHideDelayMs) || DEFAULT_SUBTITLE_CONFIG.autoHideDelayMs;
    this.assistantHideTimer = setTimeout(() => {
      this.hideAssistant();
      this.assistantHideTimer = null;
    }, delay);
  }

  /** 隐藏用户字幕 */
  hideUser(): void {
    this._hide(this.userSlot);
  }

  /** 隐藏助手字幕 */
  hideAssistant(): void {
    this._hide(this.assistantSlot);
    this.thinkingVisible = false;
  }

  /** 清空所有字幕状态与定时器 */
  clear(): void {
    if (this.userHideTimer) { clearTimeout(this.userHideTimer); this.userHideTimer = null; }
    if (this.assistantHideTimer) { clearTimeout(this.assistantHideTimer); this.assistantHideTimer = null; }
    this._cancelReveal();
    this.targetText = '';
    this.displayText = '';
    this.revealIndex = 0;
    this.textCompleteReceived = false;
    this.thinkingVisible = false;
    this.lastRoundId = '';
    if (this.userText) this.userText.textContent = '';
    if (this.assistantText) this.assistantText.textContent = '';
    this.hideUser();
    this.hideAssistant();
  }

  /** 从 DOM 移除字幕容器 */
  destroyDom(): void {
    if (this.root?.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
    this.userSlot = null;
    this.userText = null;
    this.assistantSlot = null;
    this.assistantText = null;
  }

  /** 完全销毁（清状态 + 移除 DOM） */
  destroy(): void {
    this.clear();
    this.destroyDom();
  }
}
