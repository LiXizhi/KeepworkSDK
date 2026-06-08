/**
 * PersonalPageStore.sync.ts — 同步层（磁盘读写 + 远端同步 + 文件操作 API）
 *
 * 包含：
 * - clearLocalDisk / clearRemotePage / clearPageData
 * - listPages
 * - _getRemoteTreeParams / _fetchRemoteTree
 * - checkLoadData / checkLoadPageFromDisk
 * - saveToDisk / syncToGit / batchSaveToDisk / batchSyncToGit / batchSyncToRemote
 * - debouncedDiskSave
 * - 文件操作 API：readFile / replaceStringInFile / grepSearch / createFile / listDir
 * - 辅助：_isFileOpScoped / _globToRegex
 */

import YMLParser from './YMLParser';
import { StorageUtil } from './LocalStorageUtil';
import type { ListDirOptions, TreeEntry } from './PersonalPageStore.types';
import { PersonalPageStoreData } from './PersonalPageStore.data';

export class PersonalPageStoreSync extends PersonalPageStoreData {

  // ──────────────────── 清除操作 ────────────────────

  /**
   * 清除指定页面的本地磁盘（IndexedDB）数据和内存缓存。
   * 同时清理 `.md` 扩展名变体，兼容旧版存储格式。
   *
   * @param pageName - 页面名
   * @returns 是否成功清除至少一条记录
   */
  async clearLocalDisk(pageName: string): Promise<boolean> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    try {
      if (!pageKey) return false;
      const username = this.getUsername() ?? 'anonymous';
      const keyPrefix = `personal_page_${username}_`;
      const pageCandidates = new Set([pageKey]);
      if (!this._isAbsolutePath(pageKey)) {
        if (pageKey.endsWith('.md')) pageCandidates.add(pageKey.slice(0, -3));
        else pageCandidates.add(`${pageKey}.md`);
      }
      const storageCandidates = new Set(Array.from(pageCandidates).map((n) => `${keyPrefix}${n}`));
      let removedCount = 0;
      try {
        const allKeys = await StorageUtil.getAllKeys();
        for (const key of allKeys) {
          if (typeof key === 'string' && storageCandidates.has(key)) {
            StorageUtil.removeItem(key);
            removedCount++;
          }
        }
      } catch {
        for (const key of storageCandidates) { StorageUtil.removeItem(key); removedCount++; }
      }
      for (const candidate of pageCandidates) {
        if (this.personalPageData[candidate]) delete this.personalPageData[candidate];
        if (this.personalPageDataUpdated[candidate]) delete this.personalPageDataUpdated[candidate];
        if (this.personalPageDataDeleted[candidate]) delete this.personalPageDataDeleted[candidate];
        if (this.pageStatus[candidate]) delete this.pageStatus[candidate];
        if (this.pageMutationVersion[candidate]) delete this.pageMutationVersion[candidate];
        this.pendingDiskPages.delete(candidate);
        this.pendingSync.delete(candidate);
        if (this.pageSyncOptions[candidate]) delete this.pageSyncOptions[candidate];
      }
      if (removedCount > 0) {
        console.info(`Successfully cleared local disk data for page: ${pageKey} (${removedCount} key(s))`);
        return true;
      }
      console.warn(`No matching local storage key found for page: ${pageKey}`);
      return false;
    } catch (error) {
      console.warn(`Error clearing local disk for page ${pageKey}:`, error);
      return false;
    }
  }

  /**
   * 删除远端页面文件（调用 sdk.deleteMarkdownByFullPath）。
   * 本地模式下跳过远端操作，直接返回 true。
   *
   * @param pageName - 页面名
   */
  async clearRemotePage(pageName: string): Promise<boolean> {
    try {
      const pageKey = this._toInternalPageKey(pageName) || pageName;
      if (this.isUseLocal()) return true;
      const remotePath = this.getRemotePagePath(pageKey);
      if (!remotePath) return false;
      await this.sdk.deleteMarkdownByFullPath?.(remotePath);
      this.pendingSync.delete(pageKey);
      console.info(`Successfully cleared remote page: ${pageKey}`);
      return true;
    } catch (error) {
      console.warn(`Error clearing remote page ${pageName}:`, error);
      return false;
    }
  }

  /**
   * 同时清除本地磁盘和远端页面。
   * @param pageName - 页面名
   */
  async clearPageData(pageName: string): Promise<void> {
    await this.clearLocalDisk(pageName);
    await this.clearRemotePage(pageName);
  }

  // ──────────────────── 页面列表 ────────────────────

  /**
   * 列出所有已知页面名（内存 + IndexedDB + 远端 API）。
   * 委托给 `listDir('.', true)` 并去除 `.md` 扩展名。
   */
  async listPages(): Promise<string[]> {
    const listing = await this.listDir('.', true);
    if (!listing || typeof listing !== 'string') return [];
    return listing.split('\n').filter(Boolean).map((n) => n.endsWith('.md') ? n.slice(0, -3) : n);
  }

  // ──────────────────── 远端树参数 ────────────────────

  /**
   * 获取当前 workspace 在远端的站点路径和目录参数。
   * @returns `{ sitePath, remotePrefix, folderBase }`
   */
  _getRemoteTreeParams(): { sitePath: string; remotePrefix: string; folderBase: string } {
    const remoteUsername = this.overrideUsername ?? this.getUsername();
    const storePathParts = this.remoteStorePath.split('/');
    const siteName = storePathParts[0]!;
    const storeSubPath = storePathParts.slice(1).join('/');
    const sitePath = `${remoteUsername}/${siteName}`;
    const folderBase = this.workspace
      ? (storeSubPath ? `${storeSubPath}/${this.workspace}` : this.workspace)
      : (storeSubPath || '');
    return { sitePath, remotePrefix: folderBase + '/', folderBase };
  }

  /**
   * 获取当前 workspace 的完整远端文件树（30 秒内存缓存）。
   * @returns 页面名数组（相对于 workspace，不含 .md）
   */
  async _fetchRemoteTree(): Promise<string[]> {
    const now = Date.now();
    if (this._remoteTreeCache && this._remoteTreeCacheTime && (now - this._remoteTreeCacheTime < 30_000)) {
      return this._remoteTreeCache;
    }
    const { sitePath, folderBase } = this._getRemoteTreeParams();
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
    this._remoteTreeCache = entries;
    this._remoteTreeCacheTime = now;
    return entries;
  }

  // ──────────────────── 磁盘加载 ────────────────────

  /**
   * 从 IndexedDB 加载页面数据（懒加载，已加载则跳过）。
   * 同步迁移 localStorage 旧版数据到 IndexedDB。
   *
   * @param pageName    - 页面名
   * @param forceRefresh - 强制重新从磁盘读取
   */
  async checkLoadPageFromDisk(pageName: string, forceRefresh?: boolean): Promise<void> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    await this.ensureUserProfile();
    this.pageStatus[pageKey] = this.pageStatus[pageKey] ?? {};
    const localVersionChecked = this.pageStatus[pageKey]!['_localVersionChecked'];
    if (!localVersionChecked || forceRefresh) {
      this.pageStatus[pageKey]!['_localVersionChecked'] = true;
      this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
      try {
        const localPath = this.getLocalPagePath(pageKey);
        const content = await StorageUtil.getItemAsync<string>(localPath);
        if (content) {
          const pageData = YMLParser.yamlToObject(content, true) as Record<string, unknown>;
          if (pageData) {
            this.mergeData(this.personalPageData[pageKey]!, pageData);
            const meta = this.getMetadata(pageData);
            console.info(`load page data ${pageKey} version: ${meta?.version} from disk`);
          }
        }
      } catch (error) {
        console.warn('Failed to load from disk:', error);
      }
    }
  }

  // ──────────────────── 磁盘写入 ────────────────────

  /**
   * 将内存中的最新数据序列化并写入 IndexedDB（同步调用，立即返回）。
   *
   * 流程：
   * 1. 合并 personalPageDataUpdated 到 personalPageData
   * 2. 处理 personalPageDataDeleted 中的删除 key
   * 3. 更新版本元数据
   * 4. 序列化为 YAML 并调用 StorageUtil.setItem
   *
   * @param pageName  - 页面名
   * @param forceSave - 即使无更新也强制保存（用于版本冲突解决）
   */
  async saveToDisk(pageName: string, forceSave?: boolean): Promise<boolean> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    await this.ensureUserProfile();
    const localPath = this.getLocalPagePath(pageKey);
    if (!localPath) return false;
    const hasUpdate = !!(this.personalPageDataUpdated[pageKey] &&
      Object.keys(this.personalPageDataUpdated[pageKey]!).length > 0);
    const hasDeleted = !!(this.personalPageDataDeleted[pageKey] &&
      this.personalPageDataDeleted[pageKey]!.length > 0);
    const mutationVersion = this._getPageMutationVersion(pageKey);
    if (!forceSave && !hasUpdate && !hasDeleted) return false;
    try {
      this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
      const mergedData = this.personalPageData[pageKey]!;
      if (hasUpdate) this.mergeData(mergedData, this.personalPageDataUpdated[pageKey] ?? {});
      if (hasDeleted) {
        for (const key of this.personalPageDataDeleted[pageKey] ?? []) {
          PersonalPageStoreSync._log(`personalPageStore: Processing deleted key: ${key}`);
          this.deleteValueByPath(mergedData, key);
        }
      }
      const currentMeta = this.getMetadata(mergedData);
      const newMeta = (hasUpdate || hasDeleted || !currentMeta?.version)
        ? this.generateVersion(mergedData)
        : currentMeta;
      this.setMetadata(mergedData, newMeta);
      const yamlContent = YMLParser.objectToYaml(mergedData as Parameters<typeof YMLParser.objectToYaml>[0], true, true);
      StorageUtil.setItem(localPath, yamlContent);
      const savedMeta = this.getMetadata(mergedData);
      console.info(`page ${pageKey} data saved to disk with version ${savedMeta?.version}`);
      if (this.isUseLocal() && mutationVersion === this._getPageMutationVersion(pageKey)) {
        this.personalPageDataUpdated[pageKey] = {};
        this.personalPageDataDeleted[pageKey] = [];
      }
      return true;
    } catch (error) {
      console.warn(`Failed to save ${pageKey} to disk:`, error);
      return false;
    }
  }

  // ──────────────────── 远端同步 ────────────────────

  /**
   * 将页面数据同步到远端 Git（editMarkdownByFullPath）。
   *
   * 同步前先合并最新远端版本（防止覆盖他人更改）。
   * 同步成功后清除 pending 状态。
   *
   * @param pageName  - 页面名
   * @param bUseCache - 是否使用 API 缓存
   */
  async syncToGit(pageName: string, bUseCache?: boolean): Promise<boolean> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    if (this.isUseLocal()) return true;
    await this.checkMergeRemoteData(pageKey, !bUseCache, bUseCache);
    const hasUpdate = !!(this.personalPageDataUpdated[pageKey] &&
      Object.keys(this.personalPageDataUpdated[pageKey]!).length > 0);
    const hasDeleted = !!(this.personalPageDataDeleted[pageKey] &&
      this.personalPageDataDeleted[pageKey]!.length > 0);
    const mutationVersion = this._getPageMutationVersion(pageKey);
    if (!hasUpdate && !hasDeleted) { this.pendingSync.delete(pageKey); return true; }
    try {
      const remotePath = this.getRemotePagePath(pageKey);
      this.mergeData(this.personalPageData[pageKey] ?? {}, this.personalPageDataUpdated[pageKey] ?? {});
      if (hasDeleted) {
        for (const key of this.personalPageDataDeleted[pageKey] ?? []) {
          PersonalPageStoreSync._log(`personalPageStore: Processing deleted key for remote sync: ${key}`);
          this.deleteValueByPath(this.personalPageData[pageKey]!, key);
        }
      }
      const yamlContent = YMLParser.objectToYaml(this.personalPageData[pageKey] as Parameters<typeof YMLParser.objectToYaml>[0], true, true);
      const isCandybox = pageKey === 'game_activity_candybox' || pageKey.endsWith('/game_activity_candybox');
      const useCache = bUseCache !== undefined ? bUseCache : isCandybox;
      await this.sdk.editMarkdownByFullPath?.(remotePath, yamlContent, undefined, useCache);
      if (mutationVersion === this._getPageMutationVersion(pageKey)) {
        this.personalPageDataUpdated[pageKey] = {};
        this.personalPageDataDeleted[pageKey] = [];
        this.pendingSync.delete(pageKey);
        if (this.pageSyncOptions[pageKey]) delete this.pageSyncOptions[pageKey];
      }
      console.info(`successfully sync ${pageKey} version ${(this.personalPageData[pageKey]?.['_metadata'] as Record<string, unknown> | undefined)?.['version']} to Git:`);
      return true;
    } catch (error) {
      console.warn(`Failed to sync ${pageKey} to Git:`, error);
      this.pendingSync.delete(pageKey);
      return false;
    }
  }

  /**
   * 防抖磁盘写入（500ms 后执行 batchSaveToDisk）。
   * 写入完成后若还有待保存页面则继续递归调度。
   */
  debouncedDiskSave(): void {
    if (!this._diskSaveTimeout) {
      this._diskSaveTimeout = setTimeout(async () => {
        try {
          await this.batchSaveToDisk();
        } catch (error) {
          console.warn('Debounced disk save error:', error);
        } finally {
          this._diskSaveTimeout = null;
          if (this.pendingDiskPages.size > 0) this.debouncedDiskSave();
        }
      }, 500);
    }
  }

  /**
   * 批量写入所有 pendingDiskPages 到 IndexedDB。
   * 调用方若已在进行中，直接复用同一 Promise（合并并发）。
   *
   * @returns 成功保存的页面数
   */
  async batchSaveToDisk(): Promise<number> {
    if (this._batchSavePromise) return this._batchSavePromise;
    this._batchSavePromise = (async () => {
      let pageCount = 0;
      try {
        while (this.pendingDiskPages.size > 0) {
          const batchPages = Array.from(this.pendingDiskPages);
          this.pendingDiskPages.clear();
          for (const pageName of batchPages) {
            try {
              if (await this.saveToDisk(pageName)) pageCount++;
            } catch (error) {
              console.warn(`Failed to save page ${pageName} to disk:`, error);
            }
          }
        }
        return pageCount;
      } catch (error) {
        console.warn('Batch save to disk error:', error);
        return pageCount;
      } finally {
        this._batchSavePromise = null;
      }
    })();
    return this._batchSavePromise;
  }

  /**
   * 批量同步所有 pendingSync 到远端（每批并发执行，循环直到队列清空）。
   * 调用方若已在进行中，直接复用同一 Promise。
   *
   * @param forceSync - 强制同步（当前未使用，预留参数）
   * @returns 成功同步的页面数
   */
  async batchSyncToGit(forceSync = false): Promise<number> {
    if (this._batchSyncPromise) return this._batchSyncPromise;
    this._batchSyncPromise = (async () => {
      void forceSync;
      this.isSyncing = true;
      let syncCount = 0;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          await this.batchSaveToDisk();
          if (this.pendingSync.size === 0) return syncCount;
          const batchPages = Array.from(this.pendingSync);
          this.pendingSync.clear();
          const syncPromises = batchPages.map((pageName) => {
            const options = this.pageSyncOptions[pageName] ?? {};
            return this.syncToGit(pageName, options.useCache).then((success) => {
              if (success) syncCount++;
            });
          });
          await Promise.all(syncPromises);
        }
      } finally {
        this.isSyncing = false;
        this._batchSyncPromise = null;
      }
    })();
    return this._batchSyncPromise;
  }

  /**
   * batchSyncToGit 的别名（兼容旧调用约定）。
   */
  async batchSyncToRemote(forceSync = false): Promise<number> {
    return this.batchSyncToGit(forceSync);
  }

  // ──────────────────── 文件操作 API ────────────────────

  /**
   * 校验文件操作是否在 workspace 作用域内（未设置 workspace 时拒绝执行）。
   * @private
   */
  _isFileOpScoped(callerName: string): boolean {
    if (!this.workspace) {
      console.warn(
        `PersonalPageStore: File operation '${callerName}' rejected - no workspace set. ` +
        `Use withWorkspace() to create a scoped store first.`
      );
      return false;
    }
    return true;
  }

  /**
   * 将 glob 模式转换为 RegExp（支持 * / ** / ?）。
   * @private
   */
  _globToRegex(glob: string): RegExp {
    const regexStr = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    return new RegExp('^' + regexStr + '$');
  }

  /**
   * 按行范围读取文件内容。
   * 文件内容存储在页面数据的 `"content"` 键下。
   * 读取顺序：只读搜索路径 → 本地存储 → mountedFolder → 非只读搜索路径。
   *
   * @param pageName  - 页面名（相当于文件路径）
   * @param startLine - 起始行（1-based，默认 1）
   * @param endLine   - 终止行（1-based，包含，默认最后一行）
   * @returns 指定行范围的内容字符串
   */
  async readFile(pageName: string, startLine?: number, endLine?: number): Promise<string> {
    let content: string | null | undefined;
    if (this._isAbsolutePath(pageName)) {
      content = await this._readAbsoluteFile(pageName);
    } else {
      const relativePageName = this.sanitizePageName(pageName);
      if (!this._isFileOpScoped('readFile')) return '';
      if (this._searchPaths.length) content = await this._readFromSearchPath(relativePageName, true);
      if (content == null) content = await this.loadPageData(relativePageName, 'content', false, true) as string | null;
      if (content == null && this.mountedFolder) content = await this._readMountedFile(relativePageName);
      if (content == null && this._searchPaths.length) content = await this._readFromSearchPath(relativePageName, false);
    }
    if (content == null) return '';
    const lines = String(content).split('\n');
    const totalLines = lines.length;
    const start = Math.max(1, startLine ?? 1) - 1;
    const requestedEnd = Number(endLine);
    const end = Number.isFinite(requestedEnd) && requestedEnd > 0
      ? Math.min(totalLines, requestedEnd)
      : totalLines;
    return lines.slice(start, end).join('\n');
  }

  /**
   * 精确替换文件中的一处字符串（仅替换首次出现，若多处匹配则报错）。
   * mountedFolder 中的文件走 copy-on-write：读取后写入本地。
   *
   * @param pageName  - 页面名
   * @param oldString - 要精确匹配的原始字符串
   * @param newString - 替换后的字符串
   * @returns 操作结果描述字符串
   */
  async replaceStringInFile(pageName: string, oldString: string, newString: string): Promise<string> {
    pageName = this.sanitizePageName(pageName);
    if (!this._isFileOpScoped('replaceStringInFile')) return '';
    let content = await this.loadPageData(pageName, 'content', false, true) as string | null;
    if (content == null && this.mountedFolder) content = await this._readMountedFile(pageName);
    if (content == null) return `File not found: ${pageName}`;
    content = String(content);
    const index = content.indexOf(oldString);
    if (index === -1) return 'Failed: oldString not found in file. You may read the file again.';
    const secondIndex = content.indexOf(oldString, index + oldString.length);
    if (secondIndex !== -1) return 'Failed: oldString matches multiple locations in file. Make the string more specific.';
    const newContent = content.substring(0, index) + newString + content.substring(index + oldString.length);
    await this.savePageData(pageName, 'content', newContent, true, true);
    return 'File updated successfully.';
  }

  /**
   * 在已加载页面的内容中全文搜索（text / regex）。
   * 当 `includePattern` 为精确文件名时，还会从磁盘/远端加载该文件。
   *
   * @param query          - 搜索字符串或正则模式
   * @param isRegexp       - 是否将 query 视为正则表达式
   * @param includePattern - Glob 模式，用于过滤搜索范围
   * @param maxResults     - 最大返回结果数（默认 100）
   * @returns 格式化的搜索结果字符串
   */
  async grepSearch(
    query: string,
    isRegexp = false,
    includePattern?: string,
    maxResults = 100
  ): Promise<string> {
    if (!this._isFileOpScoped('grepSearch')) return '';
    let regex: RegExp;
    try {
      regex = isRegexp
        ? new RegExp(query, 'gi')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (e) {
      return `Failed: Invalid regex pattern: ${(e as Error).message}`;
    }
    const isExactFile = includePattern && !/[*?{}\[\]]/.test(includePattern);
    let filteredPages: string[];
    const resolveKey = (name: string): string => this._toInternalPageKey(name) || name;
    if (isExactFile) {
      let exactName = this.sanitizePageName(includePattern!);
      if (exactName.endsWith('.md')) exactName = exactName.slice(0, -3);
      filteredPages = [exactName];
    } else {
      const pageNames = new Set<string>();
      for (const key of Object.keys(this.personalPageData)) {
        const relativeName = this._toCurrentWorkspaceRelative(key);
        if (relativeName !== null && this.getValueByPath(this.personalPageData[key]!, 'content') != null) {
          pageNames.add(relativeName);
        }
      }
      for (const key of Object.keys(this.personalPageDataUpdated)) {
        const relativeName = this._toCurrentWorkspaceRelative(key);
        if (relativeName !== null && this.getValueByPath(this.personalPageDataUpdated[key]!, 'content') != null) {
          pageNames.add(relativeName);
        }
      }
      if (includePattern) {
        const patternRegex = this._globToRegex(includePattern);
        filteredPages = Array.from(pageNames).filter((p) => patternRegex.test(p));
      } else {
        filteredPages = Array.from(pageNames);
      }
    }
    const results: Array<{ file: string; line: number; text: string }> = [];
    const limit = maxResults || 100;
    for (const pageName of filteredPages) {
      if (results.length >= limit) break;
      const storeKey = resolveKey(pageName);
      let content = this.getValueByPath(this.personalPageDataUpdated[storeKey] ?? {}, 'content') as string | undefined;
      if (!content || !this.isValidValue(content)) {
        content = this.getValueByPath(this.personalPageData[storeKey] ?? {}, 'content') as string | undefined;
      }
      if (!content && isExactFile) {
        if (this._isAbsolutePath(pageName)) {
          content = await this._readAbsoluteFile(pageName) ?? undefined;
        } else {
          content = await this.loadPageData(pageName, 'content', false, true) as string | undefined;
        }
        if (!content && !this._isAbsolutePath(pageName) && this.mountedFolder) {
          content = await this._readMountedFile(pageName) ?? undefined;
        }
      }
      if (!content) continue;
      const lines = String(content).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= limit) break;
        regex.lastIndex = 0;
        if (regex.test(lines[i]!)) results.push({ file: pageName, line: i + 1, text: lines[i]!.trim() });
      }
    }
    if (results.length === 0) return 'No matches found.';
    let output = '';
    let currentFile = '';
    for (const r of results) {
      if (r.file !== currentFile) { currentFile = r.file; output += `\n${currentFile}:\n`; }
      output += `  L${r.line}: ${r.text}\n`;
    }
    return output.trim();
  }

  /**
   * 创建或覆盖文件（将内容存储到页面的 `"content"` 键）。
   *
   * @param pageName - 页面名（文件路径）
   * @param content  - 文件内容（undefined/null 写入空字符串）
   */
  async createFile(pageName: string, content?: string): Promise<string> {
    pageName = this.sanitizePageName(pageName);
    if (!this._isFileOpScoped('createFile')) return '';
    await this.savePageData(pageName, 'content', content ?? '', true, true);
    return `File created: ${pageName}`;
  }

  /**
   * 列出目录内容（本地 + 远端 + mountedFolder 三源合并）。
   * 目录以 `/` 结尾，文件不加后缀（但内部用 `.md` 标识）。
   *
   * @param dirPath   - 目录路径；`"."` / `""` / `"/"` 表示 workspace 根
   * @param recursive - 是否递归列出（默认 false）
   * @param options   - showInvisibleFiles / remoteOnly / skipLocalOnlyFile
   * @returns 换行分隔的子项名称字符串
   */
  async listDir(dirPath: string, recursive = false, options: ListDirOptions | null = null): Promise<string> {
    const showInvisibleFiles = options?.showInvisibleFiles;
    const remoteOnly = options?.remoteOnly;
    const skipLocalOnlyFile = options?.skipLocalOnlyFile;
    dirPath = this.sanitizePageName(dirPath) || dirPath;
    const isRoot = !dirPath || dirPath === '.' || dirPath === './' || dirPath === '/';
    const normalizedDir = isRoot ? '' : (dirPath.endsWith('/') ? dirPath : dirPath + '/');
    const children = new Set<string>();

    // ── 本地来源（内存 + IndexedDB）──
    await this.ensureUserProfile();
    const username = this.getUsername() ?? 'anonymous';
    const prefix = `personal_page_${username}_`;
    const wsPrefix = this.workspace ? `${this.workspace}/` : '';
    if (!remoteOnly) {
      const localPageNames = new Set<string>();
      for (const key of Object.keys(this.personalPageData)) {
        const rel = this._toCurrentWorkspaceRelative(key);
        if (rel !== null) localPageNames.add(rel);
      }
      for (const key of Object.keys(this.personalPageDataUpdated)) {
        const rel = this._toCurrentWorkspaceRelative(key);
        if (rel !== null) localPageNames.add(rel);
      }
      if (!skipLocalOnlyFile) {
        try {
          const allKeys = await StorageUtil.getAllKeys();
          for (const key of allKeys) {
            if (typeof key === 'string' && key.startsWith(prefix)) {
              let pageName = key.substring(prefix.length);
              if (this.workspace) {
                if (pageName.startsWith(wsPrefix)) localPageNames.add(pageName.substring(wsPrefix.length));
              } else {
                localPageNames.add(pageName);
              }
            }
          }
        } catch { /* ignore */ }
      }
      for (let pageName of localPageNames) {
        if (!pageName.endsWith('.md')) pageName += '.md';
        if (isRoot) {
          if (recursive) { children.add(pageName); }
          else {
            const si = pageName.indexOf('/');
            children.add(si === -1 ? pageName : pageName.substring(0, si) + '/');
          }
        } else {
          if (!pageName.startsWith(normalizedDir)) continue;
          const relative = pageName.substring(normalizedDir.length);
          if (!relative) continue;
          if (recursive) { children.add(relative); }
          else {
            const si = relative.indexOf('/');
            children.add(si === -1 ? relative : relative.substring(0, si) + '/');
          }
        }
      }
    }

    // ── 远端来源 ──
    if (!this.isUseLocal()) {
      try {
        const { sitePath, folderBase } = this._getRemoteTreeParams();
        const remoteFolderPath = isRoot ? folderBase : `${folderBase}/${dirPath.replace(/\/$/, '')}`;
        if (recursive) {
          const treeData = await this.sdk.getSiteTree?.(sitePath, true, remoteFolderPath, true) ?? [];
          const collectEntries = (items: TreeEntry[], parentPath: string): void => {
            if (!Array.isArray(items)) return;
            for (const entry of items) {
              const entryPath = parentPath ? `${parentPath}/${entry.name}` : (entry.name ?? '');
              if (entry.isTree) { if (entry.children?.length) collectEntries(entry.children, entryPath); }
              else { let n = entryPath; if (!n.endsWith('.md')) n += '.md'; if (n) children.add(n); }
            }
          };
          collectEntries(treeData, '');
        } else {
          const treeData = await this.sdk.getSiteTree?.(sitePath, false, remoteFolderPath, true) ?? [];
          if (Array.isArray(treeData)) {
            for (const entry of treeData) {
              let name = entry.name ?? '';
              if (entry.isTree) { if (name) children.add(name + '/'); }
              else { if (!name.endsWith('.md')) name += '.md'; if (name) children.add(name); }
            }
          }
        }
      } catch (error) {
        console.warn('listDir: remote listing failed, using local data only:', error);
      }
    }

    // ── mountedFolder 来源 ──
    if (this.mountedFolder) {
      const mountedChildren = await this._listMountedDir(dirPath, isRoot, normalizedDir, recursive);
      for (const child of mountedChildren) children.add(child);
    }

    // 过滤隐藏文件
    if (!showInvisibleFiles) {
      for (const entry of children) {
        const name = entry.split('/')[0]!;
        if (name.startsWith('.')) children.delete(entry);
      }
    }

    if (children.size === 0) return `Directory is empty or not found: ${dirPath}`;
    return Array.from(children).sort().join('\n');
  }
}
