import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createBookmarkService, digestTree } from '../dist/server.js';
import { readOperation, applyActions } from '../dist/operations.js';
import { flatten } from '../dist/protocol.js';
export function fixture() {
  return [{id:'0',title:'',children:[{id:'1',parentId:'0',title:'Bookmarks bar',folderType:'bookmarks-bar',children:[
    {id:'10',parentId:'1',title:'Research',dateAdded:1,children:[
      {id:'11',parentId:'10',title:'Example α',url:'https://example.com/',dateAdded:1},
      {id:'12',parentId:'10',title:'Example copy',url:'https://example.com/',dateAdded:2},
      {id:'13',parentId:'10',title:'Other',url:'https://sub.example.com/article#one',dateAdded:3},
      {id:'14',parentId:'10',title:'Bookmarklet',url:'javascript:alert(1)',dateAdded:4}
    ]} ]},{id:'2',parentId:'0',title:'Other bookmarks',folderType:'other',children:[]},
    {id:'3',parentId:'0',title:'Managed',unmodifiable:'managed',children:[{id:'30',parentId:'3',title:'Policy',url:'https://policy.example/'}]}]}];
}
export function mockAPI() {
  const tree = fixture(); let next = 100;
  const get = id => {const n=flatten(tree).find(n=>n.id===id);if(!n)throw Error('Node not found');return n;};
  const clone = x => structuredClone(x);
  const normalize = parent => (parent.children ?? []).forEach((n,index)=>{n.index=index;});
  return {
    tree, getTree:async()=>clone(tree), get:async id=>clone([get(id)]),
    getChildren:async id=>clone(get(id).children??[]),getSubTree:async id=>clone([get(id)]),
    search:async query=>clone(flatten(tree).filter(n=>(n.title+' '+(n.url??'')).toLowerCase().includes(query.toLowerCase()))),
    create:async p=>{const parent=get(p.parentId);if(parent.url)throw Error('Not a folder');const node={...p,id:String(next++),dateAdded:Date.now(),...(p.url?{}:{children:[]})};parent.children??=[];parent.children.splice(p.index??parent.children.length,0,node);normalize(parent);return clone(node);},
    update:async(id,p)=>{const n=get(id);Object.assign(n,p);return clone(n);},
    move:async(id,p)=>{const n=get(id),old=get(n.parentId),parent=get(p.parentId);old.children=old.children.filter(x=>x.id!==id);normalize(old);parent.children??=[];parent.children.splice(p.index??parent.children.length,0,n);n.parentId=p.parentId;normalize(parent);return clone(n);},
    remove:async id=>{const n=get(id);if(n.children?.length)throw Error('Folder not empty');const parent=get(n.parentId);parent.children=parent.children.filter(x=>x.id!==id);normalize(parent);},
    removeTree:async id=>{const n=get(id),parent=get(n.parentId);parent.children=parent.children.filter(x=>x.id!==id);normalize(parent);}
  };
}
export async function harness(options={}) {
  const dir=mkdtempSync(join(tmpdir(),'bookmark-agent-test-'));
  const config={version:2,port:0,token:randomBytes(32).toString('hex'),bridgeToken:randomBytes(32).toString('hex'),extensionId:'a'.repeat(32)};
  const service=createBookmarkService(config,{dataDir:dir,...options}); config.port=await service.listen();
  writeFileSync(join(dir,'config.json'),JSON.stringify(config));
  const api=mockAPI(); let session;
  const ws=new WebSocket(`ws://127.0.0.1:${config.port}/bridge`,{headers:{Authorization:`Bearer ${config.bridgeToken}`}});
  const ready=new Promise((resolve,reject)=>{ws.once('error',reject);ws.on('message',bytes=>{const m=JSON.parse(bytes);if(m.type==='ready'){session=m.sessionId;resolve(m);}});});
  ws.on('open',()=>ws.send(JSON.stringify({type:'hello',profileId:randomUUID(),profileLabel:'Isolated fixture profile',extensionId:config.extensionId})));
  ws.on('message',async bytes=>{
    const m=JSON.parse(bytes);if(m.type!=='request')return;
    try {
      const data=m.command.method==='apply' ? await applyActions(api,m.command.params.actions,JSON.stringify(await api.getTree())) : await readOperation(api,m.command);
      if(options.dropApply && m.command.method==='apply')return;
      ws.send(JSON.stringify({type:'response',id:m.id,ok:true,data}));
    }catch(e){ws.send(JSON.stringify({type:'response',id:m.id,ok:false,error:{code:e.code??'CHROME_ERROR',message:e.message,details:e.details}}));}
  });
  await ready;
  const http=async(path,body,headers={})=>{
    const res=await fetch(`http://127.0.0.1:${config.port}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:res.status,body:await res.json()};
  };
  return {dir,config,api,service,ws,session,http,
    rpc:async(method,params={})=>(await http('/api/v1/rpc',{sessionId:session,request:{method,params}})).body,
    close:()=>service.close()};
}
