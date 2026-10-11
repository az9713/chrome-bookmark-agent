// Render synthetic bookmarks for the public README; never connects to a real profile.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { harness } from '../test/mock.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const h=await harness();
const research=h.api.tree[0].children[0].children[0];
research.title='AI Research';
research.children=[
  {id:'11',parentId:'10',title:'Attention Is All You Need',url:'https://arxiv.org/abs/1706.03762'},
  {id:'12',parentId:'10',title:'MCP TypeScript SDK',url:'https://github.com/modelcontextprotocol/typescript-sdk'},
  {id:'13',parentId:'10',title:'Chrome bookmarks API',url:'https://developer.chrome.com/docs/extensions/reference/api/bookmarks'}
];
h.api.tree[0].children[1].children=[{id:'20',parentId:'2',title:'Reading Queue',children:[
  {id:'21',parentId:'20',title:'OpenAI Codex documentation',url:'https://developers.openai.com/codex/'},
  {id:'22',parentId:'20',title:'Claude Code documentation',url:'https://code.claude.com/docs/'}
]}];
h.service.sessions.get(h.session).profileLabel='Demo profile';
let browser;
try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  await page.goto(`http://127.0.0.1:${h.config.port}`);
  await page.getByRole('link',{name:'Attention Is All You Need',exact:true}).waitFor();
  await page.getByRole('button',{name:'Choose folders',exact:true}).click();
  for(const id of ['10','20']){
    await page.getByLabel('Find scope folders',{exact:true}).fill(id);
    await page.getByLabel(`Scope folder ${id}`,{exact:true}).check();
  }
  await page.getByRole('button',{name:'Apply scope',exact:true}).click();
  await page.getByText('2 selected folders · Including subfolders',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Attention Is All You Need',exact:true}).waitFor();
  const folder=fileURLToPath(new URL('../docs/assets/',import.meta.url));
  mkdirSync(folder,{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL('../docs/assets/manager-demo.png',import.meta.url)),fullPage:false});
  console.log('Saved synthetic manager screenshot. No real bookmarks or credentials accessed.');
} finally {await browser?.close();await h.close();}
