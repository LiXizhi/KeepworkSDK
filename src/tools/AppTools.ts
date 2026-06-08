/**
 * AppTools.ts — 浏览器端 DOM 自动化工具（TypeScript 完整实现）
 *
 * 向 LLM 暴露四个工具：
 * - `read_app`：描述当前页面可见的可交互元素快照
 * - `click_element`：按 selector / ref 点击元素
 * - `type_in_app`：向输入框输入文本或触发按键
 * - `screenshot_app`：委托外部 screenshotHandler 截图
 *
 * 特性：
 * - data-ai-hint / data-ai-type 属性支持非交互元素
 * - addIframe 注册子 iframe，自动合并到 read_app 结果
 * - ignoreList / whiteList 过滤器（持久 + 单次调用两种粒度）
 * - 元素 ref 数字索引，支持过期 ref 回退（aria-label → 文本匹配）
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('AppTools');

// ──────────────────── 常量 ────────────────────

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
  '[role="tab"]', '[role="menuitem"]', '[role="switch"]', '[role="combobox"]',
  '[role="slider"]', '[role="spinbutton"]', '[role="textbox"]',
  '[contenteditable="true"]', 'details > summary',
  '[tabindex]:not([tabindex="-1"])',
  '[data-ai-type]',
].join(', ');

const LANDMARK_SELECTOR = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'nav', 'main', 'header', 'footer', 'section', 'aside',
  '[role="navigation"]', '[role="main"]', '[role="banner"]',
  '[role="contentinfo"]', '[role="region"]', '[role="heading"]',
].join(', ');

const FORM_SELECTOR = 'input, select, textarea, button[type="submit"], button[type="reset"]';
const LINK_SELECTOR = 'a[href]';
const AI_HINT_SELECTOR = '[data-ai-hint]';
const ALL_SELECTOR = [INTERACTIVE_SELECTOR, LANDMARK_SELECTOR, AI_HINT_SELECTOR].join(', ');

const IMPLICIT_ROLES: Record<string, string | null> = {
  a: 'link', button: 'button', input: null,
  select: 'combobox', textarea: 'textbox', summary: 'button',
  h1: 'heading', h2: 'heading', h3: 'heading',
  h4: 'heading', h5: 'heading', h6: 'heading',
  nav: 'navigation', main: 'main', header: 'banner',
  footer: 'contentinfo', aside: 'complementary', section: 'region',
};

const INPUT_TYPE_ROLES: Record<string, string> = {
  checkbox: 'checkbox', radio: 'radio', text: 'textbox',
  search: 'searchbox', email: 'textbox', url: 'textbox',
  tel: 'textbox', password: 'textbox', number: 'spinbutton',
  range: 'slider', submit: 'button', reset: 'button', button: 'button',
};

const BUTTON_MAP: Record<string, number> = { left: 0, middle: 1, right: 2 };

// ──────────────────── 类型 ────────────────────

/** OpenAI Function Calling 工具定义 */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** AppTools 运行时配置（setConfig 参数） */
export interface AppToolsConfig {
  readHandler?: (filters: unknown, whiteList?: string[]) => Promise<unknown>;
  screenshotHandler?: () => Promise<unknown>;
  clickHandler?: (args: Record<string, unknown>) => Promise<unknown>;
  typeHandler?: (args: Record<string, unknown>) => Promise<unknown>;
  ignoreList?: string[];
  whiteList?: string[];
  [key: string]: unknown;
}

/** 元素 ref 元数据（用于过期 ref 回退） */
interface RefMeta {
  ariaLabel: string;
  label: string;
  text: string;
  selector: string;
}

/** 挂起的跨 iframe 调用记录 */
interface PendingCall {
  resolve: (result: string) => void;
}

// ──────────────────── AppTools ────────────────────

/**
 * AppTools — 浏览器端 DOM 自动化工具（供 CopilotTools 注册为 'app' 分类）。
 */
class AppTools {
  static readonly definitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'read_app',
        description: 'Get a snapshot of the current app state. This is better than screenshot.',
        parameters: {
          type: 'object',
          properties: {
            filters: { type: 'string', description: 'which part of the app you want to read. default to rough app summary' },
            whiteList: { type: 'array', items: { type: 'string' }, description: 'Optional array of CSS selectors. When provided, only elements matching (or inside) these selectors are returned.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'screenshot_app',
        description: "Capture a screenshot of the current app. You can't perform actions based on the screenshot; use read_app for actions.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'click_element',
        description: 'Click on an element in an app.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'selector of the element to click.' },
            ref: { type: 'string', description: 'Element reference to click. One of "selector" or "ref" must be provided.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to click with. Default is "left".' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'type_in_app',
        description: 'Type text or press keys in an app.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to type.' },
            key: { type: 'string', description: 'A key or key combination to press (e.g., "Enter", "Tab", "Control+c").' },
            selector: { type: 'string', description: 'CSS selector of the element to target. If omitted, types into the focused element.' },
            ref: { type: 'string', description: 'Element reference from a prior read_app call.' },
            clear: { type: 'boolean', description: 'If true, clear the field before typing. Default is true.' },
          },
          required: [],
        },
      },
    },
  ];

  private sdk: unknown;
  private _readHandler: ((filters: unknown, whiteList?: string[]) => Promise<unknown>) | null = null;
  private _screenshotHandler: (() => Promise<unknown>) | null = null;
  private _clickHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  private _typeHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  private _refMap = new Map<string, Element>();
  private _refMetaMap = new Map<string, RefMeta>();
  private _iframeRefMap = new Map<string, { iframe: HTMLIFrameElement; originalRef: string }>();
  private _ignoreList: string[] = [];
  private _whiteList: string[] = [];
  private _iframes = new Set<HTMLIFrameElement>();
  private _pendingCalls = new Map<number, PendingCall>();
  private _callIdCounter = 0;
  private _instanceId = Math.random().toString(36).slice(2, 10);
  private _onMessage?: (e: MessageEvent) => void;

  constructor(sdk: unknown) {
    this.sdk = sdk;
    this._initMessageListener();
  }

  // ──────────────────── 配置 ────────────────────

  setReadHandler(handler: (filters: unknown, whiteList?: string[]) => Promise<unknown>): void { this._readHandler = handler; }
  setScreenshotHandler(handler: () => Promise<unknown>): void { this._screenshotHandler = handler; }
  setClickHandler(handler: (args: Record<string, unknown>) => Promise<unknown>): void { this._clickHandler = handler; }
  setTypeHandler(handler: (args: Record<string, unknown>) => Promise<unknown>): void { this._typeHandler = handler; }

  /** 设置持久 ignore 列表（CSS selectors），匹配的元素及其后代从 read_app 排除。 */
  setIgnoreList(selectors: string[]): void {
    this._ignoreList = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
  }

  /** 设置持久 white 列表（CSS selectors），非空时只返回匹配元素或其后代。 */
  setWhiteList(selectors: string[]): void {
    this._whiteList = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
  }

  /** 更新运行时配置（由 CopilotTools.setToolConfig 调用）。 */
  setConfig(config: AppToolsConfig): void {
    if (config.readHandler) this._readHandler = config.readHandler;
    if (config.screenshotHandler) this._screenshotHandler = config.screenshotHandler;
    if (config.clickHandler) this._clickHandler = config.clickHandler;
    if (config.typeHandler) this._typeHandler = config.typeHandler;
    if (config.ignoreList !== undefined) this.setIgnoreList(config.ignoreList);
    if (config.whiteList !== undefined) this.setWhiteList(config.whiteList);
  }

  // ──────────────────── Iframe 管理 ────────────────────

  /**
   * 注册子 iframe 以参与 read_app / click_element / type_in_app 操作。
   * iframe 内需已加载 keepworkSDK。
   */
  addIframe(iframe: HTMLIFrameElement): void {
    if (iframe?.contentWindow) this._iframes.add(iframe);
  }

  /** 取消注册子 iframe。 */
  removeIframe(iframe: HTMLIFrameElement): void { this._iframes.delete(iframe); }

  /** 返回所有活跃 iframe（手动注册 + data-ai-hint 自动发现）。 */
  private _getActiveIframes(): HTMLIFrameElement[] {
    const set = new Set<HTMLIFrameElement>(this._iframes);
    document.querySelectorAll<HTMLIFrameElement>('iframe[data-ai-hint]').forEach((f) => set.add(f));
    return [...set].filter((f) => f.isConnected && f.contentWindow);
  }

  // ──────────────────── 消息监听（响应父窗口请求）────────────────────

  private _initMessageListener(): void {
    this._onMessage = (e: MessageEvent) => {
      const msg = e.data as Record<string, unknown>;
      if (!msg || !msg['is_app_tools']) return;
      if (msg['_senderId'] === this._instanceId) return;
      if (e.source === window && msg['type'] === 'request') return;
      if (msg['type'] === 'request') {
        void this._handleRequest(msg, e.source as Window | null);
      } else if (msg['type'] === 'response') {
        const pending = this._pendingCalls.get(msg['callId'] as number);
        if (pending) { this._pendingCalls.delete(msg['callId'] as number); pending.resolve(msg['result'] as string); }
      }
    };
    window.addEventListener('message', this._onMessage);
  }

  private async _handleRequest(msg: Record<string, unknown>, source: Window | null): Promise<void> {
    if (!source) return;
    const { action, args, callId, filters } = msg as { action: string; args?: Record<string, unknown>; callId: number; filters?: Record<string, unknown> };
    let result: unknown;
    if (action === 'read_app') {
      const mergedArgs = { ...(args ?? {}) };
      if (filters?.['whiteList'] !== undefined) mergedArgs['whiteList'] = filters['whiteList'];
      if (filters?.['ignoreList'] !== undefined) mergedArgs['ignoreList'] = filters['ignoreList'];
      result = await this.execute('read_app', mergedArgs);
    } else if (action === 'click_element') {
      result = await this.execute('click_element', { ...(args ?? {}), _delegated: true });
    } else if (action === 'type_in_app') {
      result = await this.execute('type_in_app', { ...(args ?? {}), _delegated: true });
    } else if (action === 'screenshot_app') {
      result = await this.execute('screenshot_app', args ?? {});
    } else {
      result = 'Unknown app tool action';
    }
    source.postMessage({ is_app_tools: true, type: 'response', callId, result, _senderId: this._instanceId }, '*');
  }

  /** 向子 iframe 的 AppTools 发送请求并等待响应。 */
  private _queryIframe(
    iframe: HTMLIFrameElement,
    action: string,
    args: Record<string, unknown> = {},
    options: { whiteList?: string[]; ignoreList?: string[]; forwardWhiteList?: boolean } = {}
  ): Promise<string> {
    return new Promise((resolve) => {
      if (!iframe.contentWindow) return resolve('');
      const callId = ++this._callIdCounter;
      const timeout = setTimeout(() => { this._pendingCalls.delete(callId); resolve(''); }, 5000);
      this._pendingCalls.set(callId, { resolve: (r) => { clearTimeout(timeout); resolve(r); } });
      const ignoreList = options.ignoreList ?? this._ignoreList;
      const whiteList = options.forwardWhiteList === false ? [] : (options.whiteList ?? this._whiteList);
      iframe.contentWindow.postMessage({
        is_app_tools: true, type: 'request', action, callId, args,
        filters: { ignoreList, whiteList }, _senderId: this._instanceId,
      }, '*');
    });
  }

  /** 清除 ref→element 映射（DOM 重大变化后调用）。 */
  clearRefs(): void { this._refMap.clear(); this._refMetaMap.clear(); this._iframeRefMap.clear(); }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行指定工具函数（CopilotTools 分发入口）。
   * @param name   - 工具名
   * @param args   - 工具参数
   * @param config - 运行时配置（当前未使用，预留扩展）
   */
  async execute(name: string, args: Record<string, unknown> = {}, _config: unknown = {}): Promise<unknown> {
    if (name === 'read_app') {
      if (this._readHandler) return await this._readHandler(args['filters'], Array.isArray(args['whiteList']) ? args['whiteList'] as string[] : undefined);
      const whiteList = Array.isArray(args['whiteList']) ? (args['whiteList'] as string[]).filter(Boolean) : this._whiteList;
      const ignoreList = Array.isArray(args['ignoreList']) ? (args['ignoreList'] as string[]).filter(Boolean) : this._ignoreList;
      return await this._defaultReadApp(args['filters'] as string | undefined, whiteList, ignoreList);
    }
    if (name === 'screenshot_app') {
      if (!this._screenshotHandler) return 'Failed: No screenshot handler registered';
      return await this._screenshotHandler();
    }
    if (name === 'click_element') {
      if (this._clickHandler) {
        const { selector, ref, button } = args as { selector?: string; ref?: string; button?: string };
        if (!selector && !ref) return 'Failed: One of "selector" or "ref" must be provided';
        return await this._clickHandler({ ...args, selector, ref, button: button ?? 'left' });
      }
      return await this._defaultClickElement(args);
    }
    if (name === 'type_in_app') {
      if (this._typeHandler) {
        const { selector, ref, text, key } = args as { selector?: string; ref?: string; text?: string; key?: string };
        if (!text && !key) return 'Failed: One of "text" or "key" must be provided';
        return await this._typeHandler({ ...args, selector, ref, text, key, clear: args['clear'] });
      }
      return await this._defaultTypeInApp(args);
    }
    return 'Unknown app tool';
  }

  // ──────────────────── read_app ────────────────────

  private async _defaultReadApp(
    filters: string | undefined,
    whiteList: string[] = [],
    ignoreList: string[] = []
  ): Promise<string> {
    const { roots, selector } = this._resolveScope(filters);
    this._refMap.clear(); this._refMetaMap.clear(); this._iframeRefMap.clear();
    const lines: string[] = [];
    let refCounter = 0;

    for (const root of roots) {
      const els = root.querySelectorAll(selector);
      for (const el of els) {
        if (!this._isVisible(el)) continue;
        if (!this._passesFilter(el, whiteList, ignoreList)) continue;
        refCounter++;
        this._refMap.set(String(refCounter), el);
        this._refMetaMap.set(String(refCounter), this._getElementRefMeta(el));
        lines.push(this._describeElement(el, refCounter));
      }
    }

    const liveIframes = this._getActiveIframes();
    if (liveIframes.length > 0) {
      const hasWhiteList = whiteList.length > 0;
      const iframeResults = await Promise.all(
        liveIframes.map((f) => {
          if (hasWhiteList) {
            const matches = whiteList.some((sel) => { try { return f.matches(sel) || !!f.closest(sel); } catch { return false; } });
            if (!matches) return Promise.resolve('');
            return this._queryIframe(f, 'read_app', { filters }, { forwardWhiteList: false, ignoreList });
          }
          return this._queryIframe(f, 'read_app', { filters }, { whiteList, ignoreList });
        })
      );
      for (let i = 0; i < iframeResults.length; i++) {
        const text = iframeResults[i]!;
        if (!text || /\| 0 elements? found/.test(text)) continue;
        const iframeRefMeta = this._parseRefMetadataFromReadResult(text);
        const hint = liveIframes[i]!.getAttribute('data-ai-hint');
        const src = hint ?? liveIframes[i]!.src ?? liveIframes[i]!.id ?? `iframe-${i}`;
        const rewritten = text.replace(/\[ref=(\d+)\]/g, (_, origRef: string) => {
          refCounter++;
          this._iframeRefMap.set(String(refCounter), { iframe: liveIframes[i]!, originalRef: origRef });
          const meta = iframeRefMeta.get(origRef);
          if (meta) this._refMetaMap.set(String(refCounter), meta);
          return `[ref=${refCounter}]`;
        });
        lines.push(`\n── iframe: ${src} ──`);
        lines.push(rewritten);
      }
    }

    const title = document.title || location.pathname;
    const header = `Page: ${title} | ${refCounter} element${refCounter !== 1 ? 's' : ''} found`;
    return header + '\n' + lines.join('\n');
  }

  private _passesFilter(el: Element, whiteList = this._whiteList, ignoreList = this._ignoreList): boolean {
    if (el.closest('[data-digitalhuman-frame]')) return false;
    for (const sel of ignoreList) { try { if (el.closest(sel)) return false; } catch { /* invalid selector */ } }
    if (whiteList.length) {
      for (const sel of whiteList) { try { if (el.closest(sel)) return true; } catch { /* invalid selector */ } }
      return false;
    }
    return true;
  }

  private _resolveScope(filters: string | undefined): { roots: Element[]; selector: string } {
    if (!filters || typeof filters !== 'string') return { roots: [document.body], selector: INTERACTIVE_SELECTOR };
    const f = filters.trim().toLowerCase();
    if (f === 'all' || f === 'full') return { roots: [document.body], selector: ALL_SELECTOR };
    if (f === 'forms' || f === 'form') return { roots: [document.body], selector: FORM_SELECTOR };
    if (f === 'links' || f === 'link') return { roots: [document.body], selector: LINK_SELECTOR };
    if (f === 'ai-hint') return { roots: [document.body], selector: AI_HINT_SELECTOR };
    try {
      const containers = document.querySelectorAll(filters.trim());
      if (containers.length > 0) return { roots: Array.from(containers), selector: INTERACTIVE_SELECTOR };
    } catch { /* not valid CSS selector */ }
    return { roots: [document.body], selector: INTERACTIVE_SELECTOR };
  }

  private _isVisible(el: Element): boolean {
    if (el.closest('[aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if ((el as HTMLElement).offsetWidth === 0 && (el as HTMLElement).offsetHeight === 0) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  }

  // ──────────────────── 元素描述 ────────────────────

  private _describeElement(el: Element, ref: number): string {
    const tag = el.tagName.toLowerCase();
    const role = this._getRole(el, tag);
    const label = this._getLabel(el, tag);
    const sel = this._buildSelector(el);
    const state = this._getState(el, tag);
    let line = `- [ref=${ref}]`;
    line += ` ${role ?? tag}`;
    if (label) line += ` "${label}"`;
    if (sel) line += ` [selector: ${sel}]`;
    if (state) line += ` {${state}}`;
    const aiLabel = el.getAttribute('data-ai-hint');
    if (aiLabel && aiLabel !== label) line += ` [hint: ${aiLabel}]`;
    return line;
  }

  private _getRole(el: Element, tag: string): string | null {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (tag === 'input') {
      const type = ((el.getAttribute('type') ?? 'text')).toLowerCase();
      return INPUT_TYPE_ROLES[type] ?? 'textbox';
    }
    return IMPLICIT_ROLES[tag] ?? this._getAiHintRole(el, tag);
  }

  private _getAiHintRole(el: Element, tag: string): string | null {
    if (!el.hasAttribute('data-ai-hint')) return null;
    if (tag !== 'div' && tag !== 'span') return null;
    const aiType = (el.getAttribute('data-ai-type') ?? '').toLowerCase();
    if (aiType === 'textbox') return 'textbox';
    if (aiType === 'button') return 'button';
    if (this._isPressableElement(el)) return 'button';
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    if (el.querySelector(INTERACTIVE_SELECTOR)) return 'group';
    return 'group';
  }

  private _isPressableElement(el: Element): boolean {
    if (typeof (el as HTMLElement).onclick === 'function') return true;
    const tabIndex = el.getAttribute('tabindex');
    if (tabIndex !== null && tabIndex !== '-1') return true;
    if (el.hasAttribute('aria-pressed') || el.hasAttribute('aria-expanded')) return true;
    return false;
  }

  private _getLabel(el: Element, tag: string): string {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return this._truncate(ariaLabel, 60);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean);
      if (parts.length) return this._truncate(parts.join(' '), 60);
    }
    if (el.id && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return this._truncate(label.textContent?.trim() ?? '', 60);
    }
    if (['button', 'a', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') {
      const text = ((el as HTMLElement).innerText ?? '').trim();
      if (text) return this._truncate(text, 60);
    }
    return this._truncate(el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('alt') ?? el.getAttribute('data-ai-hint') ?? '', 60);
  }

  private _getElementRefMeta(el: Element): RefMeta {
    const tag = el.tagName.toLowerCase();
    return { ariaLabel: this._getAriaLabelText(el), label: this._getLabel(el, tag), text: this._getElementText(el), selector: this._buildSelector(el) };
  }

  private _getAriaLabelText(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.replace(/\s+/g, ' ').trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (!labelledBy) return '';
    return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  private _getElementText(el: Element): string {
    return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  private _parseRefMetadataFromReadResult(text: string): Map<string, RefMeta> {
    const meta = new Map<string, RefMeta>();
    const lineRe = /^- \[ref=(\d+)\]\s+\S+(?:\s+"([^"]*)")?(?:\s+\[selector:\s*([^\]]+)\])?/gm;
    let match: RegExpExecArray | null;
    while ((match = lineRe.exec(text)) !== null) {
      const label = (match[2] ?? '').trim();
      meta.set(match[1]!, { ariaLabel: label, label, text: label, selector: (match[3] ?? '').trim() });
    }
    return meta;
  }

  private _getState(el: Element, tag: string): string {
    const parts: string[] = [];
    const htmlEl = el as HTMLInputElement;
    if (htmlEl.disabled) parts.push('disabled');
    if (htmlEl.readOnly) parts.push('readonly');
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') { parts.push(`checked: ${htmlEl.checked}`); }
      else {
        if (htmlEl.value) parts.push(`value: "${this._truncate(htmlEl.value, 40)}"`);
        const ph = el.getAttribute('placeholder');
        if (ph) parts.push(`placeholder: "${this._truncate(ph, 30)}"`);
      }
    } else if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const opt = sel.options[sel.selectedIndex];
      if (opt) parts.push(`selected: "${this._truncate(opt.textContent?.trim() ?? '', 40)}"`);
    } else if (tag === 'textarea') {
      const val = (el as HTMLTextAreaElement).value;
      if (val) parts.push(`value: "${this._truncate(val, 40)}"`);
    } else if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) parts.push(`href: ${this._truncate(href, 60)}`);
    } else if (el.getAttribute('data-ai-type') === 'textbox') {
      const text = ((el as HTMLElement).innerText ?? '').trim();
      if (text) parts.push(`value: "${this._truncate(text, 40)}"`);
    }
    if (el.getAttribute('aria-expanded') !== null) parts.push(`expanded: ${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-pressed') !== null) parts.push(`pressed: ${el.getAttribute('aria-pressed')}`);
    return parts.join(', ');
  }

  // ──────────────────── 选择器构建 ────────────────────

  private _buildSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
    const name = el.getAttribute('name');
    const tag = el.tagName.toLowerCase();
    if (name) {
      const sel = `${tag}[name="${CSS.escape(name)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const parts: string[] = [];
    let current: Element | null = el;
    for (let depth = 0; depth < 5 && current && current !== document.body; depth++) {
      const currentTag = current.tagName.toLowerCase();
      if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
      const parentEl: HTMLElement | null = current.parentElement;
      if (parentEl) {
        const siblings = Array.from(parentEl.children).filter((c) => c.tagName === current!.tagName);
        parts.unshift(siblings.length > 1 ? `${currentTag}:nth-of-type(${siblings.indexOf(current!) + 1})` : currentTag);
      } else { parts.unshift(currentTag); }
      current = parentEl;
    }
    return parts.join(' > ');
  }

  // ──────────────────── click_element ────────────────────

  private async _defaultClickElement(args: Record<string, unknown>): Promise<string> {
    const { selector, ref, button, _delegated } = args as { selector?: string; ref?: string; button?: string; _delegated?: boolean };
    if (!selector && !ref) return 'Failed: One of "selector" or "ref" must be provided';

    if (ref) {
      const iframeEntry = this._iframeRefMap.get(ref);
      if (iframeEntry?.iframe.isConnected && iframeEntry.iframe.contentWindow) {
        const result = await this._queryIframe(iframeEntry.iframe, 'click_element', { ...args, ref: iframeEntry.originalRef, button });
        if (result) return result.replace(`[ref=${iframeEntry.originalRef}]`, `[ref=${ref}]`);
      }
    }

    const el = this._resolveElement(selector, ref, args);
    if (!el) {
      if (!_delegated) {
        for (const iframe of this._getActiveIframes()) {
          const result = await this._queryIframe(iframe, 'click_element', { ...args, selector, ref, button });
          if (result && !result.startsWith('Failed:')) return result;
        }
      }
      return `Failed: Element not found${ref ? ` for ref=${ref}` : ` for selector "${selector}"`}`;
    }
    if (!this._isVisible(el)) return 'Failed: Element is not visible';

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();

    const btn = BUTTON_MAP[button ?? 'left'] ?? 0;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const shared = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: btn };
    el.dispatchEvent(new PointerEvent('pointerdown', shared));
    el.dispatchEvent(new MouseEvent('mousedown', shared));
    el.dispatchEvent(new PointerEvent('pointerup', shared));
    el.dispatchEvent(new MouseEvent('mouseup', shared));
    el.dispatchEvent(new MouseEvent('click', shared));
    if (btn === 2) el.dispatchEvent(new MouseEvent('contextmenu', { ...shared, button: 2 }));

    const tag = el.tagName.toLowerCase();
    const label = this._getLabel(el, tag);
    const role = this._getRole(el, tag) ?? tag;
    if (ref) return `Clicked [ref=${ref}] ${role}${label ? ` "${label}"` : ''}`;
    return `Clicked ${role}${label ? ` "${label}"` : ''} matching "${selector}"`;
  }

  // ──────────────────── type_in_app ────────────────────

  private async _defaultTypeInApp(args: Record<string, unknown>): Promise<string> {
    const { selector, ref, text, key, _delegated } = args as { selector?: string; ref?: string; text?: string; key?: string; _delegated?: boolean };
    const clear = (args['clear'] as boolean | undefined) !== false;
    if (!text && !key) return 'Failed: One of "text" or "key" must be provided';

    if (ref) {
      const iframeEntry = this._iframeRefMap.get(ref);
      if (iframeEntry?.iframe.isConnected && iframeEntry.iframe.contentWindow) {
        const result = await this._queryIframe(iframeEntry.iframe, 'type_in_app', { ...args, ref: iframeEntry.originalRef });
        if (result) return result.replace(`[ref=${iframeEntry.originalRef}]`, `[ref=${ref}]`);
      }
    }

    if (key) {
      const hasTarget = selector || ref;
      const el: Element | null = hasTarget ? this._resolveElement(selector, ref, args) : document.activeElement;
      if (!el) {
        if (!_delegated) {
          for (const iframe of this._getActiveIframes()) {
            const result = await this._queryIframe(iframe, 'type_in_app', { ...args, selector, ref, key });
            if (result && !result.startsWith('Failed:')) return result;
          }
        }
        return `Failed: Element not found`;
      }
      const parts = key.split('+').map((k) => k.trim());
      const mainKey = parts.pop() ?? '';
      const modifiers = new Set(parts.map((m) => m.toLowerCase()));
      const keyOpts = { key: mainKey, code: this._keyToCode(mainKey), bubbles: true, cancelable: true, ctrlKey: modifiers.has('control') || modifiers.has('ctrl'), shiftKey: modifiers.has('shift'), altKey: modifiers.has('alt'), metaKey: modifiers.has('meta') || modifiers.has('command') || modifiers.has('cmd') };
      el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      el.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
      if (mainKey === 'Enter' && (el as HTMLInputElement).form && el.tagName.toLowerCase() !== 'textarea') {
        const form = (el as HTMLInputElement).form!;
        form.requestSubmit ? form.requestSubmit() : form.submit();
      }
      const tag2 = el.tagName.toLowerCase();
      return `Pressed ${key} on ${ref ? `[ref=${ref}] ${this._getRole(el, tag2) ?? tag2}` : selector ? `${this._getRole(el, tag2) ?? tag2} matching "${selector}"` : `focused ${this._getRole(el, tag2) ?? tag2}`}`;
    }

    const hasTarget = selector || ref;
    const el: Element | null = hasTarget ? this._resolveElement(selector, ref, args) : document.activeElement;
    if (!el) {
      if (!_delegated) {
        for (const iframe of this._getActiveIframes()) {
          const result = await this._queryIframe(iframe, 'type_in_app', { ...args, selector, ref, text, clear });
          if (result && !result.startsWith('Failed:')) return result;
        }
      }
      return 'Failed: Element not found';
    }
    if (!this._isVisible(el)) return 'Failed: Element is not visible';

    const tag = el.tagName.toLowerCase();
    const isAiTextbox = el.getAttribute('data-ai-type') === 'textbox';
    const isEditable = tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable || isAiTextbox || el.getAttribute('role') === 'textbox';
    if (!isEditable) return 'Failed: Element is not a text input';

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();

    const textToType = text ?? '';
    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const option = Array.from(sel.options).find((o) => o.value === textToType || o.textContent?.trim().toLowerCase() === textToType.toLowerCase());
      if (!option) return `Failed: No option matching "${textToType}" found`;
      sel.value = option.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (clear) { nativeSetter ? nativeSetter.call(el, '') : ((el as HTMLInputElement).value = ''); el.dispatchEvent(new Event('input', { bubbles: true })); }
      const newVal = clear ? textToType : (el as HTMLInputElement).value + textToType;
      nativeSetter ? nativeSetter.call(el, newVal) : ((el as HTMLInputElement).value = newVal);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ((el as HTMLElement).isContentEditable || isAiTextbox) {
      if ((el as HTMLElement).isContentEditable) { if (clear) (el as HTMLElement).textContent = ''; document.execCommand('insertText', false, textToType); }
      else { (el as HTMLElement).textContent = clear ? textToType : ((el as HTMLElement).textContent ?? '') + textToType; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const label = this._getLabel(el, tag);
    const role = this._getRole(el, tag) ?? tag;
    if (ref) return `Typed in [ref=${ref}] ${role}${label ? ` "${label}"` : ''}`;
    if (selector) return `Typed in ${role}${label ? ` "${label}"` : ''} matching "${selector}"`;
    return `Typed in focused ${role}${label ? ` "${label}"` : ''}`;
  }

  private _keyToCode(key: string): string {
    const map: Record<string, string> = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space', ' ': 'Space', F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12' };
    if (map[key]) return map[key]!;
    if (key.length === 1) return `Key${key.toUpperCase()}`;
    return key;
  }

  // ──────────────────── 元素解析 ────────────────────

  private _resolveElement(selector: string | undefined, ref: string | undefined, target: Record<string, unknown> = {}): Element | null {
    if (ref) {
      const el = this._refMap.get(ref);
      if (el?.isConnected) return el;
      return this._resolveStaleRefFallback(ref, target);
    }
    if (selector) { const r = this._resolveSelector(selector); if (r) return r; }
    const hints = this._getTargetHints(target);
    if (hints.ariaLabel) { const r = this._findByAriaLabel(hints.ariaLabel, true) ?? this._findByAriaLabel(hints.ariaLabel, false); if (r) return r; }
    if (hints.text) return this._findByText(hints.text, true) ?? this._findByText(hints.text, false);
    return null;
  }

  private _resolveStaleRefFallback(ref: string, target: Record<string, unknown>): Element | null {
    const meta = this._refMetaMap.get(ref) ?? ({} as RefMeta);
    const hints = this._getTargetHints(target, meta);
    if (hints.ariaLabel) { const r = this._findByAriaLabel(hints.ariaLabel, true) ?? this._findByAriaLabel(hints.ariaLabel, false); if (r) return r; }
    if (hints.text) return this._findByText(hints.text, true) ?? this._findByText(hints.text, false);
    return null;
  }

  private _resolveSelector(selector: string): Element | null {
    const textMatch = selector.match(/^text=("?)(.+)\1$/);
    if (textMatch) return this._findByText(textMatch[2]!, textMatch[1] === '"');
    try { return document.querySelector(selector); } catch { return null; }
  }

  private _getTargetHints(target: Record<string, unknown>, refMeta: Partial<RefMeta> = {}): { ariaLabel: string; text: string } {
    const refText = typeof target['ref'] === 'string' ? target['ref'] : '';
    return {
      ariaLabel: this._firstText(refMeta.ariaLabel, refMeta.label, refText),
      text: this._firstText(refMeta.text, refMeta.label, refText),
    };
  }

  private _firstText(...values: Array<string | undefined>): string {
    for (const v of values) { if (typeof v === 'string') { const n = v.replace(/\s+/g, ' ').trim(); if (n) return n; } }
    return '';
  }

  private _findByAriaLabel(needle: string, exact: boolean): Element | null {
    if (!needle) return null;
    const matches = (value: string | null): boolean => {
      const n = (value ?? '').replace(/\s+/g, ' ').trim();
      return n ? (exact ? n === needle : n.toLowerCase().includes(needle.toLowerCase())) : false;
    };
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) { if (matches(this._getAriaLabelText(el))) return el; }
    for (const el of document.body.querySelectorAll('*')) { if (matches(this._getAriaLabelText(el))) return el; }
    return null;
  }

  private _findByText(needle: string, exact: boolean): Element | null {
    const check = (el: Element): boolean => {
      const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
      return exact ? t === needle : t.toLowerCase().includes(needle.toLowerCase());
    };
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) { if (check(el)) return el; }
    for (const el of document.body.querySelectorAll('*')) { if (check(el)) return el; }
    return null;
  }

  private _truncate(str: string, max: number): string {
    if (!str) return '';
    str = str.replace(/\s+/g, ' ').trim();
    return str.length <= max ? str : str.slice(0, max - 1) + '…';
  }

  // ──────────────────── 静态工具 ────────────────────

  /**
   * 发出 `dh:app-page-opened` postMessage 通知 DigitalHuman 页面切换。
   * DigitalHuman 会根据 pageRouters 配置切换 agent 并发送唤醒文本。
   * @param page - 页面名称（必须匹配 pageRouters 配置中的某个 key）
   */
  static postAppPageOpened(page: string): void {
    window.postMessage({ type: 'dh:app-page-opened', page }, '*');
  }
}

export default AppTools;