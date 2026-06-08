# KeepworkSDK core API

This guide covers the `KeepworkSDK` class: authentication, user/profile helpers, page APIs, and site operations.

For a working browser UI that exercises most of these APIs, see [`testKeepworkSDK.html`](../test/testKeepworkSDK.html).

## Creating an instance

### Use the default instance

```js
const sdk = window.keepwork;
```

### Create your own instance

```js
const sdk = new window.KeepworkSDK({
  baseURL: "https://api.keepwork.com/core/v0",
  timeout: 30000,
  retryCount: 1,
  retryDelay: 1000,
  userCacheTimeout: 5 * 60 * 1000,
});
```

Key behavior:

- `baseURL` defaults to the current Keepwork domain, derived from `window.location.hostname`
- `request()` automatically adds `Authorization: Bearer ...` when a token is present
- requests use retry logic based on `retryCount` and `retryDelay`
- the constructor also wires up helper modules such as `personalPageStore`, `speech`, `copilotTools`, `aiChat`, `wxAuth`, and `loginWindow`

## Authentication

### Set a token directly

```js
sdk.setToken("your-jwt-token");
```

### Set a token and immediately refresh user state

```js
const profile = await sdk.setTokenAndRefresh("your-jwt-token");
console.log(profile.username);
```

### Login with username and password

```js
const loginResult = await sdk.login({
  username: "your-username",
  password: "your-password",
});

console.log(loginResult);
```

### Logout

```js
await sdk.logout();
```

### Show the built-in login window

```js
await sdk.loginWindow.show({
  title: "Sign in to Keepwork",
});
```

If you want a full UI example, check the authentication section in [`testKeepworkSDK.html`](../test/testKeepworkSDK.html).

## User and profile helpers

Common helpers exposed by the core SDK:

- `getUserProfile(options?)`
- `getUserId(options?)`
- `getUsername(options?)`
- `getUserEmail(options?)`
- `getUserDisplayName(options?)`
- `getUserPortrait(options?)`
- `getUserField(path, defaultValue?, options?)`
- `isUserVip(options?)`
- `isUserSvip(options?)`
- `getUserVipExpiration(options?)`
- `getUserSvipExpiration(options?)`
- `isUserRealNameVerified(options?)`

### Example: fetch and display profile data

```js
const profile = await sdk.getUserProfile();

console.log({
  id: await sdk.getUserId(),
  username: await sdk.getUsername(),
  displayName: await sdk.getUserDisplayName(),
  isVip: await sdk.isUserVip(),
  portrait: await sdk.getUserPortrait(),
});
```

### Example: read a nested user field safely

```js
const schoolName = await sdk.getUserField("profile.school.name", "unknown");
console.log("school:", schoolName);
```

## Page APIs

These are the core content-management methods for Keepwork pages.

### Save a page

```js
await sdk.savePage({
  sitePath: "username/sitename",
  pagePath: "docs/hello.md",
  content: "# Hello\n\nCreated with KeepworkSDK.",
});
```

### Load a page

```js
const page = await sdk.loadPage({
  sitePath: "username/sitename",
  pagePath: "docs/hello.md",
});

console.log(page);
```

### Delete a page

```js
await sdk.deletePage({
  sitePath: "username/sitename",
  pagePath: "docs/hello.md",
});
```

### Check whether a page exists

```js
const exists = await sdk.checkPageExists("username/sitename/docs/hello");
console.log(exists);
```

### Convenience helpers using a full path

These helpers are useful when your app already works with the combined `username/sitename/path/to/page` format.

```js
await sdk.editMarkdownByFullPath(
  "username/sitename/docs/hello",
  "# Updated\n\nEdited by the browser client."
);

const markdown = await sdk.getMarkdownByFullPath("username/sitename/docs/hello");
console.log(markdown);
```

### Read raw content from a URL

```js
const raw = await sdk.getRawPage(
  "https://keepwork.com/username/sitename/docs/hello.md",
  true
);

console.log(raw);
```

## Site APIs

Useful methods for working with Keepwork sites include:

- `createSite(siteData)`
- `getAllSites()`
- `getSitesByUsername(username)`
- `getSiteDetail(siteId)`
- `getSiteTree(sitePath, recursive?)`

### Example: create a site and inspect its tree

```js
const site = await sdk.createSite({
  name: "my-demo-site",
  title: "My Demo Site",
  visibility: "public",
});

const tree = await sdk.getSiteTree("username/my-demo-site", true);
console.log(tree);
```

## Low-level request helper

If you need an authenticated request that still benefits from the SDK's retry and header handling, use `sdk.request(...)`.

```js
const result = await sdk.request(`${sdk.baseURL}/users/profile`, {
  method: "GET",
});

console.log(result);
```

Prefer the higher-level methods where possible, but `request()` is useful for endpoints that do not yet have a dedicated wrapper.

## Related modules created by `KeepworkSDK`

The core SDK also initializes these services for you:

- `sdk.personalPageStore`
- `sdk.remoteLog`
- `sdk.speech`
- `sdk.copilotTools`
- `sdk.aiChat`
- `sdk.wxLaunchApp`
- `sdk.wxAuth`
- `sdk.loginWindow`
- `sdk.agentRouter` (lazy singleton per window)

The next docs to read are:

- [personal-page-store.md](./personal-page-store.md)
- [ai-tools.md](./ai-tools.md)
- [integrations-and-utilities.md](./integrations-and-utilities.md)

## Complete examples

- [`testKeepworkSDK.html`](../test/testKeepworkSDK.html) - end-to-end UI for auth, pages, user helpers, and related modules

