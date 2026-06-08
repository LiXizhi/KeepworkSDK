/**
 * CloudDrive.ts — 个人文件上传/管理（经七牛 CDN，完整 TypeScript 实现）
 *
 * 提供上传、列表、删除、重命名、原始 URL 等能力：与 Keepwork 存储网关
 * （`/ts-storage`）通信，并把文件直传到七牛 `z2` 区域。
 *
 * @example
 *   const drive = window.keepwork.cloudDrive;
 *   const file = (document.querySelector('input[type=file]') as HTMLInputElement).files![0];
 *   const result = await drive.upload(file, { onProgress: p => console.log(p) });
 *   const list   = await drive.list();
 *   await drive.rename(result.key, 'newName.png');
 *   const url    = await drive.getRawUrl(result.key);
 *   await drive.remove(result.key);
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

/** upload() 选项 */
export interface CloudDriveUploadOptions {
  /** 显示名（默认 file.name） */
  filename?: string;
  /** 显式七牛 key（省略则自动生成） */
  key?: string;
  /** 进度回调 */
  onProgress?: UploadProgressCallback;
}

/** uploadTempFile() 选项 */
export interface CloudDriveTempUploadOptions extends CloudDriveUploadOptions {
  /** 生命周期（自动删除时间），见类内文档 */
  expire?: string | number | null;
}

/** upload() 返回结果 */
export interface CloudDriveUploadResult {
  key: string;
  fileId: string | number | undefined;
  filename: string;
  size: number;
}

/** uploadTempFile() 返回结果 */
export interface CloudDriveTempUploadResult extends CloudDriveUploadResult {
  url: string;
}

/** list() 选项 */
export interface CloudDriveListOptions {
  /** 页码（1-based） */
  page?: number;
  /** 每页条数 */
  perPage?: number;
  /** 按文件名子串过滤 */
  filename?: string;
}

/** 存储网关 token 响应 */
interface TokenResponse {
  token?: string;
  fileId?: string | number;
  data?: { token?: string; fileId?: string | number };
}

/** sdk 需提供的最小接口 */
interface CloudDriveSdk {
  baseURL?: string;
  user?: { id?: string | number };
  getAuthHeaders(): Record<string, string>;
}

/** _storageRequest 选项 */
interface StorageRequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  body?: BodyInit | Record<string, unknown> | null;
  headers?: Record<string, string>;
}

// ──────────────────── CloudDrive ────────────────────

export default class CloudDrive {
  sdk: CloudDriveSdk;

  constructor(sdk: unknown) {
    this.sdk = sdk as CloudDriveSdk;
  }

  // =================== 内部辅助 ===================

  /**
   * 从 SDK 的核心 API 基地址推导存储网关基地址。
   * api.keepwork.com/core/v0 → api.keepwork.com/ts-storage
   */
  private _getStorageBase(): string {
    const base = this.sdk.baseURL || 'https://api.keepwork.com/core/v0';
    const origin = base.replace(/\/core\/v0\/?$/, '');
    return `${origin}/ts-storage`;
  }

  /**
   * 向存储网关发起带认证的请求。
   */
  private async _storageRequest(path: string, options: StorageRequestOptions = {}): Promise<unknown> {
    const url = `${this._getStorageBase()}${path}`;
    const { headers: custom = {}, body, ...rest } = options;
    const fetchOptions: RequestInit = {
      method: 'GET',
      ...rest,
      headers: {
        ...this.sdk.getAuthHeaders(),
        ...custom,
      },
    };
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      fetchOptions.body = JSON.stringify(body);
    } else if (body != null) {
      fetchOptions.body = body as BodyInit;
    }
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`StorageGateway ${res.status}: ${text}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const ct = res.headers.get('content-type');
    if (ct && ct.includes('application/json')) return res.json();
    return res.text();
  }

  // =================== 上传 ===================

  /**
   * 为给定文件生成唯一七牛 object key。格式：`{userId}-{uuid}.{ext}`
   */
  private _generateKey(file: File | Blob): string {
    const name = (file as File).name || '';
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const userId = this.sdk.user?.id || 'anon';
    const id = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${userId}-${id}.${ext}`;
  }

  /**
   * 上传 File/Blob 到个人 CDN 文件夹。
   */
  async upload(file: File | Blob, opts: CloudDriveUploadOptions = {}): Promise<CloudDriveUploadResult> {
    if (!file) throw new Error('CloudDrive.upload: file is required');

    const key = opts.key || this._generateKey(file);
    const filename = opts.filename || (file as File).name;

    // 1. 从存储网关获取上传 token（及网关文件 id）
    const tokenRes = await this._storageRequest(`/files/${encodeURIComponent(key)}/token`) as TokenResponse;
    const token = tokenRes.data?.token || tokenRes.token;
    const fileId = tokenRes.data?.fileId ?? tokenRes.fileId;
    if (!token) throw new Error('CloudDrive.upload: failed to obtain upload token');

    // 2. 通过 multipart form 直传七牛
    const formData = new FormData();
    formData.append('file', file);
    formData.append('key', key);
    formData.append('token', token);
    formData.append('x:filename', filename);

    await this._qiniuUpload(formData, opts.onProgress);

    return { key, fileId, filename, size: file.size };
  }

  /**
   * 底层七牛上传（XMLHttpRequest，支持进度）。
   * 七牛 z2 区上传端点：https://upload-z2.qiniup.com
   */
  private _qiniuUpload(formData: FormData, onProgress?: UploadProgressCallback): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://upload-z2.qiniup.com/', true);

      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress({
              percent: Math.round((e.loaded / e.total) * 100),
              loaded: e.loaded,
              total: e.total,
            });
          }
        });
      }

      xhr.onload = (): void => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve(xhr.responseText); }
        } else {
          reject(new Error(`Qiniu upload failed (${xhr.status}): ${xhr.responseText}`));
        }
      };
      xhr.onerror = (): void => reject(new Error('Qiniu upload: network error'));
      xhr.send(formData);
    });
  }

  // =================== 临时上传 ===================

  /**
   * 把 `opts.expire`（string | number | null）解析为控制
   * `keepwork-public-temporary` 桶生命周期的桶前缀。
   *
   * 生命周期规则：
   *   - （无前缀）→ 服务端默认过期时间
   *   - `tmpImg`    → 7 天
   *   - `temp_90`   → 90 天
   *   - `temp_180`  → 180 天
   *   - `temp_360`  → 360 天
   *
   * 接受：null/undefined/'' → ''；精确前缀字符串原样用；number(天数)→最小满足的前缀；
   * 形如 '91days'/'180 d'/'7' 的字符串→解析为天数。
   */
  private _resolveTempPrefix(expire?: string | number | null): string {
    const tiers = [
      { prefix: 'tmpImg', days: 7 },
      { prefix: 'temp_90', days: 90 },
      { prefix: 'temp_180', days: 180 },
      { prefix: 'temp_360', days: 360 },
    ];

    if (expire == null || expire === '') return '';

    let expireNum: number;
    if (typeof expire === 'string') {
      // 精确前缀匹配
      const exact = tiers.find((t) => t.prefix === expire);
      if (exact) return exact.prefix;
      // 尝试从字符串解析前导数字
      const m = expire.match(/-?\d+(\.\d+)?/);
      if (m) expireNum = parseFloat(m[0]);
      else return '';
    } else {
      expireNum = expire;
    }

    if (typeof expireNum === 'number' && isFinite(expireNum)) {
      const days = Math.max(0, expireNum);
      const tier = tiers.find((t) => days <= t.days) || tiers[tiers.length - 1];
      return tier.prefix;
    }

    return '';
  }

  /**
   * 为临时桶生成七牛 object key。镜像 `_generateKey()` 但可选地前置生命周期前缀
   * 并保留原始文件名。格式：`{prefix}_{userId}-{originalFilename}`（无前缀时省略 prefix_）
   */
  private _generateTempKey(prefix: string, file?: File | Blob): string {
    const userId = this.sdk.user?.id || 'anon';
    const original = (file as File)?.name || '';
    const tail = original || (
      crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    return prefix ? `${prefix}_${userId}-${tail}` : `${userId}-${tail}`;
  }

  /**
   * 上传 File/Blob 到公共临时 CDN 桶。生命周期（自动删除时间）由 `opts.expire` 控制
   * （映射为桶 key 前缀，见 _resolveTempPrefix）。
   *
   * 结果 URL：`https://qiniu-public-temporary.keepwork.com/{key}`
   */
  async uploadTempFile(file: File | Blob, opts: CloudDriveTempUploadOptions = {}): Promise<CloudDriveTempUploadResult> {
    if (!file) throw new Error('CloudDrive.uploadTempFile: file is required');

    const prefix = this._resolveTempPrefix(opts.expire);
    const key = opts.key || this._generateTempKey(prefix, file);
    const filename = opts.filename || (file as File).name;

    // 1. 从 public-temporary 端点获取上传 token
    const tokenRes = await this._storageRequest(
      `/files/${encodeURIComponent(key)}/tokenByPublicTemporary`,
    ) as TokenResponse;
    const token = tokenRes.data?.token || tokenRes.token;
    const fileId = tokenRes.data?.fileId ?? tokenRes.fileId;
    if (!token) throw new Error('CloudDrive.uploadTempFile: failed to obtain upload token');

    // 2. multipart form 直传七牛
    const formData = new FormData();
    formData.append('file', file);
    formData.append('key', key);
    formData.append('token', token);
    formData.append('x:filename', filename);

    await this._qiniuUpload(formData, opts.onProgress);

    const url = `https://qiniu-public-temporary.keepwork.com/${key}`;
    return { key, fileId, filename, size: file.size, url };
  }

  // =================== 列表 ===================

  /**
   * 列出用户个人 CDN 文件夹中的文件。返回 `{ data: [...], total, page, ... }`。
   */
  async list(opts: CloudDriveListOptions = {}): Promise<unknown> {
    const body: Record<string, unknown> = {};
    if (opts.page) body.page = opts.page;
    if (opts.perPage) body.perPage = opts.perPage;
    if (opts.filename) body.filename = opts.filename;
    return this._storageRequest('/files/list', {
      method: 'POST',
      body,
    });
  }

  // =================== 信息 / 统计 ===================

  /**
   * 获取存储用量统计。
   */
  async info(): Promise<unknown> {
    return this._storageRequest('/files/statistics');
  }

  // =================== 重命名 ===================

  /**
   * 重命名文件的显示名（七牛 key 保持不变）。
   */
  async rename(key: string, filename: string): Promise<unknown> {
    return this._storageRequest('/files', {
      method: 'POST',
      body: { key, filename },
    });
  }

  // =================== 删除 ===================

  /**
   * 按 id（或当作 id 的 key）删除文件。
   */
  async remove(id: string | number): Promise<unknown> {
    return this._storageRequest(`/files/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  // =================== 原始 URL ===================

  /**
   * 获取文件的公共 CDN URL。
   */
  async getRawUrl(fileId: string | number): Promise<string> {
    const res = await this._storageRequest(`/files/${encodeURIComponent(fileId)}/rawurl`) as { data?: string } | string;
    return (typeof res === 'object' && res !== null ? res.data : res) as string;
  }
}
