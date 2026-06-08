/**
 * AudioEngine.utils.js — AudioEngine 内部工具层
 *
 * 包含：
 * - 常量（DB 名称、语音参数键、超时配置、音符映射等）
 * - IndexedDB 辅助函数（_openDB / _getFromDB / _saveToDB / _clearDB）
 * - Blob/ArrayBuffer 类型检查工具
 * - MIDI 工具（_midiToFrequency / _noteNameToMidi / _normalizeMidiSequence 等）
 * - 音频超时估算（_estimateDurationFromText / _timeoutFromBuffer 等）
 * - 缓存键构建（_buildCacheKey / _extractSpeechParams）
 *
 * 供 AudioEngine.js 主类导入使用，不直接暴露给外部。
 */

// ===================== Constants =====================

const DB_NAME = 'keepwork-audio-cache';
const STORE_NAME = 'audio-blobs';
const DB_VERSION = 1;

/** Speech parameter keys that affect audio output (sorted for deterministic serialization) */
const SPEECH_PARAM_KEYS = ['per', 'pit', 'speed', 'spd', 'vol'];

/** Estimated average reading speed: characters per second for CJK text */
const CJK_CHARS_PER_SECOND = 4.5;
/** Estimated average reading speed: words per second for Latin text */
const LATIN_WORDS_PER_SECOND = 2.5;
/** Minimum timeout in ms for text-length-based estimates */
const MIN_TEXT_TIMEOUT = 2000;
/** Maximum timeout in ms for text-length-based estimates */
const MAX_TEXT_TIMEOUT = 60000;
/** Extra padding added to estimated duration (ms) */
const TIMEOUT_PADDING = 1500;
/** Minimum timeout for URL/fallback playback when actual duration is unknown */
const MIN_UNKNOWN_AUDIO_TIMEOUT = 5000;
/** Conservative multiplier for estimated durations when metadata is unavailable */
const UNKNOWN_AUDIO_TIMEOUT_MULTIPLIER = 1.8;
/** Extra loading budget for SDK TTS fallback before audio playback begins */
const SPEAK_FALLBACK_LOAD_PADDING = 8000;
/** Maximum timeout for SDK TTS fallback including network loading */
const MAX_SPEAK_FALLBACK_TIMEOUT = 90000;

const AUDIO_RECORD_TYPE = 'audioBlob';
const MIDI_RECORD_TYPE = 'midiSequence';

const NOTE_NAME_TO_SEMITONE: Record<string, number> = {
	c: 0,
	'db': 1,
	'c#': 1,
	d: 2,
	'eb': 3,
	'd#': 3,
	e: 4,
	f: 5,
	'gb': 6,
	'f#': 6,
	g: 7,
	'ab': 8,
	'g#': 8,
	a: 9,
	'bb': 10,
	'a#': 10,
	b: 11,
};

// ===================== IndexedDB Helpers =====================

let _dbPromise: Promise<IDBDatabase> | null = null;

function _openDB(): Promise<IDBDatabase> {
	if (_dbPromise) return _dbPromise;
	_dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof window === 'undefined' || !window.indexedDB) {
			reject(new Error('IndexedDB not supported'));
			return;
		}
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			_dbPromise = null;
			reject(request.error);
		};
	});
	return _dbPromise;
}

async function _getFromDB(cacheKey: string): Promise<unknown> {
	try {
		const db = await _openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const store = tx.objectStore(STORE_NAME);
			const request = store.get(cacheKey);
			request.onsuccess = () => resolve(request.result || null);
			request.onerror = () => reject(request.error);
		});
	} catch {
		return null;
	}
}

async function _saveToDB(cacheKey: string, blob: unknown): Promise<void> {
	try {
		const db = await _openDB();
		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			const request = store.put(blob, cacheKey);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	} catch {
		// silent
	}
}

function _isBlob(value: unknown): value is Blob {
	return typeof Blob !== 'undefined' && value instanceof Blob;
}

function _isArrayBuffer(value: unknown): value is ArrayBuffer {
	return typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer;
}

function _isArrayBufferView(value: unknown): value is ArrayBufferView {
	return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value);
}

function _isAudioUrl(value: unknown): boolean {
	return typeof value === 'string' && /^(https?:|blob:|data:audio\/|\/|\.\/|\.\.\/)/i.test(value.trim());
}

function _createAudioBlobFromData(data: unknown, mimeType = 'audio/mpeg'): Blob | null {
	if (_isBlob(data)) return data;
	if (_isArrayBuffer(data) || _isArrayBufferView(data)) {
		return new Blob([data as BlobPart], { type: mimeType });
	}
	if (typeof data === 'string') {
		const value = data.trim();
		if (value.startsWith('data:')) return null;
		try {
			const binary = atob(value);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return new Blob([bytes], { type: mimeType });
		} catch (_) {
			return null;
		}
	}
	return null;
}

function _getAudioSourceFromOptions(options: Record<string, unknown> | null | undefined): unknown {
	if (!options || typeof options !== 'object') return null;
	return options.source || options.audioSource || options.audioFile || options.file || options.blob || options.audioBlob || options.audioData || options.arrayBuffer || options.url || options.audioUrl || null;
}

function _getMidiSequenceFromOptions(options: Record<string, unknown> | null | undefined): unknown {
	if (!options || typeof options !== 'object') return null;
	return options.midiSequence || options.midi || null;
}

function _midiToFrequency(note: number): number {
	return 440 * Math.pow(2, (note - 69) / 12);
}

function _noteNameToMidi(noteName: unknown): number | null {
	if (typeof noteName !== 'string') return null;
	const match = noteName.trim().toLowerCase().match(/^([a-g](?:#|b)?)(-?\d+)$/);
	if (!match) return null;
	const semitone = NOTE_NAME_TO_SEMITONE[match[1]];
	const octave = Number(match[2]);
	if (semitone === undefined || !Number.isFinite(octave)) return null;
	return (octave + 1) * 12 + semitone;
}

function _normalizeMidiNoteValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') return _noteNameToMidi(value);
	return null;
}

function _normalizeMidiSequence(sequence: unknown, options: Record<string, unknown> = {}): Record<string, unknown> | null {
	const rawNotes = Array.isArray(sequence) ? sequence : (sequence as { notes?: unknown[] })?.notes;
	if (!Array.isArray(rawNotes) || rawNotes.length === 0) return null;

	const defaults: Record<string, unknown> = (sequence && !Array.isArray(sequence) ? sequence : {}) as Record<string, unknown>;
	const tempo = Number(options.tempo ?? defaults.tempo ?? 120);
	const beatSeconds = 60 / (Number.isFinite(tempo) && tempo > 0 ? tempo : 120);
	const step = Number(options.step ?? defaults.step ?? beatSeconds);
	const defaultDuration = Number(options.duration ?? defaults.duration ?? step * 0.85);
	const defaultVelocity = Number(options.velocity ?? defaults.velocity ?? 0.7);
	const type = options.type || defaults.type || 'sine';
	const attack = Number(options.attack ?? defaults.attack ?? 0.005);
	const release = Number(options.release ?? defaults.release ?? 0.06);
	const notes: Array<Record<string, unknown>> = [];

	for (let index = 0; index < rawNotes.length; index++) {
		const raw = rawNotes[index] as unknown;
		let noteValue: unknown;
		let time: unknown;
		let duration: unknown;
		let velocity: unknown;
		let noteType: unknown;

		if (Array.isArray(raw)) {
			noteValue = raw[0];
			time = raw[1];
			duration = raw[2];
			velocity = raw[3];
			noteType = raw[4];
		} else if (raw && typeof raw === 'object') {
			const ro = raw as Record<string, unknown>;
			noteValue = ro.note ?? ro.midi ?? ro.pitch;
			time = ro.time ?? ro.start ?? ro.at;
			duration = ro.duration ?? ro.length;
			velocity = ro.velocity ?? ro.volume;
			noteType = ro.type;
		} else {
			noteValue = raw;
		}

		const midi = _normalizeMidiNoteValue(noteValue);
		if (midi === null || !Number.isFinite(midi)) continue;

		const start = Number(time);
		const noteDuration = Number(duration);
		const noteVelocity = Number(velocity);
		notes.push({
			note: midi,
			time: Number.isFinite(start) && start >= 0 ? start : index * step,
			duration: Number.isFinite(noteDuration) && noteDuration > 0 ? noteDuration : defaultDuration,
			velocity: Number.isFinite(noteVelocity) ? Math.max(0, Math.min(1, noteVelocity)) : Math.max(0, Math.min(1, defaultVelocity)),
			type: noteType || type,
		});
	}

	if (!notes.length) return null;
	let totalDuration = 0;
	for (const note of notes) totalDuration = Math.max(totalDuration, (note.time as number) + (note.duration as number));
	return {
		notes,
		tempo,
		attack: Math.max(0, attack),
		release: Math.max(0, release),
		volume: Math.max(0, Math.min(1, Number(options.volume ?? defaults.volume ?? 1))),
		duration: totalDuration,
	};
}

function _normalizeOutputVolume(value: unknown, fallback = 1): number {
	const volume = Number(value);
	if (!Number.isFinite(volume)) return fallback;
	return Math.max(0, Math.min(4, volume));
}

async function _clearDB(): Promise<void> {
	try {
		const db = await _openDB();
		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			const request = store.clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	} catch {
		// silent
	}
}

// ===================== Cache Key Helpers =====================

function _extractSpeechParams(options: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
	if (!options) return null;
	let params: Record<string, unknown> | null = null;
	for (const key of SPEECH_PARAM_KEYS) {
		if (options[key] !== undefined) {
			if (!params) params = {};
			params[key] = options[key];
		}
	}
	if (params && params.speed !== undefined && params.spd === undefined) {
		params.spd = params.speed;
	}
	if (params) delete params.speed;
	return params;
}

function _buildCacheKey(text: string, options: Record<string, unknown> | null | undefined): string {
	const params = _extractSpeechParams(options);
	if (!params) return text;
	const paramStr = SPEECH_PARAM_KEYS
		.filter(k => params[k] !== undefined)
		.map(k => `${k}=${params[k]}`)
		.join('|');
	return `${text}||${paramStr}`;
}

// ===================== Duration Estimation =====================

/**
 * Estimate audio duration in ms from text content.
 * Uses CJK character count or Latin word count as heuristic.
 */
function _estimateDurationFromText(text: string): number {
	if (!text || typeof text !== 'string') return MIN_TEXT_TIMEOUT;
	const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
	const cjkCount = cjkMatches ? cjkMatches.length : 0;
	const latinWords = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, '').trim().split(/\s+/).filter(Boolean);
	const latinCount = latinWords.length;

	let estimatedSeconds = 0;
	if (cjkCount > 0) estimatedSeconds += cjkCount / CJK_CHARS_PER_SECOND;
	if (latinCount > 0) estimatedSeconds += latinCount / LATIN_WORDS_PER_SECOND;

	const ms = Math.round(estimatedSeconds * 1000) + TIMEOUT_PADDING;
	return Math.max(MIN_TEXT_TIMEOUT, Math.min(MAX_TEXT_TIMEOUT, ms));
}

/** Derive timeout from an AudioBuffer's actual duration. */
function _timeoutFromBuffer(audioBuffer: AudioBuffer | null | undefined): number | null {
	if (!audioBuffer || !audioBuffer.duration) return null;
	return Math.round(audioBuffer.duration * 1000) + TIMEOUT_PADDING;
}

/** Derive timeout from HTMLMediaElement metadata. */
function _timeoutFromMediaDuration(duration: number): number | null {
	if (!Number.isFinite(duration) || duration <= 0) return null;
	return Math.round(duration * 1000) + TIMEOUT_PADDING;
}

/** Conservative timeout when actual audio duration is not known. */
function _timeoutForUnknownAudio(text: string): number {
	const estimated = _estimateDurationFromText(text);
	const conservative = Math.round(estimated * UNKNOWN_AUDIO_TIMEOUT_MULTIPLIER);
	return Math.max(MIN_UNKNOWN_AUDIO_TIMEOUT, Math.min(MAX_TEXT_TIMEOUT, conservative));
}

/** Conservative timeout for SDK-managed TTS playback (includes loading budget). */
function _timeoutForSpeakFallback(text: string): number {
	return Math.min(MAX_SPEAK_FALLBACK_TIMEOUT, _timeoutForUnknownAudio(text) + SPEAK_FALLBACK_LOAD_PADDING);
}

export {
	DB_NAME, STORE_NAME, DB_VERSION, SPEECH_PARAM_KEYS,
	CJK_CHARS_PER_SECOND, LATIN_WORDS_PER_SECOND,
	MIN_TEXT_TIMEOUT, MAX_TEXT_TIMEOUT, TIMEOUT_PADDING,
	MIN_UNKNOWN_AUDIO_TIMEOUT, UNKNOWN_AUDIO_TIMEOUT_MULTIPLIER,
	SPEAK_FALLBACK_LOAD_PADDING, MAX_SPEAK_FALLBACK_TIMEOUT,
	AUDIO_RECORD_TYPE, MIDI_RECORD_TYPE, NOTE_NAME_TO_SEMITONE,
	_openDB, _getFromDB, _saveToDB, _clearDB,
	_isBlob, _isArrayBuffer, _isArrayBufferView, _isAudioUrl,
	_createAudioBlobFromData, _getAudioSourceFromOptions, _getMidiSequenceFromOptions,
	_midiToFrequency, _noteNameToMidi, _normalizeMidiNoteValue, _normalizeMidiSequence,
	_normalizeOutputVolume,
	_extractSpeechParams, _buildCacheKey,
	_estimateDurationFromText, _timeoutFromBuffer, _timeoutFromMediaDuration,
	_timeoutForUnknownAudio, _timeoutForSpeakFallback,
};
