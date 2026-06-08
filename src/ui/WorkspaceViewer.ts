/**
 * WorkspaceViewer.ts — 工作区文件浏览器 UI 组件（基于 Shadow DOM 的文件树）
 *
 * 支持工作区/挂载文件夹切换、文件预览/编辑、搜索、新建、打开/删除文件、原始视图等。
 */

import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('WorkspaceViewer');

// ──────────────────────────────── 类型声明 ────────────────────────────────

/** WorkspaceViewer 构造选项 */
export interface WorkspaceViewerOptions {
  /** 挂载容器元素（必填） */
  container?: HTMLElement;
  /** KeepworkSDK 实例（默认 window.keepwork） */
  sdk?: unknown;
  /** 工作区名（默认 'workspace_default'） */
  workspace?: string;
  /** 可选挂载文件夹 */
  mountFolder?: string;
  /** 初始打开的文件 */
  file?: string;
  /** 隐藏顶栏 */
  hideTopbar?: boolean;
  /** 隐藏工具栏 */
  hideToolbar?: boolean;
  /** 紧凑布局 */
  compact?: boolean;
  /** 显示名映射 */
  displayNameMap?: Record<string, string>;
  /** 隐藏的页面根 */
  hiddenPageRoots?: string[];
  /** 只读模式 */
  readOnly?: boolean;
  /** 隐藏用户信息 */
  hideUserInfo?: boolean;
  /** 隐藏搜索 */
  hideSearch?: boolean;
  /** 隐藏新建文件 */
  hideNewFile?: boolean;
  /** 隐藏打开文件 */
  hideOpenFile?: boolean;
  /** 隐藏删除 */
  hideDelete?: boolean;
  /** 隐藏原始视图 */
  hideRawView?: boolean;
  /** 允许切换工作区 */
  allowChangeWorkspace?: boolean;
  /** 允许切换挂载文件夹 */
  allowChangeMount?: boolean;
  [key: string]: unknown;
}

/** PersonalPageStore（workspace-scoped）结构化接口 */
interface WVStore {
  mountedFolder?: unknown;
  _remoteTreeCache?: unknown;
  listDir(path: string, recursive?: boolean): Promise<string>;
  readFile(path: string): Promise<string>;
  loadPageData(key: string, sub: string | null, a: boolean, b: boolean): Promise<unknown>;
  savePageData(key: string, sub: string, value: unknown, a: boolean, b: boolean): Promise<unknown>;
  clearPageData(key: string): Promise<unknown>;
  clearLocalDisk(key: string): Promise<unknown>;
  grepSearch(query: string, isRegexp: boolean, fileFilter?: string): Promise<string>;
  _readMountedFile(key: string): Promise<string | null>;
  [key: string]: unknown;
}

/** WorkspaceViewer 依赖的 SDK 表面 */
interface WVSdk {
  token?: unknown;
  personalPageStore: {
    withWorkspace(workspace: string, mountFolder: string | null): WVStore;
    [key: string]: unknown;
  };
  getUserProfile(opts: { forceRefresh: boolean }): Promise<Record<string, unknown>>;
  showLoginWindow(opts: { title: string }): Promise<{ token?: unknown } | null>;
  showProfileWindow(): unknown;
  [key: string]: unknown;
}

/** 页面数据（含可选 content / _metadata / metadata 及任意字段） */
type WVPageData =
  | (Record<string, unknown> & { content?: unknown; _metadata?: unknown; metadata?: unknown })
  | null
  | undefined;

/** 内部状态 */
interface WVState {
  selectedFile: string | null;
  viewMode: 'content' | 'raw' | 'edit';
  fileItems: string[];
  isMounted: boolean;
  mountedPageSet: Set<string> | null;
  selectedFolder: string | null;
  expandedFolders: Set<string>;
  folderChildren: Record<string, string[]>;
  editPageData: { content: string } | null;
  absFiles: string[];
}

/** 解析后的选项（构造内部使用） */
interface WVResolvedOptions {
  workspace: string;
  mountFolder: string;
  file: string;
  hideTopbar: boolean;
  hideToolbar: boolean;
  compact: boolean;
  readOnly: boolean;
  hideUserInfo: boolean;
  hideSearch: boolean;
  hideNewFile: boolean;
  hideOpenFile: boolean;
  hideDelete: boolean;
  hideRawView: boolean;
  allowChangeWorkspace: boolean;
  allowChangeMount: boolean;
}

const WORKSPACE_VIEWER_STYLE = `
:host { display: block; width: 100%; height: 100%; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.wv-root {
  font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
  background: #f3f5f7;
  color: #1f2937;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: linear-gradient(135deg, #0f766e, #0ea5a4);
  color: #ecfeff;
  flex-shrink: 0;
}
.topbar h1 { font-size: 15px; font-weight: 700; }
.topbar .spacer { flex: 1; }
.topbar .info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.topbar .badge {
  background: rgba(255,255,255,0.18);
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}
.topbar .badge.clickable {
  cursor: pointer;
  border: 1px dashed rgba(255,255,255,0.35);
}
.topbar .badge.clickable:hover {
  background: rgba(255,255,255,0.3);
}
.topbar .user-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.topbar .user-info:hover { opacity: 0.8; }
.topbar .user-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255,255,255,0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.toolbar label { font-size: 12px; font-weight: 600; color: #475569; }
.toolbar input[type="text"] {
  padding: 5px 8px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 12px;
  width: 160px;
}
.toolbar input[type="text"]:focus { outline: none; border-color: #0f766e; }
.toolbar button {
  border: 0;
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-weight: 600;
  font-size: 11px;
  background: #0f766e;
  color: #fff;
}
.toolbar button.secondary { background: #64748b; }
.toolbar button:hover { filter: brightness(0.92); }
.toolbar .sep {
  width: 1px;
  height: 20px;
  background: #e5e7eb;
  margin: 0 2px;
}
.search-bar {
  display: flex;
  align-items: center;
  gap: 5px;
}
.search-bar label {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
}
.main {
  display: flex;
  flex: 1;
  min-height: 0;
}
.file-tree {
  width: 250px;
  min-width: 180px;
  border-right: 1px solid #e5e7eb;
  background: #fbfdff;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.file-tree-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 700;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.file-tree-header .mobile-toggle { display: none; }
.file-tree-header .count {
  font-weight: 400;
  color: #94a3b8;
  text-transform: none;
}
.file-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.file-item {
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #334155;
  border-left: 3px solid transparent;
}
.file-item:hover { background: #f0f9ff; }
.file-item.active {
  background: #ecfdf5;
  border-left-color: #0f766e;
  color: #0f766e;
  font-weight: 600;
}
.file-item.dir { color: #64748b; font-style: italic; }
.file-item .toggle-arrow {
  display: inline-block;
  width: 14px;
  text-align: center;
  font-size: 10px;
  flex-shrink: 0;
  color: #94a3b8;
  transition: transform 0.15s;
}
.file-item.dir.expanded .toggle-arrow { transform: rotate(90deg); }
.file-children { margin: 0; padding: 0; }
.file-item.mounted { color: #7c3aed; }
.file-item.mounted .file-icon { opacity: 0.7; }
.file-icon { font-size: 14px; flex-shrink: 0; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.file-tree .empty-msg {
  padding: 20px 12px;
  font-size: 12px;
  color: #94a3b8;
  text-align: center;
}
.content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #fff;
}
.content-header {
  padding: 6px 14px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #f8fafc;
  flex-shrink: 0;
}
.content-header .btn-back {
  display: none;
  border: 0;
  background: none;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 4px;
  color: #0f766e;
  flex-shrink: 0;
}
.content-header .file-path {
  font-size: 12px;
  font-family: Consolas, "Courier New", monospace;
  color: #0f766e;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.content-header .file-revision {
  font-size: 11px;
  color: #94a3b8;
  font-family: Consolas, "Courier New", monospace;
  white-space: nowrap;
  flex-shrink: 0;
}
.content-header .spacer { flex: 0; }
.view-toggle {
  display: flex;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  overflow: hidden;
}
.view-toggle button {
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  border: 0;
  background: #fff;
  color: #64748b;
  cursor: pointer;
  border-radius: 0;
}
.view-toggle button.active { background: #0f766e; color: #fff; }
.content-body {
  flex: 1;
  overflow: auto;
  padding: 0;
  min-height: 0;
  user-select: text;
  -webkit-user-select: text;
}
.content-body pre {
  font-family: Consolas, "Courier New", monospace;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  padding: 12px 14px;
  margin: 0;
  min-height: 100%;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}
.content-body pre.dark { background: #0b1220; color: #d1e3ff; }
.content-body pre.light { background: #fff; color: #1e293b; }
.content-body .md-content {
  font-family: Consolas, "Courier New", monospace;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  padding: 12px 14px;
  margin: 0;
  min-height: 100%;
  background: #fff;
  color: #1e293b;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}
.content-body .md-content .md-heading {
  font-size: 15px;
  font-weight: 700;
  color: #0f766e;
  margin: 4px 0 2px;
}
.content-body .md-content .md-section-title {
  font-weight: 700;
  color: #334155;
}
.toolbar button:disabled { opacity: 0.4; cursor: default; filter: none; }
.edit-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 12px 14px;
}
.edit-section-title {
  font-size: 11px;
  font-weight: 700;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}
.edit-textarea {
  flex: 1;
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 10px 12px;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.6;
  resize: none;
  color: #1e293b;
  min-height: 0;
}
.edit-textarea:focus { outline: none; border-color: #0f766e; }
.content-header .edit-actions { display: flex; gap: 6px; }
.content-header .edit-actions button {
  border: 0;
  border-radius: 6px;
  padding: 5px 14px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.content-header .btn-save { background: #0f766e; color: #fff; }
.content-header .btn-cancel { background: #64748b; color: #fff; }
.content-header .edit-actions button:hover { filter: brightness(0.92); }
.content-header .save-status {
  font-size: 11px;
  color: #16a34a;
  font-weight: 600;
  align-self: center;
}
.content-header .save-status.error { color: #dc2626; }
.content-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #94a3b8;
  font-size: 14px;
}
.login-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.login-overlay .login-card {
  background: #fff;
  border-radius: 12px;
  padding: 32px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
  text-align: center;
  max-width: 360px;
}
.login-overlay .login-card h2 { font-size: 18px; margin-bottom: 8px; }
.login-overlay .login-card p {
  font-size: 13px;
  color: #64748b;
  margin-bottom: 20px;
}
.login-overlay .login-card button {
  border: 0;
  border-radius: 8px;
  padding: 12px 32px;
  background: #0f766e;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.login-overlay .login-card button:hover { filter: brightness(0.92); }
.login-overlay .login-card .skip {
  display: block;
  margin-top: 12px;
  font-size: 12px;
  color: #94a3b8;
  cursor: pointer;
  background: none;
  padding: 0;
}
.login-overlay .login-card .skip:hover { color: #475569; }
.search-results {
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.7;
  font-family: Consolas, "Courier New", monospace;
}
.search-results .sr-file {
  font-weight: 700;
  color: #0f766e;
  margin-top: 8px;
  cursor: pointer;
}
.search-results .sr-file:hover { text-decoration: underline; }
.search-results .sr-line { padding-left: 16px; color: #334155; }
.search-results .sr-line .sr-num {
  color: #94a3b8;
  margin-right: 6px;
  user-select: none;
}
.search-results .sr-empty { color: #94a3b8; font-style: italic; }
.wv-root.compact .topbar { padding: 5px 12px; }
.wv-root.compact .topbar h1 { font-size: 13px; }
.wv-root.compact .toolbar { padding: 4px 12px; }
.wv-root.compact .file-tree { width: 220px; }
.wv-root.hide-topbar .topbar { display: none; }
.wv-root.hide-toolbar .toolbar { display: none; }
@media (max-width: 700px) {
  .file-tree { width: 170px; min-width: 130px; }
}

/* ── Mobile portrait ── */
@media (max-width: 520px) {
  .topbar { padding: 6px 10px; gap: 6px; }
  .topbar h1 { font-size: 13px; }
  .topbar .info { gap: 4px; }
  .topbar .badge { font-size: 10px; padding: 2px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; min-width: 0; }
  .topbar .user-info { font-size: 11px; }

  .toolbar { padding: 4px 8px; gap: 4px; }
  .toolbar button { padding: 5px 8px; font-size: 10px; }
  .toolbar input[type="text"] { width: 80px; font-size: 11px; padding: 4px 6px; }
  .toolbar .search-bar { width: 100%; flex-wrap: wrap; gap: 4px; }
  .toolbar label { font-size: 11px; }

  .main { flex-direction: column; }

  .file-tree {
    width: 100% !important;
    min-width: 0;
    border-right: none;
    border-bottom: 1px solid #e5e7eb;
    max-height: 40vh;
    flex-shrink: 0;
  }
  .file-tree.collapsed {
    max-height: 0;
    overflow: hidden;
    border-bottom: none;
  }
  .file-tree-header { cursor: pointer; }
  .file-tree-header .mobile-toggle { display: inline-block; font-size: 10px; margin-left: 4px; color: #94a3b8; }

  .content-area { min-height: 0; flex: 1; }
  .content-header { padding: 5px 8px; gap: 6px; flex-wrap: wrap; }
  .content-header .btn-back { display: block; }
  .content-header .file-path { font-size: 11px; min-width: 0; flex: 1; }
  .view-toggle button { padding: 3px 7px; font-size: 10px; }
  .content-header .edit-actions button { padding: 4px 10px; font-size: 10px; }

  .content-body pre { font-size: 11px; padding: 8px 10px; }
  .content-body .md-content { font-size: 11px; padding: 8px 10px; }
  .edit-container { padding: 8px 10px; }
  .edit-textarea { font-size: 11px; }

  .search-results { padding: 8px 10px; font-size: 12px; }

  .login-overlay .login-card { margin: 16px; padding: 24px 16px; }
}
`;

const WORKSPACE_VIEWER_TEMPLATE = `
<div class="wv-root">
  <div id="loginOverlay" class="login-overlay" style="display:none;">
    <div class="login-card">
      <h2>Login Required</h2>
      <p>Sign in to access your workspace files.</p>
      <button id="btnLogin">Login</button>
      <span class="skip" id="btnSkipLogin">Continue without login</span>
    </div>
  </div>

  <div class="topbar">
    <div class="spacer"></div>
    <div class="info">
      <span class="badge" id="badgeWorkspace"></span>
      <span class="badge" id="badgeMount" style="display:none;"></span>
    </div>
    <div class="user-info" id="userInfo" style="display:none;">
      <div class="user-avatar" id="userAvatar"></div>
      <span id="userName"></span>
    </div>
  </div>

  <div class="toolbar">
    <button id="btnRefresh" class="secondary">Refresh</button>
    <button id="btnNewFile" class="secondary">+ New File</button>
    <button id="btnOpenFile" class="secondary">Open…</button>
    <button id="btnDeleteFile" class="secondary">Delete</button>
    <div class="sep"></div>
    <div class="search-bar">
      <label>Search:</label>
      <input type="text" id="inputSearch" placeholder="Search in files..." />
      <input type="text" id="inputSearchFile" placeholder="File filter" style="width:120px;" />
      <label style="font-weight:400;"><input type="checkbox" id="chkRegex" /> Regex</label>
      <button id="btnSearch" class="secondary">Go</button>
    </div>
  </div>

  <div class="main">
    <div class="file-tree">
      <div class="file-tree-header" id="fileTreeHeader">
        <span>Files <span class="mobile-toggle" id="mobileToggle">▼</span></span>
        <span class="count" id="fileCount">0</span>
      </div>
      <div class="file-list" id="fileList">
        <div class="empty-msg">Loading...</div>
      </div>
    </div>

    <div class="content-area">
      <div class="content-header">
        <button class="btn-back" id="btnBack">◀</button>
        <span class="file-path" id="filePath">(no file selected)</span>
        <span class="file-revision" id="fileRevision"></span>
        <div class="spacer"></div>
        <span class="save-status" id="saveStatus"></span>
        <div class="edit-actions" id="editActions" style="display:none;">
          <button class="btn-save" id="btnSave">Save</button>
          <button class="btn-cancel" id="btnCancelEdit">Cancel</button>
        </div>
        <div class="view-toggle" id="viewToggle">
          <button id="btnViewContent" class="active">Content</button>
          <button id="btnViewRaw">Raw YAML</button>
          <button id="btnEdit">Edit</button>
        </div>
      </div>
      <div class="content-body" id="contentBody">
        <div class="content-placeholder">Select a file from the left panel</div>
      </div>
    </div>
  </div>
</div>
`;

export class WorkspaceViewer {
  sdk: WVSdk;
  StorageUtil: unknown;
  options: WVResolvedOptions;
  currentWorkspace: string;
  displayNameMap: Record<string, string>;
  hiddenPageRoots: string[];
  _state: WVState;
  container: HTMLElement;
  shadowRoot: ShadowRoot;
  root!: HTMLElement;
  dom!: Record<string, HTMLElement & Record<string, unknown>>;
  _handlers!: Record<string, EventListener>;

  constructor(options: WorkspaceViewerOptions = {}) {
    const {
      container,
      sdk = (window as unknown as { keepwork: WVSdk }).keepwork,
      workspace = "workspace_default",
      mountFolder = "",
      file = "",
      hideTopbar = false,
      hideToolbar = false,
      compact = false,
      displayNameMap = {},
      hiddenPageRoots = [],
      readOnly = false,
      hideUserInfo = false,
      hideSearch = false,
      hideNewFile = false,
      hideOpenFile = false,
      hideDelete = false,
      hideRawView = false,
      allowChangeWorkspace = false,
      allowChangeMount = false,
    } = options;

    const sdkTyped = sdk as WVSdk;
    if (!container) throw new Error("WorkspaceViewer requires a container element");
    if (!sdkTyped) throw new Error("KeepworkSDK not initialized - window.keepwork is missing");
    if (!sdkTyped.personalPageStore) throw new Error("KeepworkSDK personalPageStore is missing");

    this.sdk = sdkTyped;
    this.StorageUtil = (window as unknown as { StorageUtil: unknown }).StorageUtil;
    this.options = { workspace, mountFolder, file, hideTopbar, hideToolbar, compact,
      readOnly, hideUserInfo, hideSearch, hideNewFile, hideOpenFile, hideDelete, hideRawView,
      allowChangeWorkspace, allowChangeMount } as WVResolvedOptions;
    this.currentWorkspace = workspace as string;
    this.displayNameMap = displayNameMap as Record<string, string>;
    this.hiddenPageRoots = hiddenPageRoots as string[];

    this._state = {
      selectedFile: null,
      viewMode: "content",
      fileItems: [],
      isMounted: false,
      mountedPageSet: null,
      selectedFolder: null,
      expandedFolders: new Set(),
      folderChildren: {},
      editPageData: null,
      absFiles: [],
    };

    this.container = container;
    this.shadowRoot = container.shadowRoot || container.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${WORKSPACE_VIEWER_STYLE}</style>${WORKSPACE_VIEWER_TEMPLATE}`;

    this.root = this.shadowRoot.querySelector(".wv-root") as HTMLElement;
    this._bindDom();
    this._bindEvents();
    this._applyLayoutModes();
    this._applyFeatureFlags();
    this._initBadges();
    this.initLogin();
  }

  _bindDom(): void {
    const q = (id: string): HTMLElement => this.shadowRoot.getElementById(id) as HTMLElement;
    this.dom = ({
      loginOverlay: q("loginOverlay"),
      btnLogin: q("btnLogin"),
      btnSkipLogin: q("btnSkipLogin"),
      userInfo: q("userInfo"),
      userAvatar: q("userAvatar"),
      userNameEl: q("userName"),
      badgeWorkspace: q("badgeWorkspace"),
      badgeMount: q("badgeMount"),
      btnRefresh: q("btnRefresh"),
      btnNewFile: q("btnNewFile"),
      btnOpenFile: q("btnOpenFile"),
      btnDeleteFile: q("btnDeleteFile"),
      fileList: q("fileList"),
      fileCount: q("fileCount"),
      filePath: q("filePath"),
      contentBody: q("contentBody"),
      btnViewContent: q("btnViewContent"),
      btnViewRaw: q("btnViewRaw"),
      btnEdit: q("btnEdit"),
      btnSave: q("btnSave"),
      btnCancelEdit: q("btnCancelEdit"),
      editActions: q("editActions"),
      viewToggle: q("viewToggle"),
      btnBack: q("btnBack"),
      fileRevision: q("fileRevision"),
      saveStatus: q("saveStatus"),
      inputSearch: q("inputSearch"),
      inputSearchFile: q("inputSearchFile"),
      chkRegex: q("chkRegex"),
      btnSearch: q("btnSearch"),
      topbarTitle: this.shadowRoot.querySelector(".topbar h1") as HTMLElement,
      fileTree: this.shadowRoot.querySelector(".file-tree") as HTMLElement,
      fileTreeHeader: q("fileTreeHeader"),
      mobileToggle: q("mobileToggle"),
    }) as unknown as Record<string, HTMLElement & Record<string, unknown>>;
  }

  _bindEvents(): void {
    const d = this.dom;
    this._handlers = {
      onLogin: async () => {
        try {
          const response = await this.sdk.showLoginWindow({ title: "Workspace Viewer Login" });
          if (response && response.token) {
            d.loginOverlay.style.display = "none";
            const profile = await this.sdk.getUserProfile({ forceRefresh: true });
            this.showUser(profile);
            await this.startWorkspace();
          }
        } catch (_e) {
          // cancelled
        }
      },
      onSkipLogin: async () => {
        d.loginOverlay.style.display = "none";
        this.showUser(null);
        await this.startWorkspace();
      },
      onRefresh: () => { void this.refreshWorkspace(); },
      onSearch: () => { void this.runSearch(); },
      onSearchEnter: (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") void this.runSearch();
      },
      onViewContent: () => this.setViewMode("content"),
      onViewRaw: () => this.setViewMode("raw"),
      onEdit: () => {
        if (this.options.readOnly || !this._state.selectedFile) return;
        this.setViewMode("edit");
      },
      onCancelEdit: () => this.setViewMode("content"),
      onSave: () => this.saveEdit(),
      onNewFile: () => { if (!this.options.readOnly) this.createNewFile(); },
      onOpenFile: () => this._promptOpenFile(),
      onDeleteFile: () => { if (!this.options.readOnly) this.deleteSelected(); },
      onUserInfoClick: () => {
        if (this.sdk.token) this.sdk.showProfileWindow();
      },
      onWorkspaceClick: () => this._promptChangeWorkspace(),
      onMountClick: () => this._promptChangeMount(),
    };

    d.btnLogin.addEventListener("click", this._handlers.onLogin);
    d.btnSkipLogin.addEventListener("click", this._handlers.onSkipLogin);
    d.badgeWorkspace.addEventListener("click", this._handlers.onWorkspaceClick);
    d.badgeMount.addEventListener("click", this._handlers.onMountClick);
    d.fileTreeHeader.addEventListener("click", () => this._toggleFileTreeMobile());
    d.btnRefresh.addEventListener("click", this._handlers.onRefresh);
    d.btnOpenFile.addEventListener("click", this._handlers.onOpenFile);
    d.btnSearch.addEventListener("click", this._handlers.onSearch);
    d.inputSearch.addEventListener("keydown", this._handlers.onSearchEnter);
    d.btnViewContent.addEventListener("click", this._handlers.onViewContent);
    d.btnViewRaw.addEventListener("click", this._handlers.onViewRaw);
    d.btnEdit.addEventListener("click", this._handlers.onEdit);
    d.btnCancelEdit.addEventListener("click", this._handlers.onCancelEdit);
    d.btnSave.addEventListener("click", this._handlers.onSave);
    d.btnNewFile.addEventListener("click", this._handlers.onNewFile);
    d.btnDeleteFile.addEventListener("click", this._handlers.onDeleteFile);
    d.btnBack.addEventListener("click", () => this._expandFileTreeMobile());
    d.userInfo.addEventListener("click", this._handlers.onUserInfoClick);
  }

  _applyFeatureFlags() {
    const o = this.options;
    const hide = (el: Element | null | undefined): void => { if (el) (el as HTMLElement).style.display = "none"; };
    if (o.hideUserInfo) hide(this.dom.userInfo);
    if (o.hideSearch) {
      hide(this.dom.inputSearch);
      hide(this.dom.inputSearchFile);
      hide(this.dom.btnSearch);
      hide(this.dom.chkRegex?.parentElement);
      // hide the separator before search bar
      const sep = this.dom.btnDeleteFile?.nextElementSibling;
      if (sep && sep.classList.contains("sep")) hide(sep);
    }
    if (o.readOnly || o.hideNewFile) hide(this.dom.btnNewFile);
    if (o.hideOpenFile) hide(this.dom.btnOpenFile);
    if (o.readOnly || o.hideDelete) hide(this.dom.btnDeleteFile);
    if (o.readOnly) hide(this.dom.btnEdit);
    if (o.hideRawView) hide(this.dom.btnViewRaw);
  }

  _applyLayoutModes() {
    const { hideTopbar, hideToolbar, compact } = this.options;
    if (hideTopbar) this.root.classList.add("hide-topbar");
    if (hideToolbar) this.root.classList.add("hide-toolbar");
    if (compact) this.root.classList.add("compact");
  }

  _initBadges() {
    this._updateBadges();
  }

  _updateBadges() {
    const ws = this.currentWorkspace;
    const mf = this.options.mountFolder;
    this.dom.badgeWorkspace.textContent = ws;
    if (this.options.allowChangeWorkspace) {
      this.dom.badgeWorkspace.classList.add("clickable");
      this.dom.badgeWorkspace.title = "Click to change workspace";
    } else {
      this.dom.badgeWorkspace.classList.remove("clickable");
      this.dom.badgeWorkspace.title = "";
    }
    if (mf) {
      this.dom.badgeMount.textContent = "\uD83D\uDCE6 " + mf;
      this.dom.badgeMount.style.display = "";
    } else if (this.options.allowChangeMount) {
      this.dom.badgeMount.textContent = "\uD83D\uDCE6 (no mount)";
      this.dom.badgeMount.style.display = "";
    } else {
      this.dom.badgeMount.style.display = "none";
    }
    if (this.options.allowChangeMount) {
      this.dom.badgeMount.classList.add("clickable");
      this.dom.badgeMount.title = "Click to set mount folder";
    } else {
      this.dom.badgeMount.classList.remove("clickable");
      this.dom.badgeMount.title = "";
    }
  }

  async initLogin() {
    if (this.sdk.token) {
      try {
        const profile = await this.sdk.getUserProfile({ forceRefresh: true });
        this.showUser(profile);
        await this.startWorkspace();
        return;
      } catch (_e) {
        // token invalid
      }
    }
    this.dom.loginOverlay.style.display = "";
  }

  showUser(profile: Record<string, unknown> | null): void {
    if (profile && profile.username) {
      this.dom.userInfo.style.display = "";
      const name = String(profile.nickname || profile.username);
      this.dom.userNameEl.textContent = name;
      this.dom.userAvatar.textContent = (name[0] || "?").toUpperCase();
      return;
    }
    this.dom.userInfo.style.display = "";
    this.dom.userNameEl.textContent = "anonymous";
    this.dom.userAvatar.textContent = "?";
  }

  _promptChangeWorkspace() {
    if (!this.options.allowChangeWorkspace) return;
    const value = window.prompt("Workspace name:", this.currentWorkspace);
    if (value === null) return;
    const ws = value.trim();
    if (!ws || ws === this.currentWorkspace) return;
    void this.switchWorkspace(ws);
  }

  _promptChangeMount() {
    if (!this.options.allowChangeMount) return;
    const current = this.options.mountFolder || "";
    const value = window.prompt("Mount folder (username/sitename/path, empty to clear):", current);
    if (value === null) return;
    void this.setMountFolder(value.trim());
  }

  async _promptOpenFile() {
    const value = window.prompt("File path (e.g. notes.md or //user/site/page):");
    if (value === null) return;
    const path = value.trim();
    if (!path) return;
    // Absolute path: starts with / or //
    if (path.startsWith("/")) {
      const ok = await this.addAbsoluteFile(path);
      if (!ok) window.alert("File not found: " + path);
      return;
    }
    // Relative path: select within current workspace
    await this.selectFile(path);
  }

  async switchWorkspace(workspace: string): Promise<void> {
    this.currentWorkspace = workspace;
    this.options.workspace = workspace;
    this._state.absFiles = [];
    this._updateBadges();
    await this.loadWorkspace();
  }

  async setMountFolder(mountFolder: string): Promise<void> {
    this.options.mountFolder = mountFolder || "";
    this._state.isMounted = Boolean(mountFolder);
    this._state.absFiles = [];
    this._updateBadges();
    await this.loadWorkspace();
  }

  _getMountedStore() {
    if (!this.options.mountFolder) return this._getLocalStore();
    return this.sdk.personalPageStore.withWorkspace(this.currentWorkspace, this.options.mountFolder);
  }

  _getLocalStore() {
    return this.sdk.personalPageStore.withWorkspace(this.currentWorkspace, null);
  }

  async startWorkspace() {
    if (this.options.mountFolder) {
      this._state.isMounted = true;
    } else {
      this._state.isMounted = false;
    }
    await this.loadWorkspace();
    if (this.options.file) {
      await this.selectFile(this.options.file);
    }
  }

  async loadWorkspace() {
    this._state.selectedFile = null;
    this._state.selectedFolder = null;
    this._state.expandedFolders.clear();
    this._state.folderChildren = {};
    this.dom.filePath.textContent = "(no file selected)";
    this.dom.contentBody.innerHTML = '<div class="content-placeholder">Loading files...</div>';

    try {
      const mountedStore = this._getMountedStore();
      const listing = await mountedStore.listDir(".");
      let pages = listing ? listing.split("\n").filter(Boolean) : [];
      pages = this._filterVisibleEntries(pages, "");

      if (this._state.isMounted && mountedStore.mountedFolder) {
        const localListing = await this._getLocalStore().listDir(".");
        const localPages = new Set(
          localListing && !localListing.startsWith("Directory is empty")
            ? localListing.split("\n").filter(Boolean)
            : []
        );
        this._state.mountedPageSet = new Set();
        for (const page of pages) {
          if (!page.endsWith("/") && !localPages.has(page)) {
            this._state.mountedPageSet.add(page.replace(/\.md$/, ""));
          }
        }
      } else {
        this._state.mountedPageSet = null;
      }

      // Merge workspace pages + absolute-path files
      const allPages = pages.slice();
      for (const af of this._state.absFiles) {
        if (!allPages.includes(af)) allPages.push(af);
      }
      this._state.fileItems = allPages.sort((a, b) => {
        const aAbs = a.startsWith("/");
        const bAbs = b.startsWith("/");
        const aDir = a.endsWith("/");
        const bDir = b.endsWith("/");
        if (aDir !== bDir) return aDir ? -1 : 1;
        if (aAbs !== bAbs) return aAbs ? 1 : -1;
        return a.localeCompare(b);
      });
      this.renderFileList();
      this._syncToolbar();
      if (!this.options.file) {
        this.dom.contentBody.innerHTML = '<div class="content-placeholder">Select a file from the left panel</div>';
      }
    } catch (err) {
      console.error("Failed to list pages:", err);
      this.dom.fileList.innerHTML = '<div class="empty-msg">Error loading files.</div>';
      this.dom.fileCount.textContent = "0";
    }
  }

  renderFileList() {
    this.dom.fileCount.textContent = String(this._getLoadedFileCount());
    if (this._state.fileItems.length === 0) {
      this.dom.fileList.innerHTML = '<div class="empty-msg">Workspace is empty.</div>';
      return;
    }
    this.dom.fileList.innerHTML = "";
    this.renderItems(this._state.fileItems, this.dom.fileList, 0, "");
  }

  renderItems(items: string[], container: HTMLElement, depth: number, parentPath: string): void {
    for (const name of items) {
      const isDir = name.endsWith("/");
      const fullPath = parentPath + name;
      const isAbsFile = name.startsWith("/");
      const isMountedFile = !isDir && !isAbsFile && this._state.isMounted && this._state.mountedPageSet && this._state.mountedPageSet.has(fullPath.replace(/\.md$/, ""));
      const isExpanded = isDir && this._state.expandedFolders.has(fullPath);

      const el = document.createElement("div");
      el.className = "file-item"
        + (isDir ? " dir" : "")
        + (isExpanded ? " expanded" : "")
        + (isMountedFile ? " mounted" : "")
        + ((fullPath === this._state.selectedFile || fullPath === this._state.selectedFolder) ? " active" : "");
      el.style.paddingLeft = (12 + depth * 16) + "px";

      const arrow = isDir
        ? '<span class="toggle-arrow">\u25B6</span>'
        : '<span style="width:14px;display:inline-block;"></span>';
      const icon = isDir ? "\uD83D\uDCC1" : (isAbsFile ? "\uD83C\uDF10" : (isMountedFile ? "\uD83D\uDD17" : "\uD83D\uDCC4"));
      el.innerHTML = arrow
        + '<span class="file-icon">' + icon + '</span>'
        + '<span class="file-name">' + this.escapeHtml(this._getDisplayName(name, parentPath)) + '</span>';

      if (isDir) {
        el.addEventListener("click", () => {
          this._state.selectedFile = null;
          this._state.selectedFolder = fullPath;
          this.toggleFolder(fullPath, el, depth);
          this.dom.filePath.textContent = this.currentWorkspace + "/" + fullPath;
          this.dom.contentBody.innerHTML = '<div class="content-placeholder">Directory: ' + this.escapeHtml(fullPath) + '</div>';
          this.shadowRoot.querySelectorAll(".file-item.active").forEach((x) => x.classList.remove("active"));
          el.classList.add("active");
        });
      } else {
        el.addEventListener("click", () => {
          this._state.selectedFolder = null;
          this.selectFile(parentPath + name);
        });
      }
      container.appendChild(el);

      if (isExpanded && this._state.folderChildren[fullPath]) {
        const childContainer = document.createElement("div");
        childContainer.className = "file-children";
        childContainer.dataset.folder = fullPath;
        this.renderItems(this._state.folderChildren[fullPath], childContainer, depth + 1, fullPath);
        container.appendChild(childContainer);
      }
    }
  }

  async toggleFolder(folderPath: string, el: HTMLElement, depth: number): Promise<void> {
    if (this._state.expandedFolders.has(folderPath)) {
      this._state.expandedFolders.delete(folderPath);
      const next = el.nextElementSibling as HTMLElement | null;
      if (next && next.classList.contains("file-children") && next.dataset.folder === folderPath) {
        next.remove();
      }
      el.classList.remove("expanded");
      return;
    }
    this._state.expandedFolders.add(folderPath);
    el.classList.add("expanded");

    if (!this._state.folderChildren[folderPath]) {
      const dirPath = folderPath.replace(/\/$/, "");
      const mountedStore = this._getMountedStore();
      const listing = await mountedStore.listDir(dirPath);
      const rawChildren = listing ? listing.split("\n").filter(Boolean) : [];
      this._state.folderChildren[folderPath] = this._filterVisibleEntries(rawChildren, folderPath).sort((a, b) => {
        const aDir = a.endsWith("/");
        const bDir = b.endsWith("/");
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      });

      if (this._state.isMounted && mountedStore.mountedFolder && this._state.mountedPageSet) {
        const localListing = await this._getLocalStore().listDir(dirPath);
        const localChildren = new Set(
          localListing && !localListing.startsWith("Directory is empty")
            ? localListing.split("\n").filter(Boolean)
            : []
        );
        for (const child of this._state.folderChildren[folderPath]) {
          if (!child.endsWith("/") && !localChildren.has(child)) {
            this._state.mountedPageSet.add((folderPath + child).replace(/\.md$/, ""));
          }
        }
      }
    }

    const childContainer = document.createElement("div");
    childContainer.className = "file-children";
    childContainer.dataset.folder = folderPath;
    this.renderItems(this._state.folderChildren[folderPath], childContainer, depth + 1, folderPath);
    el.after(childContainer);
  }

  async selectFile(name: string): Promise<void> {
    this._state.selectedFile = name;
    this._state.selectedFolder = null;
    this._syncToolbar();
    if (this._state.viewMode === "edit") {
      this._state.viewMode = "content";
      this._state.editPageData = null;
      this.syncViewModeUI();
    }
    this.renderFileList();
    this.dom.filePath.textContent = name.startsWith("/") ? name : this.currentWorkspace + "/" + name;
    this._collapseFileTreeMobile();
    await this.renderContent();
  }

  async loadFileData(): Promise<WVPageData> {
    const selectedFile = this._state.selectedFile as string;
    // Handle absolute-path files
    if (selectedFile.startsWith("/")) {
      const content = await this._getLocalStore().readFile(selectedFile);
      return (content && !content.startsWith("File not found:")) ? { content } : null;
    }
    const store = this._getLocalStore();
    let data = await store.loadPageData(selectedFile, null, false, true) as WVPageData;
    if ((data === null || data === undefined) && this._state.isMounted) {
      const mountedContent = await this._getMountedStore()._readMountedFile(selectedFile);
      if (mountedContent !== null) data = { content: mountedContent };
    }
    // `loadPageData(key=null)` may return only the pending "updated" slice which
    // lacks `_metadata`. Fall back to the merged page data so the revision info
    // (version / updated_at) reflects the latest saved state.
    if (data && typeof data === "object" && !data._metadata && !data.metadata) {
      try {
        const meta = await store.loadPageData(selectedFile, "_metadata", false, true);
        if (meta && typeof meta === "object") (data as Record<string, unknown>)._metadata = meta;
      } catch { /* ignore metadata lookup errors */ }
    }
    return data;
  }

  _updateRevisionInfo(data: WVPageData): void {
    if (!this.dom.fileRevision) return;
    if (!data || typeof data !== "object") {
      this.dom.fileRevision.textContent = "";
      return;
    }
    const m = (data._metadata || data.metadata) as Record<string, unknown> | undefined;
    if (!m) {
      this.dom.fileRevision.textContent = "";
      return;
    }
    const ver = m.version ? "v" + m.version : "";
    const time = (m.updated_at as string) || "";
    this.dom.fileRevision.textContent = [ver, time].filter(Boolean).join(", ");
  }

  async renderContent(): Promise<void> {
    if (!this._state.selectedFile) {
      this.dom.contentBody.innerHTML = '<div class="content-placeholder">Select a file from the left panel</div>';
      this._updateRevisionInfo(null);
      return;
    }
    this.dom.contentBody.innerHTML = '<div class="content-placeholder">Loading...</div>';

    try {
      if (this._state.viewMode === "edit") {
        await this.renderEditView();
      } else if (this._state.viewMode === "content") {
        const data = await this.loadFileData();
        this._updateRevisionInfo(data);
        const isMarkdown = this._isMarkdownFile(this._state.selectedFile) || this._state.selectedFile.startsWith("/");

        if (isMarkdown) {
          const viewer = document.createElement("div");
          viewer.className = "md-content";
          let html = "";
          let contentText = "";
          if (data && typeof data === "object") {
            const { content, _metadata, ...meta } = data;
            if (Object.keys(meta).length > 0) {
              html += '<div class="md-section-title">\u2500\u2500 Metadata \u2500\u2500</div>';
              for (const [k, v] of Object.entries(meta)) {
                html += "<div>" + this.escapeHtml(k + ": " + this.formatValue(v)) + "</div>";
              }
              html += "<div>&nbsp;</div>";
            }
            contentText = (content !== undefined && content !== null) ? String(content) : "";
          } else if (data !== null && data !== undefined) {
            contentText = String(data);
          }
          if (!contentText && !html) {
            html = "<div>(empty page)</div>";
          } else {
            html += this._formatMarkdownContent(contentText);
          }
          viewer.innerHTML = html;
          this.dom.contentBody.innerHTML = "";
          this.dom.contentBody.appendChild(viewer);
        } else {
          const pre = document.createElement("pre");
          pre.className = "light";
          if (data && typeof data === "object") {
            const { content, _metadata, ...meta } = data;
            let text = "";
            if (Object.keys(meta).length > 0) {
              text += "\u2500\u2500 Metadata \u2500\u2500\n";
              for (const [k, v] of Object.entries(meta)) {
                text += k + ": " + this.formatValue(v) + "\n";
              }
              text += "\n";
            }
            if (content !== undefined && content !== null) {
              if (text) text += "\u2500\u2500 Content \u2500\u2500\n";
              text += String(content);
            }
            if (!text) text = "(empty page object)";
            pre.textContent = text;
          } else if (data !== null && data !== undefined) {
            pre.textContent = String(data);
          } else {
            pre.textContent = "(no data)";
          }
          this.dom.contentBody.innerHTML = "";
          this.dom.contentBody.appendChild(pre);
        }
      } else {
        // Raw YAML view – use the same cached page data as other views
        const data = await this.loadFileData();
        this._updateRevisionInfo(data);
        let raw = "";
        if (data && typeof data === "object") {
          const YML = (window as unknown as { YMLParser?: { objectToYaml(o: unknown, a: boolean, b: boolean): string } }).YMLParser;
          raw = YML ? YML.objectToYaml(data, true, true) : JSON.stringify(data, null, 2);
        } else if (data !== null && data !== undefined) {
          raw = String(data);
        }
        const pre = document.createElement("pre");
        pre.className = "dark";
        pre.textContent = raw || "(no raw data)";
        this.dom.contentBody.innerHTML = "";
        this.dom.contentBody.appendChild(pre);
      }
    } catch (err) {
      console.error("Failed to load file:", err);
      this.dom.contentBody.innerHTML = '<div class="content-placeholder">Error: ' + this.escapeHtml((err as Error)?.message || String(err)) + '</div>';
    }
  }

  async renderEditView(): Promise<void> {
    const data = await this.loadFileData();
    this._updateRevisionInfo(data);
    let content = "";
    if (data && typeof data === "object") {
      content = data.content !== undefined && data.content !== null ? String(data.content) : "";
    } else if (data !== null && data !== undefined) {
      content = String(data);
    }
    this._state.editPageData = { content };

    const container = document.createElement("div");
    container.className = "edit-container";

    const textarea = document.createElement("textarea");
    textarea.className = "edit-textarea";
    textarea.id = "editContentArea";
    textarea.value = content;
    textarea.addEventListener("input", () => {
      if (this._state.editPageData) this._state.editPageData.content = textarea.value;
    });

    container.appendChild(textarea);
    this.dom.contentBody.innerHTML = "";
    this.dom.contentBody.appendChild(container);
  }

  syncViewModeUI() {
    const viewMode = this._state.viewMode;
    this.dom.btnViewContent.classList.toggle("active", viewMode === "content");
    this.dom.btnViewRaw.classList.toggle("active", viewMode === "raw");
    this.dom.btnEdit.classList.toggle("active", viewMode === "edit");
    this.dom.editActions.style.display = viewMode === "edit" ? "" : "none";
    this.dom.viewToggle.style.display = viewMode === "edit" ? "none" : "";
    if (viewMode !== "edit") {
      this.dom.saveStatus.textContent = "";
      this.dom.saveStatus.className = "save-status";
    }
  }

  setViewMode(mode: 'content' | 'raw' | 'edit'): void {
    this._state.viewMode = mode;
    if (mode !== "edit") this._state.editPageData = null;
    this.syncViewModeUI();
    void this.renderContent();
  }

  async addAbsoluteFile(absPath: string): Promise<boolean> {
    if (!absPath) return false;
    if (!absPath.startsWith("/")) absPath = "/" + absPath;
    if (this._state.absFiles.includes(absPath)) {
      await this.selectFile(absPath);
      return true;
    }
    const localStore = this._getLocalStore();
    const result = await localStore.readFile(absPath);
    if (result && !result.startsWith("File not found:")) {
      this._state.absFiles.push(absPath);
      await this.loadWorkspace();
      await this.selectFile(absPath);
      return true;
    }
    return false;
  }

  async saveEdit(): Promise<void> {
    if (!this._state.selectedFile || !this._state.editPageData) return;
    this.dom.saveStatus.textContent = "Saving...";
    this.dom.saveStatus.className = "save-status";
    try {
      await this._getLocalStore().savePageData(this._state.selectedFile, "content", this._state.editPageData.content, true, true);
      try {
        const updated = await this.loadFileData();
        this._updateRevisionInfo(updated);
      } catch { /* ignore revision refresh errors */ }
      this.dom.saveStatus.textContent = "Saved";
      this.dom.saveStatus.className = "save-status";
      setTimeout(() => {
        if (this._state.viewMode !== "edit") return;
        this.dom.saveStatus.textContent = "";
      }, 2000);
    } catch (err) {
      console.error("Save failed:", err);
      this.dom.saveStatus.textContent = "Error: " + ((err as Error)?.message || err);
      this.dom.saveStatus.className = "save-status error";
    }
  }

  async runSearch(): Promise<void> {
    const query = (this.dom.inputSearch as unknown as HTMLInputElement).value.trim();
    if (!query) return;
    const isRegexp = (this.dom.chkRegex as unknown as HTMLInputElement).checked;
    const fileFilter = (this.dom.inputSearchFile as unknown as HTMLInputElement).value.trim() || undefined;
    this._state.selectedFile = null;
    this.renderFileList();
    this.dom.filePath.textContent = "Search: " + query;
    this.dom.contentBody.innerHTML = '<div class="content-placeholder">Searching...</div>';

    try {
      const result = await this._getLocalStore().grepSearch(query, isRegexp, fileFilter);
      const container = document.createElement("div");
      container.className = "search-results";

      if (!result || result === "No matches found.") {
        container.innerHTML = '<div class="sr-empty">No matches found.</div>';
      } else {
        const lines = result.split("\n");
        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith("  L")) {
            const div = document.createElement("div");
            div.className = "sr-line";
            const match = line.match(/^\s*L(\d+):\s(.*)$/);
            if (match) {
              const numSpan = document.createElement("span");
              numSpan.className = "sr-num";
              numSpan.textContent = "L" + match[1];
              div.appendChild(numSpan);
              div.appendChild(document.createTextNode(match[2]));
            } else {
              div.textContent = line;
            }
            container.appendChild(div);
          } else if (line.endsWith(":")) {
            const div = document.createElement("div");
            div.className = "sr-file";
            const fileName = line.slice(0, -1);
            div.textContent = fileName;
            div.addEventListener("click", () => { void this.selectFile(fileName); });
            container.appendChild(div);
          }
        }
      }
      this.dom.contentBody.innerHTML = "";
      this.dom.contentBody.appendChild(container);
    } catch (err) {
      console.error("Search failed:", err);
      this.dom.contentBody.innerHTML = '<div class="content-placeholder">Error: ' + this.escapeHtml((err as Error)?.message || String(err)) + '</div>';
    }
  }

  async createNewFile(): Promise<void> {
    const name = window.prompt("New file name (e.g. notes.md):");
    if (!name || !name.trim()) return;
    const pageName = name.trim();
    const existing = await this._getLocalStore().loadPageData(pageName, null, false, true);
    if (existing !== null && existing !== undefined) {
      window.alert('"' + pageName + '" already exists.');
      return;
    }
    await this._getLocalStore().savePageData(pageName, "content", "", true, true);
    await this.loadWorkspace();
    this.selectFile(pageName);
  }

  async deleteSelected(): Promise<void> {
    if (this._state.selectedFolder) {
      const dirPath = this._state.selectedFolder.replace(/\/$/, "");
      const listing = await this._getLocalStore().listDir(dirPath, true);
      if (!listing || listing.startsWith("Directory is empty")) {
        window.alert("Directory is empty or not found.");
        return;
      }
      const files = listing.split("\n").filter((f) => f && !f.endsWith("/"));
      if (files.length === 0) {
        window.alert("No files found in directory.");
        return;
      }
      if (!window.confirm('Delete directory "' + dirPath + '" and all ' + files.length + ' file(s) inside from workspace "' + this.currentWorkspace + '"?')) return;
      for (const file of files) {
        const fullName = dirPath + "/" + file;
        try {
          await this._getLocalStore().clearPageData(fullName);
        } catch (_e) {
          try {
            await this._getLocalStore().clearLocalDisk(fullName);
          } catch (__e) {
            // ignore
          }
        }
      }
      this._state.selectedFolder = null;
      this._state.selectedFile = null;
      this._getLocalStore()._remoteTreeCache = null;
      await this.loadWorkspace();
      return;
    }

    if (this._state.selectedFile) {
      if (!this._isEditableFile(this._state.selectedFile)) {
        window.alert("This file cannot be deleted.");
        return;
      }
      // For absolute files, just remove from the list
      if (this._state.selectedFile.startsWith("/")) {
        this._state.absFiles = this._state.absFiles.filter((f) => f !== this._state.selectedFile);
        this._state.selectedFile = null;
        await this.loadWorkspace();
        return;
      }
      if (!window.confirm('Delete "' + this._state.selectedFile + '" from workspace "' + this.currentWorkspace + '"?')) return;
      try {
        await this._getLocalStore().clearPageData(this._state.selectedFile);
      } catch (_e) {
        await this._getLocalStore().clearLocalDisk(this._state.selectedFile);
      }
      this._state.selectedFile = null;
      this._getLocalStore()._remoteTreeCache = null;
      await this.loadWorkspace();
      return;
    }

    window.alert("No file or directory selected.");
  }

  formatValue(v: unknown): string {
    if (Array.isArray(v)) return JSON.stringify(v);
    if (v && typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  escapeHtml(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Helpers synced from WorkspaceViewerPanel ──

  _getDisplayName(name: string, parentPath: string): string {
    if (this.displayNameMap[name]) return this.displayNameMap[name];
    if (parentPath === "memory/") {
      const m = name.match(/^(\d{4})-(\d{2})\.md$/);
      if (m) return m[1] + "\u5E74" + m[2] + "\u6708";
    }
    return name;
  }

  _filterVisibleEntries(entries: string[], parentPath: string): string[] {
    if (!this.hiddenPageRoots.length) return entries;
    return entries.filter((entry) => {
      const fullPath = (parentPath + entry).replace(/\\/g, "/");
      const normalized = fullPath.replace(/\.md$/, "").replace(/\/$/, "");
      return !this.hiddenPageRoots.some((root) => normalized === root || normalized.startsWith(root + "/"));
    });
  }

  _isMarkdownFile(filePath: string): boolean {
    return typeof filePath === "string" && /\.md$/i.test(filePath);
  }

  _formatMarkdownContent(text: string): string {
    return String(text || "").split("\n").map((line) => {
      const h3 = line.match(/^###\s+(.*)$/);
      if (h3) return '<div class="md-heading">' + this._inlineFormat(h3[1]) + "</div>";
      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) return '<div class="md-heading" style="font-size:16px;">' + this._inlineFormat(h2[1]) + "</div>";
      const h1 = line.match(/^#\s+(.*)$/);
      if (h1) return '<div class="md-heading" style="font-size:18px;">' + this._inlineFormat(h1[1]) + "</div>";
      return "<div>" + (this._inlineFormat(line) || "&nbsp;") + "</div>";
    }).join("");
  }

  _inlineFormat(text: string): string {
    if (!text) return "";
    const escaped = this.escapeHtml(text);
    return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  _isEditableFile(filePath: string | null): boolean {
    if (!filePath) return false;
    if (filePath.startsWith("/")) return true;
    return !this._isMountedFile(filePath);
  }

  _isMountedFile(filePath: string): boolean {
    if (!filePath || !this._state.isMounted || !this._state.mountedPageSet) return false;
    return this._state.mountedPageSet.has(String(filePath).replace(/\.md$/, ""));
  }

  _getLoadedFileCount() {
    let count = this._state.fileItems.filter((item) => !item.endsWith("/")).length;
    for (const children of Object.values(this._state.folderChildren)) {
      count += children.filter((item) => !item.endsWith("/")).length;
    }
    return count;
  }

  _syncToolbar() {
    if (!this.dom || !this.dom.btnDeleteFile) return;
    const sel = this._state.selectedFile;
    const canDelete = !this.options.readOnly && (sel ? this._isEditableFile(sel) : Boolean(this._state.selectedFolder));
    this.dom.btnDeleteFile.disabled = !canDelete;
    if (this.options.readOnly || this.options.hideDelete) this.dom.btnDeleteFile.style.display = "none";
    if (this.options.readOnly || this.options.hideNewFile) this.dom.btnNewFile.style.display = "none";
  }

  async refreshWorkspace() {
    const prev = {
      file: this._state.selectedFile,
      folder: this._state.selectedFolder,
      expanded: new Set(this._state.expandedFolders),
      viewMode: this._state.viewMode,
    };

    try {
      const store = this._getMountedStore();
      if (store._remoteTreeCache !== undefined) store._remoteTreeCache = null;
    } catch (_) { /* ignore */ }

    this.dom.saveStatus.textContent = "Refreshing...";
    this.dom.saveStatus.className = "save-status";

    try {
      await this.loadWorkspace();

      // Restore expanded folders
      for (const folder of prev.expanded) {
        this._state.expandedFolders.add(folder);
        if (!this._state.folderChildren[folder]) {
          const dirPath = folder.replace(/\/$/, "");
          try {
            const listing = await this._getMountedStore().listDir(dirPath);
            const raw = listing ? listing.split("\n").filter(Boolean) : [];
            this._state.folderChildren[folder] = this._filterVisibleEntries(raw, folder).sort((a, b) => {
              const aDir = a.endsWith("/"); const bDir = b.endsWith("/");
              if (aDir !== bDir) return aDir ? -1 : 1;
              return a.localeCompare(b);
            });
          } catch (_) { /* ignore */ }
        }
      }

      // Restore selection
      if (prev.file) {
        this._state.selectedFile = prev.file;
        this._state.viewMode = prev.viewMode;
        this.syncViewModeUI();
        this.dom.filePath.textContent = prev.file.startsWith("/") ? prev.file : this.currentWorkspace + "/" + prev.file;
        if (prev.viewMode !== "edit") await this.renderContent();
      } else if (prev.folder) {
        this._state.selectedFolder = prev.folder;
        this.dom.filePath.textContent = this.currentWorkspace + "/" + prev.folder;
      }

      this.renderFileList();
      this._syncToolbar();
      this.dom.saveStatus.textContent = "Refreshed";
      setTimeout(() => {
        if (this.dom.saveStatus.textContent === "Refreshed") this.dom.saveStatus.textContent = "";
      }, 2000);
    } catch (err) {
      console.error("Refresh failed:", err);
      this.dom.saveStatus.textContent = "Refresh failed";
      this.dom.saveStatus.className = "save-status error";
    }
  }

  _toggleFileTreeMobile() {
    if (!window.matchMedia("(max-width: 520px)").matches) return;
    const tree = this.dom.fileTree;
    const toggle = this.dom.mobileToggle;
    tree.classList.toggle("collapsed");
    toggle.textContent = tree.classList.contains("collapsed") ? "\u25B6" : "\u25BC";
  }

  _collapseFileTreeMobile() {
    if (!window.matchMedia("(max-width: 520px)").matches) return;
    const tree = this.dom.fileTree;
    if (tree && !tree.classList.contains("collapsed")) {
      tree.classList.add("collapsed");
      if (this.dom.mobileToggle) this.dom.mobileToggle.textContent = "\u25B6";
    }
  }

  _expandFileTreeMobile() {
    const tree = this.dom.fileTree;
    if (tree && tree.classList.contains("collapsed")) {
      tree.classList.remove("collapsed");
      if (this.dom.mobileToggle) this.dom.mobileToggle.textContent = "\u25BC";
    }
  }

  destroy() {
    const d = this.dom;
    const h = this._handlers;
    if (!d || !h) return;

    d.btnLogin.removeEventListener("click", h.onLogin);
    d.btnSkipLogin.removeEventListener("click", h.onSkipLogin);
    d.btnRefresh.removeEventListener("click", h.onRefresh);
    d.btnSearch.removeEventListener("click", h.onSearch);
    d.inputSearch.removeEventListener("keydown", h.onSearchEnter);
    d.btnViewContent.removeEventListener("click", h.onViewContent);
    d.btnViewRaw.removeEventListener("click", h.onViewRaw);
    d.btnEdit.removeEventListener("click", h.onEdit);
    d.btnCancelEdit.removeEventListener("click", h.onCancelEdit);
    d.btnSave.removeEventListener("click", h.onSave);
    d.btnNewFile.removeEventListener("click", h.onNewFile);
    d.btnOpenFile.removeEventListener("click", h.onOpenFile);
    d.btnDeleteFile.removeEventListener("click", h.onDeleteFile);
    // btnBack uses inline arrow; no named handler to remove
    d.userInfo.removeEventListener("click", h.onUserInfoClick);
    d.badgeWorkspace.removeEventListener("click", h.onWorkspaceClick);
    d.badgeMount.removeEventListener("click", h.onMountClick);
    if (this.shadowRoot) {
      this.shadowRoot.innerHTML = "";
    }
  }
}

export function createWorkspaceViewer(options: WorkspaceViewerOptions): WorkspaceViewer {
  return new WorkspaceViewer(options);
}

export default WorkspaceViewer;
