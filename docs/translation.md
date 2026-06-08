# Translation (i18n)

The `Translation` class provides internationalization for KeepworkSDK. It uses **Chinese text as keys** and loads external JSON files for other languages.

## Globals

After loading the SDK bundle, the following globals are available:

| Global | Type | Description |
|--------|------|-------------|
| `window.i18n` | `Translation` | The shared Translation instance |
| `window.t(key, vars)` | `Function` | Shortcut for `i18n.t()` |
| `window.GetDisplayLanguage()` | `Function` | Returns current language code |
| `window.Translation` | `Class` | The Translation constructor |

## Language resolution order

1. URL parameter `?lang=enUS`
2. localStorage key `keepwork_ui_lang`
3. `navigator.language` (mapped to `zhCN`, `enUS`, `jaJP`, or `enUS` fallback)

## Specifying locale files

### At construction time

```js
const i18n = new Translation({
  autoInit: true,
  localeFiles: {
    enUS: '/my/path/to/enUS.json',
    jaJP: '/my/path/to/jaJP.json',
  },
});
installI18nGlobals(i18n);
```

### After the SDK loads — register additional paths

```js
window.i18n.addLocaleFiles({
  jaJP: '/my/path/to/jaJP.json',
});
// The file is fetched lazily when setLang('jaJP') or loadTranslations('jaJP') is called.
```

### Without a JSON file — merge translations directly

```js
window.i18n.mergeTranslations({
  '你好': 'Hello',
  '设置': 'Settings',
});
// Existing keys are NOT overwritten.
```

## Locale JSON format

The JSON file is organized by sections. Each section is a flat object of `"中文key": "translated value"` pairs. A special `_meta` section is ignored.

```json
{
  "_meta": { "language": "English", "version": "1.0" },
  "common": {
    "你好": "Hello",
    "设置": "Settings"
  },
  "login": {
    "登录": "Log in",
    "注册": "Sign up"
  }
}
```

All sections are flattened into a single lookup map at load time.

## API reference

### `new Translation(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `localeFiles` | `Object` | `{ enUS: './keepwork.locale.enUS.json' }` | Map of `langCode → JSON URL` |
| `defaultLang` | `string` | `'zhCN'` | Fallback language code |
| `autoInit` | `boolean` | `false` | Call `init()` immediately in the constructor |

### `init(): Promise<string>`

Detects language, loads translations if needed, calls `applyTranslations()`, and returns the resolved language code. Safe to call multiple times (returns the same promise).

### `t(key, vars?): string`

Translate a Chinese key. If the current language is the default (`zhCN`) or no translation is found, returns the key unchanged.

Variable substitution replaces `{varName}` placeholders:

```js
i18n.t('欢迎{name}', { name: 'Alice' });
// enUS → "Welcome Alice"  (if '欢迎{name}' → 'Welcome {name}' in JSON)
// zhCN → "欢迎Alice"
```

### `applyTranslations()`

Scans the DOM for all elements with `data-i18n` attribute and replaces their `textContent` with the translated value.

```html
<span data-i18n="你好">你好</span>
<!-- After applyTranslations() in enUS → -->
<span data-i18n="你好">Hello</span>
```

The attribute value is used as the key. If empty, falls back to the element's current `textContent`.

Called automatically during `init()`. Call it again manually after dynamically adding DOM elements.

### `setLang(lang): Promise<void>`

Sets the language, stores it in localStorage, loads translations if needed, and **reloads the page** with `?lang=<lang>` in the URL.

### `getLang(): string`

Returns the current language code.

### `loadTranslations(lang?): Promise<Object>`

Fetches and parses the locale JSON for the given language. Returns the flattened translation map. Cached after first load.

### `mergeTranslations(extra)`

Merges additional translations into the current map. Accepts flat (`{ '键': 'value' }`) or nested (`{ section: { '键': 'value' } }`) objects. **Existing keys are not overwritten.**

### `addLocaleFiles(files)`

Registers additional locale file paths. Files are fetched lazily when `loadTranslations()` or `setLang()` is called for that language.

```js
window.i18n.addLocaleFiles({ jaJP: '/locales/jaJP.json' });
```

### `isReady(): boolean`

Returns `true` if translations are loaded or the current language is the default (Chinese).

### `ready(): Promise`

Resolves when `init()` completes.

### `getNativeLanguage(): string`

Returns the current UI language code (alias for `getLang()`).

### `getTargetLanguage(): string`

Returns the language-learning target language from localStorage key `helloworld_target_language`, defaults to `'enUS'`.
