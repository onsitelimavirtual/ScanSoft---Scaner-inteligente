'use strict';
// ScanSoft 5.1 — OCR offline. Escuta apenas loopback; nenhum arquivo é transmitido à Internet.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{promisify}=require('node:util');
const PORT=8740,HOST='127.0.0.1',ROOT=__dirname;
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
function send(res,status,data,type='application/json; charset=utf-8') {res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; worker-src 'self' blob:; img-src 'self' data: blob:"});res.end(type.startsWith('application/json')?JSON.stringify(data):data)}
function receive(req,max){return new Promise((resolve,reject)=>{let chunks=[],n=0;req.on('data',c=>{n+=c.length;if(n>max){reject(Error('Arquivo ultrapassa limite permitido.'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function run(command,args,opt={}){return new Promise((resolve,reject)=>{let child=spawn(command,args,{shell:false,...opt}),out=[],err=[];let timer=setTimeout(()=>child.kill('SIGKILL'),120000);child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(Buffer.concat(err).toString('utf8').slice(0,400)||'Falha no programa '+command));resolve(Buffer.concat(out))})})}
const tess=process.env.TESSERACT_BIN||'tesseract',pdftoppm=process.env.PDFTOPPM_BIN||'pdftoppm';
const DATA=path.join(ROOT,'idiomas');
const allowed=new Set(['por','eng','por+eng','eng+por']);
let busy=false;
async function tempFolder(){return fs.promises.mkdtemp(path.join(os.tmpdir(),'scansoft-'))}
async function ocrPNG(bytes,lang){let dir=await tempFolder();try{let source=path.join(dir,'image.png');await fs.promises.writeFile(source,bytes);let args=[source,'stdout','--tessdata-dir',DATA,'-l',lang,'--psm','3','-c','tessedit_create_tsv=1'];let tsv=(await run(tess,args)).toString('utf8');let lines=tsv.split(/\r?\n/),fields=lines.shift().split('\t'),words=[],textLines=new Map(),confs=[];
for(let line of lines){let cols=line.split('\t');if(cols.length<12)continue;let o=Object.fromEntries(fields.map((f,i)=>[f,cols[i]]));let word=(o.text||'').trim();if(!word)continue;let conf=Number(o.conf);if(Number.isFinite(conf)&&conf>=0)confs.push(conf);let x=Number(o.left),y=Number(o.top),w=Number(o.width),h=Number(o.height);words.push({text:word,bbox:{x0:x,y0:y,x1:x+w,y1:y+h},confidence:conf});let key=[o.page_num,o.block_num,o.par_num,o.line_num].join('-');textLines.set(key,(textLines.get(key)||[]).concat(word));}
return {text:[...textLines.values()].map(x=>x.join(' ')).join('\n'),words,confidence:confs.length?confs.reduce((a,b)=>a+b,0)/confs.length:null};
}finally{await fs.promises.rm(dir,{recursive:true,force:true})}}
async function pdfPages(bytes){let dir=await tempFolder();try{let f=path.join(dir,'document.pdf');await fs.promises.writeFile(f,bytes);await run(pdftoppm,['-f','1','-l','20','-scale-to','1800','-png',f,path.join(dir,'page')]);let files=(await fs.promises.readdir(dir)).filter(n=>/^page-\d+\.png$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));let pages=[];for(let name of files){let b=await fs.promises.readFile(path.join(dir,name));if(b.length>14e6)throw Error('Página gerou imagem grande demais.');pages.push(b.toString('base64'))}return pages;
}finally{await fs.promises.rm(dir,{recursive:true,force:true})}}
http.createServer(async(req,res)=>{
try{
if(req.method==='GET'&&req.url==='/api/status'){let langs=(await fs.promises.readdir(DATA)).filter(x=>x.endsWith('.traineddata')).map(x=>x.split('.')[0]);let available=false;try{await run(tess,['--version']);available=true}catch{}return send(res,200,{ocrInstalled:available,languages:langs})}
if(req.method==='POST'&&(req.url==='/api/ocr'||req.url==='/api/pdf-pages')){
 if(busy)return send(res,429,{error:'Outro processamento está em andamento.'});busy=true;
 try{
  if(req.url==='/api/ocr'){
   let lang=String(req.headers['x-scansoft-lang']||'por');if(!allowed.has(lang))return send(res,400,{error:'Idioma inválido.'});let b=await receive(req,14*1024*1024);if(!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return send(res,415,{error:'Envie PNG válido.'});return send(res,200,await ocrPNG(b,lang));
  }
  let b=await receive(req,40*1024*1024);if(b.subarray(0,5).toString()!=='%PDF-')return send(res,415,{error:'Arquivo não parece PDF.'});return send(res,200,{pages:await pdfPages(b)});
 }finally{busy=false}
}
if(req.method!=='GET')return send(res,405,{error:'Método não permitido.'});let url=req.url==='/'?'/index.html':req.url;if(!/^\/[a-zA-Z0-9._/-]+$/.test(url)||url.includes('..'))return send(res,400,{error:'Endereço inválido.'});let p=path.join(ROOT,url);if(!p.startsWith(ROOT+path.sep))return send(res,403,{error:'Proibido.'});let data=await fs.promises.readFile(p);return send(res,200,data,mime[path.extname(p)]||'application/octet-stream');
}catch(e){return send(res,500,{error:e.message||'Falha desconhecida'})}
}).listen(PORT,HOST,()=>console.log(`ScanSoft 5.1 disponível em http://${HOST}:${PORT} (OCR offline)`));
