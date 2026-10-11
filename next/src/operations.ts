import { AppError, flatten, rpcSchema, validateActions, type BookmarkAPI, type Action, type RPC } from './protocol.js';

export async function readOperation(api: BookmarkAPI, raw: unknown): Promise<unknown> {
  const request = rpcSchema.parse(raw);
  if (request.method === 'tree') return request.params.id ? api.getSubTree(request.params.id) : api.getTree();
  if (request.method === 'get') { const [n] = await api.get(request.params.id); if (!n) throw new AppError('NOT_FOUND', 'Node does not exist'); return n; }
  if (request.method === 'children') return api.getChildren(request.params.id);
  const tree = await api.getTree(), nodes = flatten(tree), bookmarks = nodes.filter(n => n.url !== undefined);
  if (request.method === 'export') return { version: 1, exportedAt: new Date().toISOString(), tree };
  if (request.method === 'search') {
    const p = request.params;
    let results = p.query ? await api.search(p.query) : nodes.filter(n => n.parentId);
    if (p.folderId) {
      const allowed = new Set(flatten(await api.getSubTree(p.folderId)).map(n => n.id));
      results = results.filter(n => allowed.has(n.id));
    }
    if (p.domain) results = results.filter(n => {
      try { const host = new URL(n.url!).hostname.toLowerCase(), domain = p.domain!.toLowerCase(); return host === domain || host.endsWith(`.${domain}`); } catch { return false; }
    });
    const offset = p.offset ?? 0, limit = p.limit ?? 100;
    return { total: results.length, offset, limit, items: results.slice(offset, offset + limit) };
  }
  if (request.method === 'duplicates') {
    const groups = new Map<string, typeof bookmarks>();
    for (const n of bookmarks) {
      let key = n.url!;
      try { const u = new URL(key); if (request.params.ignoreFragment) u.hash = ''; key = u.href; } catch { /* preserve unsupported URLs verbatim */ }
      groups.set(key, [...groups.get(key) ?? [], n]);
    }
    return [...groups.entries()].filter(([, nodes]) => nodes.length > 1).map(([url, items]) => ({ url, items }));
  }
  if (request.method === 'rediscover') return bookmarks.sort((a,b) =>
    (a.dateLastUsed ?? a.dateAdded ?? 0) - (b.dateLastUsed ?? b.dateAdded ?? 0)).slice(0, request.params.limit ?? 20);
  throw new AppError('INVALID_METHOD', 'Mutations must use the service preview/commit flow');
}
export async function applyActions(api: BookmarkAPI, actions: Action[], expectedTree: string): Promise<unknown> {
  // The extension checks again immediately before dispatch. Chrome does not offer transactions.
  const tree = await api.getTree();
  if (JSON.stringify(tree) !== expectedTree) throw new AppError('STALE_PREVIEW', 'Bookmarks changed. Create a new preview.');
  validateActions(tree, actions);
  const completed: unknown[] = [];
  for (const action of actions) {
    try {
      let data: unknown;
      switch (action.op) {
        case 'create': case 'folder': { const { op, ...p } = action; data = await api.create(p); break; }
        case 'update': { const { op, id, ...p } = action; data = await api.update(id, p); break; }
        case 'move': { const { op, id, ...p } = action; data = await api.move(id, p); break; }
        case 'remove': await (action.recursive ? api.removeTree(action.id) : api.remove(action.id)); data = { removed: action.id }; break;
      }
      completed.push({ action, data });
    } catch (e) {
      throw new AppError('PARTIAL_FAILURE', 'Plan stopped on a failed operation. Inspect completed items before retrying.',
        { completed, failed: action, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { completed };
}
