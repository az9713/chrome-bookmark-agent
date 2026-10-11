import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { timingSafeEqual, randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig, configDir, projectRoot, type Config } from './config.js';
import { AppError, errorData, helloSchema, rpcSchema, validateActions, flatten, type Bookmark, type Action } from './protocol.js';
import { resolveScope, validateScopedActions, readScopedOperation } from './scope.js';
import type { Scope } from './protocol.js';

interface Session { sessionId: string; profileId: string; profileLabel: string; extensionId: string; connectedAt: string; ws: WebSocket; tail: Promise<unknown>; queued: number }
interface Preview { sessionId: string; digest: string; actions: Action[]; expires: number; tree: Bookmark[]; scope?: Scope }
interface Pending { sessionId: string; resolve: (data: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout>; write: boolean }
export const digestTree = (tree: unknown) => createHash('sha256').update(JSON.stringify(tree)).digest('hex');
export function authenticated(value: unknown, token: string): boolean {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function reply(res: ServerResponse, status: number, data: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
export function createBookmarkService(config: Config, options: { dataDir?: string; uiDir?: string; timeoutMs?: number } = {}) {
  const sessions = new Map<string, Session>(), previews = new Map<string, Preview>(), pending = new Map<string, Pending>();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const auditDir = join(options.dataDir ?? configDir(), 'backups');
  const uiDir = resolve(options.uiDir ?? join(projectRoot, 'dist', 'ui'));
  let boundPort = config.port;
  const host = () => `127.0.0.1:${boundPort}`;
  const managerToken = randomBytes(32).toString('hex');
  const cookieName = () => `bookmark_agent_${boundPort}`;
  function disconnected(session: Session) {
    sessions.delete(session.sessionId);
    for (const [id, preview] of previews) if (preview.sessionId === session.sessionId) previews.delete(id);
    for (const [id, item] of pending) if (item.sessionId === session.sessionId) {
      clearTimeout(item.timer); pending.delete(id);
      item.reject(new AppError(item.write ? 'OUTCOME_UNKNOWN' : 'DISCONNECTED',
        item.write ? 'Chrome disconnected during a write. Inspect bookmarks and the backup before retrying.' : 'Chrome disconnected. Reconnect the extension.'));
    }
  }
  function ask(session: Session, command: unknown, write = false): Promise<any> {
    if (sessions.get(session.sessionId) !== session || session.ws.readyState !== WebSocket.OPEN) throw new AppError('DISCONNECTED', 'Reconnect Chrome and select its new session');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(write ? 'OUTCOME_UNKNOWN' : 'TIMEOUT', write ? 'Write timed out. It may have completed; inspect bookmarks and backup before retrying.' : 'Chrome did not respond in time'));
        session.ws.terminate();
      }, options.timeoutMs ?? 20000);
      pending.set(id, { sessionId: session.sessionId, resolve, reject, timer, write });
      session.ws.send(JSON.stringify({ type: 'request', id, command }), e => {
        if (e) { clearTimeout(timer); pending.delete(id); reject(new AppError(write ? 'OUTCOME_UNKNOWN' : 'DISCONNECTED', 'Bridge send failed')); session.ws.terminate(); }
      });
    });
  }
  function saveBackup(session: Session, tree: Bookmark[], actions: Action[], requestId: string, scope?: Scope) {
    mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    const path = join(auditDir, `${Date.now()}-${requestId}.json`);
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, timestamp: new Date().toISOString(), profileId: session.profileId,
      profileLabel: session.profileLabel, sessionId: session.sessionId, requestId, tree, actions, ...(scope ? { scope } : {}) }, null, 2)); fsyncSync(fd); }
    finally { closeSync(fd); }
    return path;
  }
  async function operation(session: Session, request: z.infer<typeof rpcSchema>) {
    for (const [id, p] of previews) if (p.expires < Date.now()) previews.delete(id);
    if (request.method === 'preview') {
      if (previews.size >= 100) throw new AppError('BUSY', 'Too many active previews. Wait for expiry.');
      const tree = await ask(session, { method: 'tree', params: {} }) as Bookmark[];
      validateScopedActions(tree, request.params.actions, request.params.scope);
      validateActions(tree, request.params.actions);
      const previewId = randomUUID(), expires = Date.now() + 5 * 60 * 1000;
      previews.set(previewId, { sessionId: session.sessionId, tree, digest: digestTree(tree), actions: request.params.actions, expires, scope: request.params.scope });
      const nodes = new Map(flatten(tree).map(n => [n.id, n]));
      const selected = request.params.scope ? resolveScope(tree, request.params.scope) : undefined;
      return { previewId, sessionId: session.sessionId, profileLabel: session.profileLabel, expiresAt: new Date(expires).toISOString(),
        ...(request.params.scope ? { scope: request.params.scope, scopeFolders: request.params.scope.folderIds.map(id => ({ id, title: nodes.get(id)!.title })) } : {}),
        changes: request.params.actions.map(action => ({ action, before: 'id' in action ? selected ? selected.copy(action.id) : nodes.get(action.id) : null })),
        warning: 'Commit requires confirm:true. A complete backup is saved first. Chrome does not support atomic batches.' };
    }
    if (request.method === 'commit') {
      const preview = previews.get(request.params.previewId);
      if (!preview || preview.sessionId !== session.sessionId || preview.expires < Date.now()) throw new AppError('INVALID_PREVIEW', 'Preview expired, consumed, or belongs to another session');
      const scopeKey = (scope?: Scope) => scope && JSON.stringify({ folderIds: [...scope.folderIds].sort(), includeDescendants: scope.includeDescendants });
      if (request.params.scope && scopeKey(request.params.scope) !== scopeKey(preview.scope))
        throw new AppError('SCOPE_MISMATCH', 'Commit scope must match the preview scope; omitting it uses the stored preview scope');
      previews.delete(request.params.previewId); // One-shot, including failures: no accidental replay.
      const tree = await ask(session, { method: 'tree', params: {} }) as Bookmark[];
      if (digestTree(tree) !== preview.digest) throw new AppError('STALE_PREVIEW', 'Bookmarks changed since preview. Preview again.');
      validateScopedActions(tree, preview.actions, preview.scope);
      validateActions(tree, preview.actions);
      let backup: string;
      try { backup = saveBackup(session, tree, preview.actions, request.params.previewId, preview.scope); }
      catch { throw new AppError('BACKUP_FAILED', 'Could not save durable backup; no mutation was dispatched'); }
      try {
        const result = await ask(session, { method: 'apply', params: { actions: preview.actions, digest: preview.digest } }, true);
        return { ...result, backup, previewId: request.params.previewId, ...(preview.scope ? { scope: preview.scope } : {}) };
      } catch (e) { const err = errorData(e); throw new AppError(err.code, err.message, { backup, cause: err.details }); }
    }
    // Enforce scope here so an already-loaded extension does not need to be reinstalled.
    const data = request.params.scope
      ? readScopedOperation(await ask(session, { method: 'tree', params: {} }) as Bookmark[], request)
      : await ask(session, request);
    if (request.method === 'export') return { ...data, profile: { id: session.profileId, label: session.profileLabel }, sessionId: session.sessionId };
    return data;
  }
  const envelope = z.object({ sessionId: z.string().uuid(), request: rpcSchema }).strict();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== host() || (req.headers.origin !== undefined && req.headers.origin !== `http://${host()}`)) {
      reply(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Only this loopback origin is allowed' } }); req.resume(); return;
    }
    if (req.url?.startsWith('/api/')) {
      // Browser-supplied metadata and a non-simple header reject cross-origin requests, including other loopback ports.
      const managerRequest = req.headers['sec-fetch-site'] === 'same-origin' && req.headers['x-bookmark-agent'] === 'manager'
        && (req.method === 'GET' || req.headers.origin === `http://${host()}`);
      if (req.method === 'POST' && req.url === '/api/v1/manager-session') {
        if (!managerRequest) { reply(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Open the manager directly on this computer' } }); req.resume(); return; }
        res.setHeader('Set-Cookie', `${cookieName()}=${managerToken}; HttpOnly; SameSite=Strict; Path=/api/v1/`);
        reply(res, 200, { ok: true, data: null }); req.resume(); return;
      }
      const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName()}=`))?.slice(cookieName().length + 1);
      if (!authenticated(req.headers.authorization, config.token) && !(managerRequest && authenticated(`Bearer ${cookie}`, managerToken))) {
        reply(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Use the configured API credential or reload the local manager' } }); req.resume(); return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/status') {
        reply(res, 200, { ok: true, data: { version: 2, sessions: [...sessions.values()].map(({ ws, tail, queued, ...s }) => ({ ...s, queued })), connected: sessions.size > 0 } }); return;
      }
      if (req.method !== 'POST' || req.url !== '/api/v1/rpc') { reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }); req.resume(); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { reply(res, 415, { ok: false, error: { code: 'CONTENT_TYPE', message: 'Use application/json' } }); req.resume(); return; }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) { reply(res, 413, { ok: false, error: { code: 'TOO_LARGE', message: 'Request limit is 128 KiB' } }); req.resume(); return; } chunks.push(chunk); }
        const p = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const session = sessions.get(p.sessionId);
        if (!session) throw new AppError('DISCONNECTED', 'Selected Chrome session is unavailable. Check status and select a connected session.');
        if (session.queued >= 100) throw new AppError('BUSY', 'Session queue is full');
        session.queued++;
        const job = session.tail.then(() => operation(session, p.request));
        session.tail = job.catch(() => undefined).finally(() => { session.queued--; });
        reply(res, 200, { ok: true, data: await job });
      } catch (e) { reply(res, 400, { ok: false, error: errorData(e) }); }
      return;
    }
    if (req.method !== 'GET') { reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }); req.resume(); return; }
    try {
      const path = resolve(uiDir, '.' + decodeURIComponent((req.url ?? '/').split('?')[0] === '/' ? '/index.html' : (req.url ?? '/').split('?')[0]));
      if (!path.startsWith(uiDir + sep)) throw new Error('Invalid path');
      const content = readFileSync(path);
      const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      res.end(content);
    } catch { reply(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'UI asset not found; run npm run build' } }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/bridge' || req.headers.origin !== undefined || req.headers.host !== host() || !authenticated(req.headers.authorization, config.bridgeToken)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws));
  });
  wsServer.on('connection', ws => {
    let session: Session | undefined;
    let alive = true;
    const helloTimeout = setTimeout(() => ws.terminate(), 5000);
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 15000);
    ws.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (!session) {
          const hello = helloSchema.parse(message);
          if (!config.extensionId || hello.extensionId !== config.extensionId) throw new Error('Extension not registered in configuration');
          if ([...sessions.values()].some(s => s.profileId === hello.profileId)) throw new Error('Profile already connected');
          clearTimeout(helloTimeout);
          session = { sessionId: randomUUID(), profileId: hello.profileId, profileLabel: hello.profileLabel, extensionId: hello.extensionId,
            connectedAt: new Date().toISOString(), ws, tail: Promise.resolve(), queued: 0 };
          sessions.set(session.sessionId, session);
          ws.send(JSON.stringify({ type: 'ready', sessionId: session.sessionId, port: boundPort }));
          return;
        }
        if (message.type !== 'response' || typeof message.id !== 'string' || typeof message.ok !== 'boolean') throw new Error('Invalid response');
        const job = pending.get(message.id);
        if (!job || job.sessionId !== session.sessionId) return;
        clearTimeout(job.timer); pending.delete(message.id);
        if (message.ok) job.resolve(message.data);
        else job.reject(new AppError(typeof message.error?.code === 'string' ? message.error.code : 'CHROME_ERROR', String(message.error?.message ?? 'Chrome operation failed'), message.error?.details));
      } catch { ws.close(1008, 'Invalid bridge protocol'); }
    });
    ws.on('close', () => { clearInterval(heartbeat); clearTimeout(helloTimeout); if (session) disconnected(session); });
  });
  return { server, sessions,
    listen: () => new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', () => { boundPort = (server.address() as { port: number }).port; resolve(boundPort); }); }),
    close: async () => { for (const client of wsServer.clients) client.terminate(); await new Promise<void>(resolve => wsServer.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const service = createBookmarkService(loadConfig()); const port = await service.listen();
    console.log(`Bookmark manager: http://127.0.0.1:${port} (Chrome extension must be enabled to connect)`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void service.close().then(() => process.exit(0)); });
  } catch (e) { console.error(errorData(e)); process.exitCode = 1; }
}
