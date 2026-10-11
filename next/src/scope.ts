import { AppError, flatten, type Bookmark, type Action, type Scope, type RPC } from './protocol.js';

// Scope is an operation boundary, not a replacement for profile authentication.
export function resolveScope(tree: Bookmark[], scope: Scope) {
  const all = flatten(tree), byId = new Map(all.map(node => [node.id, node]));
  const roots = new Set(scope.folderIds), allowed = new Set<string>();
  for (const id of roots) {
    const folder = byId.get(id);
    if (!folder || folder.url !== undefined || !folder.parentId)
      throw new AppError('INVALID_SCOPE', `Scope ${id} must be an existing non-root folder`);
    allowed.add(id);
    for (const node of scope.includeDescendants ? flatten(folder.children ?? []) : folder.children ?? []) allowed.add(node.id);
  }
  const requireNode = (id: string) => {
    if (!allowed.has(id)) throw new AppError('OUT_OF_SCOPE', `Node ${id} is outside the selected folders`);
    return byId.get(id)!;
  };
  // Clone only allowed nodes, pruning children on every response (including get/search).
  const copies = new Map<string, Bookmark>();
  const managed = new Set<string>();
  for (const node of all) {
    if (node.unmodifiable || managed.has(node.parentId ?? '')) managed.add(node.id);
    if (allowed.has(node.id)) copies.set(node.id, {
      ...node, ...(node.children ? { children: [] } : {}), ...(managed.has(node.id) ? { unmodifiable: 'managed' } : {})
    });
  }
  const forest: Bookmark[] = [];
  for (const node of all) {
    const copy = copies.get(node.id); if (!copy) continue;
    const parent = copies.get(node.parentId ?? '');
    if (parent) { parent.children ??= []; parent.children.push(copy); }
    else forest.push(copy);
  }
  return { roots, allowed, byId, requireNode, forest, nodes: all.filter(n => allowed.has(n.id)),
    copy: (id: string) => { requireNode(id); return copies.get(id)!; } };
}

export function validateScopedActions(tree: Bookmark[], actions: Action[], scope?: Scope) {
  if (!scope) return;
  const selected = resolveScope(tree, scope);
  for (const action of actions) {
    if ('id' in action) {
      const node = selected.requireNode(action.id);
      if (selected.roots.has(action.id))
        throw new AppError('SCOPE_ROOT_PROTECTED', 'Selected scope folders cannot be renamed, moved or deleted; modify their contents instead');
      if (action.op === 'move' || action.op === 'remove') {
        for (const child of flatten(node.children ?? [])) {
          if (!selected.allowed.has(child.id) || selected.roots.has(child.id))
            throw new AppError('OUT_OF_SCOPE', 'Moving or deleting this folder would affect contents outside the scope or a selected scope folder');
        }
      }
    }
    if ('parentId' in action) {
      selected.requireNode(action.parentId);
      if (!scope.includeDescendants && !selected.roots.has(action.parentId))
        throw new AppError('OUT_OF_SCOPE', 'With subfolders excluded, destinations must be selected scope folders');
    }
  }
}

export function readScopedOperation(tree: Bookmark[], request: RPC) {
  const scope = request.params.scope;
  if (!scope) throw new AppError('INVALID_SCOPE', 'A folder scope is required');
  const selected = resolveScope(tree, scope);
  if (request.method === 'tree') return request.params.id ? [selected.copy(request.params.id)] : selected.forest;
  if (request.method === 'get') return selected.copy(request.params.id);
  if (request.method === 'children') return selected.copy(request.params.id).children ?? [];
  if (request.method === 'export') return { version: 1, exportedAt: new Date().toISOString(), scope, tree: selected.forest };
  if (request.method === 'search') {
    const p = request.params;
    // Words and quoted phrases each match title or URL, regardless of case.
    const terms = [...(p.query ?? '').matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] ?? m[2]).toLowerCase());
    let nodes = selected.nodes.filter(n => !selected.roots.has(n.id) &&
      terms.every(term => n.title.toLowerCase().includes(term) || (n.url ?? '').toLowerCase().includes(term)));
    if (p.folderId) {
      const folder = selected.requireNode(p.folderId);
      const ids = new Set(flatten([folder]).map(n => n.id));
      nodes = nodes.filter(n => ids.has(n.id));
    }
    if (p.domain) nodes = nodes.filter(n => {
      try { const host = new URL(n.url!).hostname.toLowerCase(), domain = p.domain!.toLowerCase();
        return host === domain || host.endsWith(`.${domain}`); } catch { return false; }
    });
    const offset = p.offset ?? 0, limit = p.limit ?? 100;
    return { total: nodes.length, offset, limit, items: nodes.slice(offset, offset + limit).map(n => selected.copy(n.id)) };
  }
  const bookmarks = selected.nodes.filter(n => n.url !== undefined);
  if (request.method === 'rediscover') return bookmarks.sort((a,b) =>
    (a.dateLastUsed ?? a.dateAdded ?? 0) - (b.dateLastUsed ?? b.dateAdded ?? 0))
    .slice(0, request.params.limit ?? 20).map(n => selected.copy(n.id));
  if (request.method === 'duplicates') {
    const groups = new Map<string, Bookmark[]>();
    for (const node of bookmarks) {
      let key = node.url!;
      try { const url = new URL(key); if (request.params.ignoreFragment) url.hash = ''; key = url.href; } catch { /* existing bookmarklet */ }
      const group = groups.get(key) ?? []; group.push(selected.copy(node.id)); groups.set(key, group);
    }
    return [...groups].filter(([,items]) => items.length > 1).map(([url,items]) => ({ url,items }));
  }
  throw new AppError('INVALID_METHOD', 'Writes must use preview and commit');
}
