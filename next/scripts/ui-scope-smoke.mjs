// Browser tests use an isolated synthetic profile, never the user's Chrome data.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { harness } from '../test/mock.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output=resolve('output/playwright');mkdirSync(output,{recursive:true});
const h=await harness();
h.api.tree[0].children[0].children[0].children.push({id:'15',parentId:'10',title:'Nested',children:[{id:'16',parentId:'15',title:'Nested scoped link',url:'https://nested.example.org/'}]});
h.api.tree[0].children[1].children.push(
  {id:'20',parentId:'2',title:'Notes',children:[{id:'21',parentId:'20',title:'Notes scoped link',url:'https://example.com/'}]},
  {id:'40',parentId:'2',title:'Outside',children:[{id:'41',parentId:'40',title:'Outside private link',url:'https://outside.example.org/'}]}
);
const outsideBefore=JSON.stringify(await h.api.getSubTree('40'));
let browser;const checks=[],errors=[],requests=[];
try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().endsWith('/api/v1/rpc'))requests.push(r.postDataJSON().request);});
  await page.goto(`http://127.0.0.1:${h.config.port}`);
  await page.getByRole('link',{name:'Outside private link',exact:true}).waitFor();
  async function choose(ids,recursive=true) {
    await page.getByRole('button',{name:'Choose folders',exact:true}).click();
    await page.getByRole('heading',{name:'Choose action scope',exact:true}).waitFor();
    for(const id of ids) {await page.getByLabel('Find scope folders',{exact:true}).fill(id);await page.getByLabel(`Scope folder ${id}`,{exact:true}).check();}
    await page.getByLabel('Include subfolders',{exact:true}).setChecked(recursive);
    await page.getByRole('button',{name:'Apply scope',exact:true}).click();
  }
  await choose(['10','20']);
  await page.getByText('2 selected folders · Including subfolders',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Notes scoped link',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Outside private link',exact:true}).count(),0);
  assert.equal(await page.locator('.collection-bar>span').innerText(),'7 items');
  checks.push('Searchable multi-folder picker restricts results to the selected union, including subfolders by default');
  await page.getByLabel('Search bookmarks',{exact:true}).fill('scoped');await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByText('2 matches for “scoped”',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Clear search',exact:true}).click();await page.getByText('7 items',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Duplicate finder',exact:true}).click();
  await page.getByRole('heading',{name:'https://example.com/',exact:true}).waitFor();assert.equal(await page.locator('article.bookmark').count(),3);
  await page.getByRole('button',{name:'Rediscover',exact:true}).click();await page.getByRole('link',{name:'Notes scoped link',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Outside private link',exact:true}).count(),0);
  await page.getByRole('button',{name:'All bookmarks',exact:true}).click();await page.getByText('7 items',{exact:true}).waitFor();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export JSON',exact:true}).click();await downloaded;
  assert.deepEqual(requests.findLast(r=>r.method==='export').params.scope,{folderIds:['10','20'],includeDescendants:true});
  checks.push('Search, duplicate finder, rediscovery and export all carry the selected scope');
  await page.getByRole('button',{name:'Choose folders',exact:true}).click();
  await page.getByLabel('Include subfolders',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Apply scope',exact:true}).click();
  await page.getByText('2 selected folders · Direct children only',{exact:true}).waitFor();
  await page.getByText('6 items',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Nested scoped link',exact:true}).count(),0);
  await page.getByRole('button',{name:'+ Save a link',exact:true}).click();
  assert.deepEqual(await page.getByLabel('Bookmark folder',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','10','20']);
  await page.getByLabel('Title',{exact:true}).fill('Scoped UI test');await page.getByLabel('URL',{exact:true}).fill('https://scoped-ui.example.org/');
  await page.getByLabel('Bookmark folder',{exact:true}).selectOption('20');
  await page.getByRole('button',{name:'Preview change',exact:true}).click();await page.getByRole('button',{name:'Confirm and apply',exact:true}).waitFor();
  assert.match(await page.locator('.preview').innerText(),/Scope: Research \(10\), Notes \(20\) · Direct children only/);
  assert.equal((await h.api.search('Scoped UI test')).length,0);
  await page.getByRole('button',{name:'Confirm and apply',exact:true}).click();await page.getByRole('link',{name:'Scoped UI test',exact:true}).waitFor();
  const created=(await h.api.search('Scoped UI test'))[0];assert.equal(created.parentId,'20');
  await page.locator('article.bookmark').filter({has:page.getByRole('link',{name:'Scoped UI test',exact:true})}).getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Scoped UI edited');await page.getByRole('button',{name:'Preview change',exact:true}).click();await page.getByRole('button',{name:'Confirm and apply',exact:true}).waitFor();
  assert.equal((await h.api.get(created.id))[0].title,'Scoped UI test');
  await page.getByRole('button',{name:'Confirm and apply',exact:true}).click();await page.getByRole('link',{name:'Scoped UI edited',exact:true}).waitFor();
  await page.getByLabel('Select Scoped UI edited',{exact:true}).check();
  assert.deepEqual(await page.getByLabel('Destination for selected nodes',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','10','20']);
  await page.getByLabel('Destination for selected nodes',{exact:true}).selectOption('10');
  await page.getByRole('button',{name:'Preview move',exact:true}).click();await page.getByRole('button',{name:'Confirm and apply',exact:true}).waitFor();
  await page.getByRole('button',{name:'Confirm and apply',exact:true}).click();await page.getByRole('link',{name:'Scoped UI edited',exact:true}).waitFor();
  assert.equal((await h.api.get(created.id))[0].parentId,'10');
  await page.getByLabel('Select Scoped UI edited',{exact:true}).check();await page.getByRole('button',{name:'Preview deletion',exact:true}).click();await page.getByRole('button',{name:'Confirm and apply',exact:true}).waitFor();
  await page.getByRole('button',{name:'Confirm and apply',exact:true}).click();await page.getByText('6 items',{exact:true}).waitFor();await assert.rejects(()=>h.api.get(created.id));
  assert.equal(JSON.stringify(await h.api.getSubTree('40')),outsideBefore);
  assert.ok(requests.filter(r=>r.method==='preview').every(r=>r.params.scope?.folderIds.join(',')==='10,20'&&r.params.scope.includeDescendants===false));
  checks.push('Scoped create, edit, move and delete retain previews and confirmation; destinations exclude out-of-scope folders and nested folders in direct-only mode; outside data stays unchanged');
  for(const width of [390,650,852,1440]) {await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:resolve(output,'scope-desktop.png'),fullPage:true});
  checks.push('Scoped manager fits 390, 650, 852 and 1440 pixel widths');
  await page.getByRole('button',{name:'Clear scope',exact:true}).click();await page.getByRole('link',{name:'Outside private link',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Clear scope',exact:true}).count(),0);
  await page.getByRole('button',{name:'Choose folders',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Apply scope',exact:true}).isEnabled(),false);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  checks.push('Clearing scope explicitly restores the library; an empty selection cannot silently become a scope');
  assert.deepEqual(errors,[]);
  writeFileSync(resolve(output,'scope-validation.json'),JSON.stringify({passed:true,checks,errors,profile:'Synthetic fixture only'},null,2));
  console.log(JSON.stringify({passed:true,checks,errors},null,2));
} catch(e) {writeFileSync(resolve(output,'scope-validation.json'),JSON.stringify({passed:false,checks,errors,failure:e.message},null,2));throw e;}
finally {await browser?.close();await h.close();}
