import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {randomUUID,randomBytes} from 'node:crypto';import {promisify} from 'node:util';
import {createBookmarkService} from '../dist/server.js';import {NativeDecoder,encode} from '../dist/framing.js';import {readOperation,applyActions} from '../dist/operations.js';import {mockAPI} from './mock.mjs';
for (const useLauncher of [false, true]) test(useLauncher ? 'compiled Windows launcher flushes binary native handshake and Unicode responses' : 'real native host forwards binary frames between simulated extension and service', {skip:useLauncher&&process.platform!=='win32'},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bookmark-native-test-')),config={version:2,port:0,token:randomBytes(32).toString('hex'),bridgeToken:randomBytes(32).toString('hex'),extensionId:'a'.repeat(32)};
  const service=createBookmarkService(config,{dataDir:dir});config.port=await service.listen();t.after(()=>service.close());
  writeFileSync(join(dir,'config.json'),JSON.stringify(config));const api=mockAPI(),decoder=new NativeDecoder();
  let executable=process.execPath,args=[resolve('dist/native-host.js'),`chrome-extension://${config.extensionId}/`];
  if(useLauncher){
    const csc=[join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),join(process.env.WINDIR,'Microsoft.NET','Framework','v4.0.30319','csc.exe')].find(existsSync);
    assert.ok(csc,'Existing .NET Framework compiler is required for launcher test');
    const literal=value=>'@"'+value.replaceAll('"','""')+'"';
    const source=readFileSync('scripts/launcher.cs','utf8').replace('@@NODE@@',literal(process.execPath)).replace('@@HOST@@',literal(resolve('dist/native-host.js'))).replace('@@CONFIG@@',literal(dir));
    const sourcePath=join(dir,'launcher.cs');writeFileSync(sourcePath,source);executable=join(dir,'fixture-host.exe');args=[`chrome-extension://${config.extensionId}/`];
    await promisify(execFile)(csc,['/nologo','/target:winexe',`/out:${executable}`,sourcePath],{windowsHide:true});
  }
  const child=spawn(executable,args,{env:{...process.env,BOOKMARK_AGENT_HOME:dir},stdio:['pipe','pipe','pipe'],windowsHide:true});
  t.after(()=>child.kill());let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
  child.stdout.on('data',bytes=>decoder.push(bytes));decoder.on('error',e=>assert.fail(e));
  const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Native handshake timed out: '+stderr)),5000);decoder.on('message',m=>{if(m.type==='ready'){clearTimeout(timeout);resolve(m);}});});
  decoder.on('message',async m=>{
    if(m.type!=='request')return;
    try{const data=m.command.method==='apply'?await applyActions(api,m.command.params.actions,JSON.stringify(await api.getTree())):await readOperation(api,m.command);child.stdin.write(encode({type:'response',id:m.id,ok:true,data},64*1024*1024));}
    catch(e){child.stdin.write(encode({type:'response',id:m.id,ok:false,error:{code:e.code??'CHROME_ERROR',message:e.message}}));}
  });
  child.stdin.write(encode({type:'hello',profileId:randomUUID(),profileLabel:'Binary α profile',extensionId:config.extensionId}));const connected=await ready;
  const rpc=async(method,params={})=>{const r=await fetch(`http://127.0.0.1:${config.port}/api/v1/rpc`,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify({sessionId:connected.sessionId,request:{method,params}})});return r.json();};
  const data=await rpc('search',{query:'Example'});assert.equal(data.ok,true);assert.equal(data.data.items[0].title,'Example α');
  const p=await rpc('preview',{actions:[{op:'update',id:'11',title:'Native 研究'}]});const result=await rpc('commit',{previewId:p.data.previewId,confirm:true});assert.equal(result.ok,true);assert.equal((await api.get('11'))[0].title,'Native 研究');
});
