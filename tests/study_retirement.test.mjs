import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { speak } from '../ui/speech.js';

test('episode pronunciation uses the device voice without a network request', () => {
  const calls=[];
  globalThis.window={speechSynthesis:{cancel:()=>calls.push('cancel'), resume:()=>calls.push('resume'), speak:u=>calls.push(u)}};
  globalThis.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
  try {
    speak('Hello');
    assert.deepEqual(calls.slice(0,2), ['cancel','resume']);
    assert.equal(calls[2].text,'Hello');
    assert.equal(calls[2].lang,'en-US');
  } finally {delete globalThis.window; delete globalThis.SpeechSynthesisUtterance;}
});

test('SW upgrade retires speech cache but preserves episode audio, documents and data', async () => {
  const handlers={}, removed=[];
  const context=vm.createContext({URL,Response,console,
    self:{location:{origin:'https://aep-review.vercel.app'},addEventListener:(name,fn)=>{handlers[name]=fn;},clients:{claim:async()=>{}}},
    caches:{keys:async()=>['aep-review-shell-v1.79.0','aep-review-tts-v1','aep-review-audio-v1','aep-review-doc-v1','aep-review-data-v1'],delete:async name=>removed.push(name)},
    fetch:()=>{throw Error('Retired speech must never reach the network');}});
  vm.runInContext(fs.readFileSync(new URL('../ui/service-worker.js',import.meta.url),'utf8'),context);
  let completion;
  handlers.activate({waitUntil:p=>{completion=p;}});
  await completion;
  assert.deepEqual(removed,['aep-review-shell-v1.79.0','aep-review-tts-v1']);
  let result;
  handlers.fetch({request:{method:'GET',url:'https://lbcvuztpyaapyckxmqhk.supabase.co/storage/v1/object/public/tts/old.mp3'},respondWith:p=>{result=p;}});
  assert.equal((await result).status,410);
});

test('all precached application files exist after Study modules are removed', () => {
  const handlers={};
  const context=vm.createContext({self:{addEventListener:(name,fn)=>{handlers[name]=fn;}}});
  const source=fs.readFileSync(new URL('../ui/service-worker.js',import.meta.url),'utf8');
  vm.runInContext(source+'\nglobalThis.shellFiles=SHELL_CRITICAL;',context);
  for(const path of context.shellFiles){
    const filename=path==='/'?'index.html':path.slice(1).split('?')[0];
    assert.ok(fs.existsSync(new URL('../ui/'+filename,import.meta.url)),filename);
    assert.ok(!/views\/(study|srs|essentials)|\/(tts|proficiency|convo|marks|clip)\.js/.test(path),path);
  }
});
