/**
 * translation.ts — KeepworkSDK 国际化模块（完整 TypeScript 实现）
 *
 * 以中文文本作为 key，外部 JSON 提供其他语言翻译；缺失翻译时回退中文。
 * 语言解析顺序：URL 参数 `?lang=enUS` > localStorage `keepwork_ui_lang` > navigator.language。
 * 完整 API 见 docs/translation.md。
 */

import SDKLogger from './SDKLogger';
const console = SDKLogger.createModuleConsole('Translation');

// ──────────────────── 类型 ────────────────────

/** Translation 构造选项 */
export interface TranslationOptions {
  /** 语言代码 → JSON URL 的映射 */
  localeFiles?: Record<string, string>;
  /** 回退语言代码（默认 'zhCN'） */
  defaultLang?: string;
  /** 是否在构造时立即调用 init()（默认 false） */
  autoInit?: boolean;
}

/** 翻译变量映射（用于 `{var}` 插值） */
export type TranslationVars = Record<string, string | number>;

/** 翻译表（扁平 key → 译文） */
type TranslationMap = Record<string, string>;

const DEFAULT_LOCALE_FILES: Record<string, string> = {
  enUS: './keepwork.locale.enUS.json',
};

// ──────────────────── Translation ────────────────────

/**
 * Translation — 可复用的 i18n 模块。
 *
 * 通常通过 `window.i18n` 访问共享实例（由 installI18nGlobals 安装）；
 * 也可直接 `new Translation(options)` 创建独立实例。
 */
export default class Translation {
  private _STORAGE_KEY: string;
  private _localeFiles: Record<string, string>;
  private _defaultLang: string;
  private _currentLang: string;
  private _translations: TranslationMap | null;
  private _isLoading: boolean;
  private _loadPromise: Promise<TranslationMap> | null;
  private _initPromise: Promise<string> | null;

  constructor(options: TranslationOptions = {}) {
    this._STORAGE_KEY = 'keepwork_ui_lang';
    this._localeFiles = options.localeFiles || { ...DEFAULT_LOCALE_FILES };
    this._defaultLang = options.defaultLang || 'zhCN';
    this._currentLang = this._defaultLang;
    this._translations = null;
    this._isLoading = false;
    this._loadPromise = null;
    this._initPromise = null;

    // bind t()，使其可作为独立函数传递（实例属性遮蔽原型方法，与原 JS 行为一致）
    (this as { t: Translation['t'] }).t = this.t.bind(this);

    if (options.autoInit) {
      this._initPromise = this.init();
    }
  }

  /**
   * 检测系统语言并映射到支持的语言代码。
   */
  private _detectSystemLang(): string {
    if (typeof navigator === 'undefined') return this._defaultLang;
    const navLang = navigator.language
      || (navigator as Navigator & { userLanguage?: string }).userLanguage
      || 'zh-CN';
    if (navLang.startsWith('zh')) return 'zhCN';
    if (navLang.startsWith('en')) return 'enUS';
    if (navLang.startsWith('ja')) return 'jaJP';
    return 'enUS';
  }

  /**
   * 解析当前 UI 语言。优先级：URL 参数 > localStorage > 系统语言。
   */
  private _resolveCurrentLang(): string {
    if (typeof window !== 'undefined' && window.location) {
      const urlParams = new URLSearchParams(window.location.search);
      const urlLang = urlParams.get('lang');
      if (urlLang) return urlLang;
    }
    if (typeof localStorage !== 'undefined') {
      const storedLang = localStorage.getItem(this._STORAGE_KEY);
      if (storedLang) return storedLang;
    }
    return this._detectSystemLang();
  }

  /**
   * 从 JSON 文件加载翻译。
   * @param lang - 要加载的语言代码（默认当前语言）
   */
  async loadTranslations(lang?: string): Promise<TranslationMap> {
    const target = lang || this._currentLang;
    const localeFile = this._localeFiles[target] || null;
    if (!localeFile) {
      console.log('[i18n] No locale file for language:', target, '- using Chinese');
      this._translations = {};
      return this._translations;
    }

    if (this._translations) return this._translations;
    if (this._loadPromise) return this._loadPromise;

    this._isLoading = true;
    this._loadPromise = fetch(localeFile)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load locale file: ' + localeFile);
        return res.json();
      })
      .then((data: Record<string, unknown>) => {
        this._translations = {};
        for (const section of Object.keys(data)) {
          if (section === '_meta') continue;
          Object.assign(this._translations, data[section]);
        }
        this._isLoading = false;
        console.log('[i18n] Loaded translations for:', target, '- entries:', Object.keys(this._translations).length);
        return this._translations;
      })
      .catch(err => {
        console.warn('[i18n] Failed to load translations, defaulting to Chinese:', err);
        this._isLoading = false;
        this._translations = {};
        this._currentLang = this._defaultLang;
        return this._translations as TranslationMap;
      });

    return this._loadPromise;
  }

  /**
   * 初始化 i18n：解析语言、加载翻译、应用 DOM 翻译。
   */
  async init(): Promise<string> {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      this._currentLang = this._resolveCurrentLang();
      console.log('[i18n] Initializing with language:', this._currentLang);

      if (this._currentLang !== this._defaultLang) {
        await this.loadTranslations(this._currentLang);
      }

      this.applyTranslations();
      return this._currentLang;
    })();

    return this._initPromise;
  }

  /**
   * 翻译文本。构造时会 bind 为实例属性 this.t（可作为独立函数传递）。
   * @param key  - 以中文文本作为 key
   * @param vars - 用于替换 `{varName}` 的变量
   */
  t(key: string, vars?: TranslationVars): string {
    let result = key;

    if (this._currentLang !== this._defaultLang && this._translations && this._translations[key]) {
      result = this._translations[key];
    }

    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }

    return result;
  }

  /**
   * 把翻译应用到所有带 data-i18n 属性的元素。
   */
  applyTranslations(): void {
    if (typeof document === 'undefined') return;
    if (this._currentLang === this._defaultLang) return;

    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n || (el.textContent || '').trim();
      if (key) {
        const translated = this.t(key);
        if (translated !== key) {
          el.textContent = translated;
        }
      }
    });
  }

  /**
   * 设置 UI 语言并重新加载翻译（会刷新页面以应用）。
   */
  async setLang(lang: string): Promise<void> {
    this._currentLang = lang;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this._STORAGE_KEY, lang);
    }

    if (lang !== this._defaultLang && !this._translations) {
      await this.loadTranslations(lang);
    }

    if (typeof window !== 'undefined' && window.location) {
      const url = new URL(window.location.href);
      url.searchParams.set('lang', lang);
      window.location.href = url.toString();
    }
  }

  /** 获取当前语言代码。 */
  getLang(): string {
    return this._currentLang;
  }

  /** 翻译是否已就绪。 */
  isReady(): boolean {
    return this._currentLang === this._defaultLang || this._translations !== null;
  }

  /** 返回初始化完成的 Promise。 */
  ready(): Promise<unknown> {
    return this._initPromise || Promise.resolve();
  }

  /**
   * 合并额外翻译（不覆盖已有 key）。支持扁平或单层嵌套对象。
   */
  mergeTranslations(extra: Record<string, unknown>): void {
    if (!extra || typeof extra !== 'object') return;
    if (!this._translations) this._translations = {};
    for (const [section, value] of Object.entries(extra)) {
      if (section === '_meta') continue;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!(k in this._translations)) this._translations[k] = v as string;
        }
      } else if (typeof value === 'string') {
        if (!(section in this._translations)) this._translations[section] = value;
      }
    }
  }

  /**
   * 注册更多语言文件路径（懒加载）。
   */
  addLocaleFiles(files: Record<string, string>): void {
    Object.assign(this._localeFiles, files);
  }

  /** [语言学习] 获取原生语言（= UI 语言）。 */
  getNativeLanguage(): string {
    return this._currentLang;
  }

  /** [语言学习] 获取目标语言（单独存储）。 */
  getTargetLanguage(): string {
    if (typeof localStorage === 'undefined') return 'enUS';
    return localStorage.getItem('helloworld_target_language') || 'enUS';
  }
}

/**
 * 在 window 上安装向后兼容的全局变量（由 bundle 入口 index.ts 自动调用）：
 * - `window.i18n`         — Translation 实例
 * - `window.t(key,vars)`  — i18n.t() 快捷方式
 * - `window.GetDisplayLanguage()` — 返回当前语言代码
 */
export function installI18nGlobals(instance: Translation): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & {
    i18n?: Translation;
    t?: (key: string, ...args: unknown[]) => string;
    GetDisplayLanguage?: () => string;
  };
  w.i18n = instance;
  w.t = (key: string, ...args: unknown[]): string => instance.t(key, args[0] as TranslationVars | undefined);
  w.GetDisplayLanguage = (): string => instance.getLang();
}
