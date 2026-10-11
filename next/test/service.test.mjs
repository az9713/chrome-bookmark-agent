import test from 'node:test';import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from './mock.mjs';
import { authenticated } from '../dist/server.js';
import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
test('loopback authentication, origin, session and schema checks',async t=>{
  const h=await harness();t.after(h.close);
  assert.equal((await h.http('/api/v1/status')).body.data.sessions.length,1);
  assert.equal((await h.http('/api/v1/status',undefined,{Authorization:'Bearer invalid'})).status,401);
  assert.equal((await h.http('/api/v1/status',undefined,{Origin:'https://evil.example'})).status,403);
  assert.equal(authenticated('Bearer '+ 'é'.repeat(64),'a'.repeat(64)),false);
  assert.equal((await h.http('/api/v1/rpc',{sessionId:'00000000-0000-4000-8000-000000000000',request:{method:'tree',params:{}}})).body.error.code,'DISCONNECTED');
  assert.equal((await h.rpc('preview',{actions:[{op:'remove',id:'1'}]})).error.code,'PROTECTED_NODE');
  assert.equal((await h.rpc('commit',{previewId:'00000000-0000-4000-8000-000000000000',confirm:false})).error.code,'INVALID_INPUT');
  const bad=await h.http('/api/v1/rpc',{sessionId:h.session,request:{method:'search',params:{unexpected:1}}});assert.equal(bad.body.ok,false);
});

test('manager connects without an API token while cookie access remains same-origin only',async t=>{
  const h=await harness();t.after(h.close);
  const base=`http://127.0.0.1:${h.config.port}`;
  const browserHeaders={'X-Bookmark-Agent':'manager','Sec-Fetch-Site':'same-origin'};
  const open=headers=>fetch(base+'/api/v1/manager-session',{method:'POST',headers});
  for(const headers of [
    {}, {...browserHeaders}, {...browserHeaders,Origin:'null'},
    {...browserHeaders,Origin:'https://evil.example'},
    {...browserHeaders,Origin:base,'Sec-Fetch-Site':'cross-site'},
    {...browserHeaders,Origin:base,'Sec-Fetch-Site':'same-site'},
    {...browserHeaders,Origin:base,'X-Bookmark-Agent':'invalid'}
  ]) {
    const denied=await open(headers);assert.equal(denied.status,403);
    assert.equal(denied.headers.get('set-cookie'),null);
    assert.equal(denied.headers.get('access-control-allow-origin'),null);
    await denied.arrayBuffer();
  }
  const rebound=await new Promise((resolve,reject)=>{
    const req=httpRequest(base+'/api/v1/manager-session',{method:'POST',headers:{...browserHeaders,Origin:base,Host:'evil.example'}},res=>{
      res.resume();res.once('end',()=>resolve(res.statusCode));
    });req.once('error',reject);req.end();
  });assert.equal(rebound,403);
  const opened=await open({...browserHeaders,Origin:base});assert.equal(opened.status,200);
  assert.deepEqual(await opened.json(),{ok:true,data:null});
  const setCookie=opened.headers.get('set-cookie');
  assert.match(setCookie,/; HttpOnly; SameSite=Strict; Path=\/api\/v1\/$/);
  assert.equal(setCookie.includes(h.config.token),false);assert.equal(setCookie.includes(h.config.bridgeToken),false);
  const cookie=setCookie.split(';')[0];
  const status=headers=>fetch(base+'/api/v1/status',{headers});
  for(const headers of [
    {}, {Cookie:cookie}, browserHeaders,
    {...browserHeaders,Cookie:cookie,'Sec-Fetch-Site':'same-site'},
    {...browserHeaders,Cookie:cookie,'Sec-Fetch-Site':'cross-site'},
    {...browserHeaders,Cookie:cookie+'invalid'}
  ]) { const denied=await status(headers);assert.equal(denied.status,401);await denied.arrayBuffer(); }
  const authorized=await status({...browserHeaders,Cookie:cookie});
  assert.equal(authorized.status,200);assert.equal((await authorized.json()).data.sessions[0].sessionId,h.session);
  const treeBody=JSON.stringify({sessionId:h.session,request:{method:'tree',params:{}}});
  const rpc=headers=>fetch(base+'/api/v1/rpc',{method:'POST',headers:{...browserHeaders,Cookie:cookie,'Content-Type':'application/json',...headers},body:treeBody});
  const missingOrigin=await rpc({});assert.equal(missingOrigin.status,401);await missingOrigin.arrayBuffer();
  const foreignOrigin=await rpc({Origin:base+'0'});assert.equal(foreignOrigin.status,403);await foreignOrigin.arrayBuffer();
  const tree=await rpc({Origin:base});assert.equal(tree.status,200);assert.deepEqual((await tree.json()).data,await h.api.getTree());
  assert.equal((await h.http('/api/v1/status')).body.ok,true);
});
test('preview does not mutate; commit saves full backup and consumes preview',async t=>{
  const h=await harness();t.after(h.close);
  const original=await h.api.getTree();const p=await h.rpc('preview',{actions:[{op:'remove',id:'12'},{op:'move',id:'11',parentId:'2'}]});assert.equal(p.ok,true);
  assert.deepEqual(await h.api.getTree(),original);
  const result=await h.rpc('commit',{previewId:p.data.previewId,confirm:true});assert.equal(result.ok,true);
  assert.equal(result.data.completed.length,2);assert.deepEqual(JSON.parse(readFileSync(result.data.backup,'utf8')).tree,original);
  await assert.rejects(()=>h.api.get('12'));assert.equal((await h.api.get('11'))[0].parentId,'2');
  assert.equal((await h.rpc('commit',{previewId:p.data.previewId,confirm:true})).error.code,'INVALID_PREVIEW');
});
test('external bookmark edits invalidate previews',async t=>{
  const h=await harness();t.after(h.close);
  const p=await h.rpc('preview',{actions:[{op:'remove',id:'12'}]});await h.api.update('11',{title:'External edit'});
  assert.equal((await h.rpc('commit',{previewId:p.data.previewId,confirm:true})).error.code,'STALE_PREVIEW');assert.ok((await h.api.get('12'))[0]);
});
test('backup failure prevents dispatch of bookmark mutations',async t=>{
  const h=await harness();t.after(h.close);
  writeFileSync(join(h.dir,'backups'),'not a directory');const p=await h.rpc('preview',{actions:[{op:'remove',id:'12'}]});
  assert.equal((await h.rpc('commit',{previewId:p.data.previewId,confirm:true})).error.code,'BACKUP_FAILED');assert.ok((await h.api.get('12'))[0]);
});
test('write timeout reports unknown outcome with backup and never replays',async t=>{
  const h=await harness({timeoutMs:150,dropApply:true});t.after(h.close);
  const p=await h.rpc('preview',{actions:[{op:'remove',id:'12'}]});const result=await h.rpc('commit',{previewId:p.data.previewId,confirm:true});
  assert.equal(result.error.code,'OUTCOME_UNKNOWN');assert.ok(readFileSync(result.error.details.backup));await assert.rejects(()=>h.api.get('12'));
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await h.http('/api/v1/status')).body.data.connected,false);
});
test('disconnect removes sessions and old preview capability',async t=>{
  const h=await harness();t.after(h.close);await h.rpc('preview',{actions:[{op:'remove',id:'12'}]});
  await new Promise(resolve=>{h.ws.once('close',resolve);h.ws.close();});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal((await h.rpc('tree')).error.code,'DISCONNECTED');
});
test('multiple profile sessions remain distinct and cannot commit each other previews',async t=>{
  const h=await harness();t.after(h.close);
  const ws=new WebSocket(`ws://127.0.0.1:${h.config.port}/bridge`,{headers:{Authorization:`Bearer ${h.config.bridgeToken}`}});
  const ready=new Promise((resolve,reject)=>{ws.once('error',reject);ws.on('message',bytes=>{const m=JSON.parse(bytes);if(m.type==='ready')resolve(m);});});
  ws.on('open',()=>ws.send(JSON.stringify({type:'hello',profileId:randomUUID(),profileLabel:'Second fixture',extensionId:h.config.extensionId})));
  ws.on('message',bytes=>{const m=JSON.parse(bytes);if(m.type==='request')ws.send(JSON.stringify({type:'response',id:m.id,ok:true,data:[{id:'0',title:'Second tree',children:[]}]}));});
  const second=await ready;assert.notEqual(second.sessionId,h.session);
  assert.equal((await h.http('/api/v1/status')).body.data.sessions.length,2);
  const p=await h.rpc('preview',{actions:[{op:'remove',id:'12'}]});
  const wrong=await h.http('/api/v1/rpc',{sessionId:second.sessionId,request:{method:'commit',params:{previewId:p.data.previewId,confirm:true}}});assert.equal(wrong.body.error.code,'INVALID_PREVIEW');
  assert.equal((await h.rpc('commit',{previewId:p.data.previewId,confirm:true})).ok,true);
  const data=await h.http('/api/v1/rpc',{sessionId:second.sessionId,request:{method:'tree',params:{}}});assert.equal(data.body.data[0].title,'Second tree');
});
