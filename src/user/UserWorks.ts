/**
 * UserWorks.ts — STEAM / 用户作品发布与作品集 API（完整 TypeScript 实现）
 *
 * 封装 coreservice 的 `/steam/*` 路由，使页面可上传作品资源、发布作品、
 * 浏览公开作品、与他人作品互动（点赞/收藏/评论等）。
 *
 * @example
 *   const asset = await keepwork.userWorks.uploadAsset(file);
 *   await keepwork.userWorks.upload({ title: 'My Game', category: 'AI Game', grade: 'G5', ... });
 *   const gallery = await keepwork.userWorks.list({ page: 1, pageSize: 20 });
 */

// ──────────────────── 类型 ────────────────────

/** 上传进度信息 */
export interface UploadProgress {
  percent: number;
  loaded: number;
  total: number;
}

/** 上传进度回调 */
export type UploadProgressCallback = (progress: UploadProgress) => void;

/** 资源上传选项 */
export interface UploadAssetOptions {
  /** 用户文件夹下的相对 key */
  key?: string;
  /** key 前缀（默认 'works'） */
  prefix?: string;
  /** 显示文件名 */
  filename?: string;
  /** 进度回调 */
  onProgress?: UploadProgressCallback;
  /** 自定义上传端点 */
  uploadUrl?: string;
}

/** 资源上传返回结果 */
export interface UploadAssetResult {
  key: string;
  relativeKey: string;
  url: string;
  domain: string;
  bucketName: string | undefined;
  response: unknown;
}

/** 上传 token 信息 */
interface UploadTokenInfo {
  token?: string;
  domain?: string;
  bucketName?: string;
  data?: { token?: string; domain?: string; bucketName?: string };
}

/** 作品对象（发布/更新用，字段较松散） */
export type WorkData = Record<string, unknown>;

/** 列表查询选项 */
export interface UserWorksListOptions {
  page?: number;
  pageSize?: number;
  keyword?: string;
  category?: string;
  grade?: string;
  sortBy?: 'hot' | 'latest' | 'rating';
  status?: number | null;
  [key: string]: unknown;
}

/** 添加评论选项 */
export interface AddCommentOptions {
  workId: string | number;
  rating?: number;
  content?: string;
  dimensions?: unknown;
}

/** sdk 需提供的最小接口 */
interface UserWorksSdk {
  user?: { username?: string };
  getUserProfile(): Promise<{ username?: string } | null>;
  get(path: string, params?: Record<string, unknown>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  delete(path: string): Promise<unknown>;
}

// ──────────────────── UserWorks ────────────────────

export default class UserWorks {
  /** STEAM 项目路由使用的作品状态值。 */
  static Status = Object.freeze({
    PENDING: 11,
    APPROVED: 12,
    REJECTED: 13,
  });

  sdk: UserWorksSdk;

  constructor(sdk: unknown) {
    this.sdk = sdk as UserWorksSdk;
  }

  // ──────────── 内部辅助 ────────────

  /** 去除空值参数。 */
  private _compactParams(params: Record<string, unknown> = {}): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    Object.keys(params).forEach(key => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') {
        result[key] = value;
      }
    });
    return result;
  }

  /** 校验并 encode id。 */
  private _requireId(id: unknown, name = 'id'): string {
    if (id === undefined || id === null || id === '') {
      throw new Error(`UserWorks: ${name} is required`);
    }
    return encodeURIComponent(String(id));
  }

  /** 取文件扩展名（含点）。 */
  private _getFileExt(file?: File | Blob): string {
    const name = (file as File)?.name || '';
    const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
    return ext ? `.${ext}` : '';
  }

  /** 生成随机 id。 */
  private _randomId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** 生成资源 key。 */
  private _generateAssetKey(file?: File | Blob, opts: UploadAssetOptions = {}): string {
    const prefix = String(opts.prefix || 'works').replace(/^\/+|\/+$/g, '');
    const filename = opts.filename || (file as File)?.name || 'asset';
    const safeName = filename
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'asset';
    return `${prefix}/${Date.now()}-${this._randomId()}-${safeName}${this._getFileExt(file)}`;
  }

  /** 获取当前用户名（资源上传需要）。 */
  private async _getUsername(): Promise<string> {
    if (this.sdk.user?.username) return this.sdk.user.username;
    const profile = await this.sdk.getUserProfile();
    if (!profile?.username) throw new Error('UserWorks: username is required for asset upload');
    return profile.username;
  }

  /** 拼接公共 URL。 */
  private _toPublicUrl(domain: string, key: string): string {
    if (!domain) return key;
    return `${String(domain).replace(/\/+$/, '')}/${String(key).replace(/^\/+/, '')}`;
  }

  /** 把 key 或 URL 归一化为存储 key。 */
  private _normalizeAssetKey(keyOrUrl: string): string {
    if (!keyOrUrl) throw new Error('UserWorks: asset key is required');
    const value = String(keyOrUrl).trim();
    if (!/^https?:\/\//i.test(value)) return value.replace(/^\/+/, '');
    try {
      return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ''));
    } catch {
      return value;
    }
  }

  /** 底层七牛上传（XHR，支持进度）。 */
  private _qiniuUpload(
    formData: FormData,
    onProgress?: UploadProgressCallback,
    uploadUrl = 'https://up-z2.qiniup.com/',
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', uploadUrl, true);

      if (onProgress) {
        xhr.upload.addEventListener('progress', event => {
          if (event.lengthComputable) {
            onProgress({
              percent: Math.round((event.loaded / event.total) * 100),
              loaded: event.loaded,
              total: event.total,
            });
          }
        });
      }

      xhr.onload = (): void => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve(xhr.responseText); }
          return;
        }
        reject(new Error(`Qiniu upload failed (${xhr.status}): ${xhr.responseText}`));
      };
      xhr.onerror = (): void => reject(new Error('Qiniu upload: network error'));
      xhr.send(formData);
    });
  }

  // ==================== 资源上传 ====================

  /**
   * 获取作品资源 key 的七牛上传 token（后端会把 key 限定在当前用户名下）。
   */
  async getUploadToken(key: string): Promise<UploadTokenInfo> {
    if (!key) throw new Error('UserWorks.getUploadToken: key is required');
    return this.sdk.get('/steam/qiniuUploadToken', { key }) as Promise<UploadTokenInfo>;
  }

  /**
   * 上传作品封面/视频资源到 STEAM 七牛桶。
   */
  async uploadAsset(file: File | Blob, opts: UploadAssetOptions = {}): Promise<UploadAssetResult> {
    if (!file) throw new Error('UserWorks.uploadAsset: file is required');
    const relativeKey = opts.key || this._generateAssetKey(file, opts);
    const [tokenInfo, username] = await Promise.all([
      this.getUploadToken(relativeKey),
      this._getUsername(),
    ]);
    const key = `${username}/${relativeKey}`.replace(/\/+/, '/');
    const token = tokenInfo?.token || tokenInfo?.data?.token;
    if (!token) throw new Error('UserWorks.uploadAsset: failed to obtain upload token');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('key', key);
    formData.append('token', token);
    formData.append('x:filename', opts.filename || (file as File).name || relativeKey.split('/').pop() || 'asset');

    const response = await this._qiniuUpload(formData, opts.onProgress, opts.uploadUrl);
    const domain = tokenInfo?.domain || tokenInfo?.data?.domain || '';
    return {
      key,
      relativeKey,
      url: this._toPublicUrl(domain, key),
      domain,
      bucketName: tokenInfo?.bucketName || tokenInfo?.data?.bucketName,
      response,
    };
  }

  /**
   * 按完整 key 或公共 URL 删除已上传的七牛资源。
   */
  async deleteAsset(keyOrUrl: string): Promise<unknown> {
    return this.sdk.post('/steam/deleteQiniuFile', {
      key: this._normalizeAssetKey(keyOrUrl),
    });
  }

  /** deleteAsset 别名。 */
  removeAsset(keyOrUrl: string): Promise<unknown> { return this.deleteAsset(keyOrUrl); }

  // ==================== 作品 CRUD / 浏览 ====================

  /**
   * 发布作品送审。必填：title, category, grade, description, background,
   * innovation, videoType('video'|'url'), videoUrl。
   */
  async upload(work: WorkData): Promise<unknown> {
    return this.sdk.post('/steam/works/upload', work || {});
  }

  /** upload 别名。 */
  uploadWork(work: WorkData): Promise<unknown> { return this.upload(work); }
  /** upload 别名。 */
  create(work: WorkData): Promise<unknown> { return this.upload(work); }

  /** 更新当前用户的某个作品。 */
  async update(id: string | number, updates: WorkData = {}): Promise<unknown> {
    return this.sdk.put(`/steam/works/${this._requireId(id)}`, updates);
  }

  /** update 别名。 */
  updateWork(id: string | number, updates: WorkData = {}): Promise<unknown> { return this.update(id, updates); }

  /** 删除当前用户的某个作品。 */
  async delete(id: string | number): Promise<unknown> {
    return this.sdk.delete(`/steam/works/${this._requireId(id)}`);
  }

  /** delete 别名。 */
  remove(id: string | number): Promise<unknown> { return this.delete(id); }
  /** delete 别名。 */
  deleteWork(id: string | number): Promise<unknown> { return this.delete(id); }

  /** 浏览所有用户已审核通过的作品。 */
  async list(options: UserWorksListOptions = {}): Promise<unknown> {
    return this.sdk.get('/steam/works/list', this._compactParams(options));
  }

  /** list 别名。 */
  browse(options: UserWorksListOptions = {}): Promise<unknown> { return this.list(options); }
  /** list 别名。 */
  getPublicWorks(options: UserWorksListOptions = {}): Promise<unknown> { return this.list(options); }

  /** 列出当前用户拥有的作品。 */
  async my(options: UserWorksListOptions = {}): Promise<unknown> {
    return this.sdk.get('/steam/works/my', this._compactParams(options));
  }

  /** my 别名。 */
  getMyWorks(options: UserWorksListOptions = {}): Promise<unknown> { return this.my(options); }
  /** my 别名。 */
  listMine(options: UserWorksListOptions = {}): Promise<unknown> { return this.my(options); }

  /** 获取作品公开详情（后端会增加访问计数）。 */
  async get(id: string | number): Promise<unknown> {
    return this.sdk.get(`/steam/works/${this._requireId(id)}`);
  }

  /** get 别名。 */
  getDetail(id: string | number): Promise<unknown> { return this.get(id); }
  /** get 别名。 */
  getWorkDetail(id: string | number): Promise<unknown> { return this.get(id); }

  /** 获取当前用户作品汇总统计。 */
  async getStats(): Promise<unknown> {
    return this.sdk.get('/steam/profile/stats');
  }

  /** getStats 别名。 */
  getUserWorksStats(): Promise<unknown> { return this.getStats(); }

  // ==================== 社交动作 ====================

  like(id: string | number): Promise<unknown> { return this.sdk.post(`/steam/works/${this._requireId(id)}/like`); }
  unlike(id: string | number): Promise<unknown> { return this.sdk.delete(`/steam/works/${this._requireId(id)}/like`); }
  getLikeStatus(id: string | number): Promise<unknown> { return this.sdk.get(`/steam/works/${this._requireId(id)}/like/status`); }

  favorite(id: string | number): Promise<unknown> { return this.sdk.post(`/steam/works/${this._requireId(id)}/favorite`); }
  unfavorite(id: string | number): Promise<unknown> { return this.sdk.delete(`/steam/works/${this._requireId(id)}/favorite`); }
  getFavoriteStatus(id: string | number): Promise<unknown> { return this.sdk.get(`/steam/works/${this._requireId(id)}/favorite`); }

  /** 列出作品的顶层评论/评分。 */
  listComments(workId: string | number, options: UserWorksListOptions = {}): Promise<unknown> {
    return this.sdk.get(`/steam/works/${this._requireId(workId, 'workId')}/comments`, this._compactParams(options));
  }

  /** listComments 别名。 */
  getComments(workId: string | number, options: UserWorksListOptions = {}): Promise<unknown> { return this.listComments(workId, options); }

  /** 添加评论/评分。必填：workId, rating, content。 */
  addComment({ workId, rating, content, dimensions }: AddCommentOptions = {} as AddCommentOptions): Promise<unknown> {
    return this.sdk.post(`/steam/works/${this._requireId(workId, 'workId')}/comments`, {
      workId: String(workId),
      rating,
      content,
      ...(dimensions ? { dimensions } : {}),
    });
  }

  deleteComment(workId: string | number, commentId: string | number): Promise<unknown> {
    return this.sdk.delete(`/steam/works/${this._requireId(workId, 'workId')}/comments/${this._requireId(commentId, 'commentId')}`);
  }

  toggleCommentStatus(workId: string | number, disabled: boolean): Promise<unknown> {
    return this.sdk.put(`/steam/works/${this._requireId(workId, 'workId')}/comment-status`, { disabled: !!disabled });
  }

  // ==================== AI 评审 / 教案 ====================

  getAIAnalysis(workId: string | number): Promise<unknown> { return this.sdk.get(`/steam/ai/analysis/${this._requireId(workId, 'workId')}`); }
  triggerAIAnalysis(workId: string | number): Promise<unknown> { return this.sdk.post(`/steam/ai/analysis/${this._requireId(workId, 'workId')}/trigger`); }
  generateLessonPlan(workId: string | number): Promise<unknown> { return this.sdk.post(`/steam/lesson-plans/generate/${this._requireId(workId, 'workId')}`); }
}
