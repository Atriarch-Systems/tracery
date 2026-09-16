import test from 'node:test';
import assert from 'node:assert/strict';
import {placeBranches} from '../dist/layout.js';

test('growing camera cluster retains ordered slots and never moves existing cards', () => {
  let nodes=[{id:'source',label:'Source',position:{x:0,y:0,anchored:true}},{id:'camera',label:'Camera'}];
  let edges=[{id:'c',source:'source',target:'camera'}];
  let result=placeBranches(nodes,edges);
  const original=new Map(result.positions);
  for(let i=0;i<9;i++) {
    nodes=[...nodes,{id:'frame'+i,label:'Frame '+i,layout:{leaf:true,lane:-2,group:'frames'}}];
    edges=[...edges,{id:'f'+i,source:'camera',target:'frame'+i}];
    const before=result.positions;
    result=placeBranches(nodes,edges,before);
    for(const [id,p] of before) assert.deepEqual(result.positions.get(id),p);
    assert.equal(result.positions.get('frame'+i).slot,i);
  }
  const again=placeBranches(nodes,[...edges,{id:'back',source:'frame8',target:'source',count:900}],result.positions);
  assert.deepEqual(again.positions,result.positions);
  assert.deepEqual(result.positions.get('camera'),original.get('camera'));
  for(const a of result.positions.values()) for(const b of result.positions.values()) if(a!==b)
    assert.ok(Math.abs(a.x-b.x)>=(a.width+b.width)/2 || Math.abs(a.y-b.y)>=(a.height+b.height)/2);
});
test('parent can arrive later in array; missing parents and cycles remain finite', () => {
 const nodes=[{id:'b',label:'B'},{id:'a',label:'A',position:{x:0,y:0,anchored:true}},{id:'c',label:'C'}];
 const result=placeBranches(nodes,[{id:'ab',source:'a',target:'b'},{id:'cb',source:'c',target:'b'},{id:'bc',source:'b',target:'c'}]);
 assert.ok(result.positions.get('b').x>result.positions.get('a').x);
 assert.ok([...result.positions.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 assert.equal(nodes[0].position,undefined);
 assert.equal(placeBranches([],[],result.positions).positions.size,0);
});
