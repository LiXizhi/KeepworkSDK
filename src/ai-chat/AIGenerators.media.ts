/**
 * AIGenerators.media.ts — 图片/视频生成层
 *
 * 继承 AIGeneratorsBase，添加：
 * - genImage（Keepwork proxy + 直连 OpenAI/Google/OpenRouter）
 * - genVideo（Keepwork proxy + OpenRouter 直连）
 * - getVideoTaskStatus / pollVideoTask
 * - CloudDrive 上传辅助（_maybeUploadDataURI）
 * - OpenRouter 视频直连辅助（_genVideoOpenRouter / _pollVideoTaskOpenRouter 等）
 * - 图片相关辅助（_toOpenRouterImageParts / _buildOpenRouterImageMessages 等）
 */

import { AIGeneratorsBase, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, type AIGeneratorsSDKRef, type GenChatOptions } from './AIGenerators.base';
import { uploadTempVisionImage } from '../utils/ImageUtils';

// ──────────────────── 类型 ────────────────────

/** genImage 选项 */
export interface GenImageOptions {
  width?: number;
  height?: number;
  provider?: string;
  apiKey?: string;
  model?: string;
  compressionRatio?: number;
  images?: Array<{ url?: string; image_url?: { url: string }; role?: string }>;
  /** 是否上传 data URI 到 Keepwork CDN（默认 true） */
  uploadResultToKeepwork?: boolean;
  fileName?: string;
  /** CloudDrive 临时文件生命周期天数（默认 180） */
  expire?: number;
  preferDirect?: boolean;
  directOnly?: boolean;
  directProvider?: string;
  aspectRatio?: string;
  aspect_ratio?: string;
  imageSize?: string;
  image_size?: string;
  size?: string;
  modalities?: string[];
  outputModalities?: string[];
  output_modalities?: string[];
  onMessage?: GenChatOptions['onMessage'];
  onReasoning?: GenChatOptions['onReasoning'];
  onImage?: GenChatOptions['onImage'];
  extraHeaders?: Record<string, string>;
  stream?: boolean;
  [key: string]: unknown;
}

/** genVideo 选项 */
export interface GenVideoOptions {
  model?: string;
  duration?: number;
  resolution?: string;
  ratio?: string;
  size?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  seed?: number;
  apiKey?: string;
  images?: Array<{ url?: string; role?: string }>;
  videos?: Array<{ url?: string; role?: string }>;
  audios?: Array<{ url?: string; role?: string }>;
  directLink?: boolean;
  preferDirect?: boolean;
  directOnly?: boolean;
  extraHeaders?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  callbackUrl?: string;
  [key: string]: unknown;
}

/** 视频任务状态 */
export interface VideoTaskStatus {
  status: 'succeeded' | 'failed' | 'pending' | 'in_progress' | 'timeout' | 'cancelled' | 'expired' | string;
  videoUrl?: string;
  contentUrl?: string;
  duration?: number;
  usage?: unknown;
  error?: string | object;
  raw?: unknown;
}

/** pollVideoTask 回调 */
export interface PollVideoCallbacks {
  onStatus?: (status: string, data: unknown) => void;
  interval?: number;
  timeout?: number;
  apiKey?: string;
  model?: string;
  directLink?: boolean;
}

// ──────────────────── AIGenerators (media 层) ────────────────────

/**
 * AIGenerators — 继承自 AIGeneratorsBase，提供图片/视频生成能力。
 */
class AIGenerators extends AIGeneratorsBase {
  constructor(sdk: AIGeneratorsSDKRef) {
    super(sdk);
  }

  // ──────────────────── 图片相关工具 ────────────────────

  /** 推断图片生成 provider（优先 caller > model 自动检测，默认 seedream）。 */
  _inferImageProvider(model?: string, provider?: string): string {
    if (provider) return provider;
    const value = String(model ?? '').trim().toLowerCase();
    if (!value) return 'seedream';
    if (value.startsWith('seedream')) return 'seedream';
    if (value.startsWith('gpt-image') || value.startsWith('dall-e')) return 'openai';
    const detected = this._detectProvider(value);
    if (detected === 'doubao') return 'seedream';
    if (detected) return detected;
    return 'seedream';
  }

  /**
   * 将参考图片列表转换为 OpenRouter chat-completions 格式的 image_url parts。
   */
  _toOpenRouterImageParts(
    images?: Array<{ url?: string; image_url?: { url: string }; [key: string]: unknown }>
  ): Array<{ type: string; image_url: { url: string } }> {
    if (!Array.isArray(images) || images.length === 0) return [];
    const parts: Array<{ type: string; image_url: { url: string } }> = [];
    for (const ref of images) {
      const url = typeof ref === 'string' ? ref : (ref?.image_url?.url ?? ref?.url);
      if (!url) continue;
      parts.push({ type: 'image_url', image_url: { url } });
    }
    return parts;
  }

  /** 构建包含参考图片的 OpenRouter 多模态 user 消息。 */
  _buildOpenRouterImageMessages(
    prompt: string,
    images?: GenImageOptions['images']
  ): Array<{ role: string; content: unknown }> {
    const imageParts = this._toOpenRouterImageParts(images);
    const content = imageParts.length === 0 ? prompt : [{ type: 'text', text: prompt }, ...imageParts];
    return [{ role: 'user', content }];
  }

  /** 从 caller opts 构建 OpenRouter image_config（aspect_ratio + image_size）。 */
  _buildOpenRouterImageConfig(opts: GenImageOptions = {}): { aspect_ratio?: string; image_size?: string } | null {
    const cfg: { aspect_ratio?: string; image_size?: string } = {};
    const aspect = opts.aspectRatio ?? opts.aspect_ratio;
    const imgSize = opts.imageSize ?? opts.image_size;
    if (typeof aspect === 'string' && aspect) cfg.aspect_ratio = aspect;
    if (typeof imgSize === 'string' && imgSize) cfg.image_size = imgSize;
    if (!cfg.aspect_ratio) {
      let width = Number(opts.width) || 0;
      let height = Number(opts.height) || 0;
      if (typeof opts.size === 'string') {
        const m = opts.size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
        if (m) { width = Number(m[1]); height = Number(m[2]); }
      }
      if (width && height) {
        const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
        const g = gcd(width, height) || 1;
        cfg.aspect_ratio = `${width / g}:${height / g}`;
      }
    }
    return Object.keys(cfg).length === 0 ? null : cfg;
  }

  /** 根据 model 决定 OpenRouter 图片生成的 output modalities。 */
  _buildOpenRouterImageModalities(model: string, opts: GenImageOptions = {}): string[] {
    const explicit = opts.modalities ?? opts.outputModalities ?? opts.output_modalities;
    if (Array.isArray(explicit) && explicit.length > 0) {
      return [...new Set(explicit.map((i) => String(i ?? '').trim()).filter(Boolean))];
    }
    const value = String(model ?? '').trim().toLowerCase();
    if (/^(google\/)?gemini/.test(value) || value.includes('/gemini-')) return ['image', 'text'];
    return ['image'];
  }

  /** 构建图片生成失败时的详细错误信息。 */
  _buildNoImageError(data: unknown, model?: string): string {
    const d = (data ?? {}) as Record<string, unknown>;
    const choicesArr2 = (d['choices'] ?? (d['data'] as Record<string, unknown> | undefined)?.['choices']) as Array<Record<string, unknown>> | undefined;
    const choice: Record<string, unknown> = choicesArr2?.[0] ?? {};
    const message = (choice['message'] ?? {}) as Record<string, unknown>;
    const content = typeof message['content'] === 'string' ? message['content'].trim() : '';
    const imageTokens = (d['usage'] as Record<string, Record<string, number>> | undefined)?.['completion_tokens_details']?.['image_tokens'] ?? (d['usage'] as Record<string, number> | undefined)?.['image_tokens'];
    const details = [
      model ? `model=${model}` : '',
      choice['finish_reason'] ? `finish_reason=${choice['finish_reason']}` : '',
      imageTokens !== undefined ? `image_tokens=${imageTokens}` : '',
      content ? `text=${content.slice(0, 120)}` : '',
    ].filter(Boolean).join('，');
    return `图片生成未返回图片数据${details ? `（${details}）` : ''}。请确认该模型/供应商当前支持 image 输出，或重试一次。`;
  }

  // ──────────────────── genImage ────────────────────

  /**
   * 生成图片（via Keepwork genImage API 或直连 provider）。
   *
   * 路由逻辑：
   * 1. 有 apiKey + preferDirect → 直连（OpenAI / Google / OpenRouter）
   * 2. directOnly 但无 key → 抛出
   * 3. 其余 → 通过 Keepwork proxy
   *
   * @param prompt - 图片描述
   * @param opts   - 尺寸 / provider / apiKey / model / 参考图片等
   * @returns 生成的图片 URL（或 data URI）
   */
  async genImage(prompt: string, opts: GenImageOptions = {}): Promise<string | null> {
    const { width = 1024, height = 1024, provider, apiKey, model, compressionRatio = 10, images } = opts;
    if (!prompt) throw new Error('Prompt is required');

    const localModelSettings = this._resolveLocalModelSettings(model ?? DEFAULT_IMAGE_MODEL, provider);
    const effectiveModel = localModelSettings.model ?? model ?? DEFAULT_IMAGE_MODEL;
    const effectiveProvider = this._inferImageProvider(effectiveModel, provider);
    const preferDirect = this._shouldPreferDirect(localModelSettings, opts);
    const directProvider = this._directProvider(localModelSettings, { ...opts, model: effectiveModel } as GenChatOptions) ?? effectiveProvider;

    let effectiveApiKey = apiKey ?? localModelSettings.apiKey ?? '';
    if (!effectiveApiKey && directProvider && this.sdk.localAPIKeySettings?.getProviderApiKey) {
      effectiveApiKey = this.sdk.localAPIKeySettings.getProviderApiKey(directProvider) ?? '';
    }

    if (effectiveApiKey && preferDirect) {
      return this._genImageDirect(prompt, { ...opts, model: effectiveModel, apiKey: effectiveApiKey, provider: directProvider });
    }
    if (opts.directOnly) {
      if (!effectiveApiKey) throw new Error(`Direct image generation requires API key for provider: ${directProvider ?? 'unknown'}`);
      throw new Error(`Direct image generation is unavailable for provider: ${directProvider ?? 'unknown'}`);
    }
    if (!this._getToken()) throw new Error('请先登录');

    const body: Record<string, unknown> = { prompt, width, height, provider: effectiveProvider, compressionRatio };
    if (effectiveModel) body['model'] = effectiveModel;
    if (effectiveApiKey) body['apiKey'] = effectiveApiKey;

    if (images?.length) {
      if (effectiveProvider === 'seedream' || effectiveProvider === 'doubao') {
        const urls = images.map((it) => (typeof it === 'string' ? it : it?.url ?? it?.image_url?.url)).filter(Boolean) as string[];
        if (urls.length === 1) body['image'] = urls[0];
        else if (urls.length > 1) body['image'] = urls;
      } else if (effectiveProvider === 'openrouter') {
        body['images'] = this._toOpenRouterImageParts(images);
        body['messages'] = this._buildOpenRouterImageMessages(prompt, images);
      } else {
        body['images'] = images;
      }
    }
    if (effectiveProvider === 'openrouter') {
      body['modalities'] = this._buildOpenRouterImageModalities(effectiveModel, opts);
      const imageConfig = this._buildOpenRouterImageConfig(opts);
      if (imageConfig) body['image_config'] = imageConfig;
      if (!body['messages']) body['messages'] = this._buildOpenRouterImageMessages(prompt, images);
    }

    const resp = await fetch(`${this._apiBase}/genImage`, {
      method: 'POST',
      headers: this._authHeaders({ 'api-cache-key': 'keepwork_image_v1' }),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => `HTTP ${resp.status}`);
      throw new Error(`图片生成失败: ${text}`);
    }
    const data = await resp.json() as Record<string, unknown>;
    const imageUrl = this._extractGeneratedImageUrl(data);
    if (imageUrl) return this._maybeUploadDataURI(imageUrl, opts);
    if (data['error']) throw new Error(`图片生成失败: ${data['error']}`);
    throw new Error(this._buildNoImageError(data, effectiveModel));
  }

  /** @private 直连 provider 生成图片的分发器。 */
  private async _genImageDirect(prompt: string, opts: GenImageOptions & { provider?: string; apiKey?: string }): Promise<string | null> {
    const { provider } = opts;
    if (provider === 'openai') return this._genImageOpenAI(prompt, opts);
    if (provider === 'gemini' || provider === 'google') return this._genImageGoogle(prompt, opts);
    if (provider === 'openrouter') return this._genImageOpenRouter(prompt, opts);
    throw new Error(`Direct image generation is not supported for provider: ${provider ?? 'unknown'}`);
  }

  private async _genImageOpenAI(prompt: string, opts: GenImageOptions): Promise<string | null> {
    const { apiKey, model = 'gpt-image-1', width = 1024, height = 1024, extraHeaders } = opts;
    const size = width && height ? `${width}x${height}` : '1024x1024';
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: this._normalizeHeaders({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(extraHeaders ?? {}) }, 'OpenAI 图片生成请求'),
      body: JSON.stringify({ model, prompt, n: 1, size }),
    });
    if (!resp.ok) throw new Error(`OpenAI 图片生成失败: ${resp.status} ${await resp.text()}`);
    const data = await resp.json() as Record<string, unknown>;
    const item: Record<string, string> = ((data?.['data'] as Array<Record<string, string>> | undefined)?.[0]) ?? {};
    if (item['url']) return item['url'];
    if (item['b64_json']) return this._maybeUploadDataURI(`data:image/png;base64,${item['b64_json']}`, opts);
    return null;
  }

  private async _genImageGoogle(prompt: string, opts: GenImageOptions): Promise<string | null> {
    const { apiKey, model = 'gemini-2.5-flash-image-preview', extraHeaders } = opts;
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } };
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey ?? '')}`, {
      method: 'POST',
      headers: this._normalizeHeaders({ 'Content-Type': 'application/json', ...(extraHeaders ?? {}) }, 'Google 图片生成请求'),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Google 图片生成失败: ${resp.status} ${await resp.text()}`);
    const data = await resp.json() as Record<string, unknown>;
    const parts = (((data?.['candidates'] as Array<Record<string, unknown>> | undefined)?.[0]?.['content'] as Record<string, unknown> | undefined)?.['parts'] as Array<Record<string, unknown>> | undefined) ?? [];
    const inline = parts.find((p) => {
      const id = (p['inlineData'] ?? p['inline_data']) as Record<string, unknown> | undefined;
      return !!(id?.['data']);
    });
    if (!inline) throw new Error('Google 图片生成未返回图片数据');
    const inlineData = (inline['inlineData'] ?? inline['inline_data']) as Record<string, string>;
    const mimeType = inlineData['mimeType'] ?? inlineData['mime_type'] ?? 'image/png';
    return this._maybeUploadDataURI(`data:${mimeType};base64,${inlineData['data']}`, opts);
  }

  private async _genImageOpenRouter(prompt: string, opts: GenImageOptions): Promise<string | null> {
    const messages = this._buildOpenRouterImageMessages(prompt, opts.images);
    const model = opts.model ?? 'google/gemini-2.5-flash-image';
    const imageConfig = this._buildOpenRouterImageConfig(opts);
    const extraBody: Record<string, unknown> = { modalities: this._buildOpenRouterImageModalities(model, opts) };
    if (imageConfig) extraBody['image_config'] = imageConfig;
    const result = await this._callOpenRouterLLM({
      model, apiKey: opts.apiKey ?? '', messages: messages as import('./AIGenerators.base').GenMessage[],
      stream: opts.stream === true, onMessage: opts.onMessage, onReasoning: opts.onReasoning, onImage: opts.onImage,
      extraHeaders: opts.extraHeaders, extraBody,
    });
    const res = result as { imageUrl?: string; text?: string; data?: unknown };
    const imageUrl = res.imageUrl ?? this._extractGeneratedImageUrl(res.data);
    if (imageUrl) return this._maybeUploadDataURI(imageUrl, opts);
    const textUrl = (res.text ?? '').match(/https?:\/\/\S+/)?.[0];
    if (textUrl) return textUrl;
    throw new Error(this._buildNoImageError(res.data, opts.model ?? 'OpenRouter'));
  }

  // ──────────────────── CDN 上传 ────────────────────

  /**
   * 将 data URI 上传到 Keepwork CDN（默认行为）。
   * 优先使用用户个人 CloudDrive，失败时回退 tempvision bucket。
   * 传入 `uploadResultToKeepwork:false` 保留原始 data URI。
   */
  async _maybeUploadDataURI(dataURI: string, opts: { uploadResultToKeepwork?: boolean; fileName?: string; expire?: number } = {}): Promise<string> {
    if (opts.uploadResultToKeepwork === false) return dataURI;
    if (!dataURI?.startsWith('data:')) return dataURI;
    const fileName = opts.fileName ?? 'generated-image.png';
    const expire = opts.expire !== undefined ? opts.expire : 180;
    if (this.sdk.cloudDrive && this.sdk.token) {
      try { return await this._uploadDataURIToCloudDrive(dataURI, fileName, { expire }); } catch (err) {
        console.warn('[AIGenerators] CloudDrive upload failed, falling back to tempvision:', (err as Error)?.message ?? err);
      }
    }
    return uploadTempVisionImage(dataURI, { sdk: this.sdk, fileName });
  }

  private async _uploadDataURIToCloudDrive(dataURI: string, fileName: string, opts: { expire?: number } = {}): Promise<string> {
    const m = dataURI.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid data URI');
    const mimeType = m[1]!, base64 = m[2]!;
    const bytes = atob(base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const ext = (mimeType.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
    const baseName = String(fileName ?? 'generated-image').replace(/\.[a-zA-Z0-9]+$/, '') || 'generated-image';
    const uniqueName = `${baseName}-${Date.now()}.${ext}`;
    const file = new File([arr], uniqueName, { type: mimeType });
    const expire = opts.expire !== undefined ? opts.expire : 180;
    const result = await this.sdk.cloudDrive!.uploadTempFile(file, { filename: uniqueName, expire });
    const url = result?.url;
    if (!url) throw new Error('CloudDrive uploadTempFile returned no url');
    return url;
  }

  // ──────────────────── genVideo ────────────────────

  /**
   * 提交视频生成任务（via Keepwork genVideo API 或 OpenRouter 直连）。
   *
   * @param prompt - 视频描述
   * @param opts   - 时长 / 分辨率 / 宽高比 / 参考图片 / provider 等
   * @returns taskId 字符串（OpenRouter 任务以 `openrouter:` 前缀标识）
   */
  async genVideo(prompt: string, opts: GenVideoOptions = {}): Promise<string> {
    const { model, duration = 5, resolution = '720p', ratio = '16:9', generateAudio = false, watermark = false, seed, apiKey, images, videos, audios } = opts;
    if (!prompt) throw new Error('Prompt is required');

    const localModelSettings = this._resolveLocalModelSettings(model ?? DEFAULT_VIDEO_MODEL);
    const effectiveModel = localModelSettings.model ?? model ?? DEFAULT_VIDEO_MODEL;
    const directProvider = this._directProvider(localModelSettings, { ...opts, model: effectiveModel } as GenChatOptions);
    let effectiveApiKey = apiKey ?? localModelSettings.apiKey ?? '';
    if (!effectiveApiKey && directProvider && this.sdk.localAPIKeySettings?.getProviderApiKey) {
      effectiveApiKey = this.sdk.localAPIKeySettings.getProviderApiKey(directProvider) ?? '';
    }

    const preferDirect = this._shouldPreferDirect(localModelSettings, opts as GenChatOptions);
    const shouldRouteDirect = !!(effectiveApiKey && (preferDirect || directProvider === 'openrouter'));

    if (shouldRouteDirect && directProvider === 'openrouter') {
      return this._genVideoOpenRouter(prompt, { ...opts, model: effectiveModel, apiKey: effectiveApiKey });
    }
    if (opts.directOnly) {
      if (directProvider === 'openrouter' && effectiveApiKey) return this._genVideoOpenRouter(prompt, { ...opts, model: effectiveModel, apiKey: effectiveApiKey });
      throw new Error(`Direct video generation requires an API key for provider: ${directProvider ?? 'unknown'}`);
    }
    if (directProvider === 'openrouter' && !effectiveApiKey) {
      throw new Error('视频生成需要 OpenRouter API Key：请在「模型接口配置 → 预设 → OpenRouter」中填写 API Key。');
    }
    if (!this._getToken()) throw new Error('请先登录');

    const body: Record<string, unknown> = {
      prompt, resolution, ratio,
      duration: duration === -1 ? -1 : Math.max(4, Math.min(15, duration)),
      generateAudio, watermark,
    };
    if (effectiveModel) body['model'] = effectiveModel;
    if (effectiveApiKey) body['apiKey'] = effectiveApiKey;
    if (Number.isFinite(seed)) body['seed'] = Math.trunc(seed!);
    if (images?.length) body['images'] = images;
    if (videos?.length) body['videos'] = videos;
    if (audios?.length) body['audios'] = audios;

    const resp = await fetch(`${this._apiBase}/genVideo`, {
      method: 'POST', headers: this._authHeaders(), body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => `HTTP ${resp.status}`);
      throw new Error(`视频生成失败: ${text}`);
    }
    const data = await resp.json() as Record<string, unknown>;
    if (!data['taskId']) throw new Error('未返回 taskId');
    return data['taskId'] as string;
  }

  // ──────────────────── getVideoTaskStatus / pollVideoTask ────────────────────

  /**
   * 单次轮询视频生成任务状态。
   * 支持 Keepwork 任务 ID 和 `openrouter:` 前缀的 OpenRouter 任务 ID。
   */
  async getVideoTaskStatus(taskId: string, opts: { apiKey?: string; model?: string } = {}): Promise<VideoTaskStatus> {
    const { apiKey, model } = opts;
    if (typeof taskId === 'string' && taskId.startsWith('openrouter:')) {
      return this._getVideoTaskStatusOpenRouter(taskId, { apiKey, model });
    }
    const localModelSettings = this._resolveLocalModelSettings(model ?? DEFAULT_VIDEO_MODEL);
    const effectiveApiKey = apiKey ?? localModelSettings.apiKey ?? '';
    let url = `${this._apiBase}/genVideo/task?taskId=${encodeURIComponent(taskId)}`;
    if (effectiveApiKey) url += `&apiKey=${encodeURIComponent(effectiveApiKey)}`;
    const resp = await fetch(url, { method: 'GET', headers: this._authHeaders() });
    if (!resp.ok) throw new Error(`轮询失败: HTTP ${resp.status}`);
    return resp.json() as Promise<VideoTaskStatus>;
  }

  /**
   * 持续轮询视频任务直到完成或失败。
   * 支持 Keepwork 任务 ID 和 `openrouter:` 前缀 ID。
   *
   * @param taskId    - 任务 ID
   * @param callbacks - onStatus / interval / timeout / apiKey / model / directLink
   */
  pollVideoTask(taskId: string, callbacks: PollVideoCallbacks = {}): Promise<VideoTaskStatus> {
    const { onStatus, interval = 5000, timeout = 600_000, apiKey, model } = callbacks;
    if (typeof taskId === 'string' && taskId.startsWith('openrouter:')) {
      return this._pollVideoTaskOpenRouter(taskId, callbacks);
    }
    const localModelSettings = this._resolveLocalModelSettings(model ?? DEFAULT_VIDEO_MODEL);
    const effectiveApiKey = apiKey ?? localModelSettings.apiKey ?? '';
    let taskUrl = `${this._apiBase}/genVideo/task?taskId=${encodeURIComponent(taskId)}`;
    if (effectiveApiKey) taskUrl += `&apiKey=${encodeURIComponent(effectiveApiKey)}`;

    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = async (): Promise<void> => {
        try {
          const resp = await fetch(taskUrl, { method: 'GET', headers: this._authHeaders() });
          if (!resp.ok) throw new Error(`轮询失败: HTTP ${resp.status}`);
          const data = await resp.json() as VideoTaskStatus;
          onStatus?.(data.status, data);
          if (data.status === 'succeeded') return resolve({ status: 'succeeded', videoUrl: data.videoUrl });
          if (data.status === 'failed') return resolve({ status: 'failed', error: (data.error as Record<string, string>)?.['message'] ?? '生成失败' });
          if (Date.now() - start > timeout) return resolve({ status: 'timeout', error: '轮询超时' });
          setTimeout(poll, interval);
        } catch (err) { reject(err); }
      };
      void poll();
    });
  }

  // ──────────────────── OpenRouter 视频直连 ────────────────────

  private async _genVideoOpenRouter(prompt: string, opts: GenVideoOptions): Promise<string> {
    const { apiKey, model, duration, resolution, ratio, size, generateAudio, watermark, seed, images, videos, audios, extraHeaders, providerOptions, callbackUrl } = opts;
    if (!apiKey) throw new Error('OpenRouter API key is required for direct video generation');
    if (!model) throw new Error('Model is required for OpenRouter video generation');
    if (Array.isArray(videos) && videos.length > 0) console.warn('[AIGenerators] OpenRouter direct video API does not support `videos` reference input; dropping', videos);
    if (Array.isArray(audios) && audios.length > 0) console.warn('[AIGenerators] OpenRouter direct video API does not support `audios` reference input; dropping', audios);
    if (watermark) console.warn('[AIGenerators] OpenRouter direct video API does not support the `watermark` flag; ignoring');

    const body: Record<string, unknown> = { model, prompt };
    if (Number.isFinite(duration) && (duration ?? 0) > 0) body['duration'] = Math.trunc(duration!);
    if (resolution) body['resolution'] = resolution;
    if (ratio) body['aspect_ratio'] = ratio;
    if (size) body['size'] = size;
    if (typeof generateAudio === 'boolean') body['generate_audio'] = generateAudio;
    if (Number.isFinite(seed) && seed !== -1) body['seed'] = Math.trunc(seed!);
    if (callbackUrl) body['callback_url'] = callbackUrl;
    if (providerOptions) body['provider'] = providerOptions;

    if (Array.isArray(images) && images.length > 0) {
      const frameImages: unknown[] = [], inputReferences: unknown[] = [];
      for (const img of images) {
        if (!img?.url) continue;
        const role = String(img.role ?? '').toLowerCase();
        const entry = { type: 'image_url', image_url: { url: img.url } };
        if (role === 'first_frame' || role === 'first' || role === 'start') frameImages.push({ ...entry, frame_type: 'first_frame' });
        else if (role === 'last_frame' || role === 'last' || role === 'end') frameImages.push({ ...entry, frame_type: 'last_frame' });
        else inputReferences.push(entry);
      }
      if (frameImages.length > 0) body['frame_images'] = frameImages;
      if (inputReferences.length > 0) body['input_references'] = inputReferences;
    }

    const resp = await fetch('https://openrouter.ai/api/v1/videos', {
      method: 'POST',
      headers: this._normalizeHeaders({
        'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://keepwork.com',
        'X-Title': 'KeepworkSDK', ...(extraHeaders ?? {}),
      }, 'OpenRouter 视频生成请求'),
      body: JSON.stringify(body),
    });
    const rawText = await resp.text();
    let data: Record<string, unknown> | null = null;
    try { data = rawText ? JSON.parse(rawText) as Record<string, unknown> : null; } catch { /* keep raw text */ }

    if (!resp.ok) {
      const msg = this._extractOpenRouterErrorMessage(data) || rawText || `HTTP ${resp.status}`;
      throw new Error(`OpenRouter 视频生成失败: ${msg}`);
    }
    const embeddedErr = this._extractOpenRouterErrorMessage(data);
    if (embeddedErr) throw new Error(`OpenRouter 视频生成失败: ${embeddedErr}`);
    if (!data?.['id']) throw new Error(`OpenRouter 未返回 id: ${rawText || '(empty response)'}`);
    return `openrouter:${data['id']}`;
  }

  _extractOpenRouterErrorMessage(data: unknown): string {
    if (!data || typeof data !== 'object') return '';
    const d = data as Record<string, unknown>;
    const err = d['error'];
    if (!err) return '';
    if (typeof err === 'string') return err;
    const e = err as Record<string, unknown>;
    let msg = String(e['message'] ?? e['code'] ?? '');
    if (msg) {
      const braceIdx = msg.indexOf('{');
      if (braceIdx >= 0) {
        try {
          const inner = JSON.parse(msg.slice(braceIdx)) as Record<string, unknown>;
          const innerMsg = String((inner?.['error'] as Record<string, unknown> | undefined)?.['message'] ?? inner?.['message'] ?? '');
          if (innerMsg) msg = `${msg.slice(0, braceIdx).trim()} ${innerMsg}`.trim();
        } catch { /* leave msg as-is */ }
      }
    }
    return msg;
  }

  _resolveOpenRouterApiKey(opts: { apiKey?: string; model?: string } = {}): string {
    if (opts.apiKey) return opts.apiKey;
    const local = opts.model ? this._resolveLocalModelSettings(opts.model, 'openrouter') : null;
    if (local?.apiKey) return local.apiKey;
    return this.sdk.localAPIKeySettings?.getProviderApiKey?.('openrouter') ?? '';
  }

  /** 从 taskId 中剥离 'openrouter:' 前缀得到 OpenRouter jobId（保持与重构前 AIGenerators.js 原型方法一致）。 */
  _openRouterJobIdFromTaskId(taskId: unknown): string {
    return String(taskId).slice('openrouter:'.length);
  }

  _normalizeOpenRouterVideoStatus(data: Record<string, unknown>): VideoTaskStatus & { contentUrl?: string } {
    const status = data?.['status'] as string | undefined;
    const contentUrl = Array.isArray(data?.['unsigned_urls']) ? (data['unsigned_urls'] as string[])[0] : undefined;
    if (status === 'completed') return { status: 'succeeded', contentUrl, usage: data?.['usage'], raw: data };
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      const extracted = this._extractOpenRouterErrorMessage(data);
      return {
        status: 'failed',
        error: extracted || (typeof data?.['error'] === 'string' ? data['error'] : '') || `视频生成${status === 'cancelled' ? '已取消' : status === 'expired' ? '已过期' : '失败'}`,
        raw: data,
      };
    }
    return { status: status ?? 'pending', raw: data };
  }

  async _resolveOpenRouterVideoDirectLink(contentUrl: string | undefined, apiKey: string, opts: { directLink?: boolean } = {}): Promise<string | undefined> {
    if (!contentUrl) return undefined;
    if (!opts.directLink) return contentUrl;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return contentUrl;
    try {
      const resp = await fetch(contentUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!resp.ok) { console.warn('[AIGenerators] OpenRouter direct video download failed:', resp.status); return contentUrl; }
      const blob = await resp.blob();
      return URL.createObjectURL(blob);
    } catch (err) { console.warn('[AIGenerators] OpenRouter direct video download error:', err); return contentUrl; }
  }

  private async _getVideoTaskStatusOpenRouter(taskId: string, opts: { apiKey?: string; model?: string; directLink?: boolean } = {}): Promise<VideoTaskStatus> {
    const apiKey = this._resolveOpenRouterApiKey(opts);
    if (!apiKey) throw new Error('OpenRouter API key is required to poll video task');
    const jobId = String(taskId).slice('openrouter:'.length);
    const resp = await fetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}`, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } });
    const rawText = await resp.text();
    let data: Record<string, unknown> | null = null;
    try { data = rawText ? JSON.parse(rawText) as Record<string, unknown> : null; } catch { /* keep raw */ }
    if (!resp.ok) throw new Error(`OpenRouter 轮询失败: ${this._extractOpenRouterErrorMessage(data) || rawText || `HTTP ${resp.status}`}`);
    const embeddedErr = this._extractOpenRouterErrorMessage(data);
    if (embeddedErr && !data?.['status']) throw new Error(`OpenRouter 轮询失败: ${embeddedErr}`);
    const normalized = this._normalizeOpenRouterVideoStatus(data ?? {});
    if (normalized.status === 'succeeded') {
      normalized.videoUrl = await this._resolveOpenRouterVideoDirectLink(normalized.contentUrl, apiKey, { directLink: opts.directLink !== false });
    }
    return normalized;
  }

  private _pollVideoTaskOpenRouter(taskId: string, callbacks: PollVideoCallbacks = {}): Promise<VideoTaskStatus> {
    const { onStatus, interval = 5000, timeout = 600_000, apiKey, model, directLink = true } = callbacks;
    const effectiveApiKey = this._resolveOpenRouterApiKey({ apiKey, model });
    if (!effectiveApiKey) return Promise.reject(new Error('OpenRouter API key is required to poll video task'));
    const jobId = String(taskId).slice('openrouter:'.length);
    const url = `https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}`;

    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = async (): Promise<void> => {
        try {
          const resp = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${effectiveApiKey}` } });
          if (!resp.ok) throw new Error(`OpenRouter 轮询失败: ${await resp.text().catch(() => `HTTP ${resp.status}`)}`);
          const data = await resp.json() as Record<string, unknown>;
          const normalized = this._normalizeOpenRouterVideoStatus(data);
          onStatus?.(normalized.status, { ...data, ...normalized });
          if (normalized.status === 'succeeded') {
            const videoUrl = await this._resolveOpenRouterVideoDirectLink(normalized.contentUrl, effectiveApiKey, { directLink });
            return resolve({ status: 'succeeded', videoUrl, contentUrl: normalized.contentUrl, usage: normalized.usage });
          }
          if (normalized.status === 'failed') return resolve({ status: 'failed', error: normalized.error ?? '生成失败' });
          if (Date.now() - start > timeout) return resolve({ status: 'timeout', error: '轮询超时' });
          setTimeout(poll, interval);
        } catch (err) { reject(err); }
      };
      void poll();
    });
  }
}

export default AIGenerators;
