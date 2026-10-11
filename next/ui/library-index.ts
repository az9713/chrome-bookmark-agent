export type LibraryNode = { id: string; title: string; url?: string; parentId?: string; folderType?: string; unmodifiable?: string; dateLastUsed?: number; dateAdded?: number; children?: LibraryNode[] };

// One traversal per tree update; status polling and input changes reuse this index.
export function indexLibrary(tree: LibraryNode[]) {
  const all: LibraryNode[] = [], byId = new Map<string, LibraryNode>();
  const managedIds = new Set<string>(), folders: LibraryNode[] = [];
  const pending = tree.map(node => ({ node, inheritedManaged: false })).reverse();
  while (pending.length) {
    const { node, inheritedManaged } = pending.pop()!;
    const managed = inheritedManaged || !!node.unmodifiable;
    all.push(node); byId.set(node.id, node);
    if (managed) managedIds.add(node.id);
    if (node.url === undefined && node.parentId && !managed) folders.push(node);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], inheritedManaged: managed });
  }
  return { all, byId, managedIds, folders };
}
