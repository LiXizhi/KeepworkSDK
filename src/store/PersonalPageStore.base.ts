/**
 * PersonalPageStore.base.ts — 基础层（构造/事件/缓存/WorkSpace/SearchPath/MountedFolder/路径工具）
 *
 * 包含：
 * - 构造函数与字段声明
 * - 事件总线（on / off / emit）
 * - reset / clearMemoryCache
 * - withConfig / withWorkspace（Proxy 作用域）
 * - _normalizeMountedFolder
 * - SearchPath（addSearchPath / removeSearchPath / _readFromSearchPath / _doReadFromSearchPath）
 * - getAbsUrl / _getMountedPagePath / _getMountedTreeParams
 * - _isAbsolutePath / _readAbsoluteFile / _readMountedFile / _listMountedDir / _fetchMountedTree
 * - sanitizePageName / getEffectivePageName / _stripSpuriousWorkspaceSegment
 * - _toInternalPageKey / _toCurrentWorkspaceRelative
 * - setUsername / getUsername
 * - checkInitSyncTimers / destroy
 * - ensureUserProfile
 */

import YMLParser from './YMLParser';
import SDKLogger from '../utils/SDKLogger';
import type {
  MountedFolder, SearchPath, PageSyncOptions, IPersonalPageSDK, TreeEntry,
} from './PersonalPageStore.types';

const console = SDKLogger.createModuleConsole('PersonalPageStore');

/**
 * PersonalPageStore 基础层。
 * 不直接实例化 — 由 PersonalPageStore.ts 主类继承并扩展。
 */
export class PersonalPageStoreBase {
  // ──────────────────── 静态 ────────────────────
  static debug = false;
  static _log(..._args: unknown[]): void {
    // 实际日志在运行时通过 debug 标志控制
  }

  // ──────────────────── 字段 ────────────────────
  sdk: IPersonalPageSDK;

  /** L1 内存缓存：pageKey → 页面数据对象 */
  personalPageData: Record<string, Record<string, unknown>> = {};
  /** 待写入（已修改未保存）的数据 */
  personalPageDataUpdated: Record<string, Record<string, unknown>> = {};
  /** 已标记删除的 key 列表 */
  personalPageDataDeleted: Record<string, string[]> = {};
  /** 各页面的状态标志（版本检查等） */
  pageStatus: Record<string, Record<string, unknown>> = {};
  /** 待磁盘写入的页面集合 */
  pendingDiskPages: Set<string> = new Set();
  /** 待远端同步的页面集合 */
  pendingSync: Set<string> = new Set();
  /** 各页面的同步选项 */
  pageSyncOptions: Record<string, PageSyncOptions> = {};
  isSyncing = false;
  _batchSavePromise: Promise<number> | null = null;
  _batchSyncPromise: Promise<number> | null = null;
  pageMutationVersion: Record<string, number> = {};
  userProfileLoaded = false;
  overrideUsername: string | null = null;
  workspace: string | null = null;
  mountedFolder: MountedFolder | null = null;
  _searchPaths: SearchPath[] = [];

  /** 远端同步间隔（ms），默认 5 秒 */
  remoteSyncInterval = 5000;
  remoteStorePath = 'edunotes/store';

  /** 事件监听器映射 */
  _eventListeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  /** 定时同步 timer */
  gitSyncTimer: ReturnType<typeof setInterval> | null = null;
  /** 防抖磁盘写入 timer */
  _diskSaveTimeout: ReturnType<typeof setTimeout> | null = null;

  // 搜索路径内部状态
  _searchPathNotFound?: Set<string>;
  _searchPathInflight?: Map<string, Promise<string | null>>;

  // 远端树缓存
  _remoteTreeCache: string[] | null = null;
  _remoteTreeCacheTime = 0;

  constructor(sdk: IPersonalPageSDK) {
    this.sdk = sdk;
  }

  // ──────────────────── 事件总线 ────────────────────

  /**
   * 注册事件监听器。
   * 已知事件：
   * - `'versionConflict'`：本地与远端版本冲突时触发，携带冲突详情
   *
   * @param event   - 事件名
   * @param handler - 回调函数
   */
  on(event: string, handler: (...args: unknown[]) => void): void {
    if (typeof handler !== 'function') return;
    (this._eventListeners[event] = this._eventListeners[event] ?? []).push(handler);
  }

  /**
   * 取消注册事件监听器。
   * @param event   - 事件名
   * @param handler - 要取消的回调
   */
  off(event: string, handler: (...args: unknown[]) => void): void {
    const list = this._eventListeners[event];
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /**
   * 触发事件，依次调用所有已注册监听器。
   * @param event - 事件名
   * @param args  - 传递给监听器的参数
   */
  emit(event: string, ...args: unknown[]): void {
    const list = this._eventListeners[event];
    if (!list?.length) return;
    for (const handler of list.slice()) {
      try {
        handler(...args);
      } catch (e) {
        console.warn(`PersonalPageStore: listener for '${event}' threw:`, e);
      }
    }
  }

  // ──────────────────── 状态重置 ────────────────────

  /**
   * 重置所有内存状态（数据/定时器/缓存），但不清除 IndexedDB 和远端数据。
   * 认证变更（setToken）后由 keepworkSDK 调用。
   */
  reset(): void {
    this.personalPageData = {};
    this.personalPageDataUpdated = {};
    this.personalPageDataDeleted = {};
    this.pageStatus = {};
    this.pendingDiskPages.clear();
    this.pendingSync.clear();
    this.pageSyncOptions = {};
    this.isSyncing = false;
    this._batchSavePromise = null;
    this._batchSyncPromise = null;
    this.pageMutationVersion = {};
    this.userProfileLoaded = false;
    this.overrideUsername = null;
    this.workspace = null;
    this.mountedFolder = null;
    this._searchPaths = [];
    this._searchPathInflight = undefined;
    this._remoteTreeCache = null;
    this._remoteTreeCacheTime = 0;

    if (this.gitSyncTimer) {
      clearInterval(this.gitSyncTimer);
      this.gitSyncTimer = null;
    }
    if (this._diskSaveTimeout) {
      clearTimeout(this._diskSaveTimeout);
      this._diskSaveTimeout = null;
    }
  }

  /**
   * 清除内存缓存（认证变更后由 keepworkSDK 调用）。
   * 等同于 reset()，不清除持久化层。
   */
  clearMemoryCache(): void {
    this.reset();
  }

  // ──────────────────── 作用域代理 ────────────────────

  /**
   * 从工具/会话 config 对象创建作用域 store 实例。
   * 自动解析 workspace 和 mountFolder，回退到当前值或 'workspace_default'。
   *
   * @param config - 包含可选 workspace / mountFolder 字段的配置对象
   * @returns 作用域 store 代理
   */
  withConfig(config: Record<string, unknown> = {}): this {
    let resolvedWorkspace: string | null;
    if (config['workspace'] !== undefined) {
      resolvedWorkspace = (config['workspace'] as string) || null;
    } else if (this.workspace) {
      resolvedWorkspace = this.workspace;
    } else {
      resolvedWorkspace = 'workspace_default';
    }

    let resolvedMountedFolder = this.mountedFolder;
    if (config['mountFolder']) {
      const normalized = this._normalizeMountedFolder(config['mountFolder']);
      if (normalized) resolvedMountedFolder = normalized;
    }

    return this.withWorkspace(resolvedWorkspace, resolvedMountedFolder);
  }

  /**
   * 创建覆盖了 workspace 和/或 mountedFolder 的轻量代理实例。
   * 代理的所有方法调用使用指定的作用域，不会修改共享 store —
   * 对并发异步操作安全。
   * 共享可变状态（Promise/定时器/缓存/同步标志/数据 map）会写穿到父 store，
   * 保持所有代理状态一致。
   *
   * @param workspace     - 工作空间名称覆盖（null 表示无工作空间）
   * @param mountedFolder - 挂载文件夹覆盖
   */
  withWorkspace(workspace: string | null, mountedFolder?: MountedFolder | null): this {
    const parent = this;
    const localOverrides = new Map<string, unknown>();
    localOverrides.set('workspace', workspace ?? null);
    if (mountedFolder !== undefined) {
      localOverrides.set('mountedFolder', this._normalizeMountedFolder(mountedFolder));
    }

    return new Proxy(parent, {
      get(target, prop: string | symbol, receiver: unknown) {
        if (typeof prop === 'string' && localOverrides.has(prop)) {
          return localOverrides.get(prop);
        }
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop: string | symbol, value: unknown) {
        if (typeof prop === 'string' && localOverrides.has(prop)) {
          localOverrides.set(prop, value);
          return true;
        }
        // 写穿到父 store
        (target as Record<string, unknown>)[prop as string] = value;
        return true;
      },
    }) as this;
  }

  // ──────────────────── MountedFolder ────────────────────

  /**
   * 将 mountedFolder 输入（路径字符串或对象）规范化为标准对象格式。
   * 路径字符串格式：`"username/remoteStorePath.../workspace"`（至少 2 段）
   * 返回 null 表示无效输入，undefined 表示未传入。
   *
   * @param mountedFolder - 路径字符串、MountedFolder 对象或 null
   */
  _normalizeMountedFolder(mountedFolder: unknown): MountedFolder | null | undefined {
    if (mountedFolder === undefined) return undefined;
    if (mountedFolder === null || mountedFolder === '') return null;

    if (typeof mountedFolder === 'string') {
      const parts = mountedFolder.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
      if (parts.length < 2) {
        console.warn('PersonalPageStore: mountedFolder path requires at least username/workspace');
        return null;
      }
      const username = parts[0]!;
      const workspace = parts[parts.length - 1]!;
      const remoteStorePath =
        parts.length > 2 ? parts.slice(1, -1).join('/') : this.remoteStorePath;
      return { username, workspace, remoteStorePath };
    }

    if (typeof mountedFolder === 'object' && mountedFolder !== null) {
      const m = mountedFolder as Record<string, unknown>;
      if (!m['username'] || !m['workspace']) {
        console.warn('PersonalPageStore: mountedFolder object requires username and workspace');
        return null;
      }
      return {
        username: m['username'] as string,
        workspace: m['workspace'] as string,
        remoteStorePath: (m['remoteStorePath'] as string | undefined) ?? this.remoteStorePath,
      };
    }

    console.warn('PersonalPageStore: mountedFolder must be a path string, object, or null');
    return null;
  }

  // ──────────────────── SearchPath ────────────────────

  /**
   * 注册 URL 搜索路径，作为 readFile 的 URL 回退。
   * 当本地和 mountedFolder 均找不到文件时，按前缀匹配 baseUrl 拼接路径并 fetch。
   *
   * @param prefix    - 路径前缀（含 workspace，如 "myws/skills"）
   * @param baseUrl   - 基础 URL（末尾应含 /）
   * @param options   - isReadonly（默认 true）：只读路径在 readFile 中优先级最高
   */
  addSearchPath(prefix: string, baseUrl: string, options: { isReadonly?: boolean } = {}): void {
    const { isReadonly = true } = options;
    const normalizedPrefix = prefix.replace(/\/+$/, '');
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const existing = this._searchPaths.find((sp) => sp.prefix === normalizedPrefix);
    if (existing) {
      existing.baseUrl = normalizedBaseUrl;
      existing.isReadonly = isReadonly;
      console.log(`[PersonalPageStore] Updated search path: ${normalizedPrefix} -> ${normalizedBaseUrl} (readonly=${isReadonly})`);
    } else {
      this._searchPaths.push({ prefix: normalizedPrefix, baseUrl: normalizedBaseUrl, isReadonly });
      console.log(`[PersonalPageStore] Added search path: ${normalizedPrefix} -> ${normalizedBaseUrl} (readonly=${isReadonly})`);
    }
  }

  /**
   * 移除已注册的搜索路径。
   * @param prefix - 要移除的路径前缀
   */
  removeSearchPath(prefix: string): void {
    const normalizedPrefix = prefix.replace(/\/+$/, '');
    this._searchPaths = this._searchPaths.filter((sp) => sp.prefix !== normalizedPrefix);
  }

  /**
   * 从已注册搜索路径中读取文件（URL 回退）。
   * 命中内存缓存时直接返回；否则发起 fetch 并将结果缓存到内存。
   * 使用 inflight Map 合并并发重复请求。
   *
   * @param pageName     - 相对于 workspace 的页面名（不含 workspace 前缀）
   * @param readonlyOnly - true=仅搜索只读路径；false=仅搜索非只读路径；undefined=全部
   */
  async _readFromSearchPath(pageName: string, readonlyOnly?: boolean): Promise<string | null> {
    if (!this._searchPaths.length) return null;
    if (!this._searchPathNotFound) this._searchPathNotFound = new Set();
    if (!this._searchPathInflight) this._searchPathInflight = new Map();
    const effectiveName = this.getEffectivePageName(pageName);

    if (this._searchPathNotFound.has(effectiveName)) return null;

    const pageKey = this._toInternalPageKey(pageName);
    const cached = this.getValueByPath(this.personalPageData[pageKey] ?? {}, 'content');
    if (cached !== null && cached !== undefined && this.isValidValue(cached)) return String(cached);

    const inflightKey = effectiveName;
    const existing = this._searchPathInflight.get(inflightKey);
    if (existing) return existing;

    const promise = this._doReadFromSearchPath(pageName, effectiveName, readonlyOnly);
    this._searchPathInflight.set(inflightKey, promise);
    try {
      return await promise;
    } finally {
      this._searchPathInflight.delete(inflightKey);
    }
  }

  /** @private 实际 fetch 逻辑（_readFromSearchPath 去重后调用一次）。 */
  private async _doReadFromSearchPath(pageName: string, effectiveName: string, readonlyOnly?: boolean): Promise<string | null> {
    for (const { prefix, baseUrl, isReadonly } of this._searchPaths) {
      if (readonlyOnly === true && !isReadonly) continue;
      if (readonlyOnly === false && isReadonly) continue;
      if (!effectiveName.startsWith(prefix + '/') && effectiveName !== prefix) continue;
      const remaining = effectiveName.substring(prefix.length).replace(/^\//, '');
      const fileName = remaining || pageName;
      const hasExtension = fileName.includes('.') && fileName.lastIndexOf('.') > fileName.lastIndexOf('/');
      const fileUrl = baseUrl + fileName + (hasExtension ? '' : '.md');
      try {
        const resp = await fetch(fileUrl);
        if (!resp.ok) continue;
        const text = await resp.text();
        if (text != null) {
          console.log(`[PersonalPageStore] SearchPath found: ${effectiveName} -> ${fileUrl}`);
          const pageKey = this._toInternalPageKey(pageName);
          this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
          this.setValueByPath(this.personalPageData[pageKey]!, 'content', text);
          return text;
        }
      } catch { /* 忽略单个搜索路径失败，继续尝试下一个 */ }
    }
    console.log(`[PersonalPageStore] SearchPath not found: ${effectiveName}`);
    this._searchPathNotFound!.add(effectiveName);
    return null;
  }

  // ──────────────────── URL / 路径工具 ────────────────────

  /**
   * 获取文件的绝对 URL。
   * 优先匹配注册的搜索路径；回退到 Keepwork raw API URL。
   *
   * @param filename - 文件名（相对于 workspace，不含 .md）
   */
  getAbsUrl(filename: string): string {
    const effectiveName = this.getEffectivePageName(filename);
    for (const { prefix, baseUrl } of this._searchPaths) {
      if (!effectiveName.startsWith(prefix + '/') && effectiveName !== prefix) continue;
      const remaining = effectiveName.substring(prefix.length).replace(/^\//, '');
      const fileName = remaining || filename;
      const hasExtension = fileName.includes('.') && fileName.lastIndexOf('.') > fileName.lastIndexOf('/');
      return baseUrl + fileName + (hasExtension ? '' : '.md');
    }
    const username = this.getUsername();
    if (!username) return effectiveName + (effectiveName.endsWith('.md') ? '' : '.md');
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.sdk.extractMainDomain?.(hostname) ?? 'keepwork.com';
    const remotePath = this.getRemotePagePath(filename);
    return `https://${domain}/api/raw/${remotePath}`;
  }

  /**
   * 构建 mountedFolder 中文件的远端路径。
   * 格式：`username/remoteStorePath/workspace/pageName`
   */
  _getMountedPagePath(pageName: string): string {
    const m = this.mountedFolder!;
    return `${m.username}/${m.remoteStorePath}/${m.workspace}/${pageName}`;
  }

  /**
   * 获取 mountedFolder 的远端树参数。
   * @returns `{ sitePath, remotePrefix, folderBase }`
   */
  _getMountedTreeParams(): { sitePath: string; remotePrefix: string; folderBase: string } {
    const m = this.mountedFolder!;
    const storePathParts = m.remoteStorePath.split('/');
    const siteName = storePathParts[0]!;
    const storeSubPath = storePathParts.slice(1).join('/');
    const sitePath = `${m.username}/${siteName}`;
    const folderBase = storeSubPath ? `${storeSubPath}/${m.workspace}` : m.workspace;
    return { sitePath, remotePrefix: folderBase + '/', folderBase };
  }

  /**
   * 检查路径是否为绝对路径（以 `//` 开头）。
   * 绝对路径格式：`//username/sitename/relative_path`
   */
  _isAbsolutePath(pageName: string): boolean {
    return typeof pageName === 'string' && pageName.startsWith('//');
  }

  /**
   * 通过绝对路径（//username/sitename/...）读取文件内容。
   * 结果缓存到内存中，后续调用直接返回缓存。
   *
   * @param absolutePath - `//` 开头的路径
   * @param bUseCache    - 是否使用 API 缓存（默认 true）
   */
  async _readAbsoluteFile(absolutePath: string, bUseCache = true): Promise<string | null> {
    const cached = this.getValueByPath(this.personalPageData[absolutePath] ?? {}, 'content');
    if (cached !== null && cached !== undefined && this.isValidValue(cached)) return String(cached);
    try {
      const fullPath = absolutePath.slice(2);
      const raw = await this.sdk.getMarkdownByFullPath?.(fullPath, null, bUseCache);
      if (raw === null || raw === undefined) return null;
      const data = YMLParser.yamlToObject(raw, true) as Record<string, unknown>;
      const content =
        data && typeof data === 'object' && data['content'] !== undefined
          ? String(data['content'])
          : String(raw);
      this.personalPageData[absolutePath] = this.personalPageData[absolutePath] ?? {};
      this.setValueByPath(this.personalPageData[absolutePath]!, 'content', content);
      return content;
    } catch { return null; }
  }

  /**
   * 从 mountedFolder（只读）读取文件内容。
   * @param pageName  - 相对于 workspace 的页面名
   * @param bUseCache - 是否使用 API 缓存（默认 true）
   */
  async _readMountedFile(pageName: string, bUseCache = true): Promise<string | null> {
    if (!this.mountedFolder) return null;
    const relativePageName = this.sanitizePageName(pageName);
    const pageKey = this._toInternalPageKey(relativePageName);
    const cached = this.getValueByPath(this.personalPageData[pageKey] ?? {}, 'content');
    if (cached !== null && cached !== undefined && this.isValidValue(cached)) return String(cached);
    try {
      const remotePath = this._getMountedPagePath(relativePageName);
      const raw = await this.sdk.getMarkdownByFullPath?.(remotePath, null, bUseCache);
      if (raw === null || raw === undefined) return null;
      const data = YMLParser.yamlToObject(raw, true) as Record<string, unknown>;
      const content =
        data && typeof data === 'object' && data['content'] !== undefined
          ? String(data['content'])
          : String(raw);
      this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
      this.setValueByPath(this.personalPageData[pageKey]!, 'content', content);
      return content;
    } catch { return null; }
  }

  /**
   * 列出 mountedFolder（只读）中的目录内容。
   * @returns 子项名称集合（目录以 `/` 结尾）
   */
  async _listMountedDir(
    dirPath: string,
    isRoot: boolean,
    _normalizedDir: string,
    recursive = false
  ): Promise<Set<string>> {
    const children = new Set<string>();
    if (!this.mountedFolder) return children;
    try {
      const { sitePath, folderBase } = this._getMountedTreeParams();
      const remoteFolderPath = isRoot ? folderBase : `${folderBase}/${dirPath.replace(/\/$/, '')}`;
      if (recursive) {
        const treeData = await this.sdk.getSiteTree?.(sitePath, true, remoteFolderPath, true) ?? [];
        const collectEntries = (items: TreeEntry[], parentPath: string): void => {
          if (!Array.isArray(items)) return;
          for (const entry of items) {
            const entryPath = parentPath ? `${parentPath}/${entry.name}` : (entry.name ?? '');
            if (entry.isTree) {
              if (entry.children?.length) collectEntries(entry.children, entryPath);
            } else {
              let name = entryPath;
              if (!name.endsWith('.md')) name += '.md';
              if (name) children.add(name);
            }
          }
        };
        collectEntries(treeData, '');
      } else {
        const treeData = await this.sdk.getSiteTree?.(sitePath, false, remoteFolderPath, true) ?? [];
        if (Array.isArray(treeData)) {
          for (const entry of treeData) {
            let name = entry.name ?? '';
            const isFolder = entry.isTree === true;
            if (isFolder) { if (name) children.add(name + '/'); }
            else { if (!name.endsWith('.md')) name += '.md'; if (name) children.add(name); }
          }
        }
      }
    } catch { /* 静默失败 — mounted folder 是 best-effort */ }
    return children;
  }

  /**
   * 获取 mountedFolder 的完整远端文件树（非递归，内部调用 sdk.getSiteTree）。
   * @returns 页面名数组（相对于 mounted workspace，不含 .md）
   */
  async _fetchMountedTree(): Promise<string[]> {
    if (!this.mountedFolder) return [];
    try {
      const { sitePath, folderBase } = this._getMountedTreeParams();
      const treeData = await this.sdk.getSiteTree?.(sitePath, true, folderBase, true) ?? [];
      const entries: string[] = [];
      const collectEntries = (items: TreeEntry[], parentPath: string): void => {
        if (!Array.isArray(items)) return;
        for (const entry of items) {
          const entryPath = parentPath ? `${parentPath}/${entry.name}` : (entry.path ?? entry.name ?? '');
          if (entry.isBlob ?? !entry.isTree) {
            let pageName = entryPath;
            if (pageName.endsWith('.md')) pageName = pageName.slice(0, -3);
            if (pageName) entries.push(pageName);
          }
          if (entry.children?.length) collectEntries(entry.children, entryPath);
        }
      };
      collectEntries(treeData, '');
      return entries;
    } catch { return []; }
  }

  // ──────────────────── 页面名规范化 ────────────────────

  /**
   * 规范化页面名：移除前导 `./` / `/`、workspace 前缀和 `.md` 扩展名。
   * 绝对路径（`//...`）不做任何处理。
   *
   * @param pageName - 原始页面名
   */
  sanitizePageName(pageName: string): string {
    if (!pageName) return pageName;
    if (this._isAbsolutePath(pageName)) return pageName;
    let name = pageName;
    while (name.startsWith('./')) name = name.substring(2);
    while (name.startsWith('/')) name = name.substring(1);
    if (this.workspace && name.startsWith(this.workspace + '/')) {
      name = name.substring(this.workspace.length + 1);
    }
    if (name.endsWith('.md')) name = name.slice(0, -3);
    return name;
  }

  /**
   * 获取含 workspace 前缀的有效页面名（用于 IndexedDB / 远端路径）。
   *
   * @param pageName - 相对页面名
   */
  getEffectivePageName(pageName: string): string {
    if (
      this.workspace &&
      typeof pageName === 'string' &&
      pageName.startsWith(this.workspace + '/') &&
      !this._isAbsolutePath(pageName)
    ) {
      const result = pageName.endsWith('.md') ? pageName.slice(0, -3) : pageName;
      return this._stripSpuriousWorkspaceSegment(result);
    }
    pageName = this.sanitizePageName(pageName);
    if (this.workspace) {
      return this._stripSpuriousWorkspaceSegment(`${this.workspace}/${pageName}`);
    }
    return pageName;
  }

  /**
   * 去除 LLM 工具调用有时注入的多余 "workspace/" 路径段。
   * 如 "silvermind/workspace/memory/x" → "silvermind/memory/x"
   * @private
   */
  _stripSpuriousWorkspaceSegment(name: string): string {
    if (!this.workspace || !name || typeof name !== 'string') return name;
    const wsPrefix = this.workspace + '/workspace/';
    if (name.startsWith(wsPrefix)) return this.workspace + '/' + name.substring(wsPrefix.length);
    if (name.startsWith('workspace/') && this.workspace !== 'workspace') {
      return name.substring('workspace/'.length);
    }
    return name;
  }

  /**
   * 将页面名转换为规范的内部存储 key。
   * 非绝对路径始终以 `workspace/pageName` 形式存储。
   */
  _toInternalPageKey(pageName: string): string {
    if (!pageName) return pageName;
    if (this._isAbsolutePath(pageName)) return pageName;
    const name = this.sanitizePageName(pageName);
    return this.workspace ? `${this.workspace}/${name}` : name;
  }

  /**
   * 将内部 key 转换为当前 workspace 的相对名称。
   * 若 key 属于其他 workspace，返回 null。
   */
  _toCurrentWorkspaceRelative(pageKey: string): string | null {
    if (!pageKey || this._isAbsolutePath(pageKey)) return null;
    if (!this.workspace) return pageKey;
    const wsPrefix = this.workspace + '/';
    if (!pageKey.startsWith(wsPrefix)) return null;
    return pageKey.substring(wsPrefix.length);
  }

  // ──────────────────── 用户名管理 ────────────────────

  /**
   * 设置 override 用户名（用于访问其他用户的页面数据）。
   * 用户名变更时自动重置所有缓存。
   * 传入 null 或 '' 表示使用当前登录用户。
   *
   * @param username - 要覆盖的用户名，或 null/'' 恢复当前用户
   */
  setUsername(username: string | null): void {
    const newUsername = username || null;
    if (this.overrideUsername !== newUsername) this.reset();
    this.overrideUsername = newUsername;
    console.log(`PersonalPageStore: Override username set to: ${this.overrideUsername ?? 'current user'}`);
  }

  /**
   * 获取当前使用的用户名（override 或当前登录用户）。
   * @returns 用户名字符串，未登录时返回 null
   */
  getUsername(): string | null {
    if (this.overrideUsername) return this.overrideUsername;
    return (this.sdk.user?.username as string | undefined) ?? null;
  }

  // ──────────────────── 定时器 ────────────────────

  /**
   * 初始化远端同步定时器（若尚未初始化）。
   * 由 savePageData 在有数据变更时自动调用。
   */
  checkInitSyncTimers(): void {
    if (!this.gitSyncTimer) {
      this.gitSyncTimer = setInterval(() => {
        (this as unknown as { batchSyncToRemote: (f: boolean) => Promise<number> })
          .batchSyncToRemote(false);
      }, this.remoteSyncInterval);
    }
  }

  /**
   * 销毁 store，清除所有定时器（页面卸载时调用）。
   */
  destroy(): void {
    if (this.gitSyncTimer) { clearInterval(this.gitSyncTimer); this.gitSyncTimer = null; }
    if (this._diskSaveTimeout) { clearTimeout(this._diskSaveTimeout); this._diskSaveTimeout = null; }
  }

  // ──────────────────── 用户档案 ────────────────────

  /**
   * 确保用户档案已加载（若已有 token）。
   * 无 token 时允许匿名模式正常运行，不阻塞操作。
   */
  async ensureUserProfile(): Promise<void> {
    if (this.userProfileLoaded) return;
    try {
      if (!this.sdk.token) {
        console.log('personalPageStore: No token set, using anonymous mode');
        return;
      }
      await this.sdk.getUserProfile?.({ useCache: true });
    } catch { /* 允许失败 */ }
    this.userProfileLoaded = true;
  }

  // ──────────────────── 占位（由子类实现）────────────────────
  // 以下方法在 data/sync 层实现，这里仅声明供 base 层内部调用

  /** @internal 由 data 层实现 */
  getValueByPath(_obj: Record<string, unknown> | null | undefined, _path: string): unknown { return null; }
  /** @internal 由 data 层实现 */
  setValueByPath(_obj: Record<string, unknown>, _path: string, _value: unknown): boolean { return false; }
  /** @internal 由 data 层实现 */
  isValidValue(_value: unknown): boolean { return false; }
  /** @internal 由 sync 层实现 */
  getRemotePagePath(_pageName: string): string { return ''; }
  /** @internal 由 sync 层实现 */
  getLocalPagePath(_pageName: string): string { return ''; }
}
