const {test}=require('node:test');
const assert=require('node:assert/strict');
const {extractParagraphs,validateSourceUrl}=require('../pdf-text-core.js');
const item=(str,x,y,width=220)=>({str,width,height:10,transform:[10,0,0,10,x,y]});
test('two-column extraction reads left column then right and keeps a spanning title',()=>{
 const rows=[item('A full width title',50,750,500)];
 for(let i=0;i<7;i++)rows.push(item(`Left ${i}.`,50,700-i*13),item(`Right ${i}.`,330,700-i*13));
 const r=extractParagraphs(rows,600);const text=r.paragraphs.join(' ');
 assert.equal(r.columns,2);assert(text.startsWith('A full width title'));
 assert(text.indexOf('Left 6.')<text.indexOf('Right 0.'));
});
test('single-column text preserves paragraph gaps and repairs line-break hyphenation',()=>{
 const r=extractParagraphs([item('A computational trans-',50,700,450),item('duction model.',50,687,450),item('A new paragraph.',50,650,450)],600);
 assert.deepEqual(r.paragraphs,['A computational transduction model.','A new paragraph.']);
});
test('empty pages and unsafe source URL schemes do not produce learning requests',()=>{
 assert.deepEqual(extractParagraphs([],600).paragraphs,[]);
 for(const url of ['file:///private/data.pdf','javascript:alert(1)','https://user:pass@example.com/a.pdf','not a URL'])assert.equal(validateSourceUrl(url),null);
 assert.equal(validateSourceUrl('https://example.com/paper.pdf#page=2'),'https://example.com/paper.pdf');
});
function makePdf(){
 const stream='BT /F1 12 Tf 60 720 Td (An English research paragraph for local PDF extraction.) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>'];
 let data='%PDF-1.7\n';const offsets=[0];objects.forEach((x,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${x}\nendobj\n`;});const xref=Buffer.byteLength(data);data+=`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return new Uint8Array(Buffer.from(data));
}
test('packaged PDF.js parses real PDF bytes and identifies a textless page without network',async()=>{
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=pdfjs.getDocument({data:makePdf(),useSystemFonts:true,useWasm:false});
 try{
 const doc=await task.promise;assert.equal(doc.numPages,2);
 const first=await doc.getPage(1);const text=await first.getTextContent();
 assert(extractParagraphs(text.items,600).paragraphs.join(' ').includes('English research paragraph'));
 const second=await doc.getPage(2);assert.equal((await second.getTextContent()).items.length,0);
 }finally{await task.destroy();}
});
test('columns with different line heights are never interleaved',()=>{
 const rows=[item('A full width title',50,750,500)];
 for(let i=0;i<10;i++)rows.push(item(`Left ${i}.`,50,700-i*12),item(`Right ${i}.`,330,700-i*14));
 const r=extractParagraphs(rows,600);assert.equal(r.columns,2);
 assert(r.paragraphs.join(' ').indexOf('Left 9.')<r.paragraphs.join(' ').indexOf('Right 0.'));
});

test('narrow column gutters preserve independent text flow',()=>{
 const rows=[item('A full width title',50,750,500)];
 for(let i=0;i<10;i++)rows.push(item(`Left ${i}.`,72,700-i*13,218),item(`Right ${i}.`,307,700-i*13,218));
 const r=extractParagraphs(rows,595);assert.equal(r.columns,2);
 assert(r.paragraphs.join(' ').indexOf('Left 9.')<r.paragraphs.join(' ').indexOf('Right 0.'));
});
