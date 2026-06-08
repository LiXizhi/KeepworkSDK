// ── UI helpers ──────────────────────────────────────────────
const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const controlsEl = document.getElementById("controls");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const textArea = document.getElementById("results");

let allPassed = true;

function log(msg, cls = "") {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = msg + "\n";
  logEl.appendChild(span);
}
function pass(msg) { log("[PASS] " + msg, "text-teal-400"); }
function fail(msg) { log("[FAIL] " + msg, "text-red-400"); allPassed = false; }
function info(msg) { log("[INFO] " + msg, "text-sky-300"); }

// ── WASM module load test ───────────────────────────────────

let recognizer = null;
let recognizerStream = null;
let resultList = [];

// Allow overriding via window.sherpaonnxBase before this script loads
if (!window.sherpaonnxBase) {
  window.sherpaonnxBase = "../../../installed/sherpaonnx-js/";
}

var DATA_FILE = "sherpa-onnx-wasm-kws-main.data";
var WASM_FILE = "sherpa-onnx-wasm-kws-main.wasm";

function getDisplayResult() {
  return resultList.map((s, i) => i + ": " + s).join("\n");
}

clearBtn.onclick = function () {
  resultList = [];
  textArea.value = "";
};

// ── Cache-aware Module setup ────────────────────────────────
// We need to set up Module (with cached buffers) BEFORE the Emscripten
// loader script runs. This async init fetches version + IndexedDB data,
// then configures Module hooks accordingly.

(async function setupModuleWithCache() {
  Module = {};

  // Fetch version from package.json (needed for both display and cache key)
  var version = "unknown";
  try {
    var pkgRes = await fetch(window.sherpaonnxBase + "package.json?_t=" + Date.now());
    var pkg = await pkgRes.json();
    version = pkg.version;
    window.sherpaonnxVersion = version;
    info("Version: " + version + " (" + pkg.name + ")");
  } catch (e) {
    info("Version: unknown (package.json not found)");
  }

  // Attempt to load from IndexedDB cache
  var cachedData = null;
  var cachedWasm = null;
  var cacheAvailable = typeof SherpaOnnxCache !== "undefined";

  if (cacheAvailable) {
    try {
      await SherpaOnnxCache.init(version);
      cachedData = await SherpaOnnxCache.get(DATA_FILE);
      cachedWasm = await SherpaOnnxCache.get(WASM_FILE);
    } catch (e) {
      cacheAvailable = false;
    }
  }

  if (cachedData && cachedWasm) {
    info("Cache: loaded .data + .wasm from IndexedDB (" + version + ")");

    // Provide cached .data buffer to Emscripten's package loader
    Module.getPreloadedPackage = function (_name, _size) {
      return cachedData;
    };

    // Provide cached .wasm binary — Emscripten skips fetch entirely
    Module.wasmBinary = cachedWasm;

    // locateFile still needed for any fallback / other files
    Module.locateFile = function (file) {
      return window.sherpaonnxBase + file;
    };
  } else {
    if (cacheAvailable) {
      info("Cache: miss — will download and cache for next load");
    }

    // No cache — let Emscripten fetch normally (with cache-bust)
    Module.locateFile = function (file) {
      return window.sherpaonnxBase + file + "?_t=" + Date.now();
    };
  }

  // ── Runtime initialized handler ─────────────────────────────
  Module.onRuntimeInitialized = function () {
    info("WASM runtime initialized");

    // Background: cache the downloaded files for next visit
    if (cacheAvailable && (!cachedData || !cachedWasm)) {
      cacheFilesInBackground(version);
    }

    runTests();
  };

  // Signal that Module is ready — the Emscripten loader script can proceed.
  // For dynamic-script loading (index_cdn.html), we load it now.
  if (window._loadEmscriptenLoader) {
    window._loadEmscriptenLoader();
  }
})();

/**
 * Download .data and .wasm from CDN and store in IndexedDB for next visit.
 * Runs in background after runtime init — does NOT block the app.
 */
function cacheFilesInBackground(version) {
  var base = window.sherpaonnxBase;

  // Fetch .data
  fetch(base + DATA_FILE)
    .then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) {
      return SherpaOnnxCache.put(DATA_FILE, buf);
    })
    .then(function () { info("Cache: stored " + DATA_FILE + " (" + (version) + ")"); })
    .catch(function () { /* silently ignore cache write failures */ });

  // Fetch .wasm
  fetch(base + WASM_FILE)
    .then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) {
      return SherpaOnnxCache.put(WASM_FILE, buf);
    })
    .then(function () { info("Cache: stored " + WASM_FILE + " (" + (version) + ")"); })
    .catch(function () { /* silently ignore cache write failures */ });
}

// ── Test suite ──────────────────────────────────────────────
function runTests() {
  // Test 1: Module loaded
  if (typeof Module._SherpaOnnxCreateKeywordSpotter === "function") {
    pass("SherpaOnnxCreateKeywordSpotter exported");
  } else {
    fail("SherpaOnnxCreateKeywordSpotter not found");
    statusEl.textContent = "FAIL";
    statusEl.className = "text-lg mt-4 px-3 py-2 rounded bg-red-900/50 text-red-400";
    return;
  }

  // Test 2: Check other exported functions
  const expectedFns = [
    "_SherpaOnnxCreateKeywordStream",
    "_SherpaOnnxDecodeKeywordStream",
    "_SherpaOnnxDestroyKeywordResult",
    "_SherpaOnnxDestroyKeywordSpotter",
    "_SherpaOnnxGetKeywordResult",
    "_SherpaOnnxIsKeywordStreamReady",
    "_SherpaOnnxOnlineStreamAcceptWaveform",
    "_SherpaOnnxOnlineStreamInputFinished",
    "_SherpaOnnxResetKeywordStream",
    "_CopyHeap",
    "_malloc",
    "_free",
  ];
  let allExported = true;
  for (const fn of expectedFns) {
    if (typeof Module[fn] !== "function") {
      fail(fn + " not exported");
      allExported = false;
    }
  }
  if (allExported) {
    pass("All expected C API functions exported (" + expectedFns.length + ")");
  }

  // Test 3: Create KWS recognizer
  info("Creating KWS recognizer...");
  try {
    recognizer = createKws(Module);
    pass("KWS recognizer created");

    // Display custom keywords
    if (recognizer.config && recognizer.config.keywords) {
      const kwSection = document.getElementById("keywords-section");
      const kwDisplay = document.getElementById("keywords-display");
      const lines = recognizer.config.keywords.trim().split("\n");
      const displayLines = lines.map(line => {
        const match = line.match(/@(.+)$/);
        return match ? match[1] : line;
      });
      if (kwDisplay) {
        kwDisplay.textContent = displayLines.join("\n");
      }
      if (kwSection) {
        kwSection.style.display = "block";
      }
      info("Keywords: " + displayLines.join(", "));
    }
  } catch (e) {
    fail("Failed to create KWS recognizer: " + e.message);
    statusEl.textContent = "FAIL";
    statusEl.className = "text-lg mt-4 px-3 py-2 rounded bg-red-900/50 text-red-400";
    return;
  }

  // Test 4: Create stream
  info("Creating KWS stream...");
  try {
    const testStream = recognizer.createStream();
    pass("KWS stream created");

    // Test 5: Feed silence and check isReady/decode
    info("Feeding silence samples...");
    const silence = new Float32Array(16000); // 1 second of silence at 16kHz
    testStream.acceptWaveform(16000, silence);
    pass("acceptWaveform succeeded");

    // Test 6: Decode
    let decoded = false;
    while (recognizer.isReady(testStream)) {
      recognizer.decode(testStream);
      decoded = true;
    }
    if (decoded) {
      pass("decode() ran successfully");
    } else {
      info("No frames ready to decode (expected for short silence)");
    }

    // Test 7: Get result
    const result = recognizer.getResult(testStream);
    if (typeof result === "object") {
      pass("getResult returned object: " + JSON.stringify(result));
    } else {
      fail("getResult did not return object");
    }

    testStream.free();
    pass("Stream freed");
  } catch (e) {
    fail("Stream test error: " + e.message);
  }

  // Show final status
  if (allPassed) {
    statusEl.textContent = "ALL TESTS PASSED";
    statusEl.className = "text-lg mt-4 px-3 py-2 rounded bg-green-900/50 text-teal-400";
  } else {
    statusEl.textContent = "SOME TESTS FAILED";
    statusEl.className = "text-lg mt-4 px-3 py-2 rounded bg-red-900/50 text-red-400";
  }

  // Enable microphone test UI
  controlsEl.style.display = "block";
  startBtn.disabled = false;


  info("Microphone KWS test ready. Click Start to begin.");
}

// ── Microphone KWS demo ─────────────────────────────────────
let audioCtx;
let mediaStream;
let recorder = null;

startBtn.onclick = async function () {
  if (!recognizer) return;

  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaStream = audioCtx.createMediaStreamSource(stream);

  const bufferSize = 4096;
  recorder = audioCtx.createScriptProcessor(bufferSize, 1, 2);

  if (!recognizerStream) {
    recognizerStream = recognizer.createStream();
    info("Using default keywords stream");
  } else {
    info("Using dynamic keywords stream");
  }

  recorder.onaudioprocess = function (e) {
    const samples = new Float32Array(e.inputBuffer.getChannelData(0));
    recognizerStream.acceptWaveform(16000, samples);

    while (recognizer.isReady(recognizerStream)) {
      recognizer.decode(recognizerStream);
      const result = recognizer.getResult(recognizerStream);
      if (result.keyword && result.keyword.length > 0) {
        console.log("Keyword detected:", result);
        resultList.push(JSON.stringify(result));
        recognizer.reset(recognizerStream);
      }
    }
    textArea.value = getDisplayResult();
    textArea.scrollTop = textArea.scrollHeight;
  };

  mediaStream.connect(recorder);
  recorder.connect(audioCtx.destination);

  startBtn.disabled = true;
  stopBtn.disabled = false;
  info("Recording started...");
};

stopBtn.onclick = function () {
  if (recorder && mediaStream) {
    recorder.disconnect(audioCtx.destination);
    mediaStream.disconnect(recorder);
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  info("Recording stopped.");
};

