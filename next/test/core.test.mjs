import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcSchema, validateActions } from '../dist/protocol.js';
import { readOperation, applyActions } from '../dist/operations.js';
import { mockAPI, fixture } from './mock.mjs';
test('query filters, duplicate grouping and rediscovery preserve safe semantics',async()=>{
  const api=mockAPI();
  const search=await readOperation(api,{method:'search',params:{query:'Example',domain:'example.com',limit:1,offset:1}});
  assert.equal(search.total,3);assert.equal(search.items.length,1);
  const dup=await readOperation(api,{method:'duplicates',params:{}});assert.equal(dup.length,1);assert.equal(dup[0].items.length,2);
  const older=await readOperation(api,{method:'rediscover',params:{limit:1}});assert.equal(older[0].id,'30');
  const exportData=await readOperation(api,{method:'export',params:{}});assert.deepEqual(exportData.tree,fixture());
});
test('validation blocks malformed URLs, unknown fields, protected and cyclic mutations',()=>{
  assert.throws(()=>rpcSchema.parse({method:'preview',params:{actions:[{op:'create',parentId:'2',title:'bad',url:'javascript:alert(1)'}]}}));
  assert.throws(()=>rpcSchema.parse({method:'tree',params:{unexpected:true}}));
  for(const id of ['0','1','3','30'])assert.throws(()=>validateActions(fixture(),[{op:'remove',id,recursive:true}]));
  assert.throws(()=>validateActions(fixture(),[{op:'move',id:'10',parentId:'10'}]),e=>e.code==='INVALID_MOVE');
  assert.throws(()=>validateActions(fixture(),[{op:'remove',id:'10'}]),e=>e.code==='FOLDER_NOT_EMPTY');
  assert.throws(()=>validateActions(fixture(),[{op:'update',id:'10',url:'https://x.example'}]));
  assert.throws(()=>validateActions(fixture(),[{op:'move',id:'11',parentId:'3'}]));
  assert.throws(()=>validateActions(fixture(),[{op:'update',id:'11',title:'first'},{op:'remove',id:'11'}]),e=>e.code==='CONFLICTING_ACTIONS');
});
test('create, folder, update, move and recursive deletion operate on fixture only',async()=>{
  const api=mockAPI();
  const apply=async actions=>applyActions(api,actions,JSON.stringify(await api.getTree()));
  const created=await apply([{op:'folder',parentId:'2',title:'New folder'}]);const folder=created.completed[0].data;
  const link=(await apply([{op:'create',parentId:folder.id,title:'Link',url:'https://new.example'}])).completed[0].data;
  await apply([{op:'update',id:link.id,title:'Edited'}]);assert.equal((await api.get(link.id))[0].title,'Edited');
  await apply([{op:'move',id:'11',parentId:folder.id}]);assert.equal((await api.get('11'))[0].parentId,folder.id);
  await apply([{op:'remove',id:folder.id,recursive:true}]);await assert.rejects(()=>api.get(link.id));
  await assert.rejects(()=>applyActions(api,[{op:'remove',id:'12'}],'stale'),e=>e.code==='STALE_PREVIEW');
});
test('partial Chrome failure reports completed writes and does not apply remaining operations',async()=>{
  const api=mockAPI(),original=api.update;api.update=async(id,p)=>{if(id==='12')throw Error('Simulated policy error');return original(id,p);};
  await assert.rejects(()=>applyActions(api,[{op:'update',id:'11',title:'Done'},{op:'update',id:'12',title:'Fails'},{op:'update',id:'13',title:'Must stay'}],JSON.stringify(fixture())),e=>e.code==='PARTIAL_FAILURE'&&e.details.completed.length===1);
  assert.equal((await api.get('11'))[0].title,'Done');assert.equal((await api.get('13'))[0].title,'Other');
});
