import { z } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export const errorData = (e: unknown) => e instanceof AppError
  ? { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) }
  : { code: e instanceof z.ZodError ? 'INVALID_INPUT' : 'INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) };

export interface Bookmark {
  id: string; title: string; parentId?: string; index?: number; url?: string;
  children?: Bookmark[]; dateAdded?: number; dateLastUsed?: number;
  folderType?: string; unmodifiable?: string;
}
export interface BookmarkAPI {
  getTree(): Promise<Bookmark[]>; get(id: string): Promise<Bookmark[]>;
  getChildren(id: string): Promise<Bookmark[]>; getSubTree(id: string): Promise<Bookmark[]>;
  search(query: string | { query?: string; title?: string; url?: string }): Promise<Bookmark[]>;
  create(p: { title: string; url?: string; parentId: string; index?: number }): Promise<Bookmark>;
  update(id: string, p: { title?: string; url?: string }): Promise<Bookmark>;
  move(id: string, p: { parentId: string; index?: number }): Promise<Bookmark>;
  remove(id: string): Promise<void>; removeTree(id: string): Promise<void>;
}
const id = z.string().min(1).max(128);
const title = z.string().max(4096);
const url = z.string().max(16384).refine(value => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}, 'New or edited URLs must use http or https');
const index = z.number().int().min(0).max(1000000).optional();
export const scopeSchema = z.object({
  folderIds: z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Scope folder IDs must be unique'),
  includeDescendants: z.boolean().default(true)
}).strict();
export type Scope = z.infer<typeof scopeSchema>;
const scope = scopeSchema.optional();
export const actionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), parentId: id, title, url, index }).strict(),
  z.object({ op: z.literal('folder'), parentId: id, title, index }).strict(),
  z.object({ op: z.literal('update'), id, title: title.optional(), url: url.optional() }).strict(),
  z.object({ op: z.literal('move'), id, parentId: id, index }).strict(),
  z.object({ op: z.literal('remove'), id, recursive: z.boolean().optional() }).strict()
]);
export type Action = z.infer<typeof actionSchema>;
export const querySchema = z.object({
  query: z.string().max(4096).optional(), domain: z.string().max(253).regex(/^[a-zA-Z0-9.-]+$/).optional(),
  folderId: id.optional(), offset: z.number().int().min(0).max(1000000).optional(),
  limit: z.number().int().min(1).max(1000).optional(), scope
}).strict();
export const rpcSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('tree'), params: z.object({ id: id.optional(), scope }).strict().default({}) }).strict(),
  z.object({ method: z.literal('get'), params: z.object({ id, scope }).strict() }).strict(),
  z.object({ method: z.literal('children'), params: z.object({ id, scope }).strict() }).strict(),
  z.object({ method: z.literal('search'), params: querySchema.default({}) }).strict(),
  z.object({ method: z.literal('duplicates'), params: z.object({ ignoreFragment: z.boolean().optional(), scope }).strict().default({}) }).strict(),
  z.object({ method: z.literal('rediscover'), params: z.object({ limit: z.number().int().min(1).max(100).optional(), scope }).strict().default({}) }).strict(),
  z.object({ method: z.literal('export'), params: z.object({ scope }).strict().default({}) }).strict(),
  z.object({ method: z.literal('preview'), params: z.object({ actions: z.array(actionSchema).min(1).max(100), scope }).strict() }).strict(),
  z.object({ method: z.literal('commit'), params: z.object({ previewId: z.string().uuid(), confirm: z.literal(true), scope }).strict() }).strict()
]);
export type RPC = z.infer<typeof rpcSchema>;
export const helloSchema = z.object({ type: z.literal('hello'), profileId: z.string().uuid(),
  profileLabel: z.string().min(1).max(100), extensionId: z.string().regex(/^[a-p]{32}$/) }).strict();

export function flatten(tree: Bookmark[]): Bookmark[] {
  const result: Bookmark[] = [], pending = [...tree].reverse();
  while (pending.length) {
    const node = pending.pop()!; result.push(node);
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) pending.push(node.children![i]);
  }
  return result;
}
export function validateActions(tree: Bookmark[], actions: Action[]) {
  const nodes = new Map(flatten(tree).map(n => [n.id, { ...n }]));
  const touched = new Set<string>();
  const get = (id: string) => { const n = nodes.get(id); if (!n) throw new AppError('NOT_FOUND', `Node ${id} does not exist`); return n; };
  const mutable = (n: Bookmark) => {
    if (!n.parentId || n.folderType || n.unmodifiable || n.parentId === '0')
      throw new AppError('PROTECTED_NODE', 'Root, browser-owned, and managed nodes cannot be modified');
    let ancestor: string | undefined = n.parentId;
    while (ancestor) { const p = get(ancestor); if (p.unmodifiable) throw new AppError('PROTECTED_NODE', 'Managed subtree is read-only'); ancestor = p.parentId; }
  };
  for (const action of actions) {
    if ('id' in action) {
      if (touched.has(action.id)) throw new AppError('CONFLICTING_ACTIONS', 'A plan may modify each node only once');
      touched.add(action.id);
      const node = get(action.id); mutable(node);
      if (action.op === 'update') {
        if (action.title === undefined && action.url === undefined) throw new AppError('INVALID_INPUT', 'Update needs a title or URL');
        if (action.url !== undefined && node.url === undefined) throw new AppError('INVALID_INPUT', 'Cannot turn a folder into a bookmark');
        Object.assign(node, { ...(action.title === undefined ? {} : { title: action.title }), ...(action.url === undefined ? {} : { url: action.url }) });
      }
      if (action.op === 'remove') {
        const descendants = [...nodes.values()].filter(n => n.parentId === node.id);
        if (descendants.length && !action.recursive) throw new AppError('FOLDER_NOT_EMPTY', 'Nonempty folder removal needs recursive:true');
        const drop = (id: string) => { for (const child of [...nodes.values()].filter(n => n.parentId === id)) { mutable(child); drop(child.id); } nodes.delete(id); };
        drop(node.id);
      }
    }
    if ('parentId' in action) {
      const parent = get(action.parentId);
      if (parent.url !== undefined || !parent.parentId || parent.unmodifiable) throw new AppError('INVALID_PARENT', 'Choose a writable non-root folder');
      let ancestor: string | undefined = parent.id;
      while (ancestor) {
        const n = get(ancestor);
        if (n.unmodifiable) throw new AppError('PROTECTED_NODE', 'Managed subtree is read-only');
        if (action.op === 'move' && ancestor === action.id) throw new AppError('INVALID_MOVE', 'Cannot move into self or descendants');
        ancestor = n.parentId;
      }
      if (action.op === 'move') get(action.id).parentId = action.parentId;
    }
  }
}
