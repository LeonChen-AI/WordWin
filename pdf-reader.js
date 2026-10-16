import {getDocument, GlobalWorkerOptions} from './vendor/pdfjs/pdf.mjs';
GlobalWorkerOptions.workerSrc=chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
const $=id=>document.getElementById(id);
const {extractParagraphs,validateSourceUrl}=globalThis.AdaptivePdfTextCore;
const MAX_BYTES=25*1024*1024;
let loadingTask=null,pdf=null,pageNumber=1,generation=0,renderTask=null,download=null,sourceGeneration=0,zoomTask=null,zoomGeneration=0;
const bridge=window.AdaptivePdfTranslation;
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function stop(){bridge.stop();$('stop').disabled=true;$('translate').disabled=!pdf || !$('reading-text').querySelector('p');}
function syncNavigation(){
 $('page-number').disabled=!pdf;$('page-number').value=pageNumber;$('page-number').max=pdf?.numPages||1;
 $('page-count').textContent=pdf?.numPages||'—';$('prev').disabled=!pdf||pageNumber<=1;$('next').disabled=!pdf||pageNumber>=pdf.numPages;
}
async function showPage(number){
 if(!pdf)return;
 closeZoom();const request=++generation;stop();renderTask?.cancel();pageNumber=Math.max(1,Math.min(pdf.numPages,number));syncNavigation();
 $('translate').disabled=true;$('zoom-original').disabled=true;$('reading-text').replaceChildren();status(`正在读取第 ${pageNumber} 页…`);
 try{
  const page=await pdf.getPage(pageNumber);if(request!==generation)return;
  const base=page.getViewport({scale:1});
  const viewport=page.getViewport({scale:Math.min(1.6,1200/base.width,Math.sqrt(8000000/(base.width*base.height)))});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport});
  await renderTask.promise;if(request!==generation)return;
  $('original').replaceChildren(canvas);$('zoom-original').disabled=false;
  const text=await page.getTextContent();if(request!==generation)return;
  const result=extractParagraphs(text.items,base.width);
  let length=0;
  for(const paragraph of result.paragraphs){length+=paragraph.length;if(length>40000)break;const p=document.createElement('p');p.textContent=paragraph;if(/@/.test(paragraph))p.dataset.readerSkip='true';$('reading-text').appendChild(p);}
  $('layout-note').textContent=result.columns===2?'已按双栏顺序整理；请核对原页':'已提取文字；复杂排版请核对原页';
  const readable=length>20 && result.paragraphs.some(p=>AdaptiveTranslationCore.detectTextLanguage(p));
  $('translate').disabled=!readable;
  status(readable?`第 ${pageNumber} 页已就绪。点击翻译后随阅读位置继续，翻页会暂停。`:'本页没有可用文字，可能是扫描件或仅含图表；暂不支持 OCR。',!readable);
 }catch(err){if(request!==generation||err.name==='RenderingCancelledException')return;status('本页读取失败：'+err.message,true);}
}
async function openBytes(bytes,name){
 closeZoom();stop();const request=++generation;renderTask?.cancel();const old=loadingTask;loadingTask=null;pdf=null;syncNavigation();
 $('reading-text').replaceChildren();$('original').replaceChildren();$('zoom-original').disabled=true;$('translate').disabled=true;
 if(old)await old.destroy();if(request!==generation)return;
 if(bytes.byteLength>MAX_BYTES){status('文件超过 25 MB，请使用较小的 PDF。',true);return;}
 if(!new TextDecoder('latin1').decode(bytes.slice(0,1024)).includes('%PDF-')){status('这不是有效的 PDF 文件。',true);return;}
 status('正在本机解析 PDF…');$('document-name').textContent=name;
 loadingTask=getDocument({data:bytes,useSystemFonts:true,useWasm:false,isEvalSupported:false});
 loadingTask.onPassword=()=>{if(request===generation){status('此 PDF 需要密码，请先在本机解锁后重新打开。',true);loadingTask.destroy();}};
 try{const doc=await loadingTask.promise;if(request!==generation)return;pdf=doc;await showPage(1);}
 catch(err){if(request===generation)status('无法打开 PDF：'+err.message,true);}
}
$('pdf-file').addEventListener('change',async event=>{
 const file=event.target.files[0];if(!file)return;const sourceRequest=++sourceGeneration;stop();download?.abort();download=null;
 $('pdf-url').value='';history.replaceState(null,'',chrome.runtime.getURL('pdf-reader.html'));
 if(file.size>MAX_BYTES){status('文件超过 25 MB，请使用较小的 PDF。',true);return;}
 try{const bytes=new Uint8Array(await file.arrayBuffer());if(sourceRequest!==sourceGeneration)return;await openBytes(bytes,file.name);}catch(err){status('读取文件失败：'+err.message,true);}
});
async function openUrl(){
 const url=validateSourceUrl($('pdf-url').value.trim());if(!url){status('请输入不含账号密码的 http(s) PDF 链接。',true);return;}
 ++sourceGeneration;stop();$('translate').disabled=true;download?.abort();const controller=new AbortController();download=controller;
 const timeout=setTimeout(()=>controller.abort(),30000);status('正在读取公开 PDF 链接…');
 try{
  const response=await fetch(url,{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});
  if(!response.ok)throw Error(`HTTP ${response.status}`);
  if(Number(response.headers.get('content-length'))>MAX_BYTES){controller.abort();throw Error('超过 25 MB');}
  const reader=response.body.getReader();const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('超过 25 MB');}chunks.push(value);}
  if(controller!==download)return;
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  clearTimeout(timeout);await openBytes(data,new URL(url).pathname.split('/').pop()||'在线 PDF');
 }catch(err){controller.abort();if(controller===download)status('链接读取失败（跨域限制、网络或文件大小）。请在原网页下载 PDF，再用“打开本地 PDF”。',true);}
 finally{clearTimeout(timeout);}
}
$('open-url').addEventListener('click',openUrl);
$('pdf-url').addEventListener('keydown',event=>{if(event.key==='Enter')openUrl();});
$('prev').addEventListener('click',()=>showPage(pageNumber-1));$('next').addEventListener('click',()=>showPage(pageNumber+1));
$('page-number').addEventListener('change',event=>{const n=Number(event.target.value);if(Number.isInteger(n)&&n>0)showPage(n);else syncNavigation();});
$('translate').addEventListener('click',async()=>{await bridge.start();$('stop').disabled=false;$('translate').disabled=true;});
$('stop').addEventListener('click',()=>{stop();status('已停止并恢复原文，排队请求已取消。');});
$('settings').addEventListener('click',()=>chrome.runtime.openOptionsPage());
window.addEventListener('adaptive-translation-status',event=>{const s=event.detail;status(s.message,s.state==='error');if(!s.enabled){$('stop').disabled=true;$('translate').disabled=!pdf||!$('reading-text').querySelector('p');}});
window.addEventListener('pagehide',()=>{bridge.stop();download?.abort();});
const source=validateSourceUrl(new URLSearchParams(location.search).get('source'));
if(source){$('pdf-url').value=source;openUrl();}

new ResizeObserver(()=>document.documentElement.style.setProperty('--header-height', document.querySelector('header').getBoundingClientRect().height+'px')).observe(document.querySelector('header'));

function closeZoom(){++zoomGeneration;zoomTask?.cancel();zoomTask=null;$('image-dialog').close();$('image-detail').replaceChildren();}
$('close-image').addEventListener('click',closeZoom);
$('image-dialog').addEventListener('cancel',event=>{event.preventDefault();closeZoom();});
$('zoom-original').addEventListener('click',async()=>{
 if(!pdf)return;
 // Pause translation before displaying the full page, including hidden figures.
 stop();const request=++zoomGeneration;const current=pdf;
 $('image-detail').textContent='正在本机绘制高清原页…';$('image-dialog').showModal();
 try{
  const page=await current.getPage(pageNumber);if(request!==zoomGeneration)return;
  const base=page.getViewport({scale:1});const scale=Math.min(3,2400/base.width,Math.sqrt(8000000/(base.width*base.height)));
  const viewport=page.getViewport({scale});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  zoomTask=page.render({canvasContext:canvas.getContext('2d'),viewport});await zoomTask.promise;
  if(request===zoomGeneration)$('image-detail').replaceChildren(canvas);
 }catch(err){if(request===zoomGeneration)$('image-detail').textContent='放大失败，请使用原始 PDF 阅读器查看。';}
});
