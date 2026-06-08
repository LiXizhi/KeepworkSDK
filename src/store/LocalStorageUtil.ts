/**
 * LocalStorageUtil — 基于 IndexedDB 的持久化存储工具，配备内存 LRU 缓存
 *
 * 数据流向：
 * - 写入：立即更新内存缓存（L1），然后异步写入 IndexedDB（L2）
 * - 读取：内存缓存命中直接返回；未命中时触发后台异步预热
 * - 旧版 localStorage 数据在首次读取时自动迁移到 IndexedDB
 *
 * 超大项（默认 > 2MB）跳过内存缓存，直接操作 IndexedDB，
 * 防止单个巨型对象挤出整个缓存。
 */

/** getStorageStats 返回的存储使用情况统计 */
export interface StorageStats {
  /** IndexedDB 中所有 key/value 的估算字节数 */
  indexedDB: number;
  /** 当前内存缓存的 key 数量 */
  memoryCache: number;
  /** 当前内存缓存的估算字节数 */
  memoryCacheSize: number;
  /** 内存缓存的最大字节限制 */
  memoryCacheMaxSize: number;
}

class LocalStorageUtil {
  static readonly DB_NAME = 'keepwork-personal-store';
  static readonly STORE_NAME = 'keyval';

  /** IndexedDB 连接 Promise（单例，全生命周期共享） */
  private static _dbPromise: Promise<IDBDatabase> | null = null;

  /** 内存 LRU 缓存（L1），key → 任意值 */
  private static _memoryCache: Record<string, unknown> = {};
  /** 当前内存缓存的估算字节数 */
  private static _memoryCacheSize = 0;
  /** 各 key 的最近访问时间戳（用于 LRU 淘汰） */
  private static _memoryCacheAccess: Record<string, number> = {};

  /** 内存缓存最大字节限制（10 MB） */
  static MAX_CACHE_SIZE = 10 * 1024 * 1024;
  /** 单项占内存缓存最大比例（20%），超过此比例的项跳过内存缓存 */
  static MAX_ITEM_SIZE_RATIO = 0.2;
  /** 触发 LRU 淘汰的缓存使用率阈值（80%） */
  static CACHE_EVICTION_THRESHOLD = 0.8;

  static get MAX_ITEM_SIZE_FOR_CACHE(): number {
    return this.MAX_CACHE_SIZE * this.MAX_ITEM_SIZE_RATIO;
  }

  // ──────────────────── 内存缓存管理 ────────────────────

  /**
   * 估算值在内存中的字节占用（近似值，UTF-16 计算）。
   * @internal
   */
  private static _estimateSize(value: unknown): number {
    try {
      if (value === null || value === undefined) return 0;
      if (typeof value === 'string') return value.length * 2;
      if (typeof value === 'number') return 8;
      if (typeof value === 'boolean') return 4;
      const str = JSON.stringify(value);
      return str ? str.length * 2 : 0;
    } catch {
      return 1000;
    }
  }

  /**
   * 将项写入内存缓存。
   * 超大项跳过缓存；若缓存接近阈值则先触发 LRU 淘汰。
   *
   * @returns 是否成功写入内存缓存
   * @internal
   */
  private static _setCacheItem(key: string, value: unknown): boolean {
    const itemSize = this._estimateSize(value);

    if (itemSize > this.MAX_ITEM_SIZE_FOR_CACHE) {
      console.info(
        `Skipping memory cache for large item: ${key} (${(itemSize / 1024 / 1024).toFixed(2)}MB)`
      );
      if (key in this._memoryCache) this._removeCacheItem(key);
      return false;
    }

    if (
      this._memoryCacheSize + itemSize >
      this.MAX_CACHE_SIZE * this.CACHE_EVICTION_THRESHOLD
    ) {
      this._evictLRUItems(itemSize);
    }

    if (key in this._memoryCache) {
      const oldSize = this._estimateSize(this._memoryCache[key]);
      this._memoryCacheSize -= oldSize;
    }

    this._memoryCache[key] = value;
    this._memoryCacheAccess[key] = Date.now();
    this._memoryCacheSize += itemSize;
    return true;
  }

  /** 从内存缓存读取项，并更新 LRU 访问时间。@internal */
  private static _getCacheItem(key: string): unknown {
    if (key in this._memoryCache) {
      this._memoryCacheAccess[key] = Date.now();
      return this._memoryCache[key];
    }
    return undefined;
  }

  /** 从内存缓存中移除项。@internal */
  private static _removeCacheItem(key: string): void {
    if (key in this._memoryCache) {
      const itemSize = this._estimateSize(this._memoryCache[key]);
      this._memoryCacheSize -= itemSize;
      delete this._memoryCache[key];
      delete this._memoryCacheAccess[key];
    }
  }

  /**
   * LRU 淘汰：按最近访问时间升序逐项删除，直到腾出足够空间。
   * @internal
   */
  private static _evictLRUItems(neededSpace: number): void {
    const targetSize =
      this.MAX_CACHE_SIZE * this.CACHE_EVICTION_THRESHOLD - neededSpace;
    const sortedKeys = Object.keys(this._memoryCacheAccess).sort(
      (a, b) => (this._memoryCacheAccess[a] ?? 0) - (this._memoryCacheAccess[b] ?? 0)
    );

    let evictedCount = 0;
    for (const key of sortedKeys) {
      if (this._memoryCacheSize <= targetSize) break;
      this._removeCacheItem(key);
      evictedCount++;
    }

    if (evictedCount > 0) {
      console.info(
        `Memory cache LRU eviction: removed ${evictedCount} items, ` +
        `current size: ${(this._memoryCacheSize / 1024 / 1024).toFixed(2)}MB`
      );
    }
  }

  // ──────────────────── IndexedDB 底层 ────────────────────

  /**
   * 获取（或初始化）IndexedDB 连接，返回单例 Promise。
   * @internal
   */
  private static _getDB(): Promise<IDBDatabase> {
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB not supported'));
        return;
      }

      const request = indexedDB.open(this.DB_NAME, 1);

      request.onerror = () => {
        this._dbPromise = null;
        reject(request.error);
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => { this._dbPromise = null; };
        resolve(db);
      };

      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.STORE_NAME);
      };
    });

    return this._dbPromise;
  }

  /**
   * 在 IndexedDB 事务中执行回调。
   * `callback` 接收 store、resolve、reject 三个参数，
   * 可在其中调用 store 方法并决定 Promise 结果。
   * @internal
   */
  private static _withStore<T>(
    mode: IDBTransactionMode,
    callback: (
      store: IDBObjectStore,
      resolve: (value: T) => void,
      reject: (reason?: unknown) => void
    ) => void
  ): Promise<T> {
    return this._getDB().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const transaction = db.transaction(this.STORE_NAME, mode);
          const store = transaction.objectStore(this.STORE_NAME);

          transaction.oncomplete = () => resolve(undefined as unknown as T);
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);

          callback(store, resolve, reject);
        })
    );
  }

  // ──────────────────── 公共 API ────────────────────

  /**
   * 同步写入（立即更新内存缓存，异步写入 IndexedDB）。
   * 适用于写入频繁、读取延迟不敏感的场景。
   *
   * @param key   - 存储键
   * @param value - 要存储的值（任意可序列化对象）
   * @returns 始终返回 true（写入操作已调度）
   */
  static setItem(key: string, value: unknown): boolean {
    this._setCacheItem(key, value);
    this._setItemAsync(key, value).catch((error) => {
      console.warn('IndexedDB setItem failed:', error);
    });
    return true;
  }

  /** @internal */
  private static async _setItemAsync(key: string, value: unknown): Promise<boolean> {
    try {
      await this._withStore<void>('readwrite', (store) => {
        store.put(value, key);
      });
      return true;
    } catch (error) {
      console.warn('IndexedDB async setItem failed:', error);
      return false;
    }
  }

  /**
   * 同步读取（从内存缓存取值，并在后台异步预热缓存）。
   * 若内存缓存未命中，立即返回 `defaultValue` 并在后台加载 IndexedDB 数据。
   *
   * @param key          - 存储键
   * @param defaultValue - 缓存未命中时的默认值（默认 null）
   */
  static getItem<T = unknown>(key: string, defaultValue: T | null = null): T | null {
    const cachedValue = this._getCacheItem(key);
    if (cachedValue !== undefined) return cachedValue as T;

    // 后台预热：不阻塞当前调用
    this._getItemAsync(key)
      .then((value) => {
        if (value !== null) this._setCacheItem(key, value);
      })
      .catch(() => { /* 静默忽略 */ });

    return defaultValue;
  }

  /** @internal */
  private static async _getItemAsync(key: string): Promise<unknown> {
    try {
      const db = await this._getDB();
      const transaction = db.transaction(this.STORE_NAME, 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.get(key);

      return await new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('IndexedDB getItem failed:', error);
      return null;
    }
  }

  /**
   * 异步读取，保证获得持久化数据。
   * 优先级：内存缓存 → IndexedDB → localStorage 旧版迁移。
   *
   * @param key          - 存储键
   * @param defaultValue - 未找到时的默认值
   */
  static async getItemAsync<T = unknown>(key: string, defaultValue: T | null = null): Promise<T | null> {
    const cachedValue = this._getCacheItem(key);
    if (cachedValue !== undefined) return cachedValue as T;

    const idbValue = await this._getItemAsync(key);
    if (idbValue !== null) {
      this._setCacheItem(key, idbValue);
      return idbValue as T;
    }

    // 兼容旧版 localStorage 存储：迁移到 IndexedDB
    try {
      if (typeof localStorage !== 'undefined') {
        const item = localStorage.getItem(key);
        if (item) {
          const localValue = JSON.parse(item) as T;
          if (localValue !== null) {
            console.info(`Migrating legacy data from localStorage to IndexedDB: ${key}`);
            this._setCacheItem(key, localValue);
            await this._setItemAsync(key, localValue);
            localStorage.removeItem(key);
            return localValue;
          }
        }
      }
    } catch (error) {
      console.warn('localStorage migration failed:', error);
    }

    return defaultValue;
  }

  /**
   * 直接从 IndexedDB 读取（绕过内存缓存，适合需要强一致性的场景）。
   */
  static async getFromIndexedDB<T = unknown>(key: string, defaultValue: T | null = null): Promise<T | null> {
    const value = await this._getItemAsync(key);
    return value !== null ? (value as T) : defaultValue;
  }

  /** 直接写入 IndexedDB（绕过内存缓存）。 */
  static async setToIndexedDB(key: string, value: unknown): Promise<boolean> {
    return this._setItemAsync(key, value);
  }

  /**
   * 获取 IndexedDB 中所有 key 的列表。
   */
  static async getAllKeys(): Promise<IDBValidKey[]> {
    try {
      const db = await this._getDB();
      const transaction = db.transaction(this.STORE_NAME, 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.getAllKeys();
      return await new Promise<IDBValidKey[]>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('IndexedDB getAllKeys failed:', error);
      return [];
    }
  }

  /**
   * 同步删除（立即清理内存缓存，异步删除 IndexedDB）。
   */
  static removeItem(key: string): boolean {
    this._removeCacheItem(key);
    this._removeItemAsync(key).catch((error) => {
      console.warn('IndexedDB removeItem failed:', error);
    });
    return true;
  }

  /** @internal */
  private static async _removeItemAsync(key: string): Promise<boolean> {
    try {
      await this._withStore<void>('readwrite', (store) => {
        store.delete(key);
      });
      return true;
    } catch (error) {
      console.warn('IndexedDB async removeItem failed:', error);
      return false;
    }
  }

  /**
   * 清空所有数据（内存缓存 + IndexedDB）。
   */
  static clear(): boolean {
    this._memoryCache = {};
    this._memoryCacheSize = 0;
    this._memoryCacheAccess = {};
    this._clearAsync().catch((error) => {
      console.warn('IndexedDB clear failed:', error);
    });
    return true;
  }

  /** @internal */
  private static async _clearAsync(): Promise<boolean> {
    try {
      await this._withStore<void>('readwrite', (store) => {
        store.clear();
      });
      return true;
    } catch (error) {
      console.warn('IndexedDB async clear failed:', error);
      return false;
    }
  }

  /**
   * 获取存储使用情况统计（内存缓存 + IndexedDB 估算大小）。
   * 用于调试和容量监控。
   */
  static async getStorageStats(): Promise<StorageStats> {
    const stats: StorageStats = {
      indexedDB: 0,
      memoryCache: Object.keys(this._memoryCache).length,
      memoryCacheSize: this._memoryCacheSize,
      memoryCacheMaxSize: this.MAX_CACHE_SIZE,
    };

    try {
      const db = await this._getDB();
      const transaction = db.transaction(this.STORE_NAME, 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);

      if (store.getAll && store.getAllKeys) {
        const getAllRequest = store.getAll();
        const getAllKeysRequest = store.getAllKeys();

        const [values, keys] = await Promise.all([
          new Promise<unknown[]>((resolve, reject) => {
            getAllRequest.onsuccess = () => resolve(getAllRequest.result as unknown[]);
            getAllRequest.onerror = () => reject(getAllRequest.error);
          }),
          new Promise<IDBValidKey[]>((resolve, reject) => {
            getAllKeysRequest.onsuccess = () => resolve(getAllKeysRequest.result);
            getAllKeysRequest.onerror = () => reject(getAllKeysRequest.error);
          }),
        ]);

        for (let i = 0; i < values.length; i++) {
          try {
            const keySize = typeof keys[i] === 'string' ? (keys[i] as string).length * 2 : 8;
            const valueSize = JSON.stringify(values[i]).length * 2;
            stats.indexedDB += keySize + valueSize;
          } catch {
            stats.indexedDB += 1000;
          }
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (cursor) {
              try {
                const keySize = typeof cursor.key === 'string' ? (cursor.key as string).length * 2 : 8;
                const valueSize = JSON.stringify(cursor.value).length * 2;
                stats.indexedDB += keySize + valueSize;
              } catch {
                stats.indexedDB += 1000;
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorRequest.onerror = () => reject(cursorRequest.error);
        });
      }
    } catch (error) {
      console.warn('Failed to calculate IndexedDB size:', error);
      try {
        if (navigator.storage?.estimate) {
          const estimate = await navigator.storage.estimate();
          stats.indexedDB = estimate.usage ?? 0;
        }
      } catch { /* 静默忽略 */ }
    }

    return stats;
  }
}

/** StorageUtil 是 LocalStorageUtil 的别名，保持向后兼容 */
const StorageUtil = LocalStorageUtil;

export default LocalStorageUtil;
export { LocalStorageUtil, StorageUtil };

if (typeof window !== 'undefined') {
  window.LocalStorageUtil = LocalStorageUtil;
  window.StorageUtil = StorageUtil;
}
