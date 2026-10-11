import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from './mock.mjs';
import { flatten } from '../dist/protocol.js';
import { parse } from '../dist/cli.js';

async function setup(t) {
  const h = await harness(); t.after(h.close);
  h.api.tree[0].children[0].children[0].children.push({id:'15',parentId:'10',title:'Nested',children:[
    {id:'16',parentId:'15',title:'Nested Example',url:'https://nested.example.com/',dateAdded:0}
  ]});
  h.api.tree[0].children[1].children.push(
    {id:'20',parentId:'2',title:'Notes',children:[{id:'21',parentId:'20',title:'Example extra',url:'https://example.com/',dateAdded:5}]},
    {id:'40',parentId:'2',title:'Outside private folder',children:[{id:'41',parentId:'40',title:'Example outside private',url:'https://private.example.com/',dateAdded:0}]}
  );
  return h;
}
const scope = {folderIds:['10'],includeDescendants:true};
const direct = {folderIds:['10'],includeDescendants:false};
const multi = {folderIds:['10','20'],includeDescendants:true};

test('scoped tree/get/children/export prune excluded nodes and preserve managed inheritance',async t => {
  const h = await setup(t);
  const tree = (await h.rpc('tree',{scope:multi})).data;
  assert.deepEqual(tree.map(n=>n.id),['10','20']);
  assert.deepEqual(flatten(tree).map(n=>n.id),['10','11','12','13','14','15','16','20','21']);
  const shallow = (await h.rpc('tree',{scope:direct})).data;
  assert.equal(flatten(shallow).some(n=>n.id==='16'),false);
  const folder = (await h.rpc('get',{id:'15',scope:direct})).data;
  assert.deepEqual(folder.children,[]);
  assert.deepEqual((await h.rpc('children',{id:'15',scope:direct})).data,[]);
  assert.equal((await h.rpc('children',{id:'10',scope})).data.length,5);
  const exported = (await h.rpc('export',{scope:multi})).data;
  assert.deepEqual(exported.scope,multi);assert.ok(exported.profile);assert.deepEqual(exported.tree,tree);
  for (const method of ['get','children','tree'])
    assert.equal((await h.rpc(method,{id:'40',scope})).error.code,'OUT_OF_SCOPE');
  h.api.tree[0].children[2].children.push({id:'31',parentId:'3',title:'Managed subfolder',children:[{id:'32',parentId:'31',title:'Policy child',url:'https://policy.example/child'}]});
  const managed = (await h.rpc('tree',{scope:{folderIds:['31']}})).data[0];
  assert.equal(managed.unmodifiable,'managed');assert.equal(managed.children[0].unmodifiable,'managed');
});

test('multiple and overlapping scopes filter searches before pagination, duplicates and rediscovery',async t => {
  const h = await setup(t);
  const found = (await h.rpc('search',{query:'Example',scope:multi,limit:2,offset:2})).data;
  assert.equal(found.total,5);assert.deepEqual(found.items.map(n=>n.id),['13','16']);
  assert.equal((await h.rpc('search',{query:'Example',scope:direct})).data.total,3);
  assert.deepEqual((await h.rpc('search',{query:'Example',domain:'example.com',scope:multi})).data.items.map(n=>n.id),['11','12','13','16','21']);
  assert.deepEqual((await h.rpc('search',{query:'"Nested Example"',scope:multi})).data.items.map(n=>n.id),['16']);
  assert.deepEqual((await h.rpc('search',{query:'Example Nested',scope:multi})).data.items.map(n=>n.id),['16']);
  assert.equal((await h.rpc('search',{folderId:'40',scope})).error.code,'OUT_OF_SCOPE');
  const duplicate = (await h.rpc('duplicates',{scope:multi})).data[0];
  assert.deepEqual(duplicate.items.map(n=>n.id),['11','12','21']);
  const old = (await h.rpc('rediscover',{scope:direct,limit:100})).data;
  assert.equal(old.some(n=>['16','21','41'].includes(n.id)),false);
  const overlapping = (await h.rpc('tree',{scope:{folderIds:['10','15']}})).data;
  assert.equal(overlapping.length,1);assert.equal(flatten(overlapping).filter(n=>n.id==='16').length,1);
});

test('invalid or empty scopes fail rather than reverting to the full library',async t => {
  const h = await setup(t);
  for (const folderIds of [[],['10','10']]) assert.equal((await h.rpc('tree',{scope:{folderIds}})).error.code,'INVALID_INPUT');
  for (const folderIds of [['missing'],['11'],['0']]) assert.equal((await h.rpc('tree',{scope:{folderIds}})).error.code,'INVALID_SCOPE');
  assert.equal((await h.rpc('tree',{scope:{folderIds:['10'],includeDescendants:'false'}})).error.code,'INVALID_INPUT');
});

test('scope rejects outside targets/destinations, recursive escapes and mutations to scope roots',async t => {
  const h = await setup(t);const original=JSON.stringify(await h.api.getTree());
  for (const action of [
    {op:'update',id:'41',title:'Forbidden'}, {op:'remove',id:'41'},
    {op:'create',parentId:'20',title:'Forbidden',url:'https://example.org/'},
    {op:'folder',parentId:'20',title:'Forbidden'}, {op:'move',id:'11',parentId:'20'}
  ]) assert.equal((await h.rpc('preview',{scope,actions:[action]})).error.code,'OUT_OF_SCOPE');
  for (const action of [{op:'update',id:'10',title:'Forbidden'},{op:'remove',id:'10',recursive:true},{op:'move',id:'10',parentId:'20'}])
    assert.equal((await h.rpc('preview',{scope:multi,actions:[action]})).error.code,'SCOPE_ROOT_PROTECTED');
  for (const action of [{op:'remove',id:'15',recursive:true},{op:'move',id:'15',parentId:'20'},{op:'create',parentId:'15',title:'Forbidden',url:'https://example.org/'}])
    assert.equal((await h.rpc('preview',{scope:{folderIds:['10','20'],includeDescendants:false},actions:[action]})).error.code,'OUT_OF_SCOPE');
  const preview = await h.rpc('preview',{scope:direct,actions:[{op:'update',id:'15',title:'Renamed child folder'}]});
  assert.deepEqual(preview.data.changes[0].before.children,[]);
  assert.equal(JSON.stringify(await h.api.getTree()),original);
});

test('scoped commit retains scope, permits moves within the union and records scope in the backup',async t => {
  const h = await setup(t);
  const outside = JSON.stringify((await h.api.getSubTree('40')));
  const preview = (await h.rpc('preview',{scope:multi,actions:[{op:'move',id:'11',parentId:'20'},{op:'update',id:'16',title:'Scoped update'}]})).data;
  assert.deepEqual(preview.scope,multi);assert.deepEqual(preview.scopeFolders.map(n=>n.id),['10','20']);
  assert.equal((await h.rpc('commit',{previewId:preview.previewId,confirm:true,scope})).error.code,'SCOPE_MISMATCH');
  const result = await h.rpc('commit',{previewId:preview.previewId,confirm:true,scope:{folderIds:['20','10']}});
  assert.equal(result.ok,true);assert.deepEqual(result.data.scope,multi);
  assert.equal((await h.api.get('11'))[0].parentId,'20');assert.equal((await h.api.get('16'))[0].title,'Scoped update');
  assert.equal(JSON.stringify(await h.api.getSubTree('40')),outside);
  const backup = JSON.parse(readFileSync(result.data.backup,'utf8'));assert.deepEqual(backup.scope,multi);assert.ok(flatten(backup.tree).some(n=>n.id==='41'));
  const create = (await h.rpc('preview',{scope,actions:[{op:'create',parentId:'10',title:'Scoped create',url:'https://new.example.org/'}]})).data;
  assert.equal((await h.rpc('commit',{previewId:create.previewId,confirm:true})).ok,true);
  const created = (await h.api.search('Scoped create'))[0];
  const remove = (await h.rpc('preview',{scope,actions:[{op:'remove',id:created.id}]})).data;
  assert.equal((await h.rpc('commit',{previewId:remove.previewId,confirm:true})).ok,true);
  await assert.rejects(()=>h.api.get(created.id));
});

test('scope cannot widen an unscoped preview; moved scope content invalidates a stored preview',async t => {
  const h = await setup(t);
  const global = (await h.rpc('preview',{actions:[{op:'update',id:'41',title:'Global preview'}]})).data;
  assert.equal((await h.rpc('commit',{previewId:global.previewId,confirm:true,scope})).error.code,'SCOPE_MISMATCH');
  const preview = (await h.rpc('preview',{scope,actions:[{op:'update',id:'11',title:'Scoped preview'}]})).data;
  await h.api.move('11',{parentId:'40'});
  assert.equal((await h.rpc('commit',{previewId:preview.previewId,confirm:true})).error.code,'STALE_PREVIEW');
  assert.equal((await h.api.get('11'))[0].title,'Example α');
});

test('CLI accepts repeated scope IDs on reads and plans, and rejects ambiguous flags',() => {
  const session='00000000-0000-4000-8000-000000000000';
  const args=['--session',session,'--scope','10','--scope','20','--direct-only'];
  for (const command of [['tree'],['get','11'],['children','10'],['search','Example'],['duplicates'],['rediscover'],['update','11','--title','Scoped']]) {
    const parsed=parse([...command,...args]);assert.deepEqual(parsed.params.scope,{folderIds:['10','20'],includeDescendants:false});
  }
  assert.throws(()=>parse(['tree','--session',session,'--direct-only']));
  assert.throws(()=>parse(['tree','--session',session,'--scope','10','--scope','10']));
  assert.throws(()=>parse(['status','--scope','10']));
});
