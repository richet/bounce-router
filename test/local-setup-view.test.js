import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalSetupView} from '../src/local-setup-view.js';

test('setup view takes answers independently and cancelling pending work blocks late save', async () => {
  let release, saves=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const view=createLocalSetupView({save:()=>{saves++;},run:async({ask,write,save})=>{
    const answer=await ask('Purpose?'); assert.equal(answer,'research');
    write('Discovering…'); await pending; write('late result');
    await save({}); return {saved:true};
  }});
  assert.equal(view.state.question,'Purpose?');
  assert.equal(view.answer('research'),true);
  await Promise.resolve();
  assert.equal(view.state.question,null);
  view.cancel(); release();
  await view.done;
  assert.equal(saves,0);
  assert.equal(view.state.active,false);
  assert.equal(view.state.lines.includes('late result'),false);
});

test('setup view supports blank defaults and bounds output without mutating active agents', async () => {
  const view=createLocalSetupView({run:async({ask,write})=>{
    assert.equal(await ask('Confirm?'),'');
    for(let i=0;i<100;i++)write(`line${i}`);
    return {saved:false};
  }});
  view.answer(''); await view.done;
  assert.ok(view.state.lines.length<=12);
  assert.equal(view.state.lines.at(-1),'line99');
});
