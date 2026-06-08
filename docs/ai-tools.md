# AI chat, tool calling, and app automation

This guide covers the SDK's AI and tool surfaces:

- `AIChat`
- `ChatSession`
- `CopilotTools`
- `SandboxToolEnv`
- `AppTools`

For complete examples, see:

- [`testSandboxToolEnv.html`](../test/testSandboxToolEnv.html)
- [`testAppTools.html`](../test/testAppTools.html)
- parts of [`testKeepworkSDK.html`](../test/testKeepworkSDK.html)

## `AIChat`: one-shot chat calls

The simplest entry point is `sdk.aiChat.chat(...)`.

```js
const sdk = window.keepwork;

const reply = await sdk.aiChat.chat({
  model: "keepwork-flash",
  messages: [
    { role: "system", content: "You are a concise coding assistant." },
    { role: "user", content: "Write a short greeting for a class website." },
  ],
});

console.log(reply);
```

### Streaming and tool callbacks

```js
const reply = await sdk.aiChat.chat({
  model: "keepwork-flash",
  stream: true,
  messages: [
    { role: "system", content: "You can use tools when needed." },
    { role: "user", content: "Read README.md and summarize it." },
  ],
  onChunk(text) {
    console.log("partial:", text);
  },
  onToolCall(toolCall) {
    console.log("tool call:", toolCall);
  },
});
```

## `ChatSession`: conversational state and workspace-aware tools

Use `createSession()` when you want message history, persistent context, workspace scoping, or agent registration.

```js
const session = sdk.aiChat.createSession({
  systemPrompt: "You help students edit Markdown files.",
  model: "keepwork-flash",
  workspace: "lesson-01",
  enabledCategories: ["read", "execute"],
});

const answer = await session.send("Summarize the current workspace files.");
console.log(answer);
```

### Update the workspace later

```js
session.setWorkspace("lesson-02");
```

### Add a readonly fallback folder

```js
session.setMountFolder("teacher/site/templates");
```

### Direct tool execution from a session

```js
const readme = await session.executeTool("read_file", {
  filePath: "README.md",
  startLine: 1,
  endLine: 120,
});

console.log(readme);
```

## `SandboxToolEnv`: template expansion and controlled tool execution

`SandboxToolEnv` is the easiest way to expose a bounded tool surface to prompts or higher-level app logic.

### Create a local sandbox

```js
const sandbox = new window.SandboxToolEnv(sdk, {
  workspace: "lesson-01",
  enabledCategories: ["read", "edit", "execute"],
});
```

### Call tools through the proxy

```js
const snippet = await sandbox.copilot.read_file("README.md", 1, 80);
console.log(snippet);
```

### Register a custom tool-like API

```js
sandbox.registerAPI("get_weather", async ({ city }) => {
  return { city, weather: "sunny" };
});

const weather = await sandbox.execute("get_weather", { city: "Shenzhen" });
console.log(weather);
```

### Expand a prompt template with `${...}` expressions

```js
const prompt = await sandbox.processTemplate(`
Current note:
${await copilot.read_file("notes/today.md", 1, 80)}
`);

console.log(prompt);
```

### Run async code with `copilot` and custom context

```js
const result = await sandbox.runCode(`
const note = await copilot.read_file(filePath, 1, 40);
return 'User: ' + user.name + '\n' + note;
`, {
  filePath: "notes/today.md",
  user: { name: "Ada" },
});

console.log(result);
```

### Remote agent mode

When paired with `AgentRouter`, a sandbox can delegate tool calls to a named remote agent.

```js
const remoteSandbox = new window.SandboxToolEnv(sdk, {
  remoteAgent: "paracraft",
  categories: ["file_io", "scene_query"],
  workspace: "robot-world",
});

const definitions = await remoteSandbox.getToolDefinitions();
console.log(definitions);
```

## `CopilotTools`: the built-in tool registry

`sdk.copilotTools` is the shared tool registry behind `SandboxToolEnv`, chat sessions, and DigitalHuman tool support.

Built-in categories include:

- `read`
- `edit`
- `execute`
- `web`
- `mqtt`
- `personalPage`
- `agent`
- `minigame`

### Get tool definitions for selected categories

```js
const defs = sdk.copilotTools.getToolDefinitions(["read", "web"]);
console.log(defs);
```

### Execute a tool directly

```js
const result = await sdk.copilotTools.execute("read_file", {
  filePath: "README.md",
  startLine: 1,
  endLine: 60,
}, {
  workspace: "lesson-01",
});

console.log(result);
```

### Register a custom category

```js
sdk.copilotTools.registerToolCategory("math", {
  definitions: [
    {
      type: "function",
      function: {
        name: "sum_numbers",
        description: "Add two numbers",
        parameters: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      },
    },
  ],
  async executor(name, args) {
    if (name === "sum_numbers") return args.a + args.b;
    throw new Error(`Unknown function: ${name}`);
  },
});
```

## `MinigameTools`: iframe tools and skill launch sessions

`MinigameTools` is registered by `DigitalHuman` / `DigitalHumanFrame` and owns minigame iframe overlays in the host window. It supports multiple named slots. The active slot is the only iframe with `id="minigame-iframe"`, so app automation tools such as `read_app`, `type_in_app`, and `click_element` target the current active minigame.

Prompt files can load UI with the `minigame` tool category:

```md
${await copilot.load_minigame({ relativePath: "skills/example/index.html", width: 600, height: 600 })}
```

For DigitalHumanFrame skill-to-skill flows, call the SDK bridge from inside a loaded minigame iframe:

```js
window.keepwork.minigame.openSkill({
  skillPath: "skills/findWords/SKILL.md",
  title: "找单词",
  layout: "modal",
  restorePolicy: "resumeParent",
});
```

The bridge posts `keepwork:minigame:openSkill` to the parent. Parent-side `MinigameTools` verifies the request came from a known minigame iframe, opens a new slot session, and delegates agent switching to `DigitalHumanFrame.launchSkill()`.

Layout presets are `fullscreen`, `modal`, `panel`, and `custom`. `frameOptions` accepts the same fields as `configure_minigame`: `width`, `height`, `left`, `top`, `right`, `bottom`, `zIndex`, `showTitleBar`, `showCloseButton`, `titleText`, `borderRadius`, `boxShadow`, `background`, and `backdrop`.

Old app-specific messages such as `dh:startSubgame` are not part of the SDK contract. Callers must migrate to `window.keepwork.minigame.openSkill()`.

## `AppTools`: browser DOM inspection and UI actions

`AppTools` exposes a small browser automation surface useful for AI-driven page interaction.

Supported actions include:

- `read_app` — describe visible interactive elements (and optionally landmarks, forms, links, or `data-ai-hint` nodes).
- `click_element` — click an element by CSS selector, `text=` selector, or `ref` from a prior `read_app`.
- `type_in_app` — type text (or press keys) into inputs, textareas, selects, contenteditable nodes, or `data-ai-type="textbox"` divs.
- `screenshot_app` — delegate to a host-provided screenshot handler.

### Read the page

```js
const appTools = sdk.copilotTools.appTools;
const visible = await appTools.execute("read_app", { filters: "all" });
console.log(visible);
```

`filters` can be `"all"`, `"forms"`, `"links"`, `"ai-hint"`, or any CSS selector to scope into a container.

Per-call `whiteList` / `ignoreList` arrays can be passed as args:

```js
// Only show elements inside #game-area
await appTools.execute("read_app", { whiteList: ["#game-area"] });
```

Persistent filters are also available via `setWhiteList()` / `setIgnoreList()` but per-call args are preferred for parallel-safe usage.

### Click an element

```js
await appTools.execute("click_element", {
  selector: "#submit-button",
});
```

If a `ref` from `read_app` becomes stale, AppTools retries by the element's prior `aria-label` / accessible label first, then by visible text as the final fallback. When there is no matching stored ref, the `ref` value itself is treated as the label/name to resolve before falling back to text.

### Type into an element

```js
// Type into an input by CSS selector
await appTools.execute("type_in_app", { selector: "#username", text: "hello", clear: true });

// Press a key combo on the focused element
await appTools.execute("type_in_app", { key: "Control+a" });
```

### HTML attributes for non-interactive elements

Use these attributes on divs/spans to expose them to AppTools without making them natively interactive:

| Attribute | Effect |
|-----------|--------|
| `data-ai-hint="description"` | Makes the element discoverable by `read_app` (especially with `filters: "ai-hint"`). The description appears as a `[hint: ...]` annotation. |
| `data-ai-type="textbox"` | Reports the element as role `textbox` with its `innerText` as value. `type_in_app` can write to it via `textContent`. |
| `data-ai-type="button"` | Reports the element as role `button`. `click_element` dispatches pointer/mouse events on it. |

Example:

```html
<div data-ai-hint="Player score display" data-ai-type="textbox" id="score">42</div>
<div data-ai-hint="Start the game" data-ai-type="button" id="start-btn">Start</div>
```

### Plug in custom screenshot handling

```js
appTools.setScreenshotHandler(async () => {
  return { ok: true, image: "<base64>" };
});
```

### Include iframes in app reading

Iframes can be included in `read_app` results in two ways:

**Manual registration:**

```js
const iframe = document.querySelector("iframe");
appTools.addIframe(iframe);
```

**Auto-discovery via `data-ai-hint`:**

Any `<iframe data-ai-hint="...">` in the DOM is automatically discovered and included — no `addIframe()` call needed. The `data-ai-hint` value is used as the section label in the output:

```html
<iframe src="/game.html" data-ai-hint="Memory training mini-game"></iframe>
```

This produces output like:

```
── iframe: Memory training mini-game ──
- [ref=5] button "Start" [selector: #start-btn]
...
```

**WhiteList behavior with iframes:**

When a `whiteList` selector matches an iframe element itself (e.g. `["#my-iframe"]`), the iframe's internal content is queried without forwarding the parent's whiteList — since the selector targets the container, not inner elements. Non-matching iframes are skipped when a whiteList is active.

**Cross-iframe click and type:**

`click_element` and `type_in_app` also delegate to registered/discovered iframes when the target element is not found in the parent DOM.

For the richest example, see [`testAppTools.html`](../test/testAppTools.html), which combines app reading, tool execution, and avatar-driven interaction.

## Recommended patterns

- use one-shot `aiChat.chat()` for simple prompts
- use `createSession()` for real conversational state
- use `workspace` and `mountFolder` consistently when tools should read project files
- use `SandboxToolEnv` when you need template expansion or a bounded set of callable tools
- put custom categories into `sdk.copilotTools` when they should be reusable across chat, sandboxes, and avatar flows

