/**
 * ImageUtils — 浏览器端 base64 图像压缩与上传工具
 *
 * 使用 HTMLCanvasElement（或 OffscreenCanvas 降级）对图片进行缩放和重编码，
 * 将大图压缩到指定字节上限，供 AI 视觉 API 使用。
 *
 * 主要入口：
 * - `compressDataURI`         压缩单个 data-URI 字符串
 * - `compressContentImages`   压缩 OpenAI 多模态 content 数组中的内联图片
 * - `prepareImageInputForProvider` 按 AI provider 决定内联 vs. 上传
 * - `uploadTempVisionImage`   上传图片到 Keepwork 临时 CDN
 */
import SDKLogger from './SDKLogger';

const console = SDKLogger.createModuleConsole('ImageUtils');

/** 默认最大字节数（32 KB） */
export const DEFAULT_MAX_BYTES = 32 * 1024;

// ──────────────────── 辅助类型 ────────────────────

/** compressBase64Image / compressDataURI 的选项 */
export interface CompressOptions {
  /** 压缩目标上限（字节），默认 32 KB */
  maxBytes?: number;
  /** 源 MIME 类型（仅用于解码，默认 'image/png'） */
  mimeType?: string;
}

/** prepareImageInputForProvider 的选项 */
export interface PrepareImageOptions {
  /** AI provider 名称（决定是否支持内联图片） */
  provider?: string;
  /** KeepworkSDK 实例（上传时用于获取 token） */
  sdk?: { token?: string | null; getUserId?: () => Promise<string | null | undefined> };
  /** 压缩字节上限 */
  maxBytes?: number;
  /** 上传时使用的文件名 */
  fileName?: string;
  /** 当 provider 不支持内联图片时是否自动上传，默认 true */
  uploadWhenUnsupported?: boolean;
}

/** OpenAI 多模态 content 数组的单个元素 */
export interface ContentItem {
  type: string;
  text?: string;
  image_url?: { url: string; [key: string]: unknown };
  [key: string]: unknown;
}

// ──────────────────── 内部工具 ────────────────────

/**
 * 估算纯 base64 字符串对应的字节数（不含 data-URI 前缀）。
 * 公式：`floor(len * 3/4) - padding`
 */
function base64ByteSize(base64: string): number {
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * 拆分 data-URI，返回 `{ mimeType, base64 }`。
 * 若输入无前缀，MIME 默认为 'image/png'。
 */
function splitDataURI(dataURI: string): { mimeType: string; base64: string } {
  const match = dataURI.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (match) return { mimeType: match[1]!, base64: match[2]! };
  return { mimeType: 'image/png', base64: dataURI };
}

/**
 * 判断指定 AI provider 是否支持内联 base64 图片。
 */
function providerSupportsInlineImages(provider: string | undefined): boolean {
  return ['google', 'gemini', 'openai', 'openrouter'].includes(
    String(provider ?? '').toLowerCase()
  );
}

/**
 * 将 base64 字符串加载为 HTMLImageElement（等待 onload）。
 * @internal
 */
function loadImage(base64: string, mimeType: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = `data:${mimeType};base64,${base64}`;
  });
}

/**
 * 将图像绘制到 canvas 并导出为 JPEG base64（始终输出 JPEG 以最小化体积）。
 * @internal
 */
function canvasToBase64(
  img: HTMLImageElement,
  width: number,
  height: number,
  quality: number
): { base64: string; byteSize: number } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  const dataURL = canvas.toDataURL('image/jpeg', quality);
  const { base64 } = splitDataURI(dataURL);
  return { base64, byteSize: base64ByteSize(base64) };
}

// ──────────────────── 公共 API ────────────────────

/**
 * 压缩纯 base64 图像（无 data-URI 前缀）至指定字节上限。
 *
 * 压缩策略（按顺序尝试）：
 * 1. 逐步降低 JPEG 质量（0.8 → 0.6 → 0.4 → 0.2）
 * 2. 若仍超限，将分辨率减半后重复步骤 1（最多迭代 6 次）
 *
 * @param inputBase64 - 纯 base64 字符串（无 data-URI 前缀）
 * @param options     - 压缩选项
 * @returns 压缩后的纯 base64（JPEG 格式）
 */
export async function compressBase64Image(
  inputBase64: string,
  options: CompressOptions = {}
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const mimeType = options.mimeType ?? 'image/png';

  if (base64ByteSize(inputBase64) <= maxBytes) return inputBase64;

  const img = await loadImage(inputBase64, mimeType);
  let width = img.naturalWidth;
  let height = img.naturalHeight;

  const QUALITY_STEPS = [0.8, 0.6, 0.4, 0.2];
  const MAX_SCALE_ITERATIONS = 6;

  for (let scaleIter = 0; scaleIter < MAX_SCALE_ITERATIONS; scaleIter++) {
    for (const quality of QUALITY_STEPS) {
      const result = canvasToBase64(img, width, height, quality);
      if (result.byteSize <= maxBytes) {
        console.log(
          `[ImageUtils] Compressed image: ${width}x${height} q=${quality} → ${(result.byteSize / 1024).toFixed(1)} KB`
        );
        return result.base64;
      }
    }
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }

  // 最坏情况：返回最小版本
  const final = canvasToBase64(img, width, height, 0.2);
  console.warn(
    `[ImageUtils] Could not compress below ${maxBytes} bytes; final size ${final.byteSize}`
  );
  return final.base64;
}

/**
 * 压缩 data-URI 格式图像字符串（如 `data:image/png;base64,...`）。
 * 若已满足大小要求则原样返回。
 *
 * @param dataURI - 完整 data-URI 字符串
 * @param options - 压缩选项
 * @returns 压缩后的 data-URI（JPEG 格式）
 */
export async function compressDataURI(
  dataURI: string,
  options: CompressOptions = {}
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { mimeType, base64 } = splitDataURI(dataURI);

  if (base64ByteSize(base64) <= maxBytes) return dataURI;

  const compressed = await compressBase64Image(base64, { maxBytes, mimeType });
  return `data:image/jpeg;base64,${compressed}`;
}

/**
 * 扫描 OpenAI 多模态 content 数组，压缩其中超限的内联 base64 图片。
 * 非图片元素和非 data-URI 的 URL 直接透传，不修改。
 *
 * @param contentArray - OpenAI content 数组（`{ type, text?, image_url? }[]`）
 * @param options      - 压缩选项
 * @returns 压缩后的新数组（原数组不变）
 */
export async function compressContentImages(
  contentArray: ContentItem[],
  options: CompressOptions = {}
): Promise<ContentItem[]> {
  if (!Array.isArray(contentArray)) return contentArray;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return Promise.all(
    contentArray.map(async (item) => {
      if (item.type !== 'image_url') return item;
      const url = item.image_url?.url;
      if (!url || !url.startsWith('data:')) return item;

      const { base64 } = splitDataURI(url);
      if (base64ByteSize(base64) <= maxBytes) return item;

      const compressedURI = await compressDataURI(url, { maxBytes });
      return { ...item, image_url: { ...item.image_url, url: compressedURI } };
    })
  );
}

/**
 * 为指定 AI provider 准备图像输入：
 * - 若 provider 支持内联图片（Gemini/OpenAI/OpenRouter），压缩后内联返回
 * - 否则压缩后上传到 Keepwork 临时 CDN，返回 CDN URL
 * - `uploadWhenUnsupported=false` 时即使不支持也直接返回压缩后的 data-URI
 *
 * @param image   - 图像字符串或含 `url` / `image_url.url` 字段的对象
 * @param options - provider、sdk、maxBytes 等选项
 */
export async function prepareImageInputForProvider(
  image: string | ContentItem | Record<string, unknown>,
  options: PrepareImageOptions = {}
): Promise<string | ContentItem | Record<string, unknown>> {
  const {
    provider,
    sdk,
    maxBytes = DEFAULT_MAX_BYTES,
    fileName = 'image.jpg',
    uploadWhenUnsupported = true,
  } = options;

  const url =
    typeof image === 'string'
      ? image
      : ((image as Record<string, unknown>)['url'] as string | undefined) ??
        (((image as ContentItem).image_url?.url) as string | undefined) ??
        '';

  if (!url) return image;
  if (!url.startsWith('data:')) return url;

  const compressed = await compressDataURI(url, { maxBytes });
  if (providerSupportsInlineImages(provider)) return compressed;
  if (!uploadWhenUnsupported) return compressed;
  return uploadTempVisionImage(compressed, { sdk, fileName, maxBytes });
}

/**
 * 上传 base64 图像（或 data-URI）到 Keepwork 临时视觉 CDN。
 *
 * 流程（对应 Lua `FileTools.UpLoadVisionFile`）：
 * 1. 从 `keepwork.shareBlock.getToken` 获取七牛 upload token
 * 2. 将二进制内容上传到七牛
 * 3. 返回公开 CDN URL
 *
 * @param base64OrDataURI - 纯 base64 或完整 data-URI
 * @param options         - sdk、fileName、maxBytes 等选项
 * @returns 公开 CDN URL（如 `https://tempvision.keepwork.com/<key>`）
 */
export async function uploadTempVisionImage(
  base64OrDataURI: string,
  options: PrepareImageOptions = {}
): Promise<string> {
  const { sdk, fileName = 'image.jpg', maxBytes } = options;

  let base64: string;
  let mimeType: string;
  if (base64OrDataURI.startsWith('data:')) {
    ({ base64, mimeType } = splitDataURI(base64OrDataURI));
  } else {
    base64 = base64OrDataURI;
    mimeType = 'image/jpeg';
  }

  // 可选：上传前再压缩
  if (maxBytes && base64ByteSize(base64) > maxBytes) {
    base64 = await compressBase64Image(base64, { maxBytes, mimeType });
    mimeType = 'image/jpeg';
  }

  const md5Fn = await _getMd5();
  let userId: string | undefined;
  if (sdk) {
    try {
      const id = await sdk.getUserId?.();
      if (id) userId = id;
    } catch { /* 忽略获取用户 ID 失败 */ }
  }

  // 用内容哈希作为 key，防止相同内容重复上传
  const contentHash = md5Fn(base64);
  const key = `tempvision_${userId ?? md5Fn(String(Date.now()))}_${contentHash}`;

  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  const isStaging = hostname.includes('kp-para');
  const apiDomain = isStaging ? 'api.kp-para.cn' : 'api.keepwork.com';
  const cdnDomain = isStaging ? 'tempvision.kp-para.cn' : 'tempvision.keepwork.com';
  const cdnUrl = `https://${cdnDomain}/${key}`;

  // Step 1：获取七牛 upload token
  const headers: Record<string, string> = {};
  if (sdk?.token) headers['Authorization'] = `Bearer ${sdk.token}`;

  const tokenResp = await fetch(
    `https://${apiDomain}/ts-storage/files/${encodeURIComponent(key)}/tokenByPublicTemporary?bucketName=tempvision`,
    { headers }
  );

  if (!tokenResp.ok) {
    if (tokenResp.status === 403) {
      try {
        const headResp = await fetch(cdnUrl, { method: 'HEAD' });
        if (headResp.ok) {
          console.log(`[ImageUtils] File already exists at ${cdnUrl}, skipping upload`);
          return cdnUrl;
        }
      } catch { /* HEAD 失败，继续抛错 */ }
    }
    throw new Error(`[ImageUtils] Failed to get upload token: HTTP ${tokenResp.status}`);
  }

  const tokenData = (await tokenResp.json()) as { data?: { token?: string } };
  const uploadToken = tokenData?.data?.token;
  if (!uploadToken) throw new Error('[ImageUtils] Upload token not found in API response');

  // Step 2：上传二进制到七牛
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: mimeType });

  const formData = new FormData();
  formData.append('token', uploadToken);
  formData.append('key', key);
  formData.append('file', blob, fileName);

  const uploadResp = await fetch('https://up.qiniup.com/', {
    method: 'POST',
    body: formData,
  });

  if (!uploadResp.ok) {
    throw new Error(`[ImageUtils] Qiniu upload failed: HTTP ${uploadResp.status}`);
  }

  console.log(`[ImageUtils] Uploaded to ${cdnUrl} (${(blob.size / 1024).toFixed(1)} KB)`);
  return cdnUrl;
}

// ──────────────────── 内部 MD5 加载器 ────────────────────

type Md5Fn = (str: string) => string;
let _cachedMd5: Md5Fn | null = null;

/**
 * 懒加载 MD5 函数：优先使用 blueimp-md5，降级使用简单哈希。
 * @internal
 */
async function _getMd5(): Promise<Md5Fn> {
  if (_cachedMd5) return _cachedMd5;
  try {
    const mod = (await import('blueimp-md5')) as { default?: Md5Fn } & Md5Fn;
    _cachedMd5 = (mod.default ?? mod) as Md5Fn;
  } catch {
    // 降级：djb2 风格简单哈希
    _cachedMd5 = (str: string): string => {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    };
  }
  return _cachedMd5;
}

export {
  base64ByteSize,
  splitDataURI,
  providerSupportsInlineImages,
};
