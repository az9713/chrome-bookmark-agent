import test from 'node:test';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {mockAPI} from './mock.mjs';import {digestTree} from '../dist/server.js';
test('built worker validates commands, profile handshake, stale plans and settings sender',async()=>{
  const api=mockAPI(),out=[],nativeListeners=[],runtimeListeners=[];
  const prefs={enabled:true,profileLabel:'Mock worker profile'};
  const port={postMessage:m=>out.push(m),disconnect:()=>{},onMessage:{addListener:fn=>nativeListeners.push(fn)},onDisconnect:{addListener:()=>{}}};
  globalThis.chrome={bookmarks:api,storage:{local:{get:async()=>({...prefs}),set:async p=>Object.assign(prefs,p)}},runtime:{
    id:'a'.repeat(32),connectNative:()=>port,getURL:path=>'chrome-extension://'+'a'.repeat(32)+'/'+path,
    onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}},onMessage:{addListener:fn=>runtimeListeners.push(fn)},openOptionsPage:async()=>{}
  },action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:{addListener:()=>{}}},alarms:{create:async()=>{},onAlarm:{addListener:()=>{}}}};
  const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Mock worker did not respond');};
  try{
    await import(pathToFileURL(resolve('dist/extension/background.js')).href+'?fixture='+randomUUID());
    await wait(()=>out.some(m=>m.type==='hello'));assert.equal(out[0].profileLabel,prefs.profileLabel);assert.match(out[0].profileId,/^[a-f0-9-]{36}$/);
    nativeListeners[0]({type:'ready',sessionId:randomUUID(),port:32180});
    const call=async command=>{const id=randomUUID();nativeListeners[0]({type:'request',id,command});await wait(()=>out.some(m=>m.id===id));return out.find(m=>m.id===id);};
    const tree=await call({method:'tree',params:{}});assert.equal(tree.ok,true);
    const invalid=await call({method:'apply',params:{actions:[{op:'create',parentId:'2',title:'Bad',url:'javascript:alert(1)'}],digest:digestTree(await api.getTree())}});assert.equal(invalid.error.code,'INVALID_INPUT');
    const stale=await call({method:'apply',params:{actions:[{op:'remove',id:'12'}],digest:'0'.repeat(64)}});assert.equal(stale.error.code,'STALE_PREVIEW');assert.ok((await api.get('12'))[0]);
    const result=await call({method:'apply',params:{actions:[{op:'update',id:'11',title:'Worker updated'}],digest:digestTree(await api.getTree())}});assert.equal(result.ok,true);assert.equal((await api.get('11'))[0].title,'Worker updated');
    let replied=false;runtimeListeners[0]({type:'status'},{id:'a'.repeat(32),url:'https://evil.example/'},()=>replied=true);assert.equal(replied,false);
    const status=await new Promise(resolve=>runtimeListeners[0]({type:'status'},{id:'a'.repeat(32),url:chrome.runtime.getURL('options.html')},resolve));assert.equal(status.connected,true);
    const disabled=await new Promise(resolve=>runtimeListeners[0]({type:'configure',settings:{enabled:false,profileLabel:prefs.profileLabel}},{id:'a'.repeat(32),url:chrome.runtime.getURL('options.html')},resolve));assert.equal(disabled.status.enabled,false);
  }finally{delete globalThis.chrome;}
});
