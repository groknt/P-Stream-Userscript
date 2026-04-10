// ==UserScript==
// @name         P-Stream Userscript
// @namespace    groknt
// @version      1.5.0
// @description  A P-Stream compatible userscript
// @author       groknt
// @license      MIT
// @match        *://pstream.net/*
// @match        *://aether.mom/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      *
// @updateURL    https://raw.githubusercontent.com/groknt/P-Stream-Userscript/main/p-stream.user.js
// @downloadURL  https://raw.githubusercontent.com/groknt/P-Stream-Userscript/main/p-stream.user.js
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "1.5.0";
  const LOG_PREFIX = "P-Stream:";

  const CORS_HEADERS = Object.freeze({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "access-control-allow-headers": "*",
  });

  const MODIFIABLE_HEADERS = new Set([
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "content-security-policy",
    "content-security-policy-report-only",
    "content-disposition",
  ]);

  const STREAMING_EXTENSIONS_RE = /\.(m3u8|mpd)(?:\?|$)/i;
  const STREAMING_MIME_TYPES = ["mpegurl", "dash+xml"];

  const XHR_STATES = Object.freeze({
    UNSENT: 0,
    OPENED: 1,
    HEADERS_RECEIVED: 2,
    LOADING: 3,
    DONE: 4,
  });

  const XHR_EVENT_TYPES = [
    "readystatechange",
    "load",
    "error",
    "timeout",
    "abort",
    "loadend",
    "progress",
    "loadstart",
  ];

  const PROGRESS_EVENT_TYPES = new Set([
    "load",
    "error",
    "timeout",
    "abort",
    "loadend",
    "progress",
    "loadstart",
  ]);

  const globalContext =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  const gmXmlHttpRequest =
    typeof GM_xmlhttpRequest === "function"
      ? GM_xmlhttpRequest
      : typeof GM?.xmlHttpRequest === "function"
        ? GM.xmlHttpRequest
        : null;

  if (!gmXmlHttpRequest) {
    console.warn(
      LOG_PREFIX,
      "GM_xmlhttpRequest unavailable — proxy requests will fail",
    );
  }

  const pageOrigin = (() => {
    try {
      const { origin, href } = globalContext.location;
      return origin !== "null" ? origin : new URL(href).origin;
    } catch {
      return "*";
    }
  })();

  const proxyRules = new Map();
  const blobUrlRegistry = new Set();
  const proxyCache = new Map();
  const regexCache = new Map();
  const patchStatus = { fetch: false, xhr: false, media: false };

  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  function normalizeUrl(input, base) {
    if (!input) return null;
    try {
      return new URL(input, base || globalContext.location.href).href;
    } catch {
      return null;
    }
  }

  function parseUrl(input) {
    if (!input) return null;
    try {
      return new URL(input, globalContext.location.href);
    } catch {
      return null;
    }
  }

  function isSameOrigin(url) {
    try {
      return new URL(url).origin === pageOrigin;
    } catch {
      return false;
    }
  }

  function buildUrl(url, options = {}) {
    const { baseUrl, query } = options;

    let fullUrl;
    if (/^https?:\/\//i.test(url)) {
      fullUrl = url;
    } else if (baseUrl) {
      const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const path = url.startsWith("/") ? url.slice(1) : url;
      fullUrl = `${base}${path}`;
    } else {
      fullUrl = url;
    }

    if (!/^https?:\/\//i.test(fullUrl)) {
      throw new Error(`Invalid URL scheme: ${fullUrl}`);
    }

    if (!query || Object.keys(query).length === 0) return fullUrl;

    const parsed = new URL(fullUrl);
    for (const key in query) {
      parsed.searchParams.set(key, query[key]);
    }
    return parsed.href;
  }

  function parseResponseHeaders(raw) {
    const headers = Object.create(null);
    if (!raw) return headers;

    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.indexOf(":");
      if (idx === -1) continue;

      const key = line.slice(0, idx).trim().toLowerCase();
      if (!key) continue;

      const value = line.slice(idx + 1).trim();
      const existing = headers[key];
      headers[key] = existing ? `${existing}, ${value}` : value;
    }
    return headers;
  }

  function buildResponseHeaders(raw, ruleHeaders, includeCredentials) {
    const parsed = parseResponseHeaders(raw);

    for (const key of MODIFIABLE_HEADERS) {
      delete parsed[key];
    }

    if (ruleHeaders) {
      for (const key in ruleHeaders) {
        parsed[key] = ruleHeaders[key];
      }
    }

    parsed["access-control-allow-origin"] =
      includeCredentials ? pageOrigin : "*";
    parsed["access-control-allow-methods"] =
      "GET, POST, PUT, DELETE, PATCH, OPTIONS";
    parsed["access-control-allow-headers"] = "*";

    if (includeCredentials) {
      parsed["access-control-allow-credentials"] = "true";
    }

    return parsed;
  }

  function shouldIncludeCredentials(url, credentialsMode, force) {
    if (force || credentialsMode === "include") return true;
    if (credentialsMode === "omit") return false;
    return isSameOrigin(url);
  }

  function normalizeRequestBody(body) {
    if (body == null) return undefined;
    if (
      typeof body === "string" ||
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body)
    ) {
      return body;
    }
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof body === "object") return JSON.stringify(body);
    return body;
  }

  function deserializeRequestBody(body, bodyType) {
    if (body == null) return undefined;
    switch (bodyType) {
      case "FormData": {
        const fd = new FormData();
        for (const [key, value] of body) {
          fd.append(key, value);
        }
        return fd;
      }
      case "URLSearchParams":
        return new URLSearchParams(body);
      case "object":
        return JSON.stringify(body);
      default:
        return body;
    }
  }

  function executeGmRequest(options) {
    return new Promise((resolve, reject) => {
      if (!gmXmlHttpRequest) {
        reject(new Error("GM_xmlhttpRequest unavailable"));
        return;
      }

      gmXmlHttpRequest({
        ...options,
        onload: resolve,
        onerror: (err) =>
          reject(new Error(err?.error || err?.message || "Network error")),
        ontimeout: () => reject(new Error("Request timeout")),
      });
    });
  }

  function responseToArrayBuffer(response) {
    if (response.response instanceof ArrayBuffer) {
      return response.response;
    }
    const encoded = textEncoder.encode(response.responseText || "");
    return encoded.buffer.byteLength === encoded.byteLength
      ? encoded.buffer
      : encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength,
        );
  }

  function getCompiledRegex(pattern) {
    let cached = regexCache.get(pattern);
    if (cached !== undefined) return cached;
    try {
      cached = new RegExp(pattern);
    } catch {
      cached = null;
    }
    regexCache.set(pattern, cached);
    return cached;
  }

  function findMatchingRule(url) {
    const parsed = parseUrl(url);
    if (!parsed) return null;

    const { href, hostname } = parsed;

    for (const rule of proxyRules.values()) {
      const domains = rule.targetDomains;
      if (domains && domains.length > 0) {
        for (let i = 0; i < domains.length; i++) {
          const d = domains[i];
          if (hostname === d || hostname.endsWith(`.${d}`)) return rule;
        }
      }

      if (rule.targetRegex) {
        const regex = getCompiledRegex(rule.targetRegex);
        if (regex && regex.test(href)) return rule;
      }
    }

    return null;
  }

  function isStreamingContent(contentType, url) {
    if (STREAMING_EXTENSIONS_RE.test(url)) return true;
    for (let i = 0; i < STREAMING_MIME_TYPES.length; i++) {
      if (contentType.includes(STREAMING_MIME_TYPES[i])) return true;
    }
    return false;
  }

  function createBlobUrl(data, contentType) {
    const url = URL.createObjectURL(
      new Blob([data], { type: contentType || "application/octet-stream" }),
    );
    blobUrlRegistry.add(url);
    return url;
  }

  function cleanupStreamData() {
    for (const url of blobUrlRegistry) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    blobUrlRegistry.clear();
    proxyCache.clear();
  }

  function createXhrEvent(type, loaded, total) {
    if (PROGRESS_EVENT_TYPES.has(type)) {
      return new ProgressEvent(type, {
        lengthComputable: total > 0,
        loaded: loaded || 0,
        total: total || 0,
      });
    }
    return new Event(type);
  }

  function proxyMediaSource(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return Promise.resolve(null);

    const rule = findMatchingRule(normalized);
    if (!rule) return Promise.resolve(null);

    const cached = proxyCache.get(normalized);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const response = await executeGmRequest({
          url: normalized,
          method: "GET",
          headers: rule.requestHeaders,
          responseType: "arraybuffer",
          withCredentials: true,
        });

        const contentType =
          parseResponseHeaders(response.responseHeaders)["content-type"] || "";
        if (isStreamingContent(contentType, normalized)) return null;

        return createBlobUrl(responseToArrayBuffer(response), contentType);
      } catch (err) {
        console.warn(LOG_PREFIX, "Media proxy failed:", err.message);
        return null;
      } finally {
        setTimeout(() => proxyCache.delete(normalized), 1000);
      }
    })();

    proxyCache.set(normalized, promise);
    return promise;
  }

  function patchFetch() {
    if (patchStatus.fetch) return;
    patchStatus.fetch = true;

    const nativeFetch = globalContext.fetch.bind(globalContext);

    globalContext.fetch = async function (input, init = {}) {
      const url = normalizeUrl(typeof input === "string" ? input : input?.url);
      const rule = url && findMatchingRule(url);
      if (!rule) return nativeFetch(input, init);

      const headers = {
        ...rule.requestHeaders,
        ...(init.headers instanceof Headers
          ? Object.fromEntries(init.headers)
          : init.headers),
      };
      const includeCreds = shouldIncludeCredentials(url, init.credentials);

      try {
        const response = await executeGmRequest({
          url,
          method: init.method || "GET",
          headers,
          data: normalizeRequestBody(init.body),
          responseType: "arraybuffer",
          withCredentials: includeCreds,
        });

        return new Response(responseToArrayBuffer(response), {
          status: response.status,
          statusText: response.statusText || "",
          headers: buildResponseHeaders(
            response.responseHeaders,
            rule.responseHeaders,
            includeCreds,
          ),
        });
      } catch (err) {
        console.warn(LOG_PREFIX, "Fetch proxy failed:", err.message);
        return nativeFetch(input, init);
      }
    };
  }

  function patchXhr() {
    if (patchStatus.xhr) return;
    patchStatus.xhr = true;

    const NativeXHR = globalContext.XMLHttpRequest;

    class ProxyXMLHttpRequest {
      constructor() {
        this._native = new NativeXHR();
        this._useNative = true;
        this._listeners = new Map();
        this._reqHeaders = {};
        this._resHeaders = null;
        this._rule = null;
        this._url = "";
        this._method = "GET";
        this._aborted = false;
        this._timeoutId = null;
        this._mimeOverride = "";
        this._nativeBound = false;

        this.readyState = 0;
        this.status = 0;
        this.statusText = "";
        this.response = null;
        this.responseText = "";
        this.responseURL = "";
        this.responseType = "";
        this.withCredentials = false;
        this.timeout = 0;
        this.upload = this._native.upload;

        this.onreadystatechange = null;
        this.onload = null;
        this.onerror = null;
        this.ontimeout = null;
        this.onabort = null;
        this.onloadend = null;
        this.onprogress = null;
        this.onloadstart = null;
      }

      _emit(type, event) {
        if (!event) event = createXhrEvent(type);

        const handler = this[`on${type}`];
        if (handler) {
          try {
            handler.call(this, event);
          } catch (e) {
            console.error(LOG_PREFIX, "XHR handler error:", e);
          }
        }

        const list = this._listeners.get(type);
        if (list && list.length > 0) {
          const snapshot = list.slice();
          for (let i = 0; i < snapshot.length; i++) {
            try {
              snapshot[i].call(this, event);
            } catch (e) {
              console.error(LOG_PREFIX, "XHR listener error:", e);
            }
          }
        }
      }

      _syncNative() {
        if (!this._useNative) return;
        try {
          this.readyState = this._native.readyState;
          if (this.readyState >= 2) {
            this.status = this._native.status;
            this.statusText = this._native.statusText;
          }
          if (this.readyState >= 3) {
            this.response = this._native.response;
          }
          if (this.readyState === 4) {
            this.responseURL = this._native.responseURL;
            const rt = this._native.responseType;
            if (!rt || rt === "text") {
              this.responseText = this._native.responseText;
            }
          }
        } catch {}
      }

      _bindNative() {
        if (this._nativeBound) return;
        this._nativeBound = true;

        const self = this;
        for (let i = 0; i < XHR_EVENT_TYPES.length; i++) {
          const type = XHR_EVENT_TYPES[i];
          this._native.addEventListener(type, function (event) {
            self._syncNative();
            self._emit(type, event);
          });
        }
      }

      _applyResponse(buffer) {
        const contentType =
          this.getResponseHeader("content-type") ||
          this._mimeOverride ||
          "application/octet-stream";

        switch (this.responseType) {
          case "arraybuffer":
            this.response = buffer;
            break;

          case "blob":
            this.response = new Blob([buffer], { type: contentType });
            break;

          case "json": {
            const text = textDecoder.decode(buffer);
            this.responseText = text;
            try {
              this.response = JSON.parse(text);
            } catch {
              this.response = null;
            }
            break;
          }

          case "document": {
            const text = textDecoder.decode(buffer);
            this.responseText = text;
            try {
              const mime = contentType.includes("xml")
                ? "application/xml"
                : "text/html";
              this.response = new DOMParser().parseFromString(text, mime);
            } catch {
              this.response = null;
            }
            break;
          }

          default: {
            const text = textDecoder.decode(buffer);
            this.response = text;
            this.responseText = text;
          }
        }
      }

      addEventListener(type, callback) {
        let list = this._listeners.get(type);
        if (!list) {
          list = [];
          this._listeners.set(type, []);
        }
        this._listeners.get(type).push(callback);
      }

      removeEventListener(type, callback) {
        const list = this._listeners.get(type);
        if (!list) return;
        const idx = list.indexOf(callback);
        if (idx !== -1) list.splice(idx, 1);
      }

      dispatchEvent(event) {
        if (this._useNative && this._nativeBound) {
          return this._native.dispatchEvent(event);
        }
        this._emit(event.type, event);
        return !event.defaultPrevented;
      }

      open(method, url, async, username, password) {
        this._method = method;
        this._url = normalizeUrl(url) || url;
        this._rule = findMatchingRule(this._url);
        this._useNative = !this._rule;
        this._aborted = false;
        this._reqHeaders = {};

        if (this._useNative) {
          this._native.open(
            method,
            url,
            async !== undefined ? async : true,
            username,
            password,
          );
          this.readyState = this._native.readyState;
          return;
        }

        this.readyState = 1;
        this._emit("readystatechange");
      }

      setRequestHeader(name, value) {
        if (this._useNative) {
          return this._native.setRequestHeader(name, value);
        }
        this._reqHeaders[name] = value;
      }

      getResponseHeader(name) {
        if (this._useNative) {
          return this._native.getResponseHeader(name);
        }
        if (!this._resHeaders) return null;
        return this._resHeaders[name?.toLowerCase()] ?? null;
      }

      getAllResponseHeaders() {
        if (this._useNative) {
          return this._native.getAllResponseHeaders();
        }
        if (!this._resHeaders) return "";
        const h = this._resHeaders;
        const keys = Object.keys(h);
        const parts = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
          parts[i] = `${keys[i]}: ${h[keys[i]]}`;
        }
        return parts.join("\r\n");
      }

      overrideMimeType(mime) {
        if (this._useNative) {
          return this._native.overrideMimeType(mime);
        }
        this._mimeOverride = mime;
      }

      abort() {
        if (this._useNative) {
          return this._native.abort();
        }

        if (this._timeoutId) {
          clearTimeout(this._timeoutId);
          this._timeoutId = null;
        }

        this._aborted = true;
        this.readyState = 0;
        this._emit("abort");
      }

      async send(body) {
        if (this._useNative) {
          this._native.withCredentials = this.withCredentials;
          this._native.responseType = this.responseType;
          this._native.timeout = this.timeout;
          this._bindNative();
          return this._native.send(body === undefined ? null : body);
        }

        const { _rule: rule, _url: url, _method: method } = this;
        const headers = { ...rule.requestHeaders, ...this._reqHeaders };
        const includeCreds = shouldIncludeCredentials(
          url,
          this.withCredentials ? "include" : undefined,
          this.withCredentials,
        );
        const wantBinary =
          this.responseType === "arraybuffer" || this.responseType === "blob";

        const reqPromise = executeGmRequest({
          url,
          method,
          headers,
          data: normalizeRequestBody(body === undefined ? null : body),
          responseType: wantBinary ? "arraybuffer" : "text",
          withCredentials: includeCreds,
        });

        let timeoutPromise;
        if (this.timeout > 0) {
          timeoutPromise = new Promise((_, reject) => {
            this._timeoutId = setTimeout(
              () => reject(new Error("timeout")),
              this.timeout,
            );
          });
        }

        this._emit("loadstart");

        try {
          const response = await (timeoutPromise
            ? Promise.race([reqPromise, timeoutPromise])
            : reqPromise);

          if (this._timeoutId) {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
          }
          if (this._aborted) return;

          this._resHeaders = buildResponseHeaders(
            response.responseHeaders,
            rule.responseHeaders,
            includeCreds,
          );
          this.responseURL = response.finalUrl || url;
          this.status = response.status;
          this.statusText = response.statusText || "";

          const buffer = responseToArrayBuffer(response);
          const size = buffer.byteLength;

          this.readyState = 2;
          this._emit("readystatechange");

          this.readyState = 3;
          this._emit("readystatechange");
          this._emit("progress", createXhrEvent("progress", size, size));

          this._applyResponse(buffer);

          this.readyState = 4;
          this._emit("readystatechange");
          this._emit("load", createXhrEvent("load", size, size));
          this._emit("loadend", createXhrEvent("loadend", size, size));
        } catch (err) {
          if (this._timeoutId) {
            clearTimeout(this._timeoutId);
            this._timeoutId = null;
          }
          if (this._aborted) return;

          this.status = 0;
          this.statusText = err.message || "";
          this.readyState = 4;

          const type = err.message === "timeout" ? "timeout" : "error";
          this._emit("readystatechange");
          this._emit(type);
          this._emit("loadend");
        }
      }
    }

    Object.assign(ProxyXMLHttpRequest, XHR_STATES);
    Object.assign(ProxyXMLHttpRequest.prototype, XHR_STATES);
    globalContext.XMLHttpRequest = ProxyXMLHttpRequest;
  }

  function patchMediaElements() {
    if (patchStatus.media) return;
    patchStatus.media = true;

    const proto = globalContext.HTMLMediaElement.prototype;
    const srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
    const nativeSetAttr = proto.setAttribute;

    if (srcDesc?.set) {
      const originalSet = srcDesc.set;

      Object.defineProperty(proto, "src", {
        ...srcDesc,
        set(value) {
          if (typeof value !== "string") {
            originalSet.call(this, value);
            return;
          }

          const normalized = normalizeUrl(value);
          if (!normalized) {
            originalSet.call(this, value);
            return;
          }

          originalSet.call(this, value);
          const el = this;

          proxyMediaSource(value)
            .then((proxied) => {
              if (proxied && el.src === normalized) {
                originalSet.call(el, proxied);
              }
            })
            .catch(() => {});
        },
      });
    }

    proto.setAttribute = function (name, value) {
      if (name?.toLowerCase() !== "src" || typeof value !== "string") {
        return nativeSetAttr.call(this, name, value);
      }

      const normalized = normalizeUrl(value);
      if (!normalized) {
        return nativeSetAttr.call(this, "src", value);
      }

      nativeSetAttr.call(this, "src", value);
      const el = this;

      proxyMediaSource(value)
        .then((proxied) => {
          if (proxied && el.src === normalized) {
            nativeSetAttr.call(el, "src", proxied);
          }
        })
        .catch(() => {});
    };

    globalContext.addEventListener("beforeunload", cleanupStreamData);
  }

  function installProxies() {
    patchFetch();
    patchXhr();
    patchMediaElements();
  }

  const messageHandlers = {
    hello() {
      return {
        success: true,
        version: VERSION,
        allowed: true,
        hasPermission: true,
      };
    },

    async makeRequest(body) {
      if (!body) throw new Error("Missing request body");

      const url = buildUrl(body.url, body);
      const includeCreds = shouldIncludeCredentials(
        url,
        body.credentials,
        body.withCredentials,
      );

      const response = await executeGmRequest({
        url,
        method: body.method || "GET",
        headers: body.headers,
        data: deserializeRequestBody(body.body, body.bodyType),
        responseType: "arraybuffer",
        withCredentials: includeCreds,
      });

      const headers = buildResponseHeaders(
        response.responseHeaders,
        null,
        includeCreds,
      );
      const text = textDecoder.decode(responseToArrayBuffer(response));
      const contentType = headers["content-type"] || "";

      let parsedBody = text;
      if (contentType.includes("application/json")) {
        try {
          parsedBody = JSON.parse(text);
        } catch {}
      }

      return {
        success: true,
        response: {
          statusCode: response.status,
          headers,
          finalUrl: response.finalUrl || url,
          body: parsedBody,
        },
      };
    },

    async prepareStream(body) {
      if (!body) throw new Error("Missing request body");

      cleanupStreamData();

      const existing = proxyRules.get(body.ruleId);
      if (existing?.targetRegex) {
        regexCache.delete(existing.targetRegex);
      }

      const responseHeaders = {};
      if (body.responseHeaders) {
        const src = body.responseHeaders;
        const keys = Object.keys(src);
        for (let i = 0; i < keys.length; i++) {
          const lower = keys[i].toLowerCase();
          if (MODIFIABLE_HEADERS.has(lower)) {
            responseHeaders[lower] = src[keys[i]];
          }
        }
      }

      proxyRules.set(body.ruleId, { ...body, responseHeaders });
      installProxies();

      return { success: true };
    },

    openPage(body) {
      if (body?.redirectUrl) {
        globalContext.location.href = body.redirectUrl;
      }
      return { success: true };
    },
  };

  function setupMessageRelay(name, handler) {
    globalContext.addEventListener("message", async (event) => {
      const data = event.data;
      if (
        event.source !== globalContext ||
        data?.name !== name ||
        data?.relayed
      ) {
        return;
      }

      const { instanceId, body } = data;

      try {
        const result = await handler(body);
        globalContext.postMessage(
          { name, instanceId, body: result, relayed: true },
          "/",
        );
      } catch (err) {
        console.error(LOG_PREFIX, `${name} handler failed:`, err.message);
        globalContext.postMessage(
          {
            name,
            instanceId,
            body: { success: false, error: err.message || String(err) },
            relayed: true,
          },
          "/",
        );
      }
    });
  }

  const handlerNames = Object.keys(messageHandlers);
  for (let i = 0; i < handlerNames.length; i++) {
    const name = handlerNames[i];
    setupMessageRelay(name, messageHandlers[name]);
  }
})();
