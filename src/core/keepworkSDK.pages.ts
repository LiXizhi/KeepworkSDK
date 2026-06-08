/**
 * keepworkSDK.pages.ts — KeepworkSDK 页面与站点管理 mixin（TypeScript 版）
 *
 * 包含：
 * - 页面 CRUD（savePage / loadPage / deletePage / getRawPage / copyPage / pageExists）
 * - 页面服务端缓存操作（savePageCache / loadPageCache）
 * - 站点文件树（getSiteTree）
 * - 站点管理（createSite / getAllSites / getSitesByUsername / getSiteDetail）
 * - 路径编码工具（getRepoPath / encodeRepoPath / safeEncodeURIComponent）
 *
 * 依赖 keepworkSDK.core.ts 注入的 request / get / post / put / delete 方法。
 */

// ──────────────────── 类型定义 ────────────────────

/** savePage 参数 */
export interface SavePageData {
  /** 格式 "username/sitename" */
  sitePath: string;
  /** 页面相对路径（含 .md 扩展名） */
  pagePath: string;
  /** 页面内容 */
  content: string;
  /** git commit 信息（默认自动生成） */
  commitMessage?: string;
  /** 内容编码方式（默认 'utf8'） */
  encoding?: 'utf8' | 'base64';
  /** 404 时自动建站（默认 false） */
  autoCreateSite?: boolean;
  /** 是否写入服务端缓存而非 git（默认 false） */
  useCache?: boolean;
}

/** savePage / loadPage 结果 */
export interface PageResult {
  success: boolean;
  path: string;
  sitePath: string;
  repoPath: string;
  content?: string;
  operation?: 'create' | 'update';
  message?: string;
  autoCreatedSite?: boolean;
  cached?: boolean;
  commitId?: string;
  fromServerCache?: boolean;
  metadata?: PageMetadata;
  error?: string;
  [key: string]: unknown;
}

/** 页面元数据（includeMetadata=true 时返回） */
export interface PageMetadata {
  commitId?: string;
  lastModified?: string;
  size?: number;
  encoding?: string;
  type?: string;
  downloadUrl?: string;
  htmlUrl?: string;
}

/** loadPage 参数 */
export interface LoadPageInfo {
  sitePath: string;
  pagePath: string;
  useCache?: boolean;
  commitId?: string;
  includeMetadata?: boolean;
  cdnState?: boolean;
  useServerCache?: boolean;
}

/** deletePage 参数 */
export interface DeletePageInfo {
  sitePath: string;
  pagePath: string;
  commitMessage?: string;
  /** 跳过存在性检查（默认 false） */
  force?: boolean;
  /** 是否验证文件存在（默认 true） */
  validateExists?: boolean;
  /** 同时清理服务端缓存（默认 false） */
  useCache?: boolean;
}

/** copyPage 参数 */
export interface CopyPageInfo {
  sourceSitePath: string;
  sourcePagePath: string;
  targetSitePath: string;
  targetPagePath: string;
  commitMessage?: string;
}

/** getSiteTree 缓存条目 */
interface SiteTreeCacheEntry {
  data: unknown;
  time: number;
}

/** createSite 参数 */
export interface CreateSiteData {
  name: string;
  username: string;
  visibility?: 'public' | 'private' | 'protected' | number;
  sitename?: string;
  description?: string;
  [key: string]: unknown;
}

// ──────────────────── Mixin 注入 ────────────────────

/**
 * 将页面/站点管理方法注入到 KeepworkSDK 类的 prototype。
 * 调用方式：`applyPagesMixin(KeepworkSDK)`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyPagesMixin(TargetClass: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto: any = TargetClass.prototype;

  // ─────────────── 路径编码工具 ───────────────

  /**
   * 构建 API 使用的 repo 路径（对 "username/sitename" 做 encodeURIComponent）。
   * 遵循 Lua KeepworkReposApi 实现惯例。
   *
   * @param sitePath  - 格式 "username/sitename"
   * @param username  - 可选，覆盖路径中的 username 部分
   * @returns 已编码的 repo 路径，输入无效时返回空字符串
   */
  proto.getRepoPath = function (sitePath: string, username?: string | null): string {
    if (!sitePath || typeof sitePath !== 'string') return '';
    const parts = sitePath.split('/');
    if (parts.length < 2) return '';
    const siteUsername = username ?? parts[0];
    const foldername = parts[1];
    if (!siteUsername || !foldername) return '';
    return encodeURIComponent(`${siteUsername}/${foldername}`);
  };

  /**
   * 对完整 repo 路径做 encodeURIComponent。
   *
   * @param repoPath - 格式 "username/sitename"
   */
  proto.encodeRepoPath = function (repoPath: string): string {
    if (!repoPath || typeof repoPath !== 'string') return '';
    return encodeURIComponent(repoPath);
  };

  /**
   * 安全版 encodeURIComponent（空值/非字符串时返回空字符串）。
   *
   * @param component - 要编码的路径组件
   */
  proto.safeEncodeURIComponent = function (component: string): string {
    if (!component || typeof component !== 'string') return '';
    return encodeURIComponent(component);
  };

  // ─────────────── 页面服务端缓存 ───────────────

  /**
   * 将页面内容写入服务端缓存（pageCache API）。
   *
   * @param repoPath        - 已编码的 repo 路径
   * @param encodedFilePath - 已编码的文件路径
   * @param content         - 页面内容
   */
  proto.savePageCache = async function (
    repoPath: string,
    encodedFilePath: string,
    content: string
  ): Promise<unknown> {
    return this.put(`/pageCache/${repoPath}/files/${encodedFilePath}`, {
      router_params: { repoPath, filePath: encodedFilePath },
      content,
    });
  };

  /**
   * 从服务端缓存读取页面内容。
   *
   * @param repoPath        - 已编码的 repo 路径
   * @param encodedFilePath - 已编码的文件路径
   */
  proto.loadPageCache = async function (
    repoPath: string,
    encodedFilePath: string
  ): Promise<unknown> {
    return this.get(`/pageCache/${repoPath}/files/${encodedFilePath}`);
  };

  // ─────────────── 页面 CRUD ───────────────

  /**
   * 保存（新建或更新）Keepwork 页面。
   *
   * 实现遵循 Lua KeepworkReposApi.AddFile / EditFile 逻辑：
   * - 先尝试 PUT 更新；404 则 POST 创建
   * - 仍 404 且 `autoCreateSite=true` 时自动建站再创建
   *
   * @param pageData - 页面数据
   * @returns 操作结果
   */
  proto.savePage = async function (pageData: SavePageData): Promise<PageResult> {
    const {
      sitePath,
      pagePath,
      content,
      commitMessage = `Save page ${pageData.pagePath}`,
      encoding = 'utf8',
      autoCreateSite = false,
      useCache = false,
    } = pageData;

    if (!sitePath || typeof sitePath !== 'string')
      throw new Error('sitePath is required and must be a string');
    if (!pagePath || typeof pagePath !== 'string')
      throw new Error('pagePath is required and must be a string');
    if (content === undefined || content === null)
      throw new Error('content is required');

    const repoPath = this.getRepoPath(sitePath) as string;
    const encodedFilePath = this.safeEncodeURIComponent(`${sitePath}/${pagePath}`) as string;

    const payload: Record<string, unknown> = { message: commitMessage };
    if (encoding === 'base64') {
      payload['encoding'] = 'base64';
      payload['content'] = btoa(unescape(encodeURIComponent(content)));
    } else {
      payload['content'] = content;
    }

    if (useCache) {
      const response = await this.savePageCache(repoPath, encodedFilePath, content) as Record<string, unknown>;
      return { success: true, path: pagePath, sitePath, repoPath, operation: 'update', message: commitMessage, ...response };
    }

    try {
      const response = await this.put(`/repos/${repoPath}/files/${encodedFilePath}`, payload) as Record<string, unknown>;
      return { success: true, path: pagePath, sitePath, repoPath, operation: 'update', message: commitMessage, ...response };
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('404')) {
        try {
          const response = await this.post(`/repos/${repoPath}/files/${encodedFilePath}`, payload) as Record<string, unknown>;
          return { success: true, path: pagePath, sitePath, repoPath, operation: 'create', message: commitMessage, ...response };
        } catch (createError) {
          const cErr = createError as Error;
          if (autoCreateSite && cErr.message.includes('404')) {
            try {
              const pathParts = sitePath.split('/');
              await this.createSite({
                name: pathParts[1] ?? '',
                username: pathParts[0] ?? '',
                visibility: 'public',
              });
              const response = await this.post(`/repos/${repoPath}/files/${encodedFilePath}`, payload) as Record<string, unknown>;
              return { success: true, path: pagePath, sitePath, repoPath, operation: 'create', autoCreatedSite: true, message: commitMessage, ...response };
            } catch (siteError) {
              throw new Error(`Failed to auto-create site: ${(siteError as Error).message}`);
            }
          }
          throw createError;
        }
      }
      throw error;
    }
  };

  /**
   * 加载 Keepwork 页面内容。
   *
   * 实现遵循 Lua KeepworkReposApi.Raw 方法，支持：
   * - 指定 commitId、CDN 模式、服务端缓存
   * - 返回元数据（includeMetadata=true）
   *
   * @param pageInfo - 页面查询参数
   * @returns 页面结果（含 content 字符串）
   */
  proto.loadPage = async function (pageInfo: LoadPageInfo): Promise<PageResult> {
    const {
      sitePath,
      pagePath,
      useCache = false,
      commitId,
      includeMetadata = false,
      cdnState = false,
      useServerCache = false,
    } = pageInfo;

    if (!sitePath || typeof sitePath !== 'string')
      throw new Error('sitePath is required and must be a string');
    if (!pagePath || typeof pagePath !== 'string')
      throw new Error('pagePath is required and must be a string');

    const repoPath = this.getRepoPath(sitePath) as string;
    const encodedFilePath = this.safeEncodeURIComponent(`${sitePath}/${pagePath}`) as string;

    const params: Record<string, string> = {};
    if (useCache) params['useCache'] = 'true';
    if (cdnState) params['cdnState'] = 'true';

    let commitIdUrl = '';
    if (commitId && typeof commitId === 'string' && commitId.toLowerCase() !== 'master') {
      commitIdUrl = `?commitId=${commitId}`;
      Object.keys(params).forEach((k) => delete params[k]);
    }

    try {
      if (useServerCache) {
        try {
          const cacheResponse = await this.loadPageCache(repoPath, encodedFilePath) as Record<string, unknown> | string;
          if (cacheResponse && (typeof cacheResponse === 'string' || (cacheResponse as Record<string, unknown>)['content'])) {
            return {
              content: typeof cacheResponse === 'string' ? cacheResponse : String((cacheResponse as Record<string, unknown>)['content']),
              path: pagePath, sitePath, repoPath, success: true, fromServerCache: true,
            };
          }
        } catch (cacheError) {
          const cErr = cacheError as Error;
          if (cErr.message.includes('404')) {
            return { content: '', path: pagePath, sitePath, repoPath, success: false, fromServerCache: true };
          }
          console.warn('Failed to load from page cache:', cacheError);
        }
      }

      let response: unknown;
      if (includeMetadata) {
        response = await this.get(`/repos/${repoPath}/files/${encodedFilePath}/info${commitIdUrl}`, commitIdUrl ? {} : params);
      } else {
        response = await this.get(`/repos/${repoPath}/files/${encodedFilePath}/raw${commitIdUrl}`, commitIdUrl ? {} : params);
      }

      const result: PageResult = {
        content: typeof response === 'string' ? response : String((response as Record<string, unknown>)?.['content'] ?? ''),
        path: pagePath,
        sitePath,
        repoPath,
        success: true,
        cached: useCache,
        commitId: commitId ?? 'master',
      };

      if (includeMetadata && typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        result.metadata = {
          commitId: (r['commitId'] ?? r['sha']) as string | undefined,
          lastModified: (r['lastModified'] ?? r['last_commit_date']) as string | undefined,
          size: r['size'] as number | undefined,
          encoding: (r['encoding'] ?? 'utf8') as string,
          type: (r['type'] ?? 'file') as string,
          downloadUrl: r['download_url'] as string | undefined,
          htmlUrl: r['html_url'] as string | undefined,
        };
      }
      return result;
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('404')) throw new Error(`Page not found: ${sitePath}/${pagePath}`);
      throw new Error(`Failed to load page ${sitePath}/${pagePath}: ${msg}`);
    }
  };

  /**
   * 通过完整 URL 或路径字符串读取页面原始内容。
   * 支持 `http(s)://` 完整 URL 和 `"username/sitename/pagename"` 相对路径。
   * 失败时返回 null（不抛出异常）。
   *
   * @param url      - 完整 URL 或相对路径
   * @param useCache - 是否传递 useCache 参数（默认 true）
   */
  proto.getRawPage = async function (
    url: string,
    useCache = true
  ): Promise<string | null> {
    try {
      let urlPath: string;
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const urlObj = new URL(url);
        urlPath = urlObj.pathname.startsWith('/') ? urlObj.pathname.slice(1) : urlObj.pathname;
      } else {
        urlPath = url.startsWith('/') ? url.slice(1) : url;
      }
      if (urlPath.endsWith('.md')) urlPath = urlPath.slice(0, -3);

      const pathParts = urlPath.split('/');
      if (pathParts.length < 3) {
        throw new Error('Invalid page path format. Expected at least: username/sitename/pagename');
      }
      const sitePath = `${pathParts[0]}/${pathParts[1]}`;
      let pagePath = pathParts.slice(2).join('/');
      if (!pagePath.endsWith('.md')) pagePath += '.md';

      const pageData = await this.loadPage({ sitePath, pagePath, useCache }) as PageResult;
      return pageData.content ?? null;
    } catch (error) {
      console.warn(`Failed to load page from URL "${url}": ${(error as Error).message}`);
      return null;
    }
  };

  /**
   * 获取页面 git 提交历史列表。
   *
   * @param pageInfo - 包含 sitePath / pagePath / page / perPage
   */
  proto.getPageHistory = async function (pageInfo: {
    sitePath: string;
    pagePath: string;
    page?: number;
    perPage?: number;
  }): Promise<unknown> {
    const { sitePath, pagePath, page = 1, perPage = 20 } = pageInfo;
    const encodedSitePath = encodeURIComponent(sitePath);
    const encodedPagePath = encodeURIComponent(`${sitePath}/${pagePath}`);
    return this.get(`/repos/${encodedSitePath}/files/${encodedPagePath}/history`, {
      page,
      perPage,
    });
  };

  /**
   * 删除 Keepwork 页面（遵循 Lua KeepworkReposApi.RemoveFile 逻辑）。
   * 默认先验证文件存在性再删除；`force:true` 可跳过验证。
   *
   * @param pageInfo - 删除参数
   */
  proto.deletePage = async function (pageInfo: DeletePageInfo): Promise<PageResult> {
    const {
      sitePath,
      pagePath,
      commitMessage = `Delete page ${pageInfo.pagePath}`,
      force = false,
      validateExists = true,
      useCache = false,
    } = pageInfo;

    if (!sitePath || typeof sitePath !== 'string')
      throw new Error('sitePath is required and must be a string');
    if (!pagePath || typeof pagePath !== 'string')
      throw new Error('pagePath is required and must be a string');

    const repoPath = this.getRepoPath(sitePath) as string;
    const encodedFilePath = this.safeEncodeURIComponent(`${sitePath}/${pagePath}`) as string;

    try {
      if (validateExists && !force) {
        try {
          await this.get(`/repos/${repoPath}/files/${encodedFilePath}/info`);
        } catch (error) {
          const msg = (error as Error).message;
          if (msg.includes('404')) throw new Error(`Page does not exist: ${sitePath}/${pagePath}`);
          throw new Error(`Failed to verify page existence: ${msg}`);
        }
      }

      if (useCache) {
        try {
          await this.delete(`/pageCache/${repoPath}/files/${encodedFilePath}/purge`, { message: commitMessage });
        } catch (error) {
          throw new Error(`Failed to purge cache for page ${sitePath}/${pagePath}: ${(error as Error).message}`);
        }
      }

      const response = await this.delete(`/repos/${repoPath}/files/${encodedFilePath}`, { message: commitMessage }) as Record<string, unknown>;
      return { success: true, path: pagePath, sitePath, repoPath, message: commitMessage, deleted: true, ...response };
    } catch (error) {
      const msg = (error as Error).message;
      throw new Error(
        msg.includes('404')
          ? `Page not found: ${sitePath}/${pagePath}`
          : `Failed to delete page ${sitePath}/${pagePath}: ${msg}`
      );
    }
  };

  /**
   * 检查页面是否存在（请求 `/info` 端点，404 返回 false）。
   *
   * @param pageInfo - 包含 sitePath / pagePath
   */
  proto.pageExists = async function (pageInfo: {
    sitePath: string;
    pagePath: string;
  }): Promise<boolean> {
    const { sitePath, pagePath } = pageInfo;
    if (!sitePath || !pagePath) return false;
    try {
      const encodedSitePath = this.encodeRepoPath(sitePath) as string;
      const encodedPagePath = this.safeEncodeURIComponent(`${sitePath}/${pagePath}`) as string;
      await this.get(`/repos/${encodedSitePath}/files/${encodedPagePath}/info`);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 将页面从一个路径复制到另一个路径（先 loadPage 再 savePage）。
   * 失败时不抛出，返回 `{ success: false, error }`。
   *
   * @param copyInfo - 源路径与目标路径
   */
  proto.copyPage = async function (copyInfo: CopyPageInfo): Promise<PageResult> {
    const {
      sourceSitePath,
      sourcePagePath,
      targetSitePath,
      targetPagePath,
      commitMessage = `Copy page from ${copyInfo.sourcePagePath} to ${copyInfo.targetPagePath}`,
    } = copyInfo;
    try {
      const sourceResult = await this.loadPage({ sitePath: sourceSitePath, pagePath: sourcePagePath }) as PageResult;
      if (!sourceResult.success) throw new Error(`Failed to load source page: ${sourceResult.error ?? 'unknown'}`);
      const targetResult = await this.savePage({
        sitePath: targetSitePath,
        pagePath: targetPagePath,
        content: sourceResult.content ?? '',
        commitMessage,
      }) as PageResult;
      return {
        ...targetResult,
        success: true,
        path: targetPagePath,
        sitePath: targetSitePath,
        repoPath: targetResult.repoPath,
        source: { sitePath: sourceSitePath, pagePath: sourcePagePath },
        target: { sitePath: targetSitePath, pagePath: targetPagePath },
      };
    } catch (error) {
      return {
        success: false,
        path: targetPagePath,
        sitePath: targetSitePath,
        repoPath: '',
        source: { sitePath: sourceSitePath, pagePath: sourcePagePath },
        target: { sitePath: targetSitePath, pagePath: targetPagePath },
        error: (error as Error).message,
      };
    }
  };

  /**
   * 获取站点文件树。支持 30 秒内存缓存（useCache=true）。
   *
   * @param sitePath   - "username/sitename"
   * @param recursive  - 是否递归（默认 true）
   * @param folderPath - 子目录路径（相对于 repo 根，可选）
   * @param useCache   - 是否使用 30s 内存缓存（默认 false）
   */
  proto.getSiteTree = async function (
    sitePath: string,
    recursive = true,
    folderPath?: string,
    useCache = false
  ): Promise<unknown> {
    const cacheKey = `${sitePath}|${recursive}|${folderPath ?? ''}`;
    if (useCache) {
      if (!this._siteTreeCache) this._siteTreeCache = {} as Record<string, SiteTreeCacheEntry>;
      const cached = (this._siteTreeCache as Record<string, SiteTreeCacheEntry>)[cacheKey];
      if (cached && Date.now() - cached.time < 30_000) return cached.data;
    }
    const encodedSitePath = encodeURIComponent(sitePath);
    const fullFolderPath = folderPath ? `${sitePath}/${folderPath}` : sitePath;
    const result = await this.get(`/repos/${encodedSitePath}/tree`, {
      folderPath: fullFolderPath,
      recursive: String(recursive),
    });
    if (useCache) {
      (this._siteTreeCache as Record<string, SiteTreeCacheEntry>)[cacheKey] = {
        data: result,
        time: Date.now(),
      };
    }
    return result;
  };

  // ─────────────── 站点管理 ───────────────

  /**
   * 创建站点。
   * `visibility` 支持字符串（'public' / 'private' / 'protected'）或数字（0 / 1 / 2）。
   *
   * @param siteData - 站点数据
   */
  proto.createSite = async function (siteData: CreateSiteData): Promise<unknown> {
    const visibilityMap: Record<string, number> = { public: 0, private: 1, protected: 2 };
    const visibility =
      typeof siteData.visibility === 'string'
        ? (visibilityMap[siteData.visibility] ?? 0)
        : (siteData.visibility ?? 0);

    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.extractMainDomain(hostname) as string;

    // 先 spread siteData，再用明确值覆盖关键字段，避免重复键
    const sitePayload: Record<string, unknown> = {
      domain: siteData.name,
      defaultDataSourceName: '内置gitlab',
      categoryName: '个人',
      type: 'personal',
      templateName: '空模板',
      styleName: '默认样式',
      logoUrl: `http://${domain}/wiki/assets/imgs/wiki_blank_template.png`,
      ...siteData,
      // 关键字段显式覆盖，不被 siteData spread 改变
      name: siteData.name,
      sitename: siteData.sitename ?? siteData.name,
      username: siteData.username,
      visibility,
    };
    return this.post('/sites', sitePayload);
  };

  /** 获取当前登录用户的所有站点。 */
  proto.getAllSites = async function (): Promise<unknown> {
    return this.get('/sites');
  };

  /**
   * 按用户名获取站点列表。
   *
   * @param username - Keepwork 用户名
   */
  proto.getSitesByUsername = async function (username: string): Promise<unknown> {
    return this.get(`/users/${username}/sites`);
  };

  /**
   * 获取站点详情。
   *
   * @param siteId - 站点 ID
   */
  proto.getSiteDetail = async function (siteId: number): Promise<unknown> {
    return this.get(`/sites/${siteId}`);
  };
}
