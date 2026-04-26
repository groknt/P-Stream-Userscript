// ==UserScript==
// @name         P-Stream Userscript
// @namespace    groknt
// @version      2.0.2
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

(function (GM) {
  "use strict";

  const CONFIG = {
    extensionVersion: "1.5.0",
    logPrefix: "P-Stream:",
    maxMediaSize: {
      enabled: false,
      value: 100 * 1024 * 1024,
    },
  };

  if (!GM) console.warn(`${CONFIG.logPrefix} GM_xmlhttpRequest missing - proxy will fail`);

  const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const sharedDecoder = new TextDecoder();

  const pageOrigin = win.location.origin !== "null" ? win.location.origin : new URL(win.location.href).origin || "*";
  const rules = new Map();
  const mediaBlobs = new WeakMap();
  const activeMediaReqs = new WeakMap();
  let patchStatus = false;

  const RE_STREAM_MANIFEST = /\.(m3u8|mpd|ism|isml)([\?\/#]|$)/i;
  const RE_STREAM_MEDIA = /\.(mp4|m4v|m4a|webm|mkv|mov|avi|wmv|mp3|ogg|ogv|flac|wav)([\?\/#]|$)/i;
  const RE_CONTENT_MEDIA = /video|audio/i;

  const MODIFIABLE_HEADERS = new Set([
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "content-security-policy",
    "content-security-policy-report-only",
    "content-disposition",
  ]);

  const normalizeUrl = (url) => {
    try {
      return new URL(url, win.location.href).href;
    } catch {
      return String(url);
    }
  };

  const getRule = (url) => {
    if (!url) return null;
    let u;
    try {
      u = new URL(url, win.location.href);
    } catch {
      return null;
    }

    const hostname = u.hostname;
    const href = u.href;

    for (const rule of rules.values()) {
      if (rule.targetDomains) {
        for (let i = 0; i < rule.targetDomains.length; i++) {
          const d = rule.targetDomains[i];
          if (hostname === d || hostname.endsWith(`.${d}`)) return rule;
        }
      }
      if (rule._compiledRegex && rule._compiledRegex.test(href)) return rule;
    }
    return null;
  };

  const parseHeaders = (raw) => {
    const h = new Headers();
    if (!raw) return h;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf(":");
      if (idx > 0) h.append(lines[i].slice(0, idx).trim(), lines[i].slice(idx + 1).trim());
    }
    return h;
  };

  const shouldIncludeCredentials = (url, mode, force) => {
    if (force || mode === "include") return true;
    if (mode === "omit") return false;
    try {
      return new URL(url).origin === pageOrigin;
    } catch {
      return false;
    }
  };

  const isMediaStream = (url, headersObj) => {
    if (RE_STREAM_MANIFEST.test(url)) return false;

    for (const k in headersObj) {
      if (k.toLowerCase() === "range" && headersObj[k].startsWith("bytes=")) return false;
    }

    if (RE_STREAM_MEDIA.test(url)) return true;

    return false;
  };

  const gmFetch = (opts) =>
    new Promise((resolve, reject) => {
      opts.headers = opts.headers || {};
      let hasReferer = false;
      let hasOrigin = false;

      for (const k in opts.headers) {
        const lowerK = k.toLowerCase();
        if (lowerK === "referer") hasReferer = true;
        if (lowerK === "origin") hasOrigin = true;
      }

      if (!hasReferer) opts.headers["Referer"] = win.location.href;
      if (!hasOrigin) opts.headers["Origin"] = pageOrigin;

      const { signal, ...gmOpts } = opts;
      let req;
      let abortHandler;

      const cleanup = () => {
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        req = null;
      };

      if (signal && signal.aborted) {
        return reject(new Error("Aborted"));
      }

      req = GM({
        ...gmOpts,
        onload: (res) => {
          cleanup();
          resolve(res);
        },
        onerror: (e) => {
          cleanup();
          reject(new Error(e?.error || e?.message || "Network Error"));
        },
        ontimeout: () => {
          cleanup();
          reject(new Error("Timeout"));
        },
        onabort: () => {
          cleanup();
          reject(new Error("Aborted"));
        },
      });

      if (signal) {
        abortHandler = () => {
          if (req && typeof req.abort === "function") req.abort();
          cleanup();
          reject(new Error("Aborted"));
        };
        signal.addEventListener("abort", abortHandler);
      }
    });

  const patchFetch = () => {
    const origFetch = win.fetch;
    win.fetch = async (input, init = {}) => {
      const isReq = typeof input === "object" && input instanceof Request;
      const rawUrl = isReq ? input.url : input instanceof URL ? input.href : String(input);
      const urlStr = normalizeUrl(rawUrl);
      const rule = getRule(urlStr);

      if (!rule) return origFetch(input, init);

      const method = init.method || (isReq ? input.method : "GET");
      const reqHeaders = new Headers();

      if (isReq && input.headers) {
        input.headers.forEach((v, k) => reqHeaders.set(k, v));
      }
      if (init.headers) {
        new Headers(init.headers).forEach((v, k) => reqHeaders.set(k, v));
      }

      if (rule.requestHeaders) {
        for (const k in rule.requestHeaders) reqHeaders.set(k, rule.requestHeaders[k]);
      }

      const gmHeaders = Object.fromEntries(reqHeaders.entries());
      if (isMediaStream(urlStr, gmHeaders)) return origFetch(input, { ...init, headers: gmHeaders });

      let body = init.body;
      if (body !== undefined && typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
        try {
          body = await new Response(body).arrayBuffer();
        } catch {}
      } else if (body === undefined && isReq && method !== "GET" && method !== "HEAD") {
        try {
          body = await input.clone().arrayBuffer();
        } catch {}
      }

      const credMode = init.credentials || (isReq ? input.credentials : undefined);

      try {
        const res = await gmFetch({
          method,
          url: urlStr,
          headers: gmHeaders,
          data: body,
          responseType: "arraybuffer",
          withCredentials: shouldIncludeCredentials(urlStr, credMode),
          signal: init.signal || (isReq ? input.signal : undefined),
        });

        const resHeaders = new Headers();
        const parsedResHeaders = parseHeaders(res.responseHeaders);
        parsedResHeaders.forEach((v, k) => {
          if (!MODIFIABLE_HEADERS.has(k)) resHeaders.set(k, v);
        });

        if (rule.responseHeaders) {
          for (const k in rule.responseHeaders) resHeaders.set(k, rule.responseHeaders[k]);
        }
        resHeaders.set("access-control-allow-origin", "*");

        return new Response(res.response, { status: res.status, statusText: res.statusText, headers: resHeaders });
      } catch (e) {
        if (e.message !== "Aborted") console.warn(`${CONFIG.logPrefix} Fetch proxy failed`, e);
        return origFetch(input, init);
      }
    };
  };

  const patchXhr = () => {
    const OrigXHR = win.XMLHttpRequest;
    win.XMLHttpRequest = class XhrProxy extends OrigXHR {
      constructor() {
        super();
        this._st = null;
      }
      open(method, url, ...args) {
        const urlStr = normalizeUrl(url instanceof URL ? url.href : String(url));
        const rule = getRule(urlStr);
        if (rule) {
          this._st = {
            rule,
            method,
            url: urlStr,
            reqHeaders: {},
            resHeaders: new Headers(),
            readyState: 1,
            status: 0,
            statusText: "",
            response: null,
            responseText: "",
            responseURL: urlStr,
            controller: new AbortController(),
          };
          this.dispatchEvent(new Event("readystatechange"));
        } else {
          this._st = null;
          super.open(method, url, ...args);
        }
      }
      setRequestHeader(name, value) {
        if (this._st) this._st.reqHeaders[name] = value;
        else super.setRequestHeader(name, value);
      }
      abort() {
        if (this._st) {
          this._st.controller.abort();
          if (this._st.readyState > 0 && this._st.readyState < 4) {
            this._st.readyState = 0;
            this._st.status = 0;
            this.dispatchEvent(new Event("readystatechange"));
            this.dispatchEvent(new Event("abort"));
            this.dispatchEvent(new ProgressEvent("loadend", { lengthComputable: false, loaded: 0, total: 0 }));
          }
        }
        super.abort();
      }
      send(body) {
        if (!this._st) return super.send(body);

        const mergedHeaders = { ...this._st.rule.requestHeaders, ...this._st.reqHeaders };
        if (isMediaStream(this._st.url, mergedHeaders)) {
          this._st = null;
          return super.send(body);
        }

        const isBinary = this.responseType === "arraybuffer" || this.responseType === "blob";

        gmFetch({
          method: this._st.method,
          url: this._st.url,
          headers: mergedHeaders,
          data: body,
          responseType: isBinary ? "arraybuffer" : "text",
          timeout: this.timeout,
          withCredentials: shouldIncludeCredentials(this._st.url, this.withCredentials ? "include" : undefined, this.withCredentials),
          signal: this._st.controller.signal,
        })
          .then((res) => {
            if (!this._st || this._st.controller.signal.aborted) return;

            const st = this._st;
            st.resHeaders = parseHeaders(res.responseHeaders);
            st.status = res.status;
            st.statusText = res.statusText || "OK";
            st.responseURL = res.finalUrl || st.url;

            let data = res.response;
            if (this.responseType === "json") {
              try {
                data = JSON.parse(res.responseText);
              } catch {
                data = null;
              }
            } else if (this.responseType === "blob") {
              data = new Blob([res.response], { type: st.resHeaders.get("content-type") || "" });
            } else if (!isBinary) {
              data = res.responseText;
              st.responseText = data;
            }
            st.response = data;

            st.readyState = 2;
            this.dispatchEvent(new Event("readystatechange"));
            if (!this._st || this._st.readyState !== 2) return;

            st.readyState = 3;
            this.dispatchEvent(new Event("readystatechange"));
            if (!this._st || this._st.readyState !== 3) return;

            this.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded: 1, total: 1 }));
            if (!this._st) return;

            st.readyState = 4;
            this.dispatchEvent(new Event("readystatechange"));
            this.dispatchEvent(new ProgressEvent("load", { lengthComputable: true, loaded: 1, total: 1 }));
            this.dispatchEvent(new ProgressEvent("loadend", { lengthComputable: true, loaded: 1, total: 1 }));
          })
          .catch((err) => {
            if (this._st && this._st.controller.signal.aborted) return;
            if (this._st) {
              this._st.readyState = 4;
              this._st.status = 0;
              this._st.statusText = "";
            }
            this.dispatchEvent(new Event("readystatechange"));
            this.dispatchEvent(new Event("error"));
            this.dispatchEvent(new ProgressEvent("loadend", { lengthComputable: false, loaded: 0, total: 0 }));
          });
      }

      get readyState() {
        return this._st ? this._st.readyState : super.readyState;
      }
      get status() {
        return this._st ? this._st.status : super.status;
      }
      get statusText() {
        return this._st ? this._st.statusText : super.statusText;
      }
      get response() {
        return this._st ? this._st.response : super.response;
      }
      get responseText() {
        return this._st ? this._st.responseText : super.responseText;
      }
      get responseURL() {
        return this._st ? this._st.responseURL : super.responseURL;
      }
      get responseXML() {
        if (!this._st) return super.responseXML;
        if (this.responseType !== "" && this.responseType !== "document") return null;
        if (this._st.responseXML !== undefined) return this._st.responseXML;
        try {
          const parser = new DOMParser();
          const contentType = this.getResponseHeader("content-type") || "";
          const mime = contentType.includes("xml") ? "application/xml" : "text/html";
          this._st.responseXML = parser.parseFromString(this._st.responseText, mime);
        } catch {
          this._st.responseXML = null;
        }
        return this._st.responseXML;
      }
      getAllResponseHeaders() {
        if (!this._st) return super.getAllResponseHeaders();
        const headers = [];
        this._st.resHeaders.forEach((v, k) => headers.push(`${k}: ${v}`));
        return headers.join("\r\n");
      }
      getResponseHeader(name) {
        if (!this._st) return super.getResponseHeader(name);
        return this._st.resHeaders.get(name);
      }
    };
  };

  const patchMedia = () => {
    const proto = win.HTMLMediaElement.prototype;
    const origSet = Object.getOwnPropertyDescriptor(proto, "src")?.set;
    const origSetAttr = proto.setAttribute;

    const cleanupElement = (el) => {
      if (mediaBlobs.has(el)) {
        URL.revokeObjectURL(mediaBlobs.get(el));
        mediaBlobs.delete(el);
      }
      if (activeMediaReqs.has(el)) {
        activeMediaReqs.get(el).abort();
        activeMediaReqs.delete(el);
      }
    };

    const intercept = async (el, val, setter) => {
      if (mediaBlobs.has(el) && mediaBlobs.get(el) === val) return;

      cleanupElement(el);
      setter.call(el, val);

      const urlStr = normalizeUrl(val);
      const rule = getRule(urlStr);
      if (!rule) return;

      const controller = new AbortController();
      activeMediaReqs.set(el, controller);

      try {
        if (!RE_STREAM_MANIFEST.test(urlStr)) {
          const head = await gmFetch({ method: "HEAD", url: urlStr, headers: rule.requestHeaders, signal: controller.signal });
          const map = parseHeaders(head.responseHeaders);
          const len = parseInt(map.get("content-length") || "0", 10);
          const contentType = map.get("content-type");
          const acceptRanges = map.get("accept-ranges");
          if (
            contentType &&
            RE_CONTENT_MEDIA.test(contentType) &&
            (acceptRanges?.includes("bytes") || (CONFIG.maxMediaSize.enabled && len > CONFIG.maxMediaSize.value) || isNaN(len))
          )
            return;
        }

        const res = await gmFetch({
          method: "GET",
          url: urlStr,
          headers: rule.requestHeaders,
          responseType: "arraybuffer",
          signal: controller.signal,
        });
        if (!res || el.src !== urlStr) return;

        const blob = new Blob([res.response], {
          type: parseHeaders(res.responseHeaders).get("content-type") || "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);

        if (mediaBlobs.has(el)) URL.revokeObjectURL(mediaBlobs.get(el));
        mediaBlobs.set(el, url);
        setter.call(el, url);
      } catch (e) {
        if (e.message !== "Aborted") console.warn(`${CONFIG.logPrefix} Media proxy failed`, e);
      }
    };

    if (origSet) {
      Object.defineProperty(proto, "src", {
        set(v) {
          typeof v === "string" ? intercept(this, v, origSet) : origSet.call(this, v);
        },
      });
    }

    proto.setAttribute = function (n, v) {
      if (n.toLowerCase() === "src" && typeof v === "string") intercept(this, v, (u) => origSetAttr.call(this, "src", u));
      else origSetAttr.call(this, n, v);
    };

    const origRemoveAttr = proto.removeAttribute;
    proto.removeAttribute = function (n) {
      if (n.toLowerCase() === "src") cleanupElement(this);
      origRemoveAttr.call(this, n);
    };

    new MutationObserver((muts) => {
      for (let i = 0; i < muts.length; i++) {
        const removed = muts[i].removedNodes;
        for (let j = 0; j < removed.length; j++) {
          const n = removed[j];
          if (n instanceof HTMLMediaElement) {
            cleanupElement(n);
          } else if (n.nodeType === 1) {
            const children = n.querySelectorAll?.("video, audio");
            if (children) {
              for (let k = 0; k < children.length; k++) {
                cleanupElement(children[k]);
              }
            }
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  };

  const handlers = {
    hello: () => ({
      success: true,
      version: CONFIG.extensionVersion,
      allowed: true,
      hasPermission: true,
    }),

    async makeRequest(body) {
      const url = new URL(body.url, body.baseUrl || win.location.href);
      if (body.query) {
        for (const k in body.query) url.searchParams.set(k, body.query[k]);
      }

      let data = body.body;
      const reqHeaders = { ...body.headers };

      if (body.bodyType === "FormData" && Array.isArray(data)) {
        const fd = new FormData();
        for (let i = 0; i < data.length; i++) fd.append(data[i][0], data[i][1]);
        data = fd;

        const ctKey = Object.keys(reqHeaders).find((k) => k.toLowerCase() === "content-type");
        if (ctKey) delete reqHeaders[ctKey];
      } else if (body.bodyType === "URLSearchParams") {
        data = new URLSearchParams(data);
      } else if (body.bodyType === "object") {
        data = JSON.stringify(data);
      }

      const res = await gmFetch({
        method: body.method || "GET",
        url: url.href,
        headers: reqHeaders,
        data,
        responseType: "arraybuffer",
        withCredentials: shouldIncludeCredentials(url.href, body.credentials, body.withCredentials),
      });

      const h = parseHeaders(res.responseHeaders);
      const headers = {};
      h.forEach((v, k) => (headers[k] = v));

      let resBody = sharedDecoder.decode(res.response);
      if (headers["content-type"]?.includes("json")) {
        try {
          resBody = JSON.parse(resBody);
        } catch {}
      }

      return { success: true, response: { statusCode: res.status, headers, finalUrl: res.finalUrl || url.href, body: resBody } };
    },

    async prepareStream(body) {
      const responseHeaders = {};
      if (body.responseHeaders) {
        for (const k in body.responseHeaders) {
          const lowerK = k.toLowerCase();
          if (MODIFIABLE_HEADERS.has(lowerK)) responseHeaders[lowerK] = body.responseHeaders[k];
        }
      }

      const rule = { ...body, responseHeaders };
      if (rule.targetRegex) {
        try {
          rule._compiledRegex = new RegExp(rule.targetRegex);
        } catch (e) {
          console.warn(`${CONFIG.logPrefix} Invalid rule regex`, rule.targetRegex);
        }
      }
      rules.set(body.ruleId, rule);

      if (!patchStatus) {
        patchFetch();
        patchXhr();
        patchMedia();
        patchStatus = true;
      }
      return { success: true };
    },

    openPage(body) {
      if (body?.redirectUrl) win.location.href = body.redirectUrl;
      return { success: true };
    },
  };

  win.addEventListener("message", async (e) => {
    const data = e.data;
    if (e.source !== win || !data || data.relayed || !handlers[data.name]) return;

    try {
      const result = await handlers[data.name](data.body);
      win.postMessage({ name: data.name, instanceId: data.instanceId, body: result, relayed: true }, pageOrigin);
    } catch (err) {
      win.postMessage(
        { name: data.name, instanceId: data.instanceId, body: { success: false, error: err.message }, relayed: true },
        pageOrigin,
      );
    }
  });
})(typeof GM_xmlhttpRequest !== "undefined" ? GM_xmlhttpRequest : GM?.xmlHttpRequest);
