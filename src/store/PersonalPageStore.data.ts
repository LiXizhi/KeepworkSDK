/**
 * PersonalPageStore.data.ts — 数据层（工具方法 + CRUD 核心）
 *
 * 包含：
 * - getValueByPath / setValueByPath / deleteValueByPath（dot notation 路径操作）
 * - isValidValue / isValueEqual（值校验/比较）
 * - deepClone / mergeData（数据复制/合并）
 * - getLocalPagePath / getRemotePagePath / isUseLocal
 * - getMetadata / setMetadata / _getTimestamp / generateVersion
 * - savePageDataTimeSeries（时序数据追加）
 * - loadPageDataAsNumber
 * - savePageData / deletePageData（核心 CRUD）
 * - checkMergeRemoteData（版本合并，含冲突解决）
 * - isRemotePageVersionChecked / setRemotePageVersionChecked
 * - _markPageMutation / _getPageMutationVersion
 * - loadPageDataFromRemote / loadPageData（读取入口）
 */

import YMLParser from './YMLParser';
import { StorageUtil } from './LocalStorageUtil';
import type { PageMetadata, TimeSeriesKeyValue, VersionConflictEvent } from './PersonalPageStore.types';
import { PersonalPageStoreBase } from './PersonalPageStore.base';

export class PersonalPageStoreData extends PersonalPageStoreBase {

  // ──────────────────── dot notation 工具 ────────────────────

  /**
   * 通过 dot notation 路径读取对象中的值。
   * 路径不存在时返回 null。
   *
   * @param obj  - 源对象
   * @param path - 如 `"user.profile.name"`；空路径返回整个对象
   */
  override getValueByPath(obj: Record<string, unknown> | null | undefined, path: string): unknown {
    if (!obj) return null;
    if (!path || path === '') return obj;
    if (!path.includes('.')) return obj[path] ?? null;
    const keys = path.split('.');
    let current: unknown = obj;
    for (const key of keys) {
      if (current && typeof current === 'object' && key in (current as object)) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return null;
      }
    }
    return current;
  }

  /**
   * 通过 dot notation 路径在对象中写入值。
   * 路径中间节点不存在时自动创建空对象。
   *
   * @param obj   - 目标对象
   * @param path  - dot notation 路径；空路径时将 value 对象合并到 obj
   * @param value - 要写入的值
   * @returns 是否写入成功
   */
  override setValueByPath(obj: Record<string, unknown>, path: string, value: unknown): boolean {
    if (!obj) return false;
    if (!path || path === '') {
      if (typeof value === 'object' && value !== null) {
        Object.assign(obj, value);
        return true;
      }
      return false;
    }
    if (!path.includes('.')) {
      obj[path] = value;
      return true;
    }
    const keys = path.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]!;
      if (!current[key] || typeof current[key] !== 'object') current[key] = {};
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]!] = value;
    return true;
  }

  /**
   * 通过 dot notation 路径删除对象中的值。
   * @returns 是否成功删除
   */
  deleteValueByPath(obj: Record<string, unknown>, path: string): boolean {
    if (!obj || !path || path === '') return false;
    if (!path.includes('.')) {
      if (obj[path] !== undefined) { delete obj[path]; return true; }
      return false;
    }
    const keys = path.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]!;
      if (!current[key] || typeof current[key] !== 'object') return false;
      current = current[key] as Record<string, unknown>;
    }
    const finalKey = keys[keys.length - 1]!;
    if (current[finalKey] !== undefined) { delete current[finalKey]; return true; }
    return false;
  }

  // ──────────────────── 值校验 ────────────────────

  /**
   * 检查值是否有效（非 null / 非空字符串 / 非空对象）。
   * @param value - 要检查的值
   */
  override isValidValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value !== '';
    if (typeof value === 'object') return Object.keys(value as object).length > 0;
    return true;
  }

  /**
   * 深度相等性比较（支持数组和嵌套对象）。
   * @param v1 - 第一个值
   * @param v2 - 第二个值
   */
  isValueEqual(v1: unknown, v2: unknown): boolean {
    if (typeof v1 !== typeof v2) return false;
    if (typeof v1 === 'object' && v1 !== null && v2 !== null) {
      if (Array.isArray(v1) && Array.isArray(v2)) {
        if (v1.length !== v2.length) return false;
        for (let i = 0; i < v1.length; i++) {
          if (!this.isValueEqual(v1[i], v2[i])) return false;
        }
        return true;
      }
      if (Array.isArray(v1) || Array.isArray(v2)) return false;
      const r1 = v1 as Record<string, unknown>, r2 = v2 as Record<string, unknown>;
      const keys1 = Object.keys(r1), keys2 = Object.keys(r2);
      if (keys1.length !== keys2.length) return false;
      for (const k of keys1) {
        if (!keys2.includes(k) || !this.isValueEqual(r1[k], r2[k])) return false;
      }
      return true;
    }
    return v1 === v2;
  }

  // ──────────────────── 数据复制/合并 ────────────────────

  /**
   * 深度克隆值（防止外部修改内部数据）。
   * 支持：null / 原始类型 / Date / Array / 普通对象；
   * 正确处理循环引用（WeakMap 追踪）。
   *
   * @param value - 要克隆的值
   * @param seen  - 循环引用追踪（内部参数，请勿手动传入）
   */
  deepClone<T>(value: T, seen?: WeakMap<object, unknown>): T {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (!seen) seen = new WeakMap();
    if (seen.has(value as object)) return seen.get(value as object) as T;
    if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      seen.set(value as object, arr);
      for (let i = 0; i < value.length; i++) arr[i] = this.deepClone(value[i], seen);
      return arr as unknown as T;
    }
    if (Object.prototype.toString.call(value) === '[object Object]') {
      const cloned: Record<string, unknown> = {};
      seen.set(value as object, cloned);
      for (const key in value as object) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          cloned[key] = this.deepClone((value as Record<string, unknown>)[key], seen);
        }
      }
      return cloned as unknown as T;
    }
    console.warn('deepClone: Unsupported object type, returning as-is:', value);
    return value;
  }

  /**
   * 深度合并 source 到 target（数组替换，对象递归合并）。
   * @param target - 目标对象（会被原地修改）
   * @param source - 源对象
   */
  mergeData(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    if (!source || typeof source !== 'object') return target;
    for (const [key, value] of Object.entries(source)) {
      if (Array.isArray(value) && Array.isArray(target[key])) {
        target[key] = value;
      } else if (
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])
      ) {
        this.mergeData(
          target[key] as Record<string, unknown>,
          value as Record<string, unknown>
        );
      } else {
        target[key] = value;
      }
    }
    return target;
  }

  // ──────────────────── 路径计算 ────────────────────

  /**
   * 计算页面在 IndexedDB / localStorage 中的存储 key。
   * 格式：`personal_page_{username}_{effectiveName}`
   */
  override getLocalPagePath(pageName: string): string {
    const username = this.getUsername() ?? 'anonymous';
    const effectiveName = this.getEffectivePageName(pageName);
    return `personal_page_${username}_${effectiveName}`;
  }

  /**
   * 计算页面在 Keepwork 远端的完整路径。
   * 格式：`username/remoteStorePath/effectiveName`
   * @throws 未登录且无 override 用户名时抛出错误
   */
  override getRemotePagePath(pageName: string): string {
    const username = this.getUsername();
    if (!username) throw new Error('No username available for remote page path');
    const effectiveName = this.getEffectivePageName(pageName);
    return `${username}/${this.remoteStorePath}/${effectiveName}`;
  }

  /**
   * 检查是否处于本地模式（无 token 且无 override 用户名，仅使用本地存储）。
   */
  isUseLocal(): boolean {
    return !this.sdk.token && this.overrideUsername === null;
  }

  // ──────────────────── 版本元数据 ────────────────────

  /**
   * 读取页面数据对象的版本元数据（向后兼容 `metadata` 和 `_metadata` 字段）。
   */
  getMetadata(data: Record<string, unknown> | null | undefined): PageMetadata {
    if (!data) return {};
    return (data['_metadata'] ?? data['metadata'] ?? {}) as PageMetadata;
  }

  /**
   * 写入页面数据对象的版本元数据（使用新字段名 `_metadata`）。
   */
  setMetadata(data: Record<string, unknown>, metadata: PageMetadata): void {
    if (!data) return;
    data['_metadata'] = metadata;
  }

  /**
   * 生成当前时间戳字符串（格式：`YYYY-MM-DD-HH:MM:SS`）。
   * 用于版本元数据的 created_at / updated_at 字段。
   */
  _getTimestamp(): string {
    return new Date().toISOString().replace('T', '-').replace(/\..+/, '');
  }

  /**
   * 生成自增版本元数据。
   * 若远端版本比本地新，基于远端版本自增；否则基于本地版本自增。
   *
   * @param localData  - 当前本地数据对象
   * @param remoteData - 最新远端数据对象（可选）
   */
  generateVersion(
    localData: Record<string, unknown> = {},
    remoteData: Record<string, unknown> = {}
  ): PageMetadata {
    const localMeta = this.getMetadata(localData);
    const remoteMeta = this.getMetadata(remoteData);
    const now = this._getTimestamp();
    if (remoteMeta.version && localMeta.version && remoteMeta.version > localMeta.version) {
      return { version: (remoteMeta.version ?? 0) + 1, created_at: remoteMeta.created_at ?? now, updated_at: now };
    }
    return { version: (localMeta.version ?? 0) + 1, created_at: localMeta.created_at ?? now, updated_at: now };
  }

  // ──────────────────── TimeSeries ────────────────────

  /**
   * 保存时序数据（数组形式，新数据插入头部，超过 maxKeyCount 时截断）。
   *
   * 支持 unique 类型（相同值时更新而非追加）、addictive（累加）、mean（均值）。
   *
   * @param pageName    - 页面名
   * @param keyValues   - 数据键值数组，每项含 `key / value / type`
   * @param maxKeyCount - 每个 key 最多保留的元素数（默认 10）
   * @param bFlush      - 是否立即写盘
   * @param bUseCache   - 是否使用缓存
   */
  async savePageDataTimeSeries(
    pageName: string,
    keyValues: TimeSeriesKeyValue[],
    maxKeyCount = 10,
    bFlush = false,
    bUseCache?: boolean
  ): Promise<void> {
    const uniqueKey = keyValues.find((kv) => kv.type === 'unique');
    let isReplaceOperation = false;

    if (uniqueKey) {
      let oldValue = await this.loadPageData(pageName, uniqueKey.key);
      const compareValue = Array.isArray(oldValue) && oldValue.length > 0 ? oldValue[0] : oldValue;
      if (uniqueKey.value === compareValue) {
        isReplaceOperation = true;
        for (const kv of keyValues) {
          let values = await this.loadPageData(pageName, kv.key);
          values = !values || !Array.isArray(values) ? [] : Array.from(values as unknown[]);
          const arr = values as unknown[];
          if (kv.type === 'addictive') {
            if (arr.length > 0) (arr[0] as { valueOf(): number }) && (arr[0] = (arr[0] as number) + (kv.value as number));
            else arr.push(kv.value);
          } else if (kv.type === 'mean') {
            if (arr.length > 0) arr[0] = ((arr[0] as number) + (kv.value as number)) / 2;
            else arr.push(kv.value);
          } else {
            arr[0] = kv.value;
          }
          kv.values = arr;
        }
      }
    }

    if (!isReplaceOperation) {
      for (const kv of keyValues) {
        const rawValues = await this.loadPageData(pageName, kv.key);
        const appendArr: unknown[] = !rawValues || !Array.isArray(rawValues) ? [] : Array.from(rawValues as unknown[]);
        appendArr.unshift(kv.value);
        kv.values = appendArr;
      }
    }

    for (const kv of keyValues) {
      if (kv.values && Array.isArray(kv.values)) kv.values = kv.values.slice(0, maxKeyCount);
    }
    for (const kv of keyValues) {
      await this.savePageData(pageName, kv.key, kv.values, bFlush, bUseCache);
    }
  }

  /**
   * 读取数值型页面数据（数组时返回第一个元素）。
   *
   * @param pageName    - 页面名
   * @param key         - 数据键
   * @param forceRemote - 是否强制从远端加载
   */
  async loadPageDataAsNumber(pageName: string, key: string, forceRemote = false): Promise<number | null> {
    let value = await this.loadPageData(pageName, key, forceRemote);
    if (Array.isArray(value) && value.length > 0) value = value[0];
    return typeof value === 'number' ? value : null;
  }

  // ──────────────────── savePageData / deletePageData ────────────────────

  /**
   * 保存页面数据（核心写入入口）。
   *
   * 写入流程：
   * 1. 检查并加载本地磁盘 + 远端数据（版本合并）
   * 2. 比较新旧值，相同则跳过
   * 3. 将变更写入 `personalPageDataUpdated`
   * 4. 标记 pending 并触发防抖磁盘写入
   *
   * @param pageName  - 页面名
   * @param key       - dot notation 数据键（`_metadata` 保留，不可直接写）
   * @param value     - 要保存的值；null 表示删除该键
   * @param bFlush    - 是否立即写盘并触发同步
   * @param bUseCache - 是否使用远端缓存
   */
  async savePageData(
    pageName: string,
    key: string,
    value: unknown,
    bFlush = false,
    bUseCache?: boolean
  ): Promise<void> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    try {
      await this.checkLoadData(pageKey, bUseCache);

      this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
      this.personalPageDataUpdated[pageKey] = this.personalPageDataUpdated[pageKey] ?? {};

      PersonalPageStoreData._log('personalPageStore:save', pageKey, key, value);

      let originalValue = this.getValueByPath(this.personalPageDataUpdated[pageKey]!, key);
      if (originalValue == null) originalValue = this.getValueByPath(this.personalPageData[pageKey]!, key);

      if (this.isValueEqual(originalValue, value)) return;

      if (key && key !== '' && key !== '_metadata' && value === null) {
        this.personalPageDataDeleted[pageKey] = this.personalPageDataDeleted[pageKey] ?? [];
        if (!this.personalPageDataDeleted[pageKey]!.includes(key)) {
          this.personalPageDataDeleted[pageKey]!.push(key);
        }
      } else {
        this.setValueByPath(this.personalPageDataUpdated[pageKey]!, key, value);
        const deletedList = this.personalPageDataDeleted[pageKey] ?? [];
        const keyIndex = deletedList.indexOf(key);
        if (keyIndex !== -1) deletedList.splice(keyIndex, 1);
      }

      this._markPageMutation(pageKey);
      this.pendingDiskPages.add(pageKey);
      this.pendingSync.add(pageKey);
      if (bUseCache !== undefined) {
        this.pageSyncOptions[pageKey] = this.pageSyncOptions[pageKey] ?? {};
        this.pageSyncOptions[pageKey]!.useCache = bUseCache;
      }

      if (bFlush) {
        await (this as unknown as { saveToDisk: (k: string) => Promise<boolean> }).saveToDisk(pageKey);
        this.pendingDiskPages.delete(pageKey);
        (this as unknown as { batchSyncToRemote: (f: boolean) => Promise<number> }).batchSyncToRemote(true);
        return;
      }

      (this as unknown as { debouncedDiskSave: () => void }).debouncedDiskSave();
      this.checkInitSyncTimers();
    } catch (error) {
      console.warn('Save page data error:', error);
    }
  }

  /**
   * 删除页面数据的指定键。
   *
   * @param pageName - 页面名
   * @param key      - dot notation 数据键（不能为 'metadata' / '_metadata'）
   * @param bFlush   - 是否立即触发同步
   * @returns 是否成功删除
   */
  async deletePageData(pageName: string, key: string, bFlush = false): Promise<boolean> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    try {
      if (!key || key === '' || key === 'metadata' || key === '_metadata') {
        console.warn('personalPageStore:delete invalid key:', key);
        return false;
      }
      await this.checkLoadData(pageKey);

      this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
      this.personalPageDataUpdated[pageKey] = this.personalPageDataUpdated[pageKey] ?? {};
      this.personalPageDataDeleted[pageKey] = this.personalPageDataDeleted[pageKey] ?? [];

      PersonalPageStoreData._log('personalPageStore:delete', pageKey, key);

      const exists =
        this.getValueByPath(this.personalPageDataUpdated[pageKey]!, key) !== undefined ||
        this.getValueByPath(this.personalPageData[pageKey]!, key) !== undefined;

      if (!exists) { PersonalPageStoreData._log('personalPageStore:delete key not found:', key); return false; }

      if (!this.personalPageDataDeleted[pageKey]!.includes(key)) {
        this.personalPageDataDeleted[pageKey]!.push(key);
      }
      this.deleteValueByPath(this.personalPageDataUpdated[pageKey]!, key);
      this.deleteValueByPath(this.personalPageData[pageKey]!, key);

      this._markPageMutation(pageKey);
      this.pendingDiskPages.add(pageKey);
      this.pendingSync.add(pageKey);
      (this as unknown as { debouncedDiskSave: () => void }).debouncedDiskSave();

      if (bFlush) {
        (this as unknown as { batchSyncToRemote: (f: boolean) => Promise<number> }).batchSyncToRemote(true);
        return true;
      }
      this.checkInitSyncTimers();
      return true;
    } catch (error) {
      console.warn('Delete page data error:', error);
      return false;
    }
  }

  // ──────────────────── 版本合并 ────────────────────

  /**
   * 检查并合并远端数据（版本比较 + 冲突解决）。
   *
   * 合并策略：
   * - 远端版本更新 → 使用远端数据
   * - 本地版本更新 + bUseCache → 可能是缓存陈旧，触发冲突解决逻辑并发出 versionConflict 事件
   * - 版本相同且本地为空 → 使用远端数据
   *
   * @param pageName    - 页面名
   * @param bForceMerge - 强制重新检查（忽略已检查标志）
   * @param bUseCache   - 是否使用远端缓存
   */
  async checkMergeRemoteData(pageName: string, bForceMerge?: boolean, bUseCache?: boolean): Promise<void> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    if (this.isUseLocal()) { this.setRemotePageVersionChecked(pageKey, true); return; }
    await this.ensureUserProfile();

    if (!this.isRemotePageVersionChecked(pageKey) || bForceMerge) {
      this.setRemotePageVersionChecked(pageKey, true);
      try {
        const localMetadata = this.getMetadata(this.personalPageData[pageKey] ?? {});
        const remotePath = this.getRemotePagePath(pageKey);
        let remoteDataContent: string | null | undefined;
        try {
          const isCandybox = pageKey === 'game_activity_candybox' || pageKey.endsWith('/game_activity_candybox');
          const useCache = bUseCache !== undefined ? bUseCache : isCandybox;
          remoteDataContent = await this.sdk.getMarkdownByFullPath?.(remotePath, undefined, useCache);
        } catch {
          console.log(`Remote page not found: ${pageKey}`);
        }

        const remoteData = YMLParser.yamlToObject(remoteDataContent ?? '', true) as Record<string, unknown>;
        if (!remoteData || JSON.stringify(remoteData) === '{}' || !remoteDataContent) {
          if (!bUseCache) this.setRemotePageVersionChecked(pageKey, false);
          return;
        }

        const remoteMetadata = this.getMetadata(remoteData);
        const localVersion = localMetadata.version ?? 0;
        const remoteVersion = remoteMetadata.version ?? 0;

        if (remoteVersion > localVersion) {
          console.log(`Using remote data (v${remoteVersion}) over local (v${localVersion}) for page: ${pageKey}`);
          this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
          const wasEmpty = Object.keys(this.personalPageData[pageKey]!).length === 0;
          if (wasEmpty) {
            this.personalPageData[pageKey] = remoteData;
          } else {
            for (const [k, v] of Object.entries(remoteData)) {
              if (k !== 'metadata' && k !== '_metadata') {
                const hasPendingUpdate = this.getValueByPath(this.personalPageDataUpdated[pageKey] ?? {}, k);
                if (!hasPendingUpdate) this.setValueByPath(this.personalPageData[pageKey]!, k, v);
              }
            }
            this.setMetadata(this.personalPageData[pageKey]!, this.getMetadata(remoteData));
          }
          this.setRemotePageVersionChecked(pageKey, true);
          await (this as unknown as { saveToDisk: (k: string, f: boolean) => Promise<boolean> }).saveToDisk(pageKey, true);

        } else if (localVersion > remoteVersion) {
          if (bUseCache) {
            const localData = this.personalPageData[pageKey] ?? {};
            const localYaml = YMLParser.objectToYaml(localData as Parameters<typeof YMLParser.objectToYaml>[0], true, true) ?? '';
            const remoteYaml = remoteDataContent ?? '';
            const localLength = localYaml.length, remoteLength = remoteYaml.length;
            const localUpdatedAt = localMetadata.updated_at ?? '';
            const remoteUpdatedAt = remoteMetadata.updated_at ?? '';
            let useLocal: boolean, tiebreaker: 'updated_at' | 'length';
            if (localUpdatedAt !== remoteUpdatedAt && (localUpdatedAt || remoteUpdatedAt)) {
              useLocal = localUpdatedAt > remoteUpdatedAt; tiebreaker = 'updated_at';
            } else {
              useLocal = localLength > remoteLength; tiebreaker = 'length';
            }
            const resolution: 'local' | 'remote' = useLocal ? 'local' : 'remote';
            console.log(
              `Cache version conflict for page ${pageKey}: local v${localVersion} > remote v${remoteVersion}. ` +
              `Resolution=${resolution}, tiebreaker=${tiebreaker}`
            );
            if (useLocal) {
              const meta = this.getMetadata(localData);
              this.setMetadata(localData, { ...meta, version: remoteVersion, updated_at: this._getTimestamp() });
              this.personalPageData[pageKey] = localData;
            } else {
              this.personalPageData[pageKey] = remoteData;
            }
            this.setRemotePageVersionChecked(pageKey, true);
            await (this as unknown as { saveToDisk: (k: string, f: boolean) => Promise<boolean> }).saveToDisk(pageKey, true);
            const conflictEvent: VersionConflictEvent = {
              pageKey, localVersion, remoteVersion,
              localUpdatedAt, remoteUpdatedAt, localLength, remoteLength, tiebreaker, resolution,
            };
            this.emit('versionConflict', conflictEvent);
          } else {
            console.log(`Using local data (v${localVersion}) over remote (v${remoteVersion}) for page: ${pageKey}`);
          }
        } else {
          const localData = this.personalPageData[pageKey] ?? {};
          const localHasContent = Object.keys(localData).some((k) => k !== '_metadata' && k !== 'metadata');
          if (!localHasContent) {
            console.log(`Equal version (v${remoteVersion}) but local is empty — using remote data for page: ${pageKey}`);
            this.personalPageData[pageKey] = remoteData;
            await (this as unknown as { saveToDisk: (k: string, f: boolean) => Promise<boolean> }).saveToDisk(pageKey, true);
          } else {
            console.log(`Using remote data (v${remoteVersion}) equals local (v${localVersion}) for page: ${pageKey}`);
          }
        }
      } catch (error) {
        console.warn('Failed to load from remote, using local version:', error);
      }
    }
  }

  // ──────────────────── 版本检查标志 ────────────────────

  isRemotePageVersionChecked(pageName: string): boolean {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    this.pageStatus[pageKey] = this.pageStatus[pageKey] ?? {};
    return !!(this.pageStatus[pageKey]!['_remoteVersionChecked']);
  }

  setRemotePageVersionChecked(pageName: string, bChecked: boolean): void {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    this.pageStatus[pageKey] = this.pageStatus[pageKey] ?? {};
    this.pageStatus[pageKey]!['_remoteVersionChecked'] = bChecked;
  }

  _markPageMutation(pageName: string): number {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    this.pageMutationVersion[pageKey] = (this.pageMutationVersion[pageKey] ?? 0) + 1;
    return this.pageMutationVersion[pageKey]!;
  }

  _getPageMutationVersion(pageName: string): number {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    return this.pageMutationVersion[pageKey] ?? 0;
  }

  // ──────────────────── 读取入口 ────────────────────

  /**
   * 直接从远端加载页面数据（绕过版本检查）。
   * 结果同步到本地缓存并写盘，下次读取直接命中缓存。
   *
   * @param pageName  - 页面名
   * @param key       - dot notation 数据键
   * @param bUseCache - 是否使用 API 缓存
   */
  async loadPageDataFromRemote(pageName: string, key: string, bUseCache?: boolean): Promise<unknown> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    try {
      await this.ensureUserProfile();
      if (this.isUseLocal()) {
        console.warn('In local mode, cannot load from remote. Using local data.');
        return await this.loadPageData(pageKey, key, false, bUseCache);
      }
      const remotePath = this.getRemotePagePath(pageKey);
      let remoteDataContent: string | null | undefined;
      try {
        remoteDataContent = await this.sdk.getMarkdownByFullPath?.(remotePath, undefined, bUseCache);
      } catch {
        console.log(`Remote page not found: ${pageKey}`);
        return await this.loadPageData(pageKey, key, false, bUseCache);
      }
      const remoteData = YMLParser.yamlToObject(remoteDataContent ?? '', true) as Record<string, unknown>;
      if (!remoteData || typeof remoteData !== 'object') return null;
      const remoteValue = this.getValueByPath(remoteData, key);
      const allowEmpty = key === 'content';
      const result = allowEmpty
        ? (remoteValue !== null && remoteValue !== undefined ? remoteValue : null)
        : (remoteValue && this.isValidValue(remoteValue) ? remoteValue : null);
      this.personalPageData[pageKey] = remoteData;
      this.setRemotePageVersionChecked(pageKey, true);
      await (this as unknown as { saveToDisk: (k: string, f: boolean) => Promise<boolean> }).saveToDisk(pageKey, true);
      return result !== null ? this.deepClone(result) : null;
    } catch (error) {
      console.warn('Error loading page data from remote:', error);
      return await this.loadPageData(pageKey, key, false, bUseCache);
    }
  }

  /**
   * 加载页面数据（含版本合并，主读取入口）。
   *
   * 读取顺序：
   * 1. `forceRemote=true` → 直接调用 loadPageDataFromRemote
   * 2. 检查本地磁盘（checkLoadPageFromDisk）
   * 3. 检查远端版本（checkMergeRemoteData）
   * 4. 读取 personalPageDataUpdated（最高优先级）
   * 5. 读取 personalPageData（原始/合并后数据）
   *
   * @param pageName    - 页面名
   * @param key         - dot notation 数据键（空字符串返回整个页面对象）
   * @param forceRemote - 强制从远端加载（默认 false）
   * @param bUseCache   - 是否使用远端缓存
   */
  async loadPageData(pageName: string, key: string, forceRemote = false, bUseCache?: boolean): Promise<unknown> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    if (forceRemote) return await this.loadPageDataFromRemote(pageKey, key, bUseCache);

    await this.checkLoadData(pageKey, bUseCache);

    this.personalPageData[pageKey] = this.personalPageData[pageKey] ?? {};
    this.personalPageDataUpdated[pageKey] = this.personalPageDataUpdated[pageKey] ?? {};

    const allowEmpty = key === 'content';
    const updatedValue = this.getValueByPath(this.personalPageDataUpdated[pageKey]!, key);
    if (allowEmpty
      ? (updatedValue !== null && updatedValue !== undefined)
      : (updatedValue && this.isValidValue(updatedValue))) {
      return this.deepClone(updatedValue);
    }
    const originalValue = this.getValueByPath(this.personalPageData[pageKey]!, key);
    const result = allowEmpty
      ? (originalValue !== null && originalValue !== undefined ? originalValue : null)
      : (originalValue && this.isValidValue(originalValue) ? originalValue : null);
    return result !== null ? this.deepClone(result) : null;
  }

  // ──────────────────── 加载数据门卫 ────────────────────

  /**
   * 确保页面数据已从磁盘加载并与远端合并（懒加载门卫）。
   */
  async checkLoadData(pageName: string, bUseCache?: boolean): Promise<void> {
    const pageKey = this._toInternalPageKey(pageName) || pageName;
    this.pageStatus[pageKey] = this.pageStatus[pageKey] ?? {};
    if (!this.pageStatus[pageKey]!['_localVersionChecked']) {
      await (this as unknown as { checkLoadPageFromDisk: (k: string) => Promise<void> }).checkLoadPageFromDisk(pageKey);
    }
    if (!this.pageStatus[pageKey]!['_remoteVersionChecked']) {
      await this.checkMergeRemoteData(pageKey, undefined, bUseCache);
    }
  }
}
