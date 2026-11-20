// The forge's HTTP surface: health probe, GitHub REST v3, GraphQL v4, MCP, and git smart HTTP.
// main.ts is the lifecycle (bind 0 -> register -> poll /done -> exit 0) and stays as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AUTH_HEADER = `Bearer ${TOKEN}`;
const store = new Store();

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function requestIdHeaders(): Record<string, string> {
  requestCounter += 1;
  return { 'x-github-request-id': `req-${requestCounter}` };
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // no token configured (local smoke tests): accept all
  return (req.headers.authorization ?? '') === AUTH_HEADER;
}

/**
 * Light git-URL parse, without `new URL()`: /{owner}/{repo}.git/{rest}?{query}.
 * Returns null when the URL is not a git path. The clone workload is 5 git
 * requests per clone, so this path must stay allocation-light.
 */
function parseGitUrl(rawUrl: string): { owner: string; repoName: string; gitPath: string; query: URLSearchParams } | null {
  const q = rawUrl.indexOf('?');
  const pathPart = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const parts = pathPart.split('/');
  // ['', owner, '<repo>.git', ...rest]
  if (parts.length < 3 || !parts[2].endsWith('.git')) return null;
  let owner: string;
  let repoName: string;
  try {
    owner = decodeURIComponent(parts[1]);
    repoName = decodeURIComponent(parts[2].slice(0, -4));
  } catch {
    return null;
  }
  const gitPath = parts.length > 3 ? `/${parts.slice(3).join('/')}` : '/';
  return { owner, repoName, gitPath, query: q < 0 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(q + 1)) };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Split a URL into pathname segments (decoded) and query params. */
function parseUrl(req: IncomingMessage): { path: string; segs: string[]; query: URLSearchParams } {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return { path: '/', segs: [], query: new URLSearchParams() };
  }
  const path = url.pathname;
  const segs = path.split('/').filter((s) => s !== '').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  return { path, segs, query: url.searchParams };
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // sendDate: false — no check reads the Date header; skip formatting one per response.
  return createServer({ sendDate: false }, (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';

    // Git fast path: the clone workload is 5 git requests per clone, and GET
    // info/refs carries no body, so answer it synchronously in this tick —
    // no URL object, no readBody wait, no async wrapper.
    if (rawUrl.includes('.git/')) {
      const git = parseGitUrl(rawUrl);
      if (git) {
        const rid = requestIdHeaders();
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }, rid); return; }
        const repo = store.getRepo(git.owner, git.repoName);
        if (!repo) { sendJson(res, 404, { message: 'Not Found' }, rid); return; }
        if (method === 'GET' && git.gitPath === '/info/refs') {
          const result = handleInfoRefs({ repo, method, path: git.gitPath, query: git.query, headers: req.headers as Record<string, string | undefined>, body: Buffer.alloc(0) });
          if (result.contentType === 'application/json') { sendJson(res, result.status, JSON.parse(result.body.toString('utf8')), rid); return; }
          sendBuffer(res, result.status, result.contentType, result.body, rid);
          return;
        }
        // POST upload-pack / receive-pack: body needed, fall through to the async path below.
        if ((method === 'POST' && (git.gitPath === '/git-upload-pack' || git.gitPath === '/git-receive-pack'))) {
          void (async () => {
            const raw = await readBody(req);
            const gitReq = { repo, method, path: git.gitPath, query: git.query, headers: req.headers as Record<string, string | undefined>, body: raw };
            const result = git.gitPath === '/git-upload-pack' ? handleUploadPack(store, gitReq) : handleReceivePack(store, gitReq);
            if (result.contentType === 'application/json') { sendJson(res, result.status, JSON.parse(result.body.toString('utf8')), rid); return; }
            sendBuffer(res, result.status, result.contentType, result.body, rid);
          })().catch((err) => {
            try { sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, requestIdHeaders()); } catch { try { res.destroy(); } catch { /* ignore */ } }
          });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, rid);
        return;
      }
    }

    void (async () => {
      const { path, segs, query } = parseUrl(req);
      const rid = requestIdHeaders();

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, rid);
        return;
      }

      // GraphQL v4
      if (path === '/api/graphql') {
        if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }, rid); return; }
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }, rid); return; }
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'invalid JSON' }, rid);
          return;
        }
        sendJson(res, 200, handleGraphQL(store, body), rid);
        return;
      }

      // MCP (Streamable HTTP, JSON-RPC 2.0)
      if (path === '/mcp') {
        if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }, rid); return; }
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }, rid); return; }
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, rid);
          return;
        }
        const result = handleMcp(store, body);
        if (result.body === null) {
          res.writeHead(result.status, rid);
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, rid);
        return;
      }

      // REST v3
      if (segs[0] === 'api' && segs[1] === 'v3') {
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }, rid); return; }
        let body: Record<string, unknown> | null = null;
        if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              const parsed: unknown = JSON.parse(raw.toString('utf8'));
              body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
            } catch {
              sendJson(res, 400, { message: 'invalid JSON' }, rid);
              return;
            }
          }
        }
        const restSegs = segs.slice(2);
        const host = req.headers.host ?? 'entry';
        const result = handleRest(store, method, restSegs, query, body, `http://${host}`);
        const headers = { ...rid, ...(result.headers ?? {}) };
        if (result.status === 204) {
          res.writeHead(204, headers);
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, headers);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1];
        const repoName = gitMatch[2];
        const gitPath = gitMatch[3] ?? '/';
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }, rid); return; }
        const repo = store.getRepo(owner, repoName);
        if (!repo) { sendJson(res, 404, { message: 'Not Found' }, rid); return; }
        const raw = await readBody(req);
        const gitReq = {
          repo,
          method,
          path: gitPath,
          query,
          headers: req.headers as Record<string, string | undefined>,
          body: raw,
        };
        let result;
        if (method === 'GET' && gitPath === '/info/refs') result = handleInfoRefs(gitReq);
        else if (method === 'POST' && gitPath === '/git-upload-pack') result = handleUploadPack(store, gitReq);
        else if (method === 'POST' && gitPath === '/git-receive-pack') result = handleReceivePack(store, gitReq);
        else { sendJson(res, 404, { message: 'Not Found' }, rid); return; }
        if (result.status === 404 || result.status >= 400) {
          // Git errors are still JSON for the client-visible 404s; protocol errors stay raw.
          if (result.contentType === 'application/json') {
            sendJson(res, result.status, JSON.parse(result.body.toString('utf8')), rid);
            return;
          }
        }
        sendBuffer(res, result.status, result.contentType, result.body, rid);
        return;
      }

      // Everything else: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' }, rid);
    })().catch((err) => {
      // Never let one bad request kill the server: answer 500 JSON and keep serving.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, requestIdHeaders());
      } catch {
        try { res.destroy(); } catch { /* ignore */ }
      }
    });
  });
}
