## P-Stream Userscript

A userscript that proxies network requests through `GM_xmlhttpRequest` to bypass CORS restrictions on P-Stream and related domains. It patches `fetch`, `XMLHttpRequest`, and media element (`<video>`, `<audio>`, `<source>`) attribute setters so that cross-origin stream manifests and media files load transparently - no browser extension needed beyond a userscript manager.

### Requirements

- A userscript manager (e.g. [ScriptCat](https://docs.scriptcat.org/en), [Violentmonkey](https://violentmonkey.github.io), [Tampermonkey](https://www.tampermonkey.net))
- `GM_xmlhttpRequest` grant (enabled automatically by the `@grant` directive)

### Install

[Click here](https://github.com/groknt/P-Stream-Userscript/raw/refs/heads/main/p-stream.user.js) and your userscript manager will prompt you to install.

### What it does

- **CORS proxy**: Intercepts `fetch` and `XHR` requests matching stream manifests (`.m3u8`, `.mpd`, `.ism`) or media files (`.mp4`, `.webm`, `.mkv`, etc.) and routes them through `GM_xmlhttpRequest`, which ignores same-origin policy.
- **Media element patching**: Intercepts `src` / `currentSrc` assignment on `<video>`, `<audio>`, and `<source>` elements, fetches the content via the same proxy, and sets a blob URL so the browser plays it natively.
- **Header stripping**: Removes `content-security-policy` and related headers from proxied responses so embedded content loads without CSP blocking.
