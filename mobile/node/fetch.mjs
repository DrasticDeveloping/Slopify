/*
 * fetch for the iPhone app's Node. Node's own (undici) needs WebAssembly, which
 * nodejs-mobile can't run on iOS, so this one is built on node:http and
 * node:https. It covers what the music server uses: methods, headers, string
 * and byte bodies, redirect "follow" / "manual" / "error", AbortSignal, gzip /
 * deflate / brotli, and responses with ok, status, url, headers (including
 * getSetCookie), a web ReadableStream body, text(), json() and arrayBuffer().
 */
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";
import zlib from "node:zlib";

const MAX_REDIRECTS = 20;

export class Headers {
  #map = new Map();

  constructor(init) {
    if (!init) return;
    const pairs = init instanceof Headers || Array.isArray(init) || typeof init[Symbol.iterator] === "function" ? [...init] : Object.entries(init);
    for (const [name, value] of pairs) this.append(name, value);
  }

  append(name, value) {
    const key = String(name).toLowerCase();
    const list = this.#map.get(key) ?? [];
    list.push(String(value));
    this.#map.set(key, list);
  }

  set(name, value) {
    this.#map.set(String(name).toLowerCase(), [String(value)]);
  }

  get(name) {
    const list = this.#map.get(String(name).toLowerCase());
    return list ? list.join(", ") : null;
  }

  getSetCookie() {
    return [...(this.#map.get("set-cookie") ?? [])];
  }

  has(name) {
    return this.#map.has(String(name).toLowerCase());
  }

  delete(name) {
    this.#map.delete(String(name).toLowerCase());
  }

  forEach(callback, thisArg) {
    for (const [name, value] of this) callback.call(thisArg, value, name, this);
  }

  *entries() {
    for (const name of [...this.#map.keys()].sort()) yield [name, this.get(name)];
  }

  *keys() {
    for (const [name] of this.entries()) yield name;
  }

  *values() {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

class Response {
  #stream;
  #used = false;

  constructor(stream, { status, statusText, headers, url, redirected }) {
    this.#stream = stream;
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.headers = headers;
    this.url = url;
    this.redirected = redirected;
    this.type = "basic";
    this.body = stream ? webStream(stream) : null;
  }

  get bodyUsed() {
    return this.#used;
  }

  async arrayBuffer() {
    const bytes = await this.#bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async text() {
    return (await this.#bytes()).toString("utf8");
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async #bytes() {
    if (this.#used) throw new TypeError("Body has already been used.");
    this.#used = true;
    if (!this.body) return Buffer.alloc(0);
    const chunks = [];
    for await (const chunk of this.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}

/**
 * A web stream reading a Node one. Node 18's Readable.toWeb can throw "Controller
 * is already closed" from an event after the reader cancelled, which nothing can
 * catch and which stops the whole server, so every step here checks first.
 */
function webStream(stream) {
  let open = true;
  const finish = (action) => {
    if (!open) return;
    open = false;
    try {
      action();
    } catch {
      // Already closed by the reader.
    }
  };
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => {
        if (!open) return;
        try {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch {
          open = false;
          stream.destroy();
          return;
        }
        if (controller.desiredSize <= 0) stream.pause();
      });
      stream.on("end", () => finish(() => controller.close()));
      stream.on("error", (error) => finish(() => controller.error(error)));
      stream.on("close", () => finish(() => controller.error(new TypeError("The connection closed before the response finished."))));
      stream.pause();
    },
    pull() {
      stream.resume();
    },
    cancel() {
      open = false;
      stream.destroy();
    },
  }, { highWaterMark: 4, size: () => 1 });
}

const abortError = (signal) => signal.reason ?? new DOMException("This operation was aborted", "AbortError");

function bodyBytes(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("This fetch sends string, URLSearchParams or byte bodies only.");
}

function decoded(res) {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip()
    : encoding === "deflate" ? zlib.createInflate()
    : encoding === "br" ? zlib.createBrotliDecompress()
    : null;
  // pipeline passes a dropped connection on as an error instead of leaving the reader waiting.
  return decoder ? pipeline(res, decoder, () => {}) : res;
}

function request(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!client) return reject(new TypeError(`fetch can't load ${url.protocol} URLs.`));
    const outgoing = {};
    for (const [name, value] of headers) outgoing[name] = value;
    outgoing["accept-encoding"] ??= "gzip, deflate, br";
    if (body) outgoing["content-length"] = String(body.length);
    const req = client.request(url, { method, headers: outgoing });
    const onAbort = () => req.destroy(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("response", (res) => {
      res.on("close", () => signal?.removeEventListener("abort", onAbort));
      resolve(res);
    });
    req.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.aborted ? abortError(signal) : Object.assign(new TypeError("fetch failed"), { cause: error }));
    });
    req.end(body ?? undefined);
  });
}

export async function fetch(input, init = {}) {
  let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  let method = String(init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  let body = bodyBytes(init.body);
  const redirect = init.redirect ?? "follow";
  const signal = init.signal ?? null;
  if (signal?.aborted) throw abortError(signal);

  for (let hops = 0; ; hops++) {
    const res = await request(url, { method, headers, body, signal });
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location && redirect !== "manual") {
      res.resume();
      if (redirect === "error") throw new TypeError(`fetch failed: ${url} redirects, and redirects aren't allowed here.`);
      if (hops >= MAX_REDIRECTS) throw new TypeError("fetch failed: too many redirects.");
      url = new URL(location, url);
      // As browsers do: 303, and 301/302 after a POST, continue as a GET without the body.
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = null;
        headers.delete("content-type");
      }
      continue;
    }
    const responseHeaders = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    const empty = method === "HEAD" || status === 204 || status === 304;
    if (empty) res.resume();
    return new Response(empty ? null : decoded(res), { status, statusText: res.statusMessage ?? "", headers: responseHeaders, url: url.href, redirected: hops > 0 });
  }
}
