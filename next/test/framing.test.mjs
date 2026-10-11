import test from 'node:test';import assert from 'node:assert/strict';
import {NativeDecoder,encode} from '../dist/framing.js';
test('native framing supports split buffers, coalesced frames and UTF-8 byte lengths',()=>{
  const d=new NativeDecoder(),messages=[];d.on('message',m=>messages.push(m));d.on('error',e=>assert.fail(e));
  const data=Buffer.concat([encode({title:'研究 α'}),encode({id:'next'})]);
  for(let i=0;i<data.length;i+=3)d.push(data.subarray(i,i+3));assert.deepEqual(messages,[{title:'研究 α'},{id:'next'}]);
});
test('oversized, zero-size and malformed native frames fail without continuing',()=>{
  for(const bytes of [Buffer.from([0,0,0,0]),Buffer.from([100,0,0,0]),Buffer.concat([Buffer.from([1,0,0,0]),Buffer.from('{')])]){
    const d=new NativeDecoder(10);let error;d.on('error',e=>error=e);d.push(bytes);assert.ok(error);
  }
  assert.throws(()=>encode({large:'x'.repeat(1024*1024)}));
});
