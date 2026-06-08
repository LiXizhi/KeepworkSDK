# AudioEngine

`AudioEngine` is a browser-side audio caching and playback engine designed for TTS (text-to-speech) workflows. It provides a three-tier cache (memory → IndexedDB → network), Web Audio API playback with HTMLAudioElement fallback, and a high-level `speak()` API that integrates with the Keepwork SDK speech module.

For a complete interactive example, see [`test/testAudioEngine.html`](../test/testAudioEngine.html).

## Access

After loading the SDK bundle, `AudioEngine` is available as `window.AudioEngine`. The SDK also creates a shared singleton accessible via:

```js
const engine = AudioEngine.getShared();
// Also available as:
// window.keepwork.audioEngine
```

`getShared()` returns the same instance across all callers in a window (stored on `window.__keepworkAudioEngine`).

## Quick start

The typical workflow is: **preload texts → cache to IndexedDB → play from cache**.

```js
const engine = AudioEngine.getShared();

// 1. Bind user gesture (required on mobile to unlock audio)
engine.bindUserGesture(document);

// 2. Preload texts via TTS API into IndexedDB
const fetchAudioUrl = async (text, params) => {
  const result = await window.keepwork.speech.textToAudio(text, params);
  return result?.data || null;
};

await engine.preload("你好，欢迎使用", { fetchAudioUrl });
await engine.preload("测试开始", { fetchAudioUrl });

// 3. Play from cache (zero network latency)
engine.play("你好，欢迎使用", {
  onStart: () => console.log("started"),
  onEnd: () => console.log("done"),
});
```

## Cache architecture

AudioEngine uses a three-tier cache with automatic promotion:

```
Memory (Blob URL + AudioBuffer)
    ↑ warmupFromDB()
IndexedDB (persistent Blob)
    ↑ preload() with fetchAudioUrl
Network (TTS API → CDN URL → download)
```

- **Memory tier**: `Map<cacheKey, BlobURL>` and `Map<cacheKey, AudioBuffer>`. Fastest playback path — zero latency for `AudioBuffer`, near-zero for `BlobURL`.
- **IndexedDB tier**: Persistent `Blob` storage in `keepwork-audio-cache` database. Survives page refreshes. Restored to memory via `warmupFromDB()`.
- **Network tier**: Called only when both memory and IndexedDB miss. Requires a `fetchAudioUrl` callback (typically wrapping `keepwork.speech.textToAudio`).

### Cache keys

Cache keys are built from `text + speech parameters`. The same text with different speech params (pitch, speed, etc.) produces different keys:

```js
engine.buildCacheKey("hello");                    // "hello"
engine.buildCacheKey("hello", { spd: 3 });        // "hello||spd=3"
engine.buildCacheKey("hello", { per: 1, spd: 3 }); // "hello||per=1|spd=3"
```

Recognized speech parameter keys: `per`, `pit`, `speed`, `spd`, `vol`. `speed` is normalized to `spd` internally.

## API reference

### Constructor and singleton

| Method | Description |
|--------|-------------|
| `new AudioEngine(options?)` | Create a new instance. Prefer `getShared()`. |
| `AudioEngine.getShared(options?)` | Returns the shared singleton, creating it if needed. |
| `engine.configure(options)` | Update options on an existing instance. |

### AudioContext lifecycle

| Method | Description |
|--------|-------------|
| `engine.isSupported()` | `true` if Web Audio API is available. |
| `engine.getContext(options?)` | Lazily creates and returns the `AudioContext`. |
| `engine.resume(options?)` | Resumes a suspended `AudioContext`. Required after page load on most browsers. |
| `engine.isContextRunning()` | `true` if the context state is `'running'`. |
| `engine.bindUserGesture(target, options?)` | Attaches click/touch listeners to unlock audio on user interaction. Returns an unbind function. |

```js
// Unlock audio on any user tap — call once at app startup
const unbind = engine.bindUserGesture(document);

// Later, to remove:
unbind();
```

### Cache operations

| Method | Description |
|--------|-------------|
| `engine.buildCacheKey(text, options?)` | Returns the deterministic cache key for a text + params pair. |
| `engine.getCachedUrl(text, options?)` | Sync lookup — returns cached Blob/CDN URL or `null`. |
| `engine.getAudioBuffer(text, options?)` | Sync lookup — returns pre-decoded `AudioBuffer` or `null`. |
| `engine.getMidiSequence(text, options?)` | Sync lookup — returns a normalized cached MIDI sequence or `null`. |
| `engine.set(text, source, options?)` | Manually cache an audio URL, `Blob`/`File`, `ArrayBuffer`, typed array, or base64 audio data. URLs download and persist to IndexedDB in background. |
| `engine.setUrl(text, url, options?)` | Explicit URL alias for `set()`. |
| `engine.setAudioFile(text, fileOrBlob, options?)` | Cache an in-memory `File` or `Blob` and persist it to IndexedDB. |
| `engine.setAudioData(text, data, options?)` | Cache base64 audio data, an `ArrayBuffer`, typed array, or data URL. |
| `engine.setMidiSequence(text, sequence, options?)` | Cache a MIDI-like note sequence and persist it to IndexedDB. |

#### URL and in-memory audio sources

`set()` keeps the original URL workflow, and now also accepts in-memory audio data. Use the explicit aliases when you want the call site to show intent:

```js
const engine = AudioEngine.getShared();

engine.setUrl("click", "https://cdn.example.com/click.mp3");
engine.setAudioFile("upload-preview", fileInput.files[0], { mimeType: "audio/mpeg" });
engine.setAudioData("generated-wav", wavArrayBuffer, { mimeType: "audio/wav" });

engine.play("click");
engine.play("upload-preview");
engine.play("generated-wav");
```

`preload()` can also receive a direct source through `source`, `audioSource`, `audioFile`, `audioBlob`, `audioData`, `arrayBuffer`, `url`, or `audioUrl`:

```js
await engine.preload("inline-intro", {
  audioFile: introBlob,
  mimeType: "audio/wav",
});
```

#### MIDI sequences

MIDI support is intentionally lightweight: pass a note sequence and AudioEngine plays it with Web Audio oscillators. This is useful for UI sounds, game cues, and generated exercises without creating an audio file first.

```js
engine.setMidiSequence("success-cue", [60, 64, 67, 72], {
  tempo: 140,
  type: "triangle",
  velocity: 0.6,
});

engine.play("success-cue");
```

Supported note formats:

```js
// Sequential MIDI note numbers, spaced by tempo/step
[60, 64, 67, 72]

// Note names
["C4", "E4", "G4", "C5"]

// Tuples: [note, timeSeconds, durationSeconds, velocity, oscillatorType]
[[60, 0, 0.25, 0.7], [67, 0.25, 0.25, 0.6]]

// Objects
[
  { note: 60, time: 0, duration: 0.3, velocity: 0.7, type: "sine" },
  { note: "G4", time: 0.3, duration: 0.4, velocity: 0.6, type: "triangle" },
]
```

You can also cache MIDI through `preload()`:

```js
await engine.preload("level-up", {
  midiSequence: [60, 64, 67, 72],
  tempo: 160,
});
```

### Preloading

| Method | Description |
|--------|-------------|
| `engine.preload(text, options?)` | Preload a single text. Checks memory → IDB → calls `options.fetchAudioUrl`. Returns the playable URL. |
| `engine.preloadBatch(items, concurrency?)` | Preload multiple items with concurrency control (default 3). |
| `engine.preloadPersistent(items, concurrency?, retryDelay?, batchDelay?)` | Background queue that retries failed loads until all complete or cancelled. |
| `engine.cancelPreload()` | Cancel a running persistent preload queue. |
| `engine.warmupFromDB(items)` | Restore cached blobs from IndexedDB to memory. Returns array of missed items. |

#### Preload options

The `options` object for `preload()` accepts speech parameters plus:

| Key | Type | Description |
|-----|------|-------------|
| `fetchAudioUrl` | `async (text, params) => url` | Custom TTS fetcher. Called only when memory and IDB miss. |
| `source` / `audioSource` | `string \| Blob \| ArrayBuffer \| TypedArray` | Direct audio source to cache. |
| `audioFile` / `audioBlob` / `file` / `blob` | `Blob \| File` | In-memory audio file to cache. |
| `audioData` / `arrayBuffer` | `string \| ArrayBuffer \| TypedArray` | Base64 audio data, data URL, or binary audio data to cache. |
| `url` / `audioUrl` | `string` | Direct audio URL to cache. |
| `midiSequence` / `midi` | `Array \| { notes: Array }` | MIDI-like note sequence to cache. |
| `mimeType` | `string` | MIME type for binary/base64 audio data, e.g. `audio/wav`. |
| `per` | `number` | Voice person ID |
| `pit` | `number` | Pitch |
| `spd` / `speed` | `number` | Speed |
| `vol` | `number` | Volume |

#### Batch preload

```js
const fetchAudioUrl = async (text) => {
  const r = await keepwork.speech.textToAudio(text);
  return r?.data || null;
};

// Preload a list of texts
await engine.preloadBatch([
  { text: "第一句", options: { fetchAudioUrl } },
  { text: "第二句", options: { fetchAudioUrl } },
  { text: "第三句", options: { fetchAudioUrl } },
], 3); // concurrency = 3
```

#### Persistent preload (background queue with retry)

```js
engine.preloadPersistent([
  { text: "句子一", options: { fetchAudioUrl } },
  { text: "句子二", options: { fetchAudioUrl } },
], 2, 5000, 100);
// concurrency=2, retryDelay=5000ms, batchDelay=100ms

// Cancel anytime:
engine.cancelPreload();
```

#### Warmup from IndexedDB

After a page refresh, memory caches are empty but IndexedDB data persists. Call `warmupFromDB()` at app startup to restore:

```js
const missed = await engine.warmupFromDB([
  "你好", "测试", "开始"
]);
// missed = items not found in IndexedDB
```

### Playback

| Method | Description |
|--------|-------------|
| `engine.play(text, options?)` | Play cached audio. Tries `AudioBuffer` → `BlobURL` → returns `null` if nothing cached. |
| `engine.stopPlayback()` | Stop current `play()` audio. |
| `engine.speak(text, options?)` | High-level TTS: tries `play()` from cache, falls back to `keepwork.speech.playKeepworkAudio`. |
| `engine.stopSpeak()` | Stop all speech — engine playback + SDK audio + keepwork-audio element. |

#### `play()` — cached playback

`play()` only plays from cache. If nothing is cached, it returns `null` — the caller should preload first or use `speak()` instead.

```js
const result = engine.play("你好", {
  onStart: () => console.log("playback started"),
  onEnd:   () => console.log("playback ended"),
  onError: (e) => console.error("error:", e),
  timeout: 10000, // optional explicit safety timeout (ms)
});

if (!result) {
  console.log("not cached — preload first");
}
// result.type: 'midi' | 'audiobuffer' | 'cached'
```

Playback resolution order:

1. **MIDI sequence** (Web Audio oscillator scheduling)
2. **AudioBuffer** (Web Audio API, zero-latency) — if context is running
3. **Blob/CDN URL** (HTMLAudioElement) — works even when context is suspended
4. **null** — nothing cached

A safety timeout fires `onEnd` if playback doesn't complete naturally (e.g. suspended context on mobile). The timeout is derived from `AudioBuffer.duration` or estimated from text length.

#### `speak()` — high-level TTS with fallback

`speak()` is the recommended API for most consumers. It combines cached playback with SDK TTS fallback:

```js
engine.speak("你好，欢迎使用", {
  onEnd: () => console.log("done speaking"),
  onError: (e) => console.error(e),
  speed: 5,
});
```

Flow:
1. Tries `play()` from cache (if available)
2. If not cached, calls `keepwork.speech.playKeepworkAudio()` (network TTS)
3. Generation-based cancellation ensures `stopSpeak()` safely invalidates in-flight callbacks

> **Note:** `playKeepworkAudio()` only reads from and writes to the AudioEngine cache when called with `useCache: true`. Without this option, it always fetches from the TTS API and does not populate the cache. `AudioEngine.speak()` sets this automatically, but direct callers of `playKeepworkAudio` must opt in explicitly.

Calling `speak()` again automatically cancels the previous utterance:

```js
engine.speak("第一句");
// 500ms later...
engine.speak("第二句"); // first utterance is cancelled
```

#### Chained sequential playback

```js
const texts = ["第一句", "第二句", "第三句"];
let i = 0;
function next() {
  if (i >= texts.length) return;
  engine.speak(texts[i], {
    onEnd: () => { i++; next(); },
  });
}
next();
```

### Cache management

| Method | Description |
|--------|-------------|
| `engine.clearCache()` | Clear memory caches only. IndexedDB data is preserved. |
| `engine.clearAll()` | Clear memory + IndexedDB. |
| `engine.getStats()` | Returns cache statistics object. |

```js
engine.getStats();
// {
//   total: 10,
//   ready: 8,
//   loading: 1,
//   error: 1,
//   blobCached: 8,
//   audioBufferDecoded: 5,
//   persistentQueueSize: 0,
//   persistentRunning: false,
// }
```

### Utility

| Method | Description |
|--------|-------------|
| `AudioEngine.estimateDuration(text)` | Static. Estimate audio duration in ms from text length. Uses CJK character count (~4.5 chars/sec) or Latin word count (~2.5 words/sec). |

```js
AudioEngine.estimateDuration("这是一段中文文本");
// → approximately 3277 (ms)
```

## Consumer patterns

### Reusable `fetchAudioUrl` helper

Most consumer code repeats the same TTS fetcher. Define it once and pass it to every `preload()` or `preloadBatch()` call:

```js
const engine = AudioEngine.getShared();

// Define once
const fetchAudioUrl = async (text, params) => {
  const r = await keepwork.speech.textToAudio(text, params);
  return r?.data || null;
};

// Use everywhere
await engine.preload("你好", { fetchAudioUrl });
await engine.preload("开始测试", { fetchAudioUrl, spd: 3 });
```

### Preload-then-play workflow

The most common pattern: preload all texts at startup, then play from cache with zero latency:

```js
const engine = AudioEngine.getShared();
engine.bindUserGesture(document);

const texts = ["欢迎使用", "请开始", "测试结束"];

// Preload all at startup
await engine.preloadBatch(
  texts.map(text => ({ text, options: { fetchAudioUrl } })),
  3,
);

// Later — play instantly from cache
engine.play("请开始", {
  onEnd: () => console.log("done"),
});
```

### Gating speech on a user preference

If your app has a "mute voice" toggle, wrap `speak()` with a guard:

```js
let voiceEnabled = true;

function speakIfEnabled(text, options = {}) {
  if (!voiceEnabled) {
    if (options.onEnd) setTimeout(options.onEnd, 0);
    return null;
  }
  return AudioEngine.getShared().speak(text, options);
}

function stopAllSpeech() {
  AudioEngine.getShared().stopSpeak();
}
```

## Mobile considerations

- **User gesture required**: Call `bindUserGesture(document)` early. On iOS/Android, the `AudioContext` starts suspended and `HTMLAudioElement.play()` is blocked until a user gesture occurs.
- **AudioContext vs HTMLAudioElement**: `play()` automatically falls back from `AudioBuffer` to `HTMLAudioElement` when the context is suspended.
- **Safety timeouts**: Both `play()` and `speak()` fire `onEnd` via timeout if playback doesn't complete naturally, so callers never hang indefinitely.
- **WeChat browser**: `bindUserGesture()` handles the silent-play trick needed to unlock audio in WeChat's embedded browser.

### User gestures on mobile devices

Modern mobile browsers (Safari on iOS, Chrome on Android, and WeChat's embedded browser) enforce an **autoplay policy**: audio cannot play programmatically until the user has interacted with the page. Both the Web Audio API `AudioContext` and `HTMLAudioElement.play()` are affected.

**What counts as a user gesture?** A synchronous call chain originating from one of:

- `click` / `pointerdown` / `pointerup`
- `touchstart` / `touchend`
- `keydown` / `keyup`

Asynchronous callbacks (setTimeout, fetch `.then()`, MutationObserver) do **not** qualify, even if a user gesture triggered them earlier. This means you cannot `fetch()` an audio URL and then call `play()` in the response handler — the gesture is already "consumed" by then.

**How `bindUserGesture()` solves this:** It attaches `pointerdown`, `touchstart`, and `click` listeners (capture phase, passive) to the given target element. On each gesture it does two things:

1. Calls `AudioContext.resume()` — transitions the context from `'suspended'` to `'running'`, enabling all future `AudioBuffer` playback.
2. Plays a silent base64-encoded WAV through a temporary `HTMLAudioElement` — this "unlocks" the `<audio>` playback path on iOS/WebKit, which requires at least one `play()` call inside a gesture before allowing programmatic playback later.

Once both paths are unlocked, the listeners automatically remove themselves.

```js
// Best practice: call once at the top level, as early as possible
const engine = AudioEngine.getShared();
engine.bindUserGesture(document);
```

**Common pitfalls:**

| Mistake | Result | Fix |
|---------|--------|-----|
| Calling `bindUserGesture()` after first `play()` | First playback is silent or fails | Bind at page load, before any audio logic runs |
| Binding to a small button instead of `document` | Gestures outside that button don't unlock audio | Bind to `document` for maximum coverage |
| Creating a *new* `AudioContext` after unlock | The new context starts suspended again | Use `AudioEngine.getShared()` so all code shares one context |
| Assuming `await fetch()` preserves the gesture | `play()` in the `.then()` is rejected | Preload audio *before* the gesture, then play synchronously from cache |

### Why sharing `AudioContext` matters

Browsers impose a **per-page limit** on `AudioContext` instances (typically 4–6 on mobile). Creating a new context in every module or component quietly fails once the limit is hit — `new AudioContext()` may return a permanently-suspended context, or the browser may garbage-collect an older one mid-playback.

Beyond the instance limit, there are practical reasons to share a single context:

- **One unlock, everywhere.** A user gesture only resumes the context it targets. If two modules each create their own context, each needs its own gesture to unlock. With a shared context, one `bindUserGesture()` call unlocks audio for the entire app.
- **Lower memory and CPU.** Each context runs its own audio-processing thread and sample-rate converter. A single context reuses one thread for all playback, decoding, and mixing.
- **Consistent sample rate.** When different contexts use different sample rates, decoded `AudioBuffer` data must be resampled on every transfer. A shared context decodes everything at one rate.
- **Simpler lifecycle.** Closing or suspending a context invalidates all `AudioBufferSourceNode`s created from it. With shared ownership through `getShared()`, no single module accidentally closes the context while another is still playing.

`AudioEngine.getShared()` solves this by storing the singleton on `window.__keepworkAudioEngine`. All callers — `Speech`, `SpeechRTC`, consumer apps — get the same instance and the same underlying `AudioContext`:

```js
// Module A (TTS preloader)
const engine = AudioEngine.getShared();
await engine.preload("你好", { fetchAudioUrl });

// Module B (game sound effects)  
const engine = AudioEngine.getShared(); // same instance
engine.play("你好"); // plays from Module A's cache, same AudioContext
```

If you need to pass an external `AudioContext` (e.g. one created by a third-party library), call `getContext()` first to let AudioEngine create its own, then use that context in the third-party code — or vice versa. The important thing is to avoid creating multiple contexts when one will do.

## IndexedDB storage

Audio blobs are stored in the `keepwork-audio-cache` IndexedDB database, `audio-blobs` object store. Each entry is keyed by the cache key string. There is no automatic eviction — use `clearAll()` if storage grows too large.
