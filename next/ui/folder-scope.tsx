import React, { useState } from 'react';
import type { LibraryNode } from './library-index';

export type FolderScope = { folderIds: string[]; includeDescendants: boolean };
type Props = { folders: LibraryNode[]; byId: Map<string, LibraryNode>; scope?: FolderScope;
  busy: boolean; onChange: (scope?: FolderScope) => void };

export function FolderScopeControl({ folders, byId, scope, busy, onChange }: Props) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string[]>([]), [descendants, setDescendants] = useState(true);
  function path(node: LibraryNode) {
    const parts: string[] = [], seen = new Set<string>();
    let current: LibraryNode | undefined = node;
    while (current && !seen.has(current.id)) {
      seen.add(current.id); if (current.parentId) parts.push(current.title || '(Untitled)');
      current = byId.get(current.parentId ?? '');
    }
    return parts.reverse().join(' / ');
  }
  const matches = folders.filter(n => (path(n) + ' ' + n.id).toLowerCase().includes(query.toLowerCase()));
  return <section className="scope-control" aria-label="Action scope">
    <div><strong>Action scope</strong><p role="status">{scope
      ? `${scope.folderIds.length} selected folder${scope.folderIds.length === 1 ? '' : 's'} · ${scope.includeDescendants ? 'Including subfolders' : 'Direct children only'}`
      : 'Entire library'}</p>{scope && <p className="scope-names">{scope.folderIds.map(id => `${byId.get(id)?.title || 'Folder'} · ${id}`).join('; ')}</p>}</div>
    <div className="scope-actions"><button className="secondary" disabled={busy} onClick={() => {
      setDraft(scope?.folderIds ?? []); setDescendants(scope?.includeDescendants ?? true); setQuery(''); setOpen(true);
    }}>Choose folders</button>{scope && <button className="text" disabled={busy} onClick={() => onChange()}>Clear scope</button>}</div>
    {open && <div className="overlay"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="scope-title">
      <h2 id="scope-title">Choose action scope</h2><p>Read, search, export and change bookmarks only within the selected folders. Selected scope folders themselves are protected.</p>
      <label>Find folders<input aria-label="Find scope folders" value={query} onChange={e => setQuery(e.target.value)} placeholder="Folder name, path or ID"/></label>
      <label className="scope-checkbox"><input type="checkbox" checked={descendants} onChange={e => setDescendants(e.target.checked)}/>Include subfolders</label>
      <p className="session-detail">{draft.length} selected (maximum 100) · {matches.length} matching folders{matches.length > 100 ? ' · First 100 shown; narrow your search' : ''}</p>
      <div className="scope-options">{matches.slice(0,100).map(n => <label key={n.id} className="scope-option"><input type="checkbox" aria-label={`Scope folder ${n.id}`} checked={draft.includes(n.id)} onChange={e => setDraft(old => e.target.checked ? [...old,n.id] : old.filter(id => id !== n.id))}/><span>{path(n)}<small>ID {n.id}</small></span></label>)}</div>
      <div className="dialog-actions"><button className="secondary" onClick={() => setOpen(false)}>Cancel</button><button disabled={busy || !draft.length || draft.length > 100} onClick={() => {
        onChange({ folderIds: draft, includeDescendants: descendants }); setOpen(false);
      }}>Apply scope</button></div>
    </section></div>}
  </section>;
}
