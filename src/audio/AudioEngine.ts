/**
 * AudioEngine — browser audio playback & caching with 3-tier storage.
 *
 * Cache tiers: Memory (Blob URL + AudioBuffer) → IndexedDB → Network TTS
 *
 * 工具函数（常量、IndexedDB、MIDI、超时估算、缓存键）已拆分至 AudioEngine.utils.js。
 */

// 工具函数和常量来自拆分的 utils 文件
import {
	AUDIO_RECORD_TYPE, MIDI_RECORD_TYPE, TIMEOUT_PADDING,
	_getFromDB, _saveToDB, _clearDB,
	_isBlob, _isArrayBuffer, _isArrayBufferView, _isAudioUrl,
	_createAudioBlobFromData, _getAudioSourceFromOptions, _getMidiSequenceFromOptions,
	_normalizeMidiSequence, _normalizeOutputVolume, _buildCacheKey, _extractSpeechParams,
	_midiToFrequency,
	_estimateDurationFromText, _timeoutFromBuffer, _timeoutFromMediaDuration,
	_timeoutForUnknownAudio, _timeoutForSpeakFallback,
} from './AudioEngine.utils';

// ─── 全部常量和工具函数已移至 AudioEngine.utils ───

/** Window 上的非标准/SDK 全局 */
interface AEWindow {
	AudioContext?: typeof AudioContext;
	webkitAudioContext?: typeof AudioContext;
	__keepworkAudioEngine?: AudioEngine;
	keepwork?: { speech?: unknown; [key: string]: unknown };
}

/** 播放回调集合（play / _playAudioBuffer / _playFromUrl / _playMidiSequence 共用） */
interface AEPlayCallbacks {
	onEnd?: (() => void) | null;
	onStart?: (() => void) | null;
	onError?: ((err?: unknown) => void) | null;
	generation: number;
	text?: string;
	refreshSafetyTimeoutFromMetadata?: boolean;
}

export default class AudioEngine {
	options: Record<string, unknown>;
	_audioContext: AudioContext | null;
	_resumePromise: Promise<void> | null;
	_outputGainNode: GainNode | null;
	_outputGainContext: AudioContext | null;
	_outputVolume: number;
	_blobUrlCache: Map<string, string>;
	_urlCache: Map<string, { url: string | null; status: string; [key: string]: unknown }>;
	_pendingLoads: Map<string, Promise<string | null>>;
	_audioBufferCache: Map<string, AudioBuffer>;
	_midiSequenceCache: Map<string, Record<string, unknown>>;
	_sourceNode: AudioBufferSourceNode | null;
	_audioElement: HTMLAudioElement | null;
	_pooledAudio: HTMLAudioElement | null;
	_urlPlaybackToken: number;
	_playGeneration: number;
	_safetyTimeoutId: ReturnType<typeof setTimeout> | null;
	_midiNodes: Set<unknown>;
	_midiEndTimerId: ReturnType<typeof setTimeout> | null;
	_persistentQueue: Array<Record<string, unknown>>;
	_persistentRunning: boolean;
	_persistentCancelled: boolean;
	_persistentTimerId: ReturnType<typeof setTimeout> | null;
	[key: string]: unknown;

	constructor(options: Record<string, unknown> = {}) {
		this.options = { ...options };
		this._audioContext = null;
		this._resumePromise = null;
		this._outputGainNode = null;
		this._outputGainContext = null;
		this._outputVolume = _normalizeOutputVolume(options.outputVolume ?? options.masterVolume ?? 1);

		// ---- Cache state ----
		/** @type {Map<string, string>} cacheKey → Blob URL */
		this._blobUrlCache = new Map();
		/** @type {Map<string, {url: string|null, status: string}>} */
		this._urlCache = new Map();
		/** @type {Map<string, Promise<string|null>>} dedup in-flight preloads */
		this._pendingLoads = new Map();
		/** @type {Map<string, AudioBuffer>} pre-decoded AudioBuffers */
		this._audioBufferCache = new Map();
		/** @type {Map<string, object>} normalized MIDI sequences */
		this._midiSequenceCache = new Map();

		// ---- Playback state ----
		/** @type {AudioBufferSourceNode|null} */
		this._sourceNode = null;
		/** @type {HTMLAudioElement|null} */
		this._audioElement = null;
		/** @type {HTMLAudioElement|null} pooled element reused by `_playFromUrl` */
		this._pooledAudio = null;
		/** monotonic token to identify which `_playFromUrl` call owns the pooled element */
		this._urlPlaybackToken = 0;
		this._playGeneration = 0;
		this._safetyTimeoutId = null;
		this._midiNodes = new Set();
		this._midiEndTimerId = null;

		// ---- Persistent preload queue ----
		this._persistentQueue = [];
		this._persistentRunning = false;
		this._persistentCancelled = false;
		this._persistentTimerId = null;
	}

	static getShared(options: Record<string, unknown> = {}): AudioEngine {
		if (typeof window === 'undefined') {
			return new AudioEngine(options);
		}
		const w = window as unknown as AEWindow;
		if (!w.__keepworkAudioEngine) {
			w.__keepworkAudioEngine = new AudioEngine(options);
		} else if (options && typeof options === 'object') {
			w.__keepworkAudioEngine.configure(options);
		}

		return w.__keepworkAudioEngine;
	}

	configure(options: Record<string, unknown> = {}): this {
		if (!options || typeof options !== 'object') return this;
		this.options = { ...this.options, ...options };
		if (options.outputVolume !== undefined || options.masterVolume !== undefined) {
			this.setVolume(options.outputVolume ?? options.masterVolume);
		}
		return this;
	}

	setVolume(volume: unknown): this {
		this._outputVolume = _normalizeOutputVolume(volume, this._outputVolume);
		if (this._outputGainNode) {
			try {
				const now = this._outputGainContext?.currentTime || 0;
				this._outputGainNode.gain.cancelScheduledValues(now);
				this._outputGainNode.gain.setTargetAtTime(this._outputVolume, now, 0.01);
			} catch {
				try { this._outputGainNode.gain.value = this._outputVolume; } catch { /* ignore */ }
			}
		}
		if (this._pooledAudio) this._pooledAudio.volume = Math.min(1, this._outputVolume);
		return this;
	}

	getVolume(): number {
		return this._outputVolume;
	}

	isSupported(): boolean {
		const w = window as unknown as AEWindow;
		return typeof window !== 'undefined' && !!(w.AudioContext || w.webkitAudioContext);
	}

	_getAudioContextCtor(): typeof AudioContext | null {
		if (typeof window === 'undefined') return null;
		const w = window as unknown as AEWindow;
		return w.AudioContext || w.webkitAudioContext || null;
	}

	getContext(options: Record<string, unknown> = {}): AudioContext {
		const AudioContextCtor = this._getAudioContextCtor();
		if (!AudioContextCtor) {
			throw new Error('Web Audio API is unavailable');
		}

		if (this._audioContext && this._audioContext.state === 'closed') {
			this._audioContext = null;
		}

		if (!this._audioContext) {
			const merged = { ...this.options, ...options };
			const sampleRate = Number(merged.sampleRate);
			this._audioContext = Number.isFinite(sampleRate) && sampleRate > 0
				? new AudioContextCtor({ sampleRate })
				: new AudioContextCtor();
		}

		return this._audioContext;
	}

	getOutputNode(options: Record<string, unknown> = {}): GainNode {
		const context = this.getContext(options);
		if (!this._outputGainNode || this._outputGainContext !== context) {
			this._outputGainNode = context.createGain();
			this._outputGainNode.gain.setValueAtTime(this._outputVolume, context.currentTime);
			this._outputGainNode.connect(context.destination);
			this._outputGainContext = context;
		}
		return this._outputGainNode;
	}

	getDestination(options: Record<string, unknown> = {}): GainNode {
		return this.getOutputNode(options);
	}

	resume(options: Record<string, unknown> = {}): Promise<AudioContext> {
		const context = this.getContext(options);
		if (!context || context.state !== 'suspended') {
			return Promise.resolve(context);
		}

		context.resume();
		return Promise.resolve(context);
	}

	/**
	 * Check whether the AudioContext is in a usable (running) state.
	 * Returns false if context hasn't been created or is suspended/closed.
	 */
	isContextRunning(): boolean {
		return !!(this._audioContext && this._audioContext.state === 'running');
	}

	bindUserGesture(target: (EventTarget & { addEventListener?: unknown; removeEventListener?: unknown }) | null, options: Record<string, unknown> = {}): () => void {
		if (!target || typeof (target as { addEventListener?: unknown }).addEventListener !== 'function') {
			return () => {};
		}
		const evtTarget = target as EventTarget;

		const events = Array.isArray(options.events) && options.events.length
			? options.events as string[]
			: ['pointerdown', 'touchstart', 'click'];

		let disposed = false;
		let audioUnlocked = false;

		const listener = () => {
			// Resume Web Audio API context
			this.resume(options).catch(() => {});

			// Unlock HTMLAudioElement on iOS/mobile — a silent play()
			// during a user gesture enables future programmatic playback.
			//
			// CRUCIAL: unlock the **pooled** element that `_playFromUrl` will
			// reuse for all cache-hit playback. Unlocking some throwaway
			// `new Audio()` would not transfer to the pool element on iOS /
			// WeChat X5 (each element requires its own gesture-triggered play).
			if (!audioUnlocked) {
				try {
					const pooled = this._getPooledAudioElement();
					const originalSrc = pooled.src;
					pooled.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
					const p = pooled.play();
					const markUnlocked = () => {
						audioUnlocked = true;
						try { pooled.pause(); } catch (_) {}
						try { pooled.currentTime = 0; } catch (_) {}
						// Restore src if something was loaded before the unlock.
						if (originalSrc && originalSrc !== pooled.src) {
							try { pooled.src = originalSrc; } catch (_) {}
						}
					};
					if (p && p.then) {
						p.then(markUnlocked).catch(() => {});
					} else {
						markUnlocked();
					}
				} catch (_) {}
			}

			if (this._audioContext && this._audioContext.state === 'running' && audioUnlocked) {
				cleanup();
			}
		};

		const cleanup = () => {
			if (disposed) return;
			disposed = true;
			for (const eventName of events) {
				evtTarget.removeEventListener(eventName, listener, true);
			}
		};

		for (const eventName of events) {
			evtTarget.addEventListener(eventName, listener, {
				capture: true,
				passive: true,
			});
		}

		return cleanup;
	}

	// =====================================================================
	//  Cache API — preload, query, and persist TTS audio
	// =====================================================================

	/**
	 * Build a deterministic cache key from text + speech params.
	 */
	buildCacheKey(text: string, options?: Record<string, unknown>): string {
		return _buildCacheKey(text, options);
	}

	/**
	 * Get a cached Blob URL or CDN URL (synchronous, memory only).
	 * @param {string} text
	 * @param {object} [options] speech params
	 * @returns {string|null}
	 */
	getCachedUrl(text: string, options?: Record<string, unknown>): string | null {
		const key = _buildCacheKey(text, options);
		const blobUrl = this._blobUrlCache.get(key);
		if (blobUrl) return blobUrl;
		const cached = this._urlCache.get(key);
		if (cached && cached.status === 'ready' && cached.url) return cached.url;
		return null;
	}

	/**
	 * Get a pre-decoded AudioBuffer (synchronous, memory only).
	 */
	getAudioBuffer(text: string, options?: Record<string, unknown>): AudioBuffer | null {
		const key = _buildCacheKey(text, options);
		return this._audioBufferCache.get(key) || null;
	}

	/**
	 * Get a normalized cached MIDI sequence (synchronous, memory only).
	 */
	getMidiSequence(text: string, options?: Record<string, unknown>): Record<string, unknown> | null {
		const key = _buildCacheKey(text, options);
		return this._midiSequenceCache.get(key) || null;
	}

	_cacheAudioBlob(cacheKey: string, blob: unknown, options: Record<string, unknown> = {}): string | null {
		if (!_isBlob(blob) || blob.size <= 0) return null;
		const previousBlobUrl = this._blobUrlCache.get(cacheKey);
		if (previousBlobUrl) {
			try { URL.revokeObjectURL(previousBlobUrl); } catch { /* ignore */ }
		}
		const blobUrl = URL.createObjectURL(blob);
		this._blobUrlCache.set(cacheKey, blobUrl);
		this._urlCache.set(cacheKey, { url: blobUrl, status: 'ready' });
		this._decodeToBuffer(cacheKey, blob).catch(() => {});
		if (options.persist !== false) {
			_saveToDB(cacheKey, { __audioEngineType: AUDIO_RECORD_TYPE, blob }).catch(() => {});
		}
		return blobUrl;
	}

	_cacheAudioUrl(cacheKey: string, url: string, options: Record<string, unknown> = {}): string | null {
		if (!url) return null;
		this._urlCache.set(cacheKey, { url, status: 'ready' });
		if (options.fetchAndPersist === false || this._blobUrlCache.has(cacheKey)) return url;

		fetch(url).then(r => {
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.blob();
		}).then(blob => {
			this._cacheAudioBlob(cacheKey, blob, options);
		}).catch(() => {});
		return url;
	}

	_cacheAudioSource(cacheKey: string, source: unknown, options: Record<string, unknown> = {}): string | null {
		if (!source) return null;
		if (_isAudioUrl(source)) return this._cacheAudioUrl(cacheKey, (source as string).trim(), options);
		const blob = _createAudioBlobFromData(source, (options.mimeType as string) || (options.type as string) || 'audio/mpeg');
		return this._cacheAudioBlob(cacheKey, blob, options);
	}

	_cacheMidiSequence(cacheKey: string, sequence: unknown, options: Record<string, unknown> = {}): Record<string, unknown> | null {
		const normalized = _normalizeMidiSequence(sequence, options);
		if (!normalized) return null;
		this._midiSequenceCache.set(cacheKey, normalized);
		this._urlCache.set(cacheKey, { url: null, status: 'ready', type: 'midi' });
		if (options.persist !== false) {
			_saveToDB(cacheKey, { __audioEngineType: MIDI_RECORD_TYPE, sequence: normalized }).catch(() => {});
		}
		return normalized;
	}

	/**
	 * Store an externally-obtained audio URL in the cache and
	 * asynchronously download + persist its Blob to IndexedDB.
	 */
	set(text: string, source: unknown, options: Record<string, unknown> = {}): unknown {
		if (!text || !source) return null;
		const key = _buildCacheKey(text, options);

		const midiSequence = options.kind === 'midi' ? source : null;
		if (midiSequence) return this._cacheMidiSequence(key, midiSequence, options);
		return this._cacheAudioSource(key, source, options);
	}

	setUrl(text: string, url: string, options: Record<string, unknown> = {}): unknown {
		return this.set(text, url, options);
	}

	setAudioFile(text: string, file: unknown, options: Record<string, unknown> = {}): unknown {
		return this.set(text, file, options);
	}

	setAudioData(text: string, data: unknown, options: Record<string, unknown> = {}): unknown {
		return this.set(text, data, options);
	}

	setMidiSequence(text: string, sequence: unknown, options: Record<string, unknown> = {}): unknown {
		if (!text || !sequence) return null;
		const key = _buildCacheKey(text, options);
		return this._cacheMidiSequence(key, sequence, options);
	}

	/**
	 * Preload a single text → audio entry through three tiers:
	 *   memory Blob URL → IndexedDB → network TTS API
	 *
	 * @param {string} text
	 * @param {object} [options] speech params
	 * @param {function} [options.fetchAudioUrl] async (text, params) => url — custom TTS fetcher
	 * @returns {Promise<string|null>} playable URL
	 */
	preload(text: string, options?: Record<string, unknown>): Promise<string | null> {
		if (!text || typeof text !== 'string') return Promise.resolve(null);

		const key = _buildCacheKey(text, options);
		const speechParams = _extractSpeechParams(options);
		const directSource = _getAudioSourceFromOptions(options);
		const midiSequence = _getMidiSequenceFromOptions(options);

		if (midiSequence) {
			const cached = this._cacheMidiSequence(key, midiSequence, options);
			return Promise.resolve(cached ? `midi:${key}` : null);
		}

		if (directSource) {
			return Promise.resolve(this._cacheAudioSource(key, directSource, options));
		}

		if (this._blobUrlCache.has(key)) return Promise.resolve(this._blobUrlCache.get(key) ?? null);
		const cached = this._urlCache.get(key);
		if (cached && cached.status === 'ready') return Promise.resolve(cached.url);
		if (this._pendingLoads.has(key)) return this._pendingLoads.get(key) as Promise<string | null>;

		const promise = (async () => {
			try {
				// IndexedDB tier
				const record = await _getFromDB(key) as Record<string, unknown> | null;
				if (record?.__audioEngineType === MIDI_RECORD_TYPE && record.sequence) {
					this._midiSequenceCache.set(key, record.sequence as Record<string, unknown>);
					this._urlCache.set(key, { url: null, status: 'ready', type: 'midi' });
					this._pendingLoads.delete(key);
					return `midi:${key}`;
				}
				const dbBlob = record?.__audioEngineType === AUDIO_RECORD_TYPE ? record.blob : record;
				if (_isBlob(dbBlob) && dbBlob.size > 0) {
					const blobUrl = this._cacheAudioBlob(key, dbBlob, { persist: false });
					this._pendingLoads.delete(key);
					return blobUrl;
				}

				// Network tier via custom fetcher
				const fetchFn = options?.fetchAudioUrl;
				if (typeof fetchFn !== 'function') {
					this._pendingLoads.delete(key);
					return null;
				}

				const cdnUrl = await (fetchFn as (t: string, p: unknown) => Promise<string>)(text, speechParams);
				if (!cdnUrl) {
					this._urlCache.set(key, { url: null, status: 'error' });
					this._pendingLoads.delete(key);
					return null;
				}

				this._urlCache.set(key, { url: cdnUrl, status: 'ready' });

				try {
					const r = await fetch(cdnUrl);
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					const audioBlob = await r.blob();
					if (audioBlob && audioBlob.size > 0) {
						const blobUrl = this._cacheAudioBlob(key, audioBlob);
						this._pendingLoads.delete(key);
						return blobUrl;
					}
				} catch {
					// Blob download failed; CDN URL is still usable
				}

				this._pendingLoads.delete(key);
				return cdnUrl;
			} catch {
				this._urlCache.set(key, { url: null, status: 'error' });
				this._pendingLoads.delete(key);
				return null;
			}
		})();

		this._pendingLoads.set(key, promise);
		this._urlCache.set(key, { url: null, status: 'loading' });
		return promise;
	}

	/**
	 * Batch-preload multiple items with concurrency control.
	 * @param {Array<string|{text:string, options?:object}>} items
	 * @param {number} [concurrency=3]
	 */
	async preloadBatch(items: Array<string | { text: string; options?: Record<string, unknown> }>, concurrency = 3): Promise<void> {
		if (!items || items.length === 0) return;
		const toLoad = items
			.map(i => typeof i === 'string' ? { text: i, options: undefined as Record<string, unknown> | undefined } : { text: i.text, options: i.options })
			.filter(({ text, options }) => {
				if (!text || typeof text !== 'string') return false;
				const key = _buildCacheKey(text, options);
				if (this._blobUrlCache.has(key)) return false;
				const c = this._urlCache.get(key);
				return !c || c.status === 'error';
			});
		for (let i = 0; i < toLoad.length; i += concurrency) {
			const batch = toLoad.slice(i, i + concurrency);
			await Promise.allSettled(batch.map(({ text, options }) => this.preload(text, options)));
		}
	}

	/**
	 * Background persistent preload queue with automatic retry.
	 */
	preloadPersistent(items: Array<string | { text: string; options?: Record<string, unknown> }>, concurrency = 2, retryDelay = 5000, batchDelay = 100): Promise<void> {
		if (!items || items.length === 0) return Promise.resolve();
		this.cancelPreload();
		this._persistentCancelled = false;
		this._persistentQueue = items
			.map(i => typeof i === 'string' ? { text: i } : { text: i.text, options: i.options })
			.filter(({ text }) => text && typeof text === 'string') as Array<Record<string, unknown>>;

		return new Promise<void>(resolve => {
			const runBatch = async () => {
				if (this._persistentCancelled || this._persistentQueue.length === 0) {
					this._persistentRunning = false;
					resolve();
					return;
				}
				this._persistentRunning = true;
				const batch = this._persistentQueue.splice(0, concurrency);
				const results = await Promise.allSettled(
					batch.map(async (item) => {
						const text = item.text as string;
						const options = item.options as Record<string, unknown> | undefined;
						const key = _buildCacheKey(text, options);
						if (this._blobUrlCache.has(key)) return;
						const c = this._urlCache.get(key);
						if (c && c.status === 'ready') return;
						const result = await this.preload(text, options);
						if (!result) throw new Error('preload failed');
					})
				);
				results.forEach((r, i) => {
					if (r.status === 'rejected' && !this._persistentCancelled) {
						this._persistentQueue.push(batch[i]);
					}
				});
				if (this._persistentCancelled) { this._persistentRunning = false; resolve(); return; }
				if (this._persistentQueue.length > 0) {
					const delay = results.some(r => r.status === 'rejected') ? retryDelay : batchDelay;
					this._persistentTimerId = setTimeout(runBatch, delay);
				} else {
					this._persistentRunning = false;
					resolve();
				}
			};
			runBatch();
		});
	}

	cancelPreload(): void {
		this._persistentCancelled = true;
		this._persistentQueue = [];
		if (this._persistentTimerId) {
			clearTimeout(this._persistentTimerId);
			this._persistentTimerId = null;
		}
		this._persistentRunning = false;
	}

	/**
	 * Warm up memory caches from IndexedDB at app startup.
	 * @returns {Promise<Array<{text:string, options?:object}>>} items not found in IndexedDB
	 */
	async warmupFromDB(items: Array<string | { text: string; options?: Record<string, unknown> }>): Promise<Array<{ text: string; options?: Record<string, unknown> }>> {
		if (!items || items.length === 0) return [];
		const missed: Array<{ text: string; options?: Record<string, unknown> }> = [];
		for (const raw of items) {
			const { text, options } = typeof raw === 'string' ? { text: raw, options: undefined as Record<string, unknown> | undefined } : raw;
			if (!text) continue;
			const key = _buildCacheKey(text, options);
			if (this._blobUrlCache.has(key) || this._midiSequenceCache.has(key)) continue;
			try {
				const record = await _getFromDB(key) as Record<string, unknown> | null;
				if (record?.__audioEngineType === MIDI_RECORD_TYPE && record.sequence) {
					this._midiSequenceCache.set(key, record.sequence as Record<string, unknown>);
					this._urlCache.set(key, { url: null, status: 'ready', type: 'midi' });
				} else {
					const blob = record?.__audioEngineType === AUDIO_RECORD_TYPE ? record.blob : record;
					if (_isBlob(blob) && blob.size > 0) {
						this._cacheAudioBlob(key, blob, { persist: false });
					} else {
						missed.push({ text, options });
					}
				}
			} catch {
				missed.push({ text, options });
			}
		}
		return missed;
	}

	/**
	 * Decode a Blob into an AudioBuffer and cache it.
	 * On mobile the AudioContext may be suspended; decodeAudioData still works
	 * in most browsers but we guard against failures gracefully.
	 * @private
	 */
	async _decodeToBuffer(cacheKey: string, blob: Blob): Promise<void> {
		if (this._audioBufferCache.has(cacheKey)) return;
		try {
			// Avoid creating AudioContext just for pre-decoding if no context
			// exists yet — on mobile this would create a suspended context that
			// counts against the browser's limit. If context already exists,
			// decoding works even when suspended.
			if (!this._audioContext) return;
			const ctx = this._audioContext;
			if (ctx.state === 'closed') return;
			const arrayBuffer = await blob.arrayBuffer();
			const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
			this._audioBufferCache.set(cacheKey, audioBuffer);
		} catch (err) {
			// Decode failure is non-fatal; HTML Audio fallback works fine
		}
	}

	// =====================================================================
	//  Playback API — play cached/preloaded audio with smart timeouts
	// =====================================================================

	/**
	 * Play audio for the given text, using the best available cached source.
	 *
	 * Resolution order: pre-decoded AudioBuffer → Blob/CDN URL → skip.
	 *
	 * On mobile, if the AudioContext is suspended (no user gesture), the method
	 * attempts `resume()` but does NOT block indefinitely. Instead it fires
	 * `onEnd` after a reasonable timeout derived from the AudioBuffer duration
	 * or estimated from text length.
	 *
	 * @param {string} text
	 * @param {object} [options]
	 * @param {function} [options.onEnd]
	 * @param {function} [options.onStart]
	 * @param {function} [options.onError]
	 * @param {number}   [options.timeout] explicit safety timeout override (ms)
	 * @returns {{ type: string }|null} playback descriptor or null if nothing to play
	 */
	play(text: string, options: Record<string, unknown> = {}): { type: string } | null {
		const { onEnd, onStart, onError } = options as { onEnd?: () => void; onStart?: () => void; onError?: (e?: unknown) => void };
		const generation = ++this._playGeneration;
		this._clearSafetyTimeout();
		this._clearMidiEndTimer();

		const key = _buildCacheKey(text, options);

		// Wrap onEnd as a one-shot call guarded by generation
		let onEndCalled = false;
		const safeOnEnd = onEnd ? () => {
			if (onEndCalled || this._playGeneration !== generation) return;
			onEndCalled = true;
			this._clearSafetyTimeout();
			onEnd();
		} : null;

		// 1. Try cached MIDI sequence (Web Audio oscillator path)
		const midiSequence = this._midiSequenceCache.get(key);
		if (midiSequence) {
			const timeout = (options.timeout as number) || Math.round(((midiSequence.duration as number) + (midiSequence.release as number)) * 1000) + TIMEOUT_PADDING;
			this._setSafetyTimeout(safeOnEnd, timeout, text);
			this._playMidiSequence(midiSequence, { onEnd: safeOnEnd, onStart, onError, generation });
			return { type: 'midi' };
		}

		// 2. Try pre-decoded AudioBuffer (zero-latency path)
		const audioBuffer = this._audioBufferCache.get(key);
		const cachedUrl = this.getCachedUrl(text, options);

		if (audioBuffer) {
			// On mobile, AudioContext may be suspended (no user gesture yet).
			// If so, fall through to URL-based playback via HTMLAudioElement
			// which has a better chance of working (especially after iOS unlock).
			const contextReady = this._audioContext && this._audioContext.state === 'running';
			if (contextReady) {
				const timeout = (options.timeout as number) || _timeoutFromBuffer(audioBuffer) || _estimateDurationFromText(text);
				this._setSafetyTimeout(safeOnEnd, timeout, text);
				this._playAudioBuffer(audioBuffer, { onEnd: safeOnEnd, onStart, onError, generation });
				return { type: 'audiobuffer' };
			}

			// Context suspended — try resume in background; if we have a URL
			// fall through to HTMLAudioElement path below.
			this.resume().catch(() => {});

			if (!cachedUrl) {
				// No URL fallback available — use AudioBuffer path anyway with
				// safety timeout to guarantee onEnd fires.
				const timeout = (options.timeout as number) || _timeoutFromBuffer(audioBuffer) || _estimateDurationFromText(text);
				this._setSafetyTimeout(safeOnEnd, timeout, text);
				this._playAudioBuffer(audioBuffer, { onEnd: safeOnEnd, onStart, onError, generation });
				return { type: 'audiobuffer' };
			}
			// else: fall through to URL path
		}

		// 3. Try cached URL (Blob URL or CDN URL) via HTMLAudioElement.
		//    On mobile this path is more reliable when AudioContext is suspended.
		if (cachedUrl) {
			const timeout = (options.timeout as number) || (audioBuffer ? _timeoutFromBuffer(audioBuffer) : null) || _timeoutForUnknownAudio(text);
			this._setSafetyTimeout(safeOnEnd, timeout, text);
			this._playFromUrl(cachedUrl, {
				onEnd: safeOnEnd,
				onStart,
				onError,
				generation,
				text,
				refreshSafetyTimeoutFromMetadata: !options.timeout,
			});
			return { type: 'cached' };
		}

		// Nothing cached — caller should fall back to SDK TTS path
		return null;
	}

	/**
	 * Play an AudioBuffer via Web Audio API.
	 * Attempts resume(); if the context stays suspended after a short wait,
	 * fires onEnd via the safety timeout rather than hanging forever.
	 * @private
	 */
	async _playAudioBuffer(audioBuffer: AudioBuffer, { onEnd, onStart, onError, generation }: AEPlayCallbacks): Promise<void> {
		this._stopCurrentAudio();

		// Guard: if a newer play() was called while we were awaiting, bail out.
		if (this._playGeneration !== generation) return;

		let ctx;
		try {
			ctx = await this.resume();
		} catch (_) {
			// resume failed — safety timeout will fire onEnd
			if (onError) onError(new Error('AudioContext resume failed'));
			return;
		}

		if (this._playGeneration !== generation) return;

		if (!ctx) {
			if (onEnd) onEnd();
			return;
		}

		// If context is still suspended after resume (no gesture yet), we let
		// the safety timeout handle onEnd rather than blocking.
		if (ctx.state !== 'running') {
			// onEnd will be fired by _safetyTimeoutId
			if (onError) onError(new Error('AudioContext suspended — no user gesture'));
			return;
		}

		let ended = false;
		const fireOnEnd = () => {
			if (ended || this._playGeneration !== generation) return;
			ended = true;
			this._sourceNode = null;
			if (onEnd) onEnd();
		};

		try {
			const source = ctx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(this.getOutputNode());
			this._sourceNode = source;

			source.onended = () => {
				if (this._sourceNode !== source) return;
				fireOnEnd();
			};

			source.start(0);
			if (onStart) onStart();
		} catch (err) {
			this._sourceNode = null;
			if (onError) onError(err);
			fireOnEnd();
		}
	}

	/**
	 * Get the shared pooled HTMLAudioElement used by `_playFromUrl`.
	 *
	 * WHY POOLED: On mobile WebViews (especially WeChat X5 / iOS Safari),
	 * each freshly-created `new Audio()` element requires its own user-gesture
	 * unlock. If we kept creating new elements, only the very first one
	 * (played during a user gesture) would be audible — subsequent cache-hit
	 * plays would silently fail while still resolving their promises,
	 * because browsers silently drop autoplay on a never-unlocked element.
	 *
	 * Reusing a single persistent element means only one unlock is required
	 * (via `bindUserGesture()` or the first natural play-during-gesture), and
	 * every later cache-hit play on the same element is permitted.
	 *
	 * The element is attached to `<body>` (hidden) because some mobile
	 * browsers require attachment for `.play()` to dispatch correctly.
	 *
	 * @private
	 */
	_getPooledAudioElement() {
		if (this._pooledAudio) return this._pooledAudio;
		if (typeof document === 'undefined') return new Audio();

		const audio = new Audio();
		audio.volume = Math.min(1, this._outputVolume);
		audio.preload = 'auto';
		audio.setAttribute('playsinline', '');
		audio.setAttribute('webkit-playsinline', '');
		audio.setAttribute('aria-hidden', 'true');
		audio.style.position = 'absolute';
		audio.style.width = '0';
		audio.style.height = '0';
		audio.style.opacity = '0';
		audio.style.pointerEvents = 'none';
		try { document.body?.appendChild(audio); } catch (_) {}
		this._pooledAudio = audio;
		return audio;
	}

	/**
	 * Play from a URL using a **pooled** HTMLAudioElement.
	 * On iOS/mobile, play() may reject if not called during a user gesture.
	 * In that case we fire onEnd immediately so callers are never left hanging.
	 * @private
	 */
	_playFromUrl(url: string, { onEnd, onStart, onError, generation, text, refreshSafetyTimeoutFromMetadata = true }: AEPlayCallbacks): void {
		this._stopCurrentAudio();

		const audio = this._getPooledAudioElement();
		// Bump playback token so previous play's stale events are ignored.
		const playbackToken = ++this._urlPlaybackToken;

		// Reset event handlers from any previous play on the same pooled element.
		audio.onloadeddata = null;
		audio.onloadedmetadata = null;
		audio.onended = null;
		audio.onerror = null;
		audio.onpause = null;

		try { audio.pause(); } catch (_) {}
		try { audio.currentTime = 0; } catch (_) {}
		audio.src = url;
		audio.volume = Math.min(1, this._outputVolume);
		try { audio.load(); } catch (_) {}
		this._audioElement = audio;

		let ended = false;
		const fireOnEnd = () => {
			if (ended || this._playGeneration !== generation) return;
			ended = true;
			// Only clear _audioElement if this playback is still the current one.
			if (this._urlPlaybackToken === playbackToken) {
				this._audioElement = null;
			}
			if (onEnd) onEnd();
		};

		const isCurrentPlayback = () => this._urlPlaybackToken === playbackToken;

		audio.onloadedmetadata = () => {
			if (!isCurrentPlayback() || ended || !refreshSafetyTimeoutFromMetadata) return;
			const metadataTimeout = _timeoutFromMediaDuration(audio.duration);
			if (metadataTimeout) {
				// Replace the conservative pre-metadata timeout with the real audio
				// duration. The timer starts here, so metadata/network loading cannot
				// consume playback budget and cut speech short.
				this._setSafetyTimeout(onEnd, metadataTimeout, text ?? '');
			}
		};
		audio.onloadeddata = () => { if (isCurrentPlayback() && onStart) onStart(); };
		audio.onended = () => { if (isCurrentPlayback()) fireOnEnd(); };
		audio.onerror = (err) => {
			if (!isCurrentPlayback()) return;
			if (onError) onError(err);
			fireOnEnd();
		};

		// Also listen for 'pause' without a preceding 'ended' — on some mobile
		// browsers the audio can be interrupted (e.g. phone call, app switch)
		// and only fires 'pause'. We treat this as onEnd to avoid getting stuck.
		audio.onpause = () => {
			if (!isCurrentPlayback() || ended) return;
			if (audio.ended) fireOnEnd();
		};

		// Attempt resume of Web Audio context in background (helps subsequent plays)
		this.resume().catch(() => {});

		const playPromise = audio.play();
		if (playPromise && typeof playPromise.then === 'function') {
			playPromise.catch((err: unknown) => {
				if (!isCurrentPlayback()) return;
				// On mobile, NotAllowedError means no user gesture — fire onEnd
				// immediately so callers don't hang.
				if (onError) onError(err);
				fireOnEnd();
			});
		}
	}

	/**
	 * Play a cached MIDI-like sequence using simple Web Audio oscillators.
	 * @private
	 */
	async _playMidiSequence(sequence: Record<string, unknown>, { onEnd, onStart, onError, generation }: AEPlayCallbacks): Promise<void> {
		this._stopCurrentAudio();

		if (this._playGeneration !== generation) return;

		let ctx: AudioContext;
		try {
			ctx = await this.resume();
		} catch {
			if (onError) onError(new Error('AudioContext resume failed'));
			return;
		}

		if (this._playGeneration !== generation) return;

		if (!ctx || ctx.state !== 'running') {
			if (onError) onError(new Error('AudioContext suspended — no user gesture'));
			return;
		}

		let ended = false;
		const fireOnEnd = () => {
			if (ended || this._playGeneration !== generation) return;
			ended = true;
			this._clearMidiEndTimer();
			if (onEnd) onEnd();
		};

		try {
			const startAt = ctx.currentTime + 0.02;
			const masterGain = ctx.createGain();
			masterGain.gain.setValueAtTime(sequence.volume as number, startAt);
			masterGain.connect(this.getOutputNode());
			this._midiNodes.add(masterGain);

			for (const note of sequence.notes as Array<Record<string, unknown>>) {
				const oscillator = ctx.createOscillator();
				const gain = ctx.createGain();
				const noteStart = startAt + (note.time as number);
				const noteEnd = noteStart + (note.duration as number);
				const releaseEnd = noteEnd + (sequence.release as number);

				oscillator.type = ['sine', 'square', 'sawtooth', 'triangle'].includes(note.type as string) ? (note.type as OscillatorType) : 'sine';
				oscillator.frequency.setValueAtTime(_midiToFrequency(note.note as number), noteStart);
				gain.gain.setValueAtTime(0.0001, noteStart);
				gain.gain.linearRampToValueAtTime(Math.max(0.0001, note.velocity as number), noteStart + (sequence.attack as number));
				gain.gain.setValueAtTime(Math.max(0.0001, note.velocity as number), noteEnd);
				gain.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

				oscillator.connect(gain);
				gain.connect(masterGain);
				oscillator.onended = () => {
					this._midiNodes.delete(oscillator);
					this._midiNodes.delete(gain);
				};

				this._midiNodes.add(oscillator);
				this._midiNodes.add(gain);
				oscillator.start(noteStart);
				oscillator.stop(releaseEnd);
			}

			this._midiEndTimerId = setTimeout(fireOnEnd, Math.round(((sequence.duration as number) + (sequence.release as number)) * 1000) + 80);
			if (onStart) onStart();
		} catch (err) {
			if (onError) onError(err);
			fireOnEnd();
		}
	}

	/**
	 * Stop any audio currently being played through this engine.
	 */
	stopPlayback(): void {
		this._playGeneration++;
		this._clearSafetyTimeout();
		this._stopCurrentAudio();
	}

	// =====================================================================
	//  High-level speak / stopSpeak API
	//  Combines cached playback with SDK TTS fallback and generation-based
	//  cancellation so that callers only need a single method.
	// =====================================================================

	/** @private — generation counter for speak(); independent of _playGeneration */
	_speakGeneration = 0;
	/** @private — safety timeout for the SDK playKeepworkAudio fallback path */
	_speakTimeoutId: ReturnType<typeof setTimeout> | null = null;

	/** @private */
	_clearSpeakTimeout(): void {
		if (this._speakTimeoutId) {
			clearTimeout(this._speakTimeoutId);
			this._speakTimeoutId = null;
		}
	}

	/**
	 * Play TTS audio for `text`, trying cached AudioEngine playback first,
	 * then falling back to the SDK `playKeepworkAudio` path.
	 *
	 * Handles generation-based cancellation so that calling `stopSpeak()` at
	 * any point safely invalidates in-flight async SDK callbacks.
	 *
	 * @param {string} text
	 * @param {object} [options]
	 * @param {function} [options.onEnd]
	 * @param {function} [options.onStart]
	 * @param {function} [options.onError]
	 * @returns {{ type: string }|null}
	 */
	speak(text: string, options: Record<string, unknown> = {}): { type: string } | null {
		const { onEnd, onStart, onError } = options as { onEnd?: () => void; onStart?: () => void; onError?: (e?: unknown) => void };

		// Increment generation to invalidate any previous speak() callbacks
		const generation = ++this._speakGeneration;

		// Clear previous speak safety timeout
		this._clearSpeakTimeout();

		const w = window as unknown as AEWindow;
		if (!(w.keepwork as { speech?: unknown } | undefined)?.speech) {
			if (onEnd) setTimeout(onEnd, 0);
			return null;
		}

		// Wrap onEnd as one-shot + generation-guarded
		let onEndCalled = false;
		const safeOnEnd = onEnd ? () => {
			if (onEndCalled) return;
			onEndCalled = true;
			this._clearSpeakTimeout();
			onEnd();
		} : null;

		// === Fast path: try cached playback via AudioEngine.play() ===
		const playResult = this.play(text, {
			...options,
			onEnd: () => {
				if (this._speakGeneration !== generation) return;
				if (safeOnEnd) safeOnEnd();
			},
			onStart,
			onError,
		});
		if (playResult) {
			// Cache hit — AudioEngine.play() manages its own safety timeout
			return playResult;
		}

		// === Fallback path: SDK playKeepworkAudio ===
		// Safety timeout includes network/TTS loading. It is reset once the SDK
		// reports that audio is loaded so loading latency cannot consume the
		// playback budget and trigger onEnd before speech finishes.
		const setSpeakTimeout = safeOnEnd ? (timeoutMs: number) => {
			this._clearSpeakTimeout();
			this._speakTimeoutId = setTimeout(() => {
				if (this._speakGeneration !== generation) return;
				console.warn('[AudioEngine] speak onEnd timeout (' + timeoutMs + 'ms) for:', (text || '').substring(0, 30));
				safeOnEnd();
			}, timeoutMs);
		} : null;
		if (safeOnEnd && setSpeakTimeout) {
			setSpeakTimeout((options.timeout as number) || _timeoutForSpeakFallback(text));
		}

		// Normalize speed → spd for SDK textToAudio
		const speechOptions: Record<string, unknown> = {
			...options,
			useCache: true,
			onEnded: () => {
				if (this._speakGeneration !== generation) return;
				if (safeOnEnd) safeOnEnd();
			},
			onLoaded: () => {
				// If stopSpeak() was called while SDK was loading, stop immediately
				if (this._speakGeneration !== generation) {
					this.stopSpeak();
					return;
				}
				if (setSpeakTimeout && !options.timeout) {
					setSpeakTimeout(_timeoutForUnknownAudio(text));
				}
			},
		};
		if (speechOptions.speed !== undefined && speechOptions.spd === undefined) {
			speechOptions.spd = speechOptions.speed;
		}
		delete speechOptions.speed;

		(w.keepwork as { speech: { playKeepworkAudio(t: string, o: unknown): Promise<unknown> } }).speech.playKeepworkAudio(text, speechOptions)
			.then(() => {
				if (this._speakGeneration !== generation) return;
				if (safeOnEnd) safeOnEnd();
			})
			.catch((err: unknown) => {
				console.error('[AudioEngine] playKeepworkAudio failed:', err);
				if (this._speakGeneration !== generation) return;
				if (onError) onError(err);
				if (safeOnEnd) safeOnEnd();
			});

		return { type: 'keepwork' };
	}

	/**
	 * Stop all speech audio: engine playback, SDK-managed audio, and fallback keepwork-audio element.
	 * Also invalidates any in-flight speak() callbacks via generation counter.
	 */
	stopSpeak(): void {
		this._speakGeneration++;
		this._clearSpeakTimeout();
		this.stopPlayback();
		// Stop SDK-managed audio
		const w = window as unknown as AEWindow;
		const speech = (w.keepwork as { speech?: { stopAllAudio(): void } } | undefined)?.speech;
		if (speech) {
			speech.stopAllAudio();
		}
		// Fallback: directly stop SDK-created keepwork-audio element
		try {
			const keepworkAudio = document.getElementById('keepwork-audio') as HTMLAudioElement | null;
			if (keepworkAudio) {
				keepworkAudio.pause();
				keepworkAudio.currentTime = 0;
			}
		} catch { /* ignore */ }
	}

	/** @private */
	_stopCurrentAudio(): void {
		this._clearMidiEndTimer();
		if (this._sourceNode) {
			try {
				this._sourceNode.onended = null;
				this._sourceNode.stop();
				this._sourceNode.disconnect();
			} catch (_) {}
			this._sourceNode = null;
		}
		if (this._audioElement) {
			// Invalidate in-flight `_playFromUrl` events so their onEnd doesn't fire.
			this._urlPlaybackToken++;
			try {
				this._audioElement.onended = null;
				this._audioElement.onerror = null;
				this._audioElement.onpause = null;
				this._audioElement.onloadeddata = null;
				this._audioElement.pause();
				this._audioElement.currentTime = 0;
			} catch (_) {}
			// Keep the pooled element alive (do NOT remove or null out the pool).
			// Just detach the "currently active" reference.
			this._audioElement = null;
		}
		if (this._midiNodes.size) {
			for (const node of this._midiNodes as Set<{ stop?: () => void; disconnect?: () => void }>) {
				try { if (typeof node.stop === 'function') node.stop(); } catch { /* ignore */ }
				try { if (typeof node.disconnect === 'function') node.disconnect(); } catch { /* ignore */ }
			}
			this._midiNodes.clear();
		}
	}

	/** @private */
	_setSafetyTimeout(safeOnEnd: (() => void) | null | undefined, timeoutMs: number, text: string): void {
		if (!safeOnEnd || !timeoutMs) return;
		this._clearSafetyTimeout();
		this._safetyTimeoutId = setTimeout(() => {
			console.warn('[AudioEngine] safety timeout fired (' + timeoutMs + 'ms) for:', (text || '').substring(0, 30));
			safeOnEnd();
		}, timeoutMs);
	}

	/** @private */
	_clearSafetyTimeout() {
		if (this._safetyTimeoutId) {
			clearTimeout(this._safetyTimeoutId);
			this._safetyTimeoutId = null;
		}
	}

	/** @private */
	_clearMidiEndTimer() {
		if (this._midiEndTimerId) {
			clearTimeout(this._midiEndTimerId);
			this._midiEndTimerId = null;
		}
	}

	// =====================================================================
	//  Utility
	// =====================================================================

	/**
	 * Estimate audio playback duration from text length (ms).
	 * Useful for setting timeouts when actual audio duration is unknown.
	 */
	static estimateDuration(text: string): number {
		return _estimateDurationFromText(text);
	}

	/**
	 * Clear all in-memory caches (does NOT clear IndexedDB).
	 */
	clearCache(): void {
		for (const blobUrl of this._blobUrlCache.values()) {
			try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
		}
		this._blobUrlCache.clear();
		this._audioBufferCache.clear();
		this._midiSequenceCache.clear();
		this._urlCache.clear();
		this._pendingLoads.clear();
		this.cancelPreload();
	}

	/**
	 * Clear both in-memory caches and IndexedDB persistent cache.
	 */
	async clearAll(): Promise<void> {
		this.clearCache();
		await _clearDB();
	}

	/**
	 * Get cache statistics (for debugging).
	 */
	getStats() {
		let ready = 0, loading = 0, error = 0;
		for (const entry of this._urlCache.values()) {
			if (entry.status === 'ready') ready++;
			else if (entry.status === 'loading') loading++;
			else error++;
		}
		return {
			total: this._urlCache.size,
			ready,
			loading,
			error,
			blobCached: this._blobUrlCache.size,
			audioBufferDecoded: this._audioBufferCache.size,
			midiCached: this._midiSequenceCache.size,
			persistentQueueSize: this._persistentQueue.length,
			persistentRunning: this._persistentRunning,
		};
	}
}
