import test from 'node:test';import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { harness } from './mock.mjs';import { parse } from '../dist/cli.js';
import { selectSession } from '../dist/client.js';
import { mockAPI } from './mock.mjs';
import { readOperation } from '../dist/operations.js';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
const exec=promisify(execFile);

test('CLI starts when invoked through an npm-style linked package path',async t=>{
  const dir=mkdtempSync(resolve(tmpdir(),'bookmark-agent-link-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const linked=resolve(dir,'package');
  symlinkSync(resolve('.'),linked,process.platform==='win32'?'junction':'dir');
  const result=await exec(process.execPath,[resolve(linked,'dist/cli.js'),'--help'],{windowsHide:true});
  assert.match(result.stdout,/Bookmark Agent/);
  assert.match(result.stdout,/--scope FOLDER_ID/);
});
test('CLI allows automatic selection and validates explicit profile selectors',()=>{
  assert.equal(parse(['tree']).sessionId,undefined);
  assert.equal(parse(['search','words','--profile','Work Chrome']).profile,'Work Chrome');
  assert.throws(()=>parse(['tree','--profile','  ']));
  assert.throws(()=>parse(['tree','--profile','Work','--session','00000000-0000-4000-8000-000000000000']));
  assert.throws(()=>parse(['status','--profile','Work']));
  assert.throws(()=>parse(['search','words','--session','a'.repeat(36),'--limti','2']));
  assert.throws(()=>parse(['commit','a'.repeat(36),'--session','a'.repeat(36)]));
  const p=parse(['create','--parent','2','--title','Research','--url','https://example.com','--session','00000000-0000-4000-8000-000000000000']);assert.equal(p.method,'preview');
});

test('profile selection rejects missing, ambiguous and unmatched connections',()=>{
  const main={sessionId:'main-session',profileId:'main-id',profileLabel:'Main Chrome'};
  const work={sessionId:'work-session',profileId:'work-id',profileLabel:'Work Chrome'};
  assert.equal(selectSession([main]),'main-session');
  assert.equal(selectSession([main,work],'main chrome'),'main-session');
  assert.equal(selectSession([main,work],'work-id'),'work-session');
  const rejects=(sessions,profile,code)=>assert.throws(()=>selectSession(sessions,profile),e=>e.code===code);
  rejects([],undefined,'NO_CONNECTED_PROFILE');
  rejects([main,work],undefined,'PROFILE_REQUIRED');
  rejects([main,work],'Offline Chrome','PROFILE_NOT_FOUND');
  rejects([main,{...work,profileLabel:'MAIN CHROME'}],'Main Chrome','PROFILE_AMBIGUOUS');
});
test('CLI talks to the authenticated fixture service and returns machine JSON',async t=>{
  const h=await harness();t.after(h.close);const env={...process.env,BOOKMARK_AGENT_HOME:h.dir};
  const result=await exec(process.execPath,['dist/cli.js','search','Example'],{env,windowsHide:true});
  const data=JSON.parse(result.stdout);assert.equal(data.ok,true);assert.equal(data.data.total,4);
  const preview=await exec(process.execPath,['dist/cli.js','remove','12'],{env,windowsHide:true});
  assert.equal(JSON.parse(preview.stdout).ok,true);assert.ok((await h.api.get('12'))[0]);
});
test('MCP SDK client discovers and invokes real stdio tools with preview/commit flow',async t=>{
  const h=await harness();t.after(h.close);
  const client=new Client({name:'fixture-client',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env:{...process.env,BOOKMARK_AGENT_HOME:h.dir},stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  const tools=await client.listTools();assert.equal(tools.tools.length,10);assert.equal(tools.tools.find(x=>x.name==='bookmark_commit').annotations.destructiveHint,true);
  const status=JSON.parse((await client.callTool({name:'bookmark_status',arguments:{}})).content[0].text);assert.equal(status.data.sessions.length,1);
  for(const tool of tools.tools.filter(x=>x.name!=='bookmark_status')){
    assert.ok(tool.inputSchema.properties.profile);
    assert.ok(!tool.inputSchema.required?.includes('sessionId'));
  }
  const p=JSON.parse((await client.callTool({name:'bookmark_preview',arguments:{actions:[{op:'update',id:'11',title:'Via MCP'}]}})).content[0].text);
  assert.equal((await h.api.get('11'))[0].title,'Example α');
  const result=JSON.parse((await client.callTool({name:'bookmark_commit',arguments:{previewId:p.data.previewId,confirm:true}})).content[0].text);
  assert.equal(result.ok,true);assert.equal((await h.api.get('11'))[0].title,'Via MCP');
});

test('CLI and MCP require a choice with multiple profiles and accept labels without UUIDs',async t=>{
  const h=await harness();t.after(h.close);const env={...process.env,BOOKMARK_AGENT_HOME:h.dir};
  const api=mockAPI();api.tree[0].children[0].children[0].children[0].title='Second profile only';
  const profileId=randomUUID();
  const ws=new WebSocket(`ws://127.0.0.1:${h.config.port}/bridge`,{headers:{Authorization:`Bearer ${h.config.bridgeToken}`}});
  const ready=new Promise((resolve,reject)=>{
    ws.once('error',reject);
    ws.on('message',async bytes=>{
      const m=JSON.parse(bytes);
      if(m.type==='ready')resolve(m);
      if(m.type==='request')ws.send(JSON.stringify({type:'response',id:m.id,ok:true,data:await readOperation(api,m.command)}));
    });
  });
  ws.on('open',()=>ws.send(JSON.stringify({type:'hello',profileId,profileLabel:'Work Chrome',extensionId:h.config.extensionId})));
  await ready;
  const run=args=>exec(process.execPath,['dist/cli.js',...args],{env,windowsHide:true});
  await assert.rejects(()=>run(['search','Example']),e=>JSON.parse(e.stdout).error.code==='PROFILE_REQUIRED');
  await assert.rejects(()=>run(['update','11','--title','Must not change']),e=>JSON.parse(e.stdout).error.code==='PROFILE_REQUIRED');
  await assert.rejects(()=>run(['search','Example','--profile','Offline']),e=>JSON.parse(e.stdout).error.code==='PROFILE_NOT_FOUND');
  const named=JSON.parse((await run(['search','Second profile only','--profile','work chrome'])).stdout);
  assert.equal(named.data.total,1);
  const stable=JSON.parse((await run(['search','Second profile only','--profile',profileId])).stdout);
  assert.equal(stable.data.total,1);
  assert.equal((await h.api.get('11'))[0].title,'Example α');
  const client=new Client({name:'selection-fixture-client',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env,stderr:'pipe'}));t.after(()=>client.close());
  const invoke=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
  assert.equal((await invoke('bookmark_search',{query:'Example'})).error.code,'PROFILE_REQUIRED');
  assert.equal((await invoke('bookmark_search',{query:'Second profile only',profile:'Work Chrome'})).data.total,1);
  assert.equal((await invoke('bookmark_search',{query:'Example',profile:'Work Chrome',sessionId:h.session})).error.code,'INVALID_PROFILE_SELECTION');
});

test('CLI scope flags reach the service and reject outside reads and writes',async t=>{
  const h=await harness();t.after(h.close);const env={...process.env,BOOKMARK_AGENT_HOME:h.dir};
  const run=args=>exec(process.execPath,['dist/cli.js',...args,'--session',h.session,'--scope','10'],{env,windowsHide:true});
  const tree=JSON.parse((await run(['tree'])).stdout);assert.equal(tree.data[0].id,'10');
  for(const args of [['get','30'],['create','--parent','2','--title','Outside','--url','https://example.org/']]) {
    await assert.rejects(()=>run(args),e=>JSON.parse(e.stdout).error.code==='OUT_OF_SCOPE');
  }
  const preview=JSON.parse((await run(['update','11','--title','CLI scoped'])).stdout);
  assert.deepEqual(preview.data.scope,{folderIds:['10'],includeDescendants:true});
  const commit=JSON.parse((await exec(process.execPath,['dist/cli.js','commit',preview.data.previewId,'--confirm','--session',h.session],{env,windowsHide:true})).stdout);
  assert.equal(commit.ok,true);assert.equal((await h.api.get('11'))[0].title,'CLI scoped');
});

test('MCP tools carry scope through discovery, bounded reads, preview and commit',async t=>{
  const h=await harness();t.after(h.close);
  const client=new Client({name:'scope-fixture-client',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env:{...process.env,BOOKMARK_AGENT_HOME:h.dir},stderr:'pipe'}));t.after(()=>client.close());
  const tools=await client.listTools();
  for(const tool of tools.tools.filter(x=>x.name!=='bookmark_status'))assert.ok(tool.inputSchema.properties.scope);
  const scope={folderIds:['10'],includeDescendants:false};
  const invoke=async(name,args)=>JSON.parse((await client.callTool({name,arguments:{sessionId:h.session,...args}})).content[0].text);
  const search=await invoke('bookmark_search',{query:'Example',scope});assert.equal(search.data.total,3);
  assert.equal((await invoke('bookmark_get',{id:'30',scope})).error.code,'OUT_OF_SCOPE');
  const preview=await invoke('bookmark_preview',{scope,actions:[{op:'update',id:'11',title:'MCP scoped'}]});assert.deepEqual(preview.data.scope,scope);
  const result=await invoke('bookmark_commit',{previewId:preview.data.previewId,confirm:true});assert.equal(result.ok,true);
  assert.deepEqual(result.data.scope,scope);assert.equal((await h.api.get('11'))[0].title,'MCP scoped');
});
