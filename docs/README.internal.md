# keepwork-sdk

Browser-side JavaScript/TypeScript SDK for the [Keepwork](https://keepwork.com) platform.
Provides page management, user authentication, personal-page-backed storage, AI chat sessions,
sandboxed tool execution, cross-iframe agent routing, WeChat integrations and optional RTC voice agents.

## Installation

```bash
npm install keepwork-sdk
```

## Quick Start

### ES Module (npm)

```ts
import { KeepworkSDK } from 'keepwork-sdk';

const sdk = new KeepworkSDK();

// Set auth token (obtained from login or WeChat OAuth)
sdk.setToken('your-jwt-token');

// Get current user
const username = await sdk.getUsername();
console.log(username);

// Save data to personal-page-backed cloud storage
await sdk.personalPageStore.savePageData('my-app', 'user.settings.theme', 'dark');
const theme = await sdk.personalPageStore.loadPageData('my-app', 'user.settings.theme');
```

> **Note:** `KeepworkSDK.API_KEYS.maisi` is intentionally empty in the npm build.
> If you need to authenticate against a `/gpt/*` endpoint, call `sdk.setUserApiKey('your-key')` yourself.

### CDN — All-in-one IIFE

```html
<script src="https://cdn.keepwork.com/sdk/keepworkSDK.iife.js"></script>
<script>
  // window.keepwork is created automatically
  const username = await window.keepwork.getUsername();
</script>
```

### CDN — Split bundles (core + lazy AI)

```html
<!-- Lightweight core -->
<script src="https://cdn.keepwork.com/sdk/keepworkSDK.core.iife.js"></script>

<!-- Load AI/DigitalHuman chunk on demand -->
<script>
  await window.keepwork.loadAIChat();
  // window.AIChat, window.AIChatRTC, window.DigitalHuman now available
</script>
```

## For Contributors — Build from Source

```bash
git clone <repo>
cd keepworksdk
npm install
cp .env.example .env   # 填入 MAISI_API_KEY（仅 CDN 自用构建需要）
```

| 命令 | 产物 | 说明 |
|------|------|------|
| `npm run build:cdn` | `dist/*.iife.js` | CDN/IIFE 自用包，从 `.env` 注入 API key |
| `npm run build:npm` | `dist-npm/` | npm 发布包，key 恒为空串 |
| `npm run typecheck` | — | 仅做 TS 类型检查 |
| `npm run dev` | — | 启动 Vite dev server（port 5001） |
| `npm publish` | npmjs | 自动触发 `prepublishOnly → build:npm` |

---

## More Examples

### Basic Setup (CDN / IIFE)
```javascript
// you can use the default instance at window.keepwork
const username = await window.keepwork.getUserName();
console.log(username);

// you can also initialize with different params
const sdk = new KeepworkSDK({
    baseURL: 'https://api.keepwork.com/core/v0',
    timeout: 30000
});

// Set authentication token (if you have one)
sdk.setToken('your-token');
```

### User Authentication
```javascript
// Login with username and password
const response = await sdk.login({
    username: 'your-username',
    password: 'your-password'
});

// Login with Maisi third-party service
await sdk.loginWithMaisi('maisi-token');

// Get user profile
const profile = await sdk.getUserProfile();
console.log('User:', profile.username);

// Check VIP status
const isVip = await sdk.isUserVip();
console.log('VIP Status:', isVip);
```

### Page Management
```javascript
// Save a page
await sdk.savePage({
    sitePath: 'username/sitename',
    pagePath: 'folder/page.md',
    content: '# Hello World\n\nThis is my page content.'
});

// Load a page
const pageData = await sdk.loadPage({
    sitePath: 'username/sitename',
    pagePath: 'folder/page.md'
});
console.log('Content:', pageData.content);

// Convenience methods with full paths
await sdk.editMarkdownByFullPath('username/sitename/folder/page', 'New content');
const content = await sdk.getMarkdownByFullPath('username/sitename/folder/page');

// Check if page exists
const exists = await sdk.checkPageExists('username/sitename/folder/page');
```

### Personal Page Store (Data Persistence)
```javascript
// Access the personal page store
const store = sdk.personalPageStore;

// Save data with dot notation for nested objects
await store.savePageData('my-app', 'user.settings.theme', 'dark');
await store.savePageData('my-app', 'user.profile.name', 'John Doe');
await store.savePageData('my-app', 'gameState.level', 5);

// Load data
const theme = await store.loadPageData('my-app', 'user.settings.theme');
const level = await store.loadPageData('my-app', 'gameState.level');

console.log('Theme:', theme); // 'dark'
console.log('Level:', level); // 5

// Data is automatically synced between local storage and remote Git
// with version control and conflict resolution
```

## Exported Modules

```ts
import {
  // Core
  KeepworkSDK,          // Main SDK class — default instance on window.keepwork (CDN)
  SDKLogger,            // Console log management (per-module enable/disable)
  PersonalPageStore,    // 3-layer cloud storage (memory → localStorage → IndexedDB)
  YMLParser,            // Lightweight YAML ↔ object serializer
  RemoteLog,            // Event tracking / telemetry
  CopilotTools,         // Category-based tool registry (mqtt / fileOps / execute / web…)
  SandboxToolEnv,       // Sandboxed tool execution with ${…} prompt templating
  CloudDrive,           // Cloud file drive helpers
  LocalAPIKeySettings,  // Local per-provider API key storage & resolution
  AIGenerators,         // Image / audio generation helpers
  UserWorks,            // User works / projects
  SocialFriends,        // Social friends list
  NPLUtil, NPLJS, ParacraftEvent,  // Paracraft / NPL bridge
  WxLaunchApp, WxAuth, WxUtils,   // WeChat integrations
  LoginWindow, ProfileWindow,      // Built-in login/profile UI modals
  AudioEngine,          // Shared browser audio engine

  // AI / DigitalHuman (heavier chunk — lazy-load with keepwork.loadAIChat() on CDN)
  AIChat,               // Streaming chat sessions, history, tool calling
  AIChatRTC,            // VolcEngine RTC-based voice/text sessions
  AIChatRTCLocal,       // Local RTC variant
  SpeechRTC,            // Speech-over-RTC helpers
  DigitalHuman,         // Virtual character (Video / Live2D / WebP) + AI session lifecycle
  DigitalHumanFrame,    // Iframe-isolated DigitalHuman with AgentRouter tool delegation
  AgentConfig,          // Cross-agent configuration helpers
  SummarizeTool, SummarizeAgent,
  MinigameTools,
  WorkspaceViewer, createWorkspaceViewer,
  Translation, installI18nGlobals,
} from 'keepwork-sdk';
```

## API Reference

### KeepworkSDK Class

#### Constructor Options
```javascript
const sdk = new KeepworkSDK({
    baseURL: 'https://api.keepwork.com/core/v0',  // API base URL
    timeout: 30000,                               // Request timeout (ms)
    retryCount: 1,                               // Number of retry attempts
    retryDelay: 1000,                            // Delay between retries (ms)
    userCacheTimeout: 300000                     // User profile cache timeout (ms)
});
```

#### Authentication Methods
- `setToken(token)` - Set JWT authentication token
- `login(credentials)` - Login with username/password
- `loginWithMaisi(token, callback?)` - Login with Maisi third-party service
- `logout()` - Logout and clear token
- `getUserProfile(options?)` - Get user profile with caching

#### User Information Methods
- `isUserVip(options?)` - Check if user has VIP status
- `isUserSvip(options?)` - Check if user has SVIP status
- `getUserVipExpiration(options?)` - Get VIP expiration date
- `getUserSvipExpiration(options?)` - Get SVIP expiration date
- `isUserRealNameVerified(options?)` - Check real name verification
- `getUserId(options?)` - Get user ID
- `getUsername(options?)` - Get username
- `getUserEmail(options?)` - Get user email
- `getUserDisplayName(options?)` - Get display name
- `getUserPortrait(options?)` - Get portrait URL
- `getUserField(fieldPath, defaultValue?, options?)` - Get specific user field

#### Page Management Methods
- `savePage(pageData)` - Save/create a page
- `loadPage(pageInfo)` - Load page content
- `deletePage(pageInfo)` - Delete a page
- `pageExists(pageInfo)` - Check if page exists
- `copyPage(copyInfo)` - Copy page to another location
- `getPageHistory(pageInfo)` - Get page commit history
- `getRawPage(url, useCache?)` - Get raw page content from URL

#### Convenience Methods
- `autoCreateSiteAndSavePage(fullPath, content, callback?)` - Auto-create site if needed
- `getMarkdownByFullPath(fullPath, callback?)` - Get markdown by full path
- `editMarkdownByFullPath(fullPath, content, callback?)` - Edit markdown by full path
- `deleteMarkdownByFullPath(fullPath, callback?)` - Delete markdown by full path
- `checkPageExists(fullPath, callback?)` - Check existence by full path

#### Site Management Methods
- `createSite(siteData)` - Create a new site
- `getAllSites()` - Get all user sites
- `getSitesByUsername(username)` - Get sites by username
- `getSiteDetail(siteId)` - Get site details
- `getSiteTree(sitePath, recursive?)` - Get site file tree

### PersonalPageStore Class

The PersonalPageStore provides persistent data storage with automatic synchronization between local storage and remote Git repositories.

#### Key Features
- **Local & Remote Sync**: Automatically syncs data between localStorage and Git
- **Version Control**: Built-in versioning with conflict resolution
- **Dot Notation**: Support for nested object access using dot notation
- **Anonymous Mode**: Works without authentication for local-only storage
- **IndexedDB Storage**: Large capacity storage (hundreds of MB) with localStorage fallback
- **Three-Layer Architecture**: Memory cache → localStorage → IndexedDB for optimal performance

#### Storage Architecture (New in 2024)

The storage system uses a three-layer architecture for maximum capacity and performance:

1. **Memory Cache (L1)** - Fastest, in-memory storage
   - Instant synchronous access
   - Cleared on page reload
   - Used for frequently accessed data

2. **localStorage (L2)** - Sync backup and compatibility layer
   - 2MB per-item size limit
   - Automatic skip for data > 2MB
   - Auto-cleanup on quota exceeded
   - Maintains compatibility with sync APIs

3. **IndexedDB (L3)** - Primary large-capacity storage
   - Hundreds of MB to GB capacity
   - Asynchronous operations (non-blocking)
   - Stores all data regardless of size
   - Falls back to localStorage on failure

**Storage Limits:**
- localStorage: ~5-10MB total (browser dependent), 2MB per item
- IndexedDB: ~50% of available disk space (hundreds of MB or more)
- Memory Cache: Limited by available RAM

**Automatic Behaviors:**
- Data > 2MB automatically skips localStorage backup
- localStorage quota exceeded triggers automatic cleanup
- All writes go to both IndexedDB and localStorage (when possible)
- Reads prioritize Memory → localStorage → IndexedDB
- Failed operations automatically fall back to next layer

#### Methods
- `savePageData(pageName, key, value, bFlush?, bUseCache?)` - Save data to a page
- `loadPageData(pageName, key, callback?, forceRemote?)` - Load data from a page
- `deletePageData(pageName, key, bFlush?)` - Delete specific key from page
- `clearLocalDisk(pageName)` - Clear local storage for a page
- `clearRemotePage(pageName)` - Clear remote data for a page
- `batchSyncToRemote(forceSync?)` - Manually trigger remote sync

#### LocalStorageUtil Module

Direct access to the low-level storage layer:

```javascript
import LocalStorageUtil, { StorageUtil } from './src/LocalStorageUtil';

// Preferred module name
LocalStorageUtil.setItem(key, value);
const value = LocalStorageUtil.getItem(key, defaultValue);

// Backward-compatible alias
// Synchronous operations (uses memory/localStorage)
StorageUtil.setItem(key, value);
const value = StorageUtil.getItem(key, defaultValue);
StorageUtil.removeItem(key);
StorageUtil.clear();

// Asynchronous operations (uses IndexedDB)
await StorageUtil.getItemAsync(key, defaultValue);
await StorageUtil._setItemAsync(key, value);
await StorageUtil._removeItemAsync(key);

// Storage statistics
const stats = await StorageUtil.getStorageStats();
console.log(stats);
// {
//   indexedDB: 1024000,  // bytes
//   localStorage: 50000,  // bytes
//   memoryCache: 10       // item count
// }
```

#### Data Structure
Data is automatically versioned with metadata:
```javascript
{
    "user": {
        "settings": {
            "theme": "dark",
            "language": "en"
        }
    },
    "gameState": {
        "level": 5,
        "score": 1000
    },
    "metadata": {
        "version": 3,
        "created_at": "2024-01-01-10:30:00",
        "updated_at": "2024-01-02-15:45:30"
    }
}
```

### Utility Classes

#### YMLParser
- `objectToYaml(obj)` - Convert object to YAML format
- `yamlToObject(yamlString)` - Parse YAML string to object

#### NPLUtil / NPLJS
NPL (Neural Parallel Language) communication for Paracraft integration:
- `NPL.activate(filename, msg)` - Send NPL message
- Message handling for different platforms (Windows, macOS, Android, etc.)

#### RemoteLog
Event logging and analytics system with support for behavioral tracking and custom events:
- `sendEvent(eventData, retryCount?)` - Send custom events with automatic retry logic
- `send(eventType, action, extra?, offlineMode?, useNewCatalog?, userId?, projectId?)` - Core event sending method (1=one-click, 2=duration)
- `logClick(action, extra?, useNewCatalog?, userId?, projectId?)` - Log one-click events
- `logBehavior(action, data, category?)` - Log user behavior events with automatic trace ID generation
- `generateTraceId()` - Generate unique trace IDs for event tracking
- `getUserId()` - Get current user ID from SDK session
- `getServerTime()` - Get current timestamp
- `generateDataPacket(eventType, userId, action, started?, useNewCatalog?, projectId?)` - Generate event data packets
- `getBrowserHeaders()` - Generate browser-specific headers for requests

**Event Types:**
- **One-click events** (eventType=1): Immediate actions like button clicks
- **Duration events** (eventType=2): Time-based events with start/end tracking
- **Behavior events**: General user behavior logging with custom categories

**Features:**
- Automatic retry with exponential backoff
- Browser header detection (User-Agent, Referer)
- JWT token authentication support
- Event data packet generation with trace IDs
- Support for both new and legacy event catalogs

## Device & Browser Detection

```javascript
// Static methods for environment detection
const isWeChat = KeepworkSDK.isWeChatBrowser();
const isMobile = KeepworkSDK.isMobileDevice();
const system = KeepworkSDK.getSystem(); // 'windows', 'macos', 'android', etc.
const isFullscreen = KeepworkSDK.checkFullscreen();
```

## WeChat OAuth Login (微信授权登录)

The SDK provides WeChat OAuth2.0 web authorization login functionality through the `WxAuth` module.

### Quick Start
```javascript
// Auto auth - automatically handles the entire OAuth flow
// Detects WeChat environment, redirects to auth page, and exchanges code for token
await window.keepwork.wxAuth.autoAuth({
  onSuccess: (res) => {
    console.log('Login successful:', res);
  },
  onFail: (error) => {
    console.error('Login failed:', error);
  }
});
```

### Initialize with Custom Config
```javascript
// Method 1: Configure at initialization
const sdk = new KeepworkSDK({
  wxAuth: {
    appId: 'wx0ae11671f8e8adb8',      // Custom WeChat App ID
    scope: 'snsapi_userinfo',         // 'snsapi_base' or 'snsapi_userinfo'
    autoRegister: false               // Auto register new users
  }
});

// Method 2: Configure at runtime
window.keepwork.wxAuth.setAppId('wx0ae11671f8e8adb8');
window.keepwork.wxAuth.setScope('snsapi_userinfo');
```

### Manual Authorization Flow
```javascript
const wxAuth = window.keepwork.wxAuth;

// Step 1: Check if in WeChat browser
if (wxAuth.isWechatBrowser()) {
  
  // Step 2: Check if already logged in
  if (!wxAuth.isLoggedIn()) {
    
    // Step 3: Check for authorization code in URL
    const code = wxAuth.getCodeFromUrl();
    
    if (code) {
      // Step 4a: Exchange code for token
      const result = await wxAuth.codeToToken(code, {
        autoRegister: true,
        onSuccess: (res) => console.log('Token received:', res.token),
        onFail: (err) => console.error('Token exchange failed:', err)
      });
    } else {
      // Step 4b: Redirect to WeChat authorization page
      wxAuth.authorize({
        appId: 'your-app-id',         // Optional: override default
        scope: 'snsapi_userinfo',     // Optional: override default
        state: 'custom-state'         // Optional: custom state parameter
      });
    }
  }
}
```

### WxAuth API Reference

#### Constructor Options
```javascript
{
  appId: 'wx7935c49369d421c1',    // Default WeChat App ID
  maisiAppId: 'wx0ae11671f8e8adb8', // Maisi App ID (special handling)
  scope: 'snsapi_userinfo',       // Authorization scope
  autoRegister: false,            // Auto register on first login
  tokenCookieDays: 14             // Token cookie expiration days
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `isWechatBrowser()` | Check if running in WeChat browser |
| `getEnvironment()` | Get detailed WeChat environment info |
| `isInIframe()` | Check if running inside an iframe |
| `isLoggedIn()` | Check if user has valid token |
| `getCodeFromUrl()` | Extract authorization code from URL |
| `authorize(options)` | Redirect to WeChat authorization page |
| `codeToToken(code, options)` | Exchange code for access token |
| `autoAuth(options)` | Complete auto authorization flow |
| `resetAuthFailedState()` | Reset failed state for retry |
| `setAppId(appId)` | Update default App ID |
| `setScope(scope)` | Update authorization scope |
| `getConfig()` | Get current configuration |

#### autoAuth Options
```javascript
{
  appId: string,           // WeChat App ID (optional)
  autoRegister: boolean,   // Auto register new users (optional)
  scope: string,           // Authorization scope (optional)
  state: string,           // Custom state parameter (optional)
  productionOnly: boolean, // Only run in production (default: true)
  refreshPage: boolean,    // Refresh page after login (default: true)
  onSuccess: Function,     // Success callback (res) => void
  onFail: Function,        // Failure callback (error) => void
  extraParams: Object      // Extra URL parameters for redirect
}
```

### WxUtils (Shared Utilities)

Low-level WeChat utilities available via `window.WxUtils`:

```javascript
// Environment detection
const env = WxUtils.detectWxEnvironment();
// Returns: { isWeChat, isMiniProgram, isWorkWeChat, isDevTools, isAnyWeChat }

// Check WeChat browser
const isWx = WxUtils.isWechatBrowser();

// Check iframe
const inIframe = WxUtils.isInIframe();

// Load WeChat JS-SDK
const wx = await WxUtils.loadWxSDK();

// Get WeChat signature for JS-SDK
const { signature, timestamp, nonceStr } = await WxUtils.getSignature(url);

// URL utilities
const queryString = WxUtils.toUrlQueryString({ key: 'value' });
const params = WxUtils.parseUrlQueryString('?key=value');

// Cookie utilities
const token = WxUtils.getTokenFromCookie();
WxUtils.setCookie('token', 'value', 14); // 14 days expiration
```

### Important Notes

1. **Domain Whitelist**: Ensure your domain is registered in WeChat Official Account settings
2. **HTTPS Required**: WeChat OAuth requires HTTPS in production
3. **App ID Types**: 
   - Mobile web authorization uses different App ID than PC QR code login
   - Default: `wx7935c49369d421c1`
   - Maisi: `wx0ae11671f8e8adb8`
4. **Scope Options**:
   - `snsapi_base`: Silent authorization, only gets openid
   - `snsapi_userinfo`: Requires user confirmation, gets full profile
5. **iframe Protection**: Auto auth is disabled inside iframes to prevent loops
6. **Production Only**: By default, auto auth only runs in production environment

## Building the SDK

### Development
```bash
# Start development server with hot reload (serves index.ts = all-in-one)
npm run dev

# Build in watch mode (all-in-one only)
npm run build:watch
```

### Production Build
```bash
# Build all three bundles
npm run build

# Build + copy to ../resource/ for deployment
npm run localDeploy
```

### Build Outputs

The build produces three bundles in `dist/`:

| File | Size | Description |
|------|------|-------------|
| `keepworkSDK.iife.js` | ≈420 KB | **All-in-one** — full backward-compatible bundle |
| `keepworkSDK.core.iife.js` | ≈168 KB | **Core** — without AIChat / DigitalHuman modules |
| `keepworkSDK.AIChat.iife.js` | ≈263 KB | **AIChat chunk** — depends on core; loaded on demand |

Each bundle has a corresponding `.map` source map file.

**Entry points:**
- `index.ts` → all-in-one bundle
- `indexCore.ts` → core-only bundle
- `indexAIChat.ts` → AIChat chunk

**What's in each bundle:**

| Module | Core | AIChat | All-in-one |
|--------|:----:|:------:|:----------:|
| KeepworkSDK, PersonalPageStore, YMLParser | ✓ | | ✓ |
| NPLUtil, NPLJS, ParacraftEvent | ✓ | | ✓ |
| CopilotTools, SandboxToolEnv, AgentRouter | ✓ | | ✓ |
| RemoteLog, Speech, LoginWindow | ✓ | | ✓ |
| WxAuth, WxLaunchApp, WxUtils | ✓ | | ✓ |
| AIChat, SpeechRTC | | ✓ | ✓ |
| AIChatRTC, AIChatRTCLocal | | ✓ | ✓ |
| DigitalHuman, DigitalHumanFrame | | ✓ | ✓ |
| AgentConfig, SummarizeTool | | ✓ | ✓ |

When using the split bundles, the AIChat chunk resolves `SandboxToolEnv` and `YMLParser` from `window.*` globals provided by the core bundle (Rollup externals), so they are **not** duplicated.

## Testing

### Main Test Suite
A comprehensive test page is included at `public/public/keepworkSDK/test/testKeepworkSDK.html`. Open this file in a browser to test all SDK features:

- Authentication (login, logout, profile loading)
- Page management (save, load, delete)
- Personal page store operations
- User information retrieval
- VIP status checking
- Site management

### IndexedDB Storage Test Suite
A specialized test page for IndexedDB storage optimization is available at `public/public/keepworkSDK/test/testIndexedDB.html`. This interactive test suite includes:

**Storage Statistics Dashboard:**
- Real-time monitoring of IndexedDB, localStorage, and memory cache usage
- Automatic refresh every 5 seconds
- Visual statistics cards showing storage consumption

**Basic Storage Tests:**
1. **Small Data Storage (< 1KB)** - Test basic read/write operations
2. **Large Data Storage (> 2MB)** - Test data exceeding localStorage limits
3. **Batch Operations** - Performance testing with 10-1000 items

**Advanced Features:**
4. **Capacity Limit Tests** - Verify 2MB localStorage threshold and auto-cleanup
5. **Three-Layer Sync** - Test Memory → localStorage → IndexedDB synchronization
6. **Async vs Sync Read** - Compare performance of different read methods

**Real-world Scenarios:**
7. **Game Data Storage** - Time series data with aggregation (addictive, mean)
8. **Concurrent Writes** - Simulate multiple simultaneous writes

**Debug Tools:**
- Inspect IndexedDB and localStorage contents
- Export test data as JSON
- Clear all storage
- Real-time event logging

**How to Use:**
```bash
# Option 1: Open directly in browser
open public/public/keepworkSDK/test/testIndexedDB.html

# Option 2: After building SDK, open through file system
# The test page will automatically load the built SDK from ../dist/keepworkSDK.iife.js
```

**Key Test Scenarios:**
- ✅ Verify data > 2MB saves to IndexedDB only (skips localStorage)
- ✅ Confirm localStorage quota exceeded triggers auto-cleanup
- ✅ Test three-layer architecture (memory → localStorage → IndexedDB)
- ✅ Validate async operations don't block UI
- ✅ Check fallback mechanism when storage layers fail

## Error Handling

The SDK includes comprehensive error handling:

```javascript
try {
    const result = await sdk.savePage({
        sitePath: 'user/site',
        pagePath: 'page.md',
        content: 'content'
    });
    console.log('Success:', result);
} catch (error) {
    console.error('Error:', error.message);
    
    // Check for specific error types
    if (error.code === 'MAX_RETRY_EXCEEDED') {
        console.log('Request failed after maximum retries');
    }
}
```

## Configuration Options

### Authentication
- Set token manually: `sdk.setToken('your-token')`
- Token is automatically stored after successful login
- Supports JWT tokens from Keepwork API

### Caching
- User profile caching (default: 5 minutes)
- Page content caching options
- Local storage for personal page store

### Network
- Configurable timeout and retry logic
- Automatic retry with exponential backoff
- Support for different base URLs

## Browser Support

- Modern browsers with ES6+ support
- Chrome, Firefox, Safari, Edge
- Mobile browsers (iOS Safari, Chrome Mobile)
- WeChat browser detection and handling

## Build Scripts (package.json)

The following npm scripts are available for building and developing the SDK:

```bash
# Development server with hot reload
npm run keepworkSDK:dev
npm run keepwork:bundle:dev

# Build production bundle
npm run keepworkSDK:build
npm run keepwork:bundle

# Build in watch mode
npm run keepworkSDK:build:watch
npm run keepwork:bundle:watch

# Preview built files
npm run keepworkSDK:preview
```

## PowerShell Build Script

A PowerShell build script is included for Windows users:

```powershell
# Build the SDK
.\build-keepworkSDK.ps1 build

# Build in watch mode
.\build-keepworkSDK.ps1 build -Watch

# Start development server
.\build-keepworkSDK.ps1 dev

# Clean build output
.\build-keepworkSDK.ps1 clean
```

## File Structure

```
/public/keepworkSDK/
├── index.ts                    # Main entry point (full bundle)
├── indexCore.ts                # Core-only entry
├── indexAIChat.ts              # AIChat / DigitalHuman entry
├── dist/                       # Built files
│   ├── keepworkSDK.iife.js    # Browser bundle
│   └── keepworkSDK.iife.js.map # Source map
├── src/                        # Source files (all TypeScript)
│   ├── keepworkSDK.ts         # Main SDK class
│   ├── PersonalPageStore.ts   # Data persistence
│   ├── YMLParser.ts           # YAML utilities
│   ├── NPL.ts                 # NPL communication
│   └── RemoteLog.ts           # Event logging
├── test/
│   └── testKeepworkSDK.html   # Test page
└── readme.md                  # This file
```

## Contributing

## Support

## License
