# Voice chat and digital human modules

This guide covers the real-time voice and avatar-oriented parts of the SDK:

- `AIChatRTC`
- `AIChatRTCLocal`
- `DigitalHuman`
- `DigitalHumanFrame`

For complete examples, see:

- [`testAIChatRTC.html`](../test/testAIChatRTC.html)
- [`testAIChatRTCLocal.html`](../test/testAIChatRTCLocal.html)
- [`testDigitalHuman.html`](../test/testDigitalHuman.html)
- [`testDigitalHumanFrame.html`](../test/testDigitalHumanFrame.html)

## `AIChatRTC`: VolcEngine real-time voice sessions

`AIChatRTC` provides RTC-based conversational sessions with subtitles, state updates, and tool support.

### Create a session

```js
const rtc = new window.AIChatRTC(window.keepwork);

const session = rtc.createSession({
  appId: "your-volcengine-app-id",
  agentConfig: {
    WelcomeMessage: "Hello, how can I help?",
  },
  config: {
    LLMConfig: {
      Model: "keepwork-flash",
    },
    TTSConfig: {
      VoiceType: "S_T3n79nTy1",
    },
  },
});
```

### Listen for live events

```js
session.on("subtitle", ({ text, isUser }) => {
  console.log(isUser ? "user:" : "assistant:", text);
});

session.on("state", ({ code, label }) => {
  console.log("state:", code, label);
});
```

### Start, send text, and stop

```js
await session.start();
await session.send("Please introduce yourself.");
await session.stop();
```

`send()` is a ChatSession-style wrapper around the RTC text channel. It supports `runCode: true` for `${...}` template expansion through the session sandbox before the text is sent:

```js
await session.send("Summarize ${ await readFile('notes/today.md') }", {
  runCode: true,
});
```

`sendText()` is still available when you want the lower-level fire-and-forget RTC call directly.

Use [`testAIChatRTC.html`](../test/testAIChatRTC.html) for a complete preset-driven UI with subtitles, room state, and tool categories.

## `AIChatRTCLocal`: local/browser voice chat

`AIChatRTCLocal` is designed for browser-only voice interaction flows. In practice, this is the easiest place to experiment with:

- local microphone capture
- VAD-based turn detection
- local or browser-based ASR/TTS
- LLM responses through `sdk.aiChat`

Because this module is highly configuration-driven, the most reliable reference is the working page:

- [`testAIChatRTCLocal.html`](../test/testAIChatRTCLocal.html)

Use it when you want a voice agent without depending on the full hosted RTC path.

## `SpeechRTC`: bidirectional TTS over the Keepwork proxy

`SpeechRTC` wraps VolcEngine bidirectional TTS for browser callers and defaults `proxyUrl` to `wss://tts.keepwork.com/ws/tts/`.

- `proxyUrl` can be omitted unless you need a custom proxy.
- `appId` and `accessToken` can also be omitted when the configured proxy supplies default credentials server-side.

```js
const speechRTC = new window.SpeechRTC(window.keepwork, {
  voiceType: "zh_female_cancan_mars_bigtts",
});

const stream = speechRTC.createTextStream();
await stream.beginText("你好，欢迎使用 SpeechRTC。");
await stream.appendText("这一段会继续发送到同一个会话。");
const result = await stream.finish();
```

## `DigitalHuman`: standalone avatar plus AI session

`DigitalHuman` combines avatar rendering with AI session management. It supports:

- video avatar actions
- Live2D rendering
- WebP-based avatar assets
- AI text chat sessions
- optional real-time voice chat
- optional SDK-managed subtitles

### Minimal avatar example

```js
const container = document.getElementById("avatar-root");

const dh = new window.DigitalHuman({
  sdk: window.keepwork,
  container,
});

await dh.initAvatar({
  idle: { url: "https://cdn.example.com/avatar-idle.mp4" },
  talk: { url: "https://cdn.example.com/avatar-talk.mp4" },
});
```

### Create a text chat session

```js
await dh.createSession({
  system_prompt: "You are a friendly classroom guide.",
  llm_model: "keepwork-flash",
  textToSpeech: {
    enabled: true,
    provider: "speech",
    voiceType: "zh_female_cancan_mars_bigtts",
  },
  tools: {
    read: { enabled: true, workspace: "lesson-01" },
    web: { enabled: true },
  },
});

const { finalText } = await dh.send("Say hello to the student.");
console.log(finalText);
```

When `textToSpeech` is enabled, `DigitalHuman` can synthesize completed assistant replies in text mode through either `sdk.speechRTC` (`provider: "speechRTC"`) or `sdk.speech` (`provider: "speech"`). This only runs when RTC voice chat is inactive, and starting `startVoiceChat()` cancels any in-flight text-mode speech playback.

If `bracketAction` is enabled for the text session, bracketed action hints such as `(wave)` or `（微笑）` are still parsed for avatar actions, but are removed from the spoken text by default for both providers. Set `textToSpeech.ignoreBracketText` to `false` if you want those bracket hints spoken aloud.

### SDK-managed subtitles

`DigitalHuman` can render user ASR subtitles and assistant reply subtitles inside the avatar root. This is disabled by default and can be enabled in the constructor, `initFromConfig()`, or at runtime:

```js
await dh.initFromConfig({
  subtitle: {
    enabled: true,
    showUser: true,
    showAssistant: true,
    typewriter: true,
    charIntervalMs: 200,
    autoHideDelayMs: 3000,
  },
});

dh.setSubtitleConfig({ enabled: false });
dh.clearSubtitle();
```

The overlay is driven directly from `message`, `complete`, `textSpeechEnd`, `subtitle`, `voiceChatState`, and tool-call events. Host apps can listen to `subtitle` for logging or analytics. Base styles are injected by the SDK with `.dh-subtitle-*` classes and CSS custom properties such as `--dh-subtitle-assistant-bg`, `--dh-subtitle-assistant-font-size`, and `--dh-subtitle-user-bottom`.

### Voice lifecycle on hidden pages

`startVoiceChat(preset, options)` enables hidden-page standby by default. When the page is hidden, `DigitalHuman` interrupts current speech, mutes input/output, clears active subtitles, and schedules a real RTC stop after `disconnectAfterMs` (default `60000`). If the page becomes visible before the timeout, the existing RTC session is unmuted and resumed. If the timeout already stopped RTC, the SDK emits `voiceLifecycle` / `voiceChatLifecycle` with `state: "disconnected"` and `needsManualStart: true`; it does not auto-reconnect.

```js
await dh.startVoiceChat(preset, {
  voiceLifecycle: {
    enabled: true,
    visibilityStandby: true,
    disconnectAfterMs: 60000,
    autoReconnect: false,
    historyPolicy: "complete-only",
  },
});
```

Set `voiceLifecycle: false` to opt out. The history policy is `complete-only`: definite user/assistant voice paragraphs are mirrored into the text session, while interrupted partial subtitles are not persisted as completed turns.

### Voice silence heartbeat

`voiceHeartbeat` adds optional silence care during RTC voice chat. It is disabled unless the app provides a heartbeat text or prompt. The SDK owns the timer, agent-state guard, per-call count, cooldown, and hidden-page standby integration.

```js
await dh.startVoiceChat(preset, {
  voiceHeartbeat: {
    enabled: true,
    silenceTimeoutMs: 30000,
    silenceMaxCount: 3,
    cooldownMs: 60000,
    silenceText: "[heartbeat] 用户已沉默约 {{silenceSec}} 秒，请自然地主动关怀。",
  },
});
```

The heartbeat only runs while the voice session is active, the DigitalHuman is active, and the RTC agent is idle (`LISTENING`, `FINISHED`, or `INTERRUPTED`). User subtitles reset the silence timer. `THINKING` and `SPEAKING` clear the pending timer. Hidden-page standby clears the silence timer, and resume resets activity before scheduling again. If the hidden-page timeout disconnects RTC, the heartbeat remains stopped until the app starts voice chat again.

`silenceText` supports simple placeholders: `{{silenceMs}}`, `{{silenceSec}}`, `{{count}}`, and `{{maxCount}}`. Apps can also provide templated text that calls host tools, as long as the final text is sent through `send()` with `runCode: true`.

Listen to `voiceHeartbeat` for diagnostics:

```js
dh.on("voiceHeartbeat", (event) => {
  console.log(event.sent, event.reason, event.count);
});
```

Apps can also trigger the same voice heartbeat path explicitly when they already know the current page or workflow state. This avoids asking the LLM to call page-reading tools during an active voice conversation:

```js
await dh.triggerVoiceHeartbeat({
  reason: "profile-step-changed",
  page: "profile",
  text: "[heartbeat] The app reports that the profile page is now on the age step. Do not call read_app; use this state directly.",
}, {
  ignoreCooldown: true,
  ignoreMaxCount: true,
  countTowardMax: false,
  updateCooldown: false,
});
```

`DigitalHumanFrame.triggerVoiceHeartbeat(input, options)` mirrors the same API through the iframe bridge. Explicit triggers still require an active voice chat session, an active DigitalHuman, an idle RTC agent, and a visible page. They emit the same `voiceHeartbeat` event as automatic silence heartbeat. By default they respect the configured cooldown and max count; apps can override those guards for critical state updates with `ignoreCooldown` and `ignoreMaxCount`.

This is separate from `pageRouters.*.heartbeatText`, which is page-route scoped and managed by page open/restart behavior.

### React to avatar events

```js
dh.on("message", ({ partialText, finalText }) => {
  console.log(partialText || finalText);
});

dh.on("bracketAction", ({ actionKey }) => {
  dh.playAction(actionKey, 3);
});
```

### Initialize from a config object

```js
await dh.initFromConfig({
  system_prompt: "You are a patient tutor.",
  llm_model: { model: "keepwork-flash", temperature: 0.7 },
  videoActions: {
    "待机|idle|0": { url: "https://cdn.example.com/idle.mp4" },
    "说话|talk|1": { url: "https://cdn.example.com/talk.mp4" },
    "happy": { url: "https://cdn.example.com/happy.mp4" },
  },
  bracketAction: {
    enabled: true,
    autoplay: true,
    duration: 3,
  },
  tools: {
    read: { enabled: true, workspace: "lesson-01" },
  },
});
```

### Load config from a remote URL or markdown file

```js
await dh.loadConfig("https://example.com/character.md");
```

The markdown-based config format uses YAML frontmatter plus markdown body as `system_prompt`. See [`testDigitalHuman.html`](../test/testDigitalHuman.html) and the `DigitalHumanConfig` test assets for full patterns.

## `DigitalHumanFrame`: iframe-isolated avatar runtime

Use `DigitalHumanFrame` when you want the avatar in a separate iframe while keeping tool execution in the parent window.

### Create the frame

```js
const frame = new window.DigitalHumanFrame({
  sdk: window.keepwork,
  container: document.getElementById("frame-root"),
  workspace: "lesson-01",
});
```

### Initialize from config

```js
await frame.initFromConfig({
  system_prompt: "You are an embedded assistant.",
  videoActions: {
    idle: { url: "https://cdn.example.com/idle.mp4" },
    talk: { url: "https://cdn.example.com/talk.mp4" },
  },
  tools: {
    read: { enabled: true},
  },
});
```

### Send messages and control the avatar

```js
await frame.send("Summarize the lesson notes.");
frame.switchToTalking();
frame.playAction("happy", 2);

const status = await frame.getAvatarStatus();
console.log(status);
```

### Start voice chat through the iframe

```js
await frame.startVoiceChat({
  appId: "your-volcengine-app-id",
}, {
  voiceLifecycle: { disconnectAfterMs: 60000 },
});

frame.sendVoiceText("Hello from the parent page.");
```

`DigitalHumanFrame` mirrors the subtitle controls: `setSubtitleConfig(config)`, `getSubtitleConfig()`, and `clearSubtitle()`. Passing `subtitle` to the frame constructor or config enables the inner iframe `DigitalHuman` subtitle overlay without host-page DOM listeners.

### Launch a skill-backed minigame session

`DigitalHumanFrame.launchSkill(promptFile, options)` opens a minigame slot session and restarts the framed DigitalHuman agent against the given prompt file. During the restart, parent-side `MinigameTools` routes the prompt's first `load_minigame` call into the target slot.

```js
await frame.launchSkill("skills/digitalHumanHome/SKILL.md", {
  slot: "default",
  root: true,
  layout: "fullscreen",
  restorePolicy: "none",
});
```

For latency-sensitive flows, preload the same skill while the slot stays hidden, then reveal it when the user reaches the interaction point:

```js
await frame.preloadSkill("skills/interaction-skill/SKILL.md", {
  slot: "roleplay-interaction",
  frameOptions: { width: "min(760px, 88vw)", height: "min(600px, 80vh)" },
  autoContinue: false,
});

frame.showPreloadedSkill({
  slot: "roleplay-interaction",
  frameOptions: { width: "min(760px, 88vw)", height: "min(600px, 80vh)" },
});
```

Nested skills can be launched from inside an existing minigame iframe with the SDK bridge:

```js
window.keepwork.minigame.openSkill({
  skillPath: "skills/findWords/SKILL.md",
  title: "找单词",
  layout: "modal",
  restorePolicy: "resumeParent",
});
```

Close behavior:

- Root sessions usually use `restorePolicy: "none"` and let the host page decide whether to navigate away after the root slot emits `gameFinished`.
- Nested sessions default to `restorePolicy: "resumeParent"`. On `gameFinished` or user close, the SDK closes the active child slot, restores the previous active slot, restarts the parent prompt with `autoContinue: false`, then sends a short result summary to the parent agent.
- `restorePolicy: "restartDefault"` restarts the default agent after the slot closes.
- `restorePolicy: "none"` only switches the active slot back without restarting an agent.

DigitalHumanFrame forwards assistant speaking state into the active minigame iframe with `type: "keepwork:digitalHuman:speaking"`. Older app-specific messages such as `dh:aiSpeaking` are not emitted by the SDK flow.

This is the best option when your main page should stay isolated from avatar-specific DOM, styles, or third-party scripts.

## Which module should you pick?

Use `AIChatRTC` when:

- you want a hosted RTC voice-agent flow
- you need live subtitles and agent state events

Use `AIChatRTCLocal` when:

- you want a local/browser voice pipeline
- you are experimenting with microphone, VAD, local ASR, or browser TTS

Use `DigitalHuman` when:

- you want an avatar in the current page
- you want to combine text chat, tool calling, and avatar actions

Use `DigitalHumanFrame` when:

- you want iframe isolation
- you want to proxy tools between parent and child windows

