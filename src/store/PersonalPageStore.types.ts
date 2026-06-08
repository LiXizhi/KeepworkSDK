/**
 * PersonalPageStore.types.ts — PersonalPageStore 共享类型定义
 *
 * 被 PersonalPageStore.base / data / sync 三个分层文件共同使用，
 * 避免循环导入。
 */

// ──────────────────── 挂载文件夹 ────────────────────

/** mountedFolder 规范化后的对象格式 */
export interface MountedFolder {
  /** 外部用户名 */
  username: string;
  /** 外部工作空间名 */
  workspace: string;
  /** 远端存储路径（默认继承 remoteStorePath）*/
  remoteStorePath: string;
}

// ──────────────────── 搜索路径 ────────────────────

/** addSearchPath 注册的 URL 回退搜索路径 */
export interface SearchPath {
  /** 路径前缀（含 workspace，如 "myws/skills"） */
  prefix: string;
  /** 基础 URL（末尾含 /，如 "https://cdn.example.com/skills/"） */
  baseUrl: string;
  /** 是否只读（只读路径在 readFile 中优先级最高） */
  isReadonly: boolean;
}

// ──────────────────── 远程树缓存 ────────────────────

/** 站点树条目（来自 sdk.getSiteTree）*/
export interface TreeEntry {
  name?: string;
  path?: string;
  isTree?: boolean;
  isBlob?: boolean;
  children?: TreeEntry[];
}

// ──────────────────── 同步选项 ────────────────────

/** 各页面的同步选项 */
export interface PageSyncOptions {
  useCache?: boolean;
}

// ──────────────────── 版本元数据 ────────────────────

/** 页面数据的版本元数据 */
export interface PageMetadata {
  version?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

// ──────────────────── 事件 ────────────────────

/** versionConflict 事件载荷 */
export interface VersionConflictEvent {
  pageKey: string;
  localVersion: number;
  remoteVersion: number;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  localLength: number;
  remoteLength: number;
  tiebreaker: 'updated_at' | 'length';
  resolution: 'local' | 'remote';
}

// ──────────────────── TimeSeries ────────────────────

/** savePageDataTimeSeries 的 keyValue 条目 */
export interface TimeSeriesKeyValue {
  key: string;
  value: unknown;
  type?: 'unique' | 'replace' | 'addictive' | 'mean';
  /** 内部字段，函数执行过程中填充 */
  values?: unknown[];
}

// ──────────────────── listDir 选项 ────────────────────

/** listDir 的附加选项 */
export interface ListDirOptions {
  /** 是否显示以 '.' 开头的隐藏文件 */
  showInvisibleFiles?: boolean;
  /** 仅列出远端文件，跳过本地 */
  remoteOnly?: boolean;
  /** 跳过仅存在于本地磁盘（不在远端）的文件 */
  skipLocalOnlyFile?: boolean;
}

// ──────────────────── SDK 最小接口 ────────────────────

/**
 * PersonalPageStore 依赖的 SDK 最小接口（避免与主类循环引用）
 */
export interface IPersonalPageSDK {
  token?: string | null;
  user?: { username?: string; [key: string]: unknown } | null;
  extractMainDomain?: (hostname: string) => string;
  getUserProfile?: (opts?: { useCache?: boolean }) => Promise<unknown>;
  getMarkdownByFullPath?: (path: string, cb?: unknown, useCache?: boolean) => Promise<string | null>;
  editMarkdownByFullPath?: (path: string, content: string, cb?: unknown, useCache?: boolean) => Promise<unknown>;
  deleteMarkdownByFullPath?: (path: string, cb?: unknown) => Promise<unknown>;
  getSiteTree?: (sitePath: string, recursive?: boolean, folderPath?: string, useCache?: boolean) => Promise<TreeEntry[]>;
  [key: string]: unknown;
}
