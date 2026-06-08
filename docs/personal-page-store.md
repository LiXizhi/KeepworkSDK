# PersonalPageStore and local persistence

`PersonalPageStore` is the SDK's browser-friendly persistence layer. It combines in-memory caching, `localStorage`, IndexedDB, and remote Keepwork page sync so you can work with structured data or file-like content from the browser.

For full examples, see:

- [`testPersonalPageStore.html`](../test/testPersonalPageStore.html)
- [`WorkspaceViewer.html`](../test/WorkspaceViewer.html)
- [`testIndexedDB.html`](../test/testIndexedDB.html)

## Accessing the store

```js
const sdk = window.keepwork;
const store = sdk.personalPageStore;
```

## Storage model

The store uses a three-layer architecture:

1. Memory cache for fast reads
2. `localStorage` for sync-friendly browser persistence
3. IndexedDB for larger payloads

Important behavior:

- large values automatically skip `localStorage` when needed
- writes are batched for remote sync
- nested data uses dot-notation keys
- the store can operate locally even before authentication, but remote sync requires user context

## Save and load structured values

### Save nested values

```js
await store.savePageData("my-app", "user.settings.theme", "dark");
await store.savePageData("my-app", "user.profile.name", "Alice");
await store.savePageData("my-app", "game.level", 5);
```

### Load values

```js
const theme = await store.loadPageData("my-app", "user.settings.theme");
const level = await store.loadPageData("my-app", "game.level");

console.log({ theme, level });
```

### Delete values

```js
await store.deletePageData("my-app", "game.level");
```

## Working with workspaces

You can scope page/file operations to a workspace. This is especially useful with AI tool calling and editor-like UIs.

```js
const workspaceStore = store.withWorkspace("lesson-01");
```

Once you create a scoped store, file-oriented operations resolve paths relative to that workspace without mutating the shared store.

### Example: switch workspace before reading files

```js
const workspaceStore = store.withWorkspace("robot-demo");

const files = await workspaceStore.listDir("", true);
console.log(files);
```

## Mount a readonly fallback folder

Use `withWorkspace(workspace, mountedFolder)` to overlay another Keepwork folder as a readonly fallback source. This is helpful when users should be able to read template content but only write into their own workspace.

```js
const workspaceStore = store.withWorkspace(
  "student-workspace",
  "demo_user/lesson-site/shared-assets"
);
```

### Example pattern

```js
const workspaceStore = store.withWorkspace(
  "student-workspace",
  "teacher/site/templates"
);

const template = await workspaceStore.readFile("intro.md", 1, 120);
console.log(template);
```

In this pattern:

- reads first check the active workspace
- if a file is missing, the mounted folder can supply it
- directory listings merge workspace files with mounted content

## File-style APIs

The store also exposes file-like methods used heavily by the AI/tooling layer.

### Read part of a file

```js
const content = await store.readFile("notes.md", 1, 80);
console.log(content);
```

### Search file contents

```js
const matches = await store.grepSearch("TODO", false, "**/*.md", 50);
console.log(matches);
```

### List a directory

```js
const listing = await store.listDir("docs", true);
console.log(listing);
```

### Work with absolute Keepwork paths

Absolute paths begin with `/` and let you read remote Keepwork files directly:

```js
const absoluteContent = await store.readFile(
  "/username/sitename/docs/reference.md",
  1,
  120
);

console.log(absoluteContent);
```

This pattern is useful when your app mixes local workspace files with published project content.

## When to use `PersonalPageStore` vs page APIs

Use `KeepworkSDK` page APIs when:

- you are managing full Keepwork pages and site content
- you want explicit `sitePath` and `pagePath` control
- you are publishing or editing regular site pages

Use `PersonalPageStore` when:

- you need browser-side persistence
- you want nested key/value storage
- you want file-like reads/search/listing inside a user workspace
- you want a natural backend for AI tools like `read_file` and `list_dir`

## Example: save app state and a generated note

```js
const store = window.keepwork.personalPageStore;

const workspaceStore = store.withWorkspace("writing-assistant");

await workspaceStore.savePageData("settings", "editor.fontSize", 16);
await workspaceStore.savePageData("settings", "editor.theme", "dark");

await workspaceStore.createFile?.("drafts/today.md", "# Daily note\n\nThis came from the browser.");

const files = await workspaceStore.listDir("drafts", true);
console.log(files);
```

If your environment uses `createFile` or richer file operations, the workspace browser examples in [`testPersonalPageStore.html`](../test/testPersonalPageStore.html) are the best reference.

## Best practices

- set `workspace` explicitly when your app has a clear project scope
- use `mountFolder()` for readonly templates or shared curriculum content
- keep structured settings in a small set of page names like `settings`, `profile`, or `state`
- use `readFile`, `listDir`, and `grepSearch` for AI/tool scenarios instead of building your own file abstraction

