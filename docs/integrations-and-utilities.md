# Integrations and utility modules

This guide groups the supporting modules that connect KeepworkSDK to Paracraft, YAML/frontmatter workflows, speech services, analytics, and WeChat-specific flows.

For working examples, see:

- [`testAgentRouter.html`](../test/testAgentRouter.html)
- [`testNplAgentRouter.html`](../test/testNplAgentRouter.html)
- [`testYML.html`](../test/testYML.html)
- [`test_fm.mjs`](../test/test_fm.mjs)
- [`testAudioResources.html`](../test/testAudioResources.html)
- [`testVoiceMapping.html`](../test/testVoiceMapping.html)

## `AgentRouter`: cross-window and iframe agent routing

`sdk.agentRouter` is a window-level singleton used to discover agents and forward tasks across iframes.

### Register a local agent

```js
const session = window.keepwork.aiChat.createSession({
  name: "fileAgent",
  backgroundAgent: true,
  workspace: "lesson-01",
  enabledCategories: ["read", "execute"],
});

window.keepwork.agentRouter.register("fileAgent", session);
```

### Submit a task to a remote agent

```js
const result = await window.keepwork.agentRouter.submitTask("fileAgent", {
  task: "Summarize README.md",
  description: "Read and summarize the project readme",
});

console.log(result);
```

In many flows you do not need to call `register()` manually because named top-level `ChatSession` instances auto-register themselves.

For the best end-to-end routing demos, see:

- [`testAgentRouter.html`](../test/testAgentRouter.html)
- [`testNplAgentRouter.html`](../test/testNplAgentRouter.html)

## `NPLUtil`, `NPLJS`, and `ParacraftEvent`

The NPL module bridges web content and Paracraft/native containers.

Important notes:

- when opening content inside Paracraft, the URL typically includes flags such as `asWebviewInParacraftClient=true` or `asIframeInWebParacraft=true`
- `index.js` initializes `NPLUtil.initializeMessageListeners()` automatically for the browser bundle
- `NPLJS` and `ParacraftEvent` are not auto-instantiated; create them when needed

### Basic NPL callback registration

```js
window.NPLUtil.NPL.this((msg) => {
  console.log("received from Paracraft:", msg);
}, { filename: "MyModule" });
```

### Send a message

```js
window.NPLUtil.NPL.activate("MyModule", {
  cmd: "say_hello",
  text: "Hello from the web page",
});
```

### Create `NPLJS` and `ParacraftEvent`

```js
window.NPLJSInstance = new window.NPLJS();
window.paracraftEvent = new window.ParacraftEvent(window.NPLJSInstance);
```

## `YMLParser`: lightweight YAML and frontmatter conversion

`YMLParser` is used by the SDK for page-like content and frontmatter parsing.

### Convert an object to YAML

```js
const yaml = window.YMLParser.objectToYaml({
  title: "Lesson 1",
  tags: ["demo", "robotics"],
  published: true,
});

console.log(yaml);
```

### Use frontmatter mode

```js
const markdownWithFrontmatter = window.YMLParser.objectToYaml({
  title: "Character config",
  llm_model: "keepwork-flash",
  content: "You are a helpful tutor.",
}, true, true);
```

### Parse YAML or markdown frontmatter

```js
const parsed = window.YMLParser.yamlToObject(`
---
title: "Character config"
llm_model: "keepwork-flash"
---
You are a helpful tutor.
`, true);

console.log(parsed);
```

For roundtrip and compatibility examples, see [`testYML.html`](../test/testYML.html) and [`test_fm.mjs`](../test/test_fm.mjs).

## `Speech`: TTS and speech-to-text helpers

The `Speech` service is available at `sdk.speech`.

### Configure speaking parameters

```js
const speech = window.keepwork.speech;

speech.setRate(4);
speech.setVolume(100);
speech.setPitch(0);
```

### Request text-to-audio data

```js
const audioInfo = await speech.textToAudio("Hello Keepwork");
console.log(audioInfo);
```

### Use the newer synthesis API and play the result

```js
await speech.playSynthesizedAudio("Welcome to the lesson", {
  voiceType: "S_T3n79nTy1",
  explicitLanguage: "zh",
});
```

### Speech-to-text

```js
const transcript = await speech.speechToText({
  audioBlob,
  language: "zh",
});

console.log(transcript);
```

Use these pages for concrete voice resource examples:

- [`testAudioResources.html`](../test/testAudioResources.html)
- [`testVoiceMapping.html`](../test/testVoiceMapping.html)

## `RemoteLog`: event and behavior reporting

`RemoteLog` is created for every SDK instance at `sdk.remoteLog`.

Use it when your app needs lightweight analytics or behavior tracing tied to the Keepwork backend.

```js
const remoteLog = window.keepwork.remoteLog;

await remoteLog.logBehavior("lesson_opened", {
  lessonId: "demo-01",
  source: "sdk-docs-example",
});

await remoteLog.logClick("open_editor", {
  lessonId: "demo-01",
});
```

Because event schemas can vary by app, inspect the existing product usage in the codebase before standardizing a new logging format.

## WeChat helpers: `WxAuth`, `WxLaunchApp`, and `WxUtils`

These helpers support WeChat browser flows and app-launch scenarios.

Available from a `KeepworkSDK` instance:

- `sdk.wxAuth`
- `sdk.wxLaunchApp`

### Load the WeChat launch SDK

```js
await window.keepwork.wxLaunchApp.loadSDK();
```

### Authentication flow

```js
const wxAuth = window.keepwork.wxAuth;
// Initialize your app-specific WeChat auth flow here.
console.log(wxAuth);
```

WeChat support is environment-specific, so test inside the target WeChat browser when possible.

## `LoginWindow`

`LoginWindow` provides the built-in login popup helper used by the core SDK.

```js
await window.keepwork.loginWindow.show({
  title: "Please sign in",
});
```

If your app already uses Keepwork's default login UX, prefer this helper over building a second login modal from scratch.
