const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const code=name=>fs.readFileSync(path.join(root,name),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const core=require('../content-core.js').createAdaptiveTranslationCore();
test('long paragraphs keep every sentence and split oversized sentences',()=>{
 const source=Array.from({length:20},(_,i)=>`Sentence number ${i} is readable.`).join(' ');
 assert.equal(core.splitIntoSentences(source).length,20);
 const large='word '.repeat(1200).trim();
 const parts=core.splitIntoSentences(large);
 assert(parts.every(p=>p.text.length<=1600));
 assert.equal(parts.map(p=>p.text).join(' '),large);
 assert.equal(core.shouldForceAnnotationOnlyForCollect('completed'),false);
});
test('scheduler caps concurrency and drops cancelled queued work',async()=>{
 const scheduler=require('../request-scheduler.js').create(2);
 let active=0,peak=0,release=[];
 const task=()=>new Promise(resolve=>{active++;peak=Math.max(peak,active);release.push(()=>{active--;resolve();});});
 const a=scheduler.run(task),b=scheduler.run(task); await tick();
 const abort=new AbortController(); let called=false;
 const c=scheduler.run(()=>{called=true},abort.signal); abort.abort();
 await assert.rejects(c,{name:'AbortError'});
 release.forEach(fn=>fn()); await Promise.all([a,b]);
 assert.equal(peak,2);assert.equal(called,false);
});
function background(fetcher){
 const callbacks={};
 const context=vm.createContext({console:{warn(){},error(){}},AbortController,DOMException,setTimeout,clearTimeout,fetch:fetcher,
 chrome:{runtime:{onMessage:{addListener:fn=>callbacks.message=fn},onInstalled:{addListener(){}}},
 tabs:{onUpdated:{addListener:fn=>callbacks.updated=fn},onRemoved:{addListener(){}}},
 storage:{local:{get:async()=>({apiKey:'test-placeholder',model:'qwen3.8-flash',baseUrl:'https://example.test/v1',serviceProvider:'aliyun',thinkingMode:'off'}),set:async()=>{}}}}});
 context.importScripts=(...names)=>names.forEach(name=>vm.runInContext(code(name),context));
 vm.runInContext(code('background.js'),context);
 return {context,callbacks,call:(expression)=>vm.runInContext(expression,context)};
}
test('HTTP 401 performs exactly one call, is fatal and never falls back',async()=>{
 let calls=0;const bg=background(async()=>{calls++;return {ok:false,status:401}});
 const result=await bg.call("handleAnnotate('This paragraph contains sufficient English text for translation.', 'paragraph','full','on',[{id:1,text:'This paragraph contains sufficient English text for translation.'}])");
 assert.equal(calls,1); assert.equal(result.fatal,true); assert.equal(result.retryable,false);
});
test('empty valid annotation result is cached without an extra model call',async()=>{
 let calls=0;const bg=background(async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:'[]'}}]})}});
 const expression="handleAnnotate('An extraordinary methodological investigation considers unprecedented experimental observations.', 'paragraph','full','off',[])";
 await bg.call(expression);await bg.call(expression);assert.equal(calls,1);
});
test('cancelling active tab aborts transport and does not invoke fallback',async()=>{
 let calls=0,aborted=false;
 const bg=background((url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancel','AbortError'))}))});
 const result=bg.call("scopedAnnotate({text:'An English paragraph for cancel testing.',contextType:'paragraph',paragraphTranslationMode:'on',sentences:[{id:1,text:'An English paragraph for cancel testing.'}],runId:1},{tab:{id:7},documentId:'doc'})");
 await tick();bg.call('cancelTabRequests(7)');
 const value=await result;assert.equal(value.cancelled,true);assert.equal(calls,1);assert.equal(aborted,true);
});
function page(html,responder){
 const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window; let listener;const requests=[];
 w.HTMLElement.prototype.getBoundingClientRect=function(){const top=Number(this.dataset.top||100);return {top,bottom:top+40,width:600,height:40,left:0,right:600}};
 w.chrome={runtime:{sendMessage:async msg=>{
   if(msg.type==='getSettings')return {concurrency:3,paragraphTranslationMode:'on'};
   if(msg.type==='checkAutoTranslate')return {shouldTranslate:false};
   if(msg.type==='annotate'){requests.push(msg);return responder?responder(msg):{annotations:[],sentenceTranslations:msg.sentences.map(s=>({id:s.id,translation:'这是中文译文。'}))};}
   return {ok:true};
 },onMessage:{addListener:fn=>listener=fn}},storage:{onChanged:{addListener(){}},local:{get(){}}}};
 for(const name of ['content-core.js','content-run-state.js','content.js'])w.eval(code(name));
 const send=type=>new Promise(resolve=>listener({type},{},resolve));
 return {w,dom,requests,send};
}
test('viewport-only, source exclusions, restore, and late-result suppression',async()=>{
 const p=page('<p id="first">A complete English paragraph contains enough words to translate properly. <code>privateCodeValue</code></p><p data-top="5000">This paragraph is far below the viewport and must wait.</p><p hidden>This hidden English text must never be sent.</p>');
 await tick();await p.send('startPageAnnotating');await tick();
 assert.equal(p.requests.length,1);assert(!p.requests[0].text.includes('privateCodeValue'));
 assert.equal(p.w.document.querySelectorAll('.adaptive-translation-paragraph-translation').length,1);
 assert.equal((await p.send('getPageStatus')).enabled,true);
 await p.send('stopPageAnnotating');assert.equal(p.w.document.querySelectorAll('.adaptive-translation-paragraph-translation').length,0);
 assert(p.w.document.querySelector('code'));p.dom.window.close();
 let resolve;const late=page('<p>This English paragraph should never be changed after cancellation.</p>',()=>new Promise(r=>resolve=r));
 await tick();await late.send('startPageAnnotating');await tick();await late.send('stopPageAnnotating');
 resolve({annotations:[],sentenceTranslations:[{id:1,translation:'迟到的结果'}]});await tick();
 assert.equal(late.w.document.querySelectorAll('.adaptive-translation-paragraph-translation').length,0);late.dom.window.close();
});
test('changed paragraph and newly revealed text receive bilingual results after completion',async()=>{
 const p=page('<p id="first">This is the first English paragraph with enough readable words.</p><p id="later" hidden>This is a newly revealed paragraph with enough English text.</p>');
 await tick();await p.send('startPageAnnotating');await tick();
 p.w.document.getElementById('first').textContent='This changed paragraph contains different English text and must be translated again.';
 p.w.document.getElementById('later').hidden=false;
 await new Promise(r=>setTimeout(r,950));
 assert.equal(p.requests.length,3);assert(p.requests.every(r=>r.paragraphTranslationMode==='on'));
 assert.equal(p.w.document.querySelectorAll('.adaptive-translation-paragraph-translation').length,2);p.dom.window.close();
});
test('identical in-flight work is shared, missing sentences do not enter successful cache',async()=>{
 let calls=0,release;
 const bg=background(()=>{calls++;return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({choices:[{message:{content:'[]'}}]})}))});
 const job="scopedAnnotate({text:'Some ordinary English words.',contextType:'paragraph',paragraphTranslationMode:'off',sentences:[],runId:1},{tab:{id:7},documentId:'doc'})";
 const a=bg.call(job),b=bg.call(job);await tick();assert.equal(calls,1);release();await Promise.all([a,b]);
 let count=0;const partial=background(async()=>{count++;return {ok:true,json:async()=>({choices:[{message:{content:count%2?' {"annotations":[],"sentences":[]}':'[]'}}]})}});
 const request="handleAnnotate('A full English paragraph that must have a translated sentence.', 'paragraph','full','on',[{id:1,text:'A full English paragraph that must have a translated sentence.'}])";
 assert((await partial.call(request)).warning);assert((await partial.call(request)).warning);assert.equal(count,4);
});
test('long paragraph batches preserve all sentence IDs without repeating whole source in prompt',async()=>{
 const bg=background(async(url,options)=>{
  const prompt=JSON.parse(options.body).messages[0].content;
  const ids=[...prompt.matchAll(/^\[(\d+)\] /gm)].map(m=>Number(m[1]));
  assert(ids.length<=8);assert(!prompt.includes('完整段落：'));
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({annotations:[],sentences:ids.map(id=>({id,translation:'这是对应译文'}))})}}]})};
 });
 const result=await bg.call("callRichLLM('full text',Array.from({length:20},(_,i)=>({id:i+1,text:'A full English sentence for testing.'})), 'L3',{apiKey:'test-placeholder',model:'qwen3.8-flash',baseUrl:'https://example.test/v1'},'paragraph')");
 assert.equal(result.sentenceTranslations.length,20);assert.equal(result.sentenceTranslations[19].id,20);
});
test('DOM source reuse while awaiting a reply never paints a stale translation',async()=>{
 let done;
 const p=page('<p id="live">The original paragraph is waiting for an asynchronous translation.</p>',()=>new Promise(resolve=>done=resolve));
 await tick();await p.send('startPageAnnotating');await tick();
 p.w.document.getElementById('live').textContent='New content belongs to a different article and must not receive the old translation.';
 done({annotations:[],sentenceTranslations:[{id:1,translation:'过期翻译'}]});await tick();
 assert.equal(p.w.document.querySelectorAll('.adaptive-translation-paragraph-translation').length,0);
 await p.send('stopPageAnnotating');p.dom.window.close();
});

test('root dark background yields a readable translation color',async()=>{
 const p=page('<html style="background-color:rgb(20,20,20)"><body><p>A readable paragraph for testing dark page backgrounds.</p></body></html>');
 await tick();await p.send('startPageAnnotating');await tick();
 const color=p.w.document.querySelector('.adaptive-translation-paragraph-translation').style.color;
 const rgb=color.match(/\d+/g).map(Number);
 const lum=a=>a.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
 assert((lum(rgb)+.05)/(lum([20,20,20])+.05)>=4.5);p.dom.window.close();
});

test('calibration returns its API error without referencing a page signal',async()=>{
 const bg=background(async()=>({ok:false,status:401}));
 const result=await bg.call("handleCalibrate('An extraordinary academic calibration example.', 'L3')");
 assert.equal(result.fatal,true);assert.match(result.error,/401/);
});
