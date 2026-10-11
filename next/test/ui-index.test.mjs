import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../ui/library-index.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'esm', target: 'node22' }).code;
const { indexLibrary } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('UI index preserves tree order and inherited managed-folder protections', () => {
  const tree = [{ id: '0', title: '', children: [
    { id: '1', title: 'Bar', parentId: '0', folderType: 'bookmarks-bar', children: [{ id: '2', title: 'User folder', parentId: '1' }] },
    { id: '3', title: 'Managed', parentId: '0', unmodifiable: 'managed', children: [
      { id: '4', title: 'Inherited', parentId: '3', children: [{ id: '5', title: 'Link', parentId: '4', url: 'https://example.org' }] }
    ] }
  ] }];
  const index = indexLibrary(tree);
  assert.deepEqual(index.all.map(n => n.id), ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual([...index.managedIds], ['3', '4', '5']);
  assert.deepEqual(index.folders.map(n => n.id), ['1', '2']);
  assert.equal(index.byId.get('2'), tree[0].children[0].children[0]);
  assert.equal(index.byId.get(index.byId.get('5').parentId).title, 'Inherited');
});

test('UI index handles a 70,000-node library and deep ancestry without recursive rescans', () => {
  const root = { id: '0', title: '', children: [] };
  for (let i = 1; i <= 7000; i++) {
    const folder = { id: `f${i}`, title: 'Folder', parentId: '0', children: [] };
    for (let j = 0; j < 9; j++) folder.children.push({ id: `b${i}-${j}`, title: 'Link', url: 'https://example.org', parentId: folder.id });
    root.children.push(folder);
  }
  const index = indexLibrary([root]);
  assert.equal(index.all.length, 70001); assert.equal(index.byId.size, 70001); assert.equal(index.folders.length, 7000);
  assert.equal(index.byId.get('b7000-8').parentId, 'f7000');
  const deep = { id: 'root', title: '', unmodifiable: 'managed', children: [] };
  let current = deep;
  for (let i = 0; i < 20000; i++) { const child = { id: String(i), title: 'Deep', parentId: current.id, children: [] }; current.children.push(child); current = child; }
  const nested = indexLibrary([deep]);
  assert.equal(nested.all.length, 20001); assert.equal(nested.managedIds.size, 20001); assert.equal(nested.folders.length, 0);
});
