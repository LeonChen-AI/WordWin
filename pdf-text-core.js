// Geometry-based extraction: separate common two-column papers before joining lines.
(function(root) {
  function extractParagraphs(items, pageWidth) {
    const words = items.filter(x => typeof x.str === 'string' && x.str.trim() && x.transform && Math.abs(x.transform[1]) <= Math.abs(x.transform[0]))
      .map(x => ({text:x.str.trim(), x:x.transform[4], y:x.transform[5], width:x.width || 0, height:Math.abs(x.height || x.transform[3] || 10)}))
      .sort((a,b) => b.y-a.y || a.x-b.x);
    const rows=[];
    for (const word of words) {
      let row=rows.at(-1);
      if (!row || Math.abs(row.y-word.y)>Math.max(2,word.height*.3)) {row={y:word.y, words:[]};rows.push(row);}
      row.words.push(word);
    }
    const mid=pageWidth/2;
    const lines=rows.map(row=>{
      const fragments=[];
      for (const word of row.words.sort((a,b)=>a.x-b.x)) {
        let f=fragments.at(-1);
        if (!f || word.x-f.right>Math.max(12,word.height*1.25)) {f={text:'',x:word.x,right:word.x,y:row.y,height:word.height};fragments.push(f);}
        // PDF.js can split words into glyph runs; only add a space across a real gap.
        const space=f.text && word.x-f.right>word.height*.12 ? ' ' : '';
        f.text+=space+word.text;f.right=Math.max(f.right,word.x+word.width);f.height=Math.max(f.height,word.height);
      }
      return fragments;
    });
    const paired=lines.filter(fs=>fs.some(f=>f.right<mid+8)&&fs.some(f=>f.x>mid-8)).length;
    const fragments=lines.flat();
    const leftCount=fragments.filter(f=>f.right<mid+8).length;
    const rightCount=fragments.filter(f=>f.x>mid-8).length;
    // Columns need not share baselines: abstracts often use a smaller font.
    const columns=(paired>=4 && paired/Math.max(1,lines.length)>=.3) ||
      (leftCount>=5 && rightCount>=5 && (leftCount+rightCount)/Math.max(1,fragments.length)>=.65);
    const ordered=[];let left=[],right=[];
    const flush=()=>{ordered.push(...left,...right);left=[];right=[];};
    const combine=fs=>({text:fs.map(f=>f.text).join(' '),x:fs[0].x,right:fs.at(-1).right,y:fs[0].y,height:Math.max(...fs.map(f=>f.height))});
    for (const fs of lines) {
      if (!fs.length) continue;
      if (!columns || fs.some(f=>f.x<mid-12 && f.right>mid+12)) {flush();ordered.push(combine(fs));continue;}
      const l=fs.filter(f=>(f.x+f.right)/2<mid),r=fs.filter(f=>(f.x+f.right)/2>=mid);
      if(l.length)left.push(combine(l));if(r.length)right.push(combine(r));
    }
    flush();
    const paragraphs=[];let text='',previous=null;
    const commit=()=>{if(text.trim())paragraphs.push(text.trim());text='';};
    for(const line of ordered){
      const sameColumn=previous && Math.abs(line.x-previous.x)<pageWidth*.25;
      const gap=previous ? previous.y-line.y : 0;
      if(previous && (!sameColumn || gap<0 || gap>Math.max(previous.height,line.height)*1.5 || text.length+line.text.length>1600))commit();
      if(text && /[A-Za-z]-$/.test(text) && /^[a-z]/.test(line.text))text=text.slice(0,-1)+line.text;
      else text+=(text?' ':'')+line.text;
      previous=line;
    }
    commit();
    return {paragraphs:paragraphs.slice(0,300),columns:columns?2:1};
  }
  function validateSourceUrl(value) {
    try { const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;u.hash='';return u.href;}catch{return null;}
  }
  root.AdaptivePdfTextCore={extractParagraphs,validateSourceUrl};
  if(typeof module==='object')module.exports=root.AdaptivePdfTextCore;
})(globalThis);
