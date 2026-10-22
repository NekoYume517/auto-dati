/** Manual-rule regression for styled native controls, ARIA, Shadow DOM and popup startup. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {launchBrowser, createTarget, attachTo, until, sleep, waitForExtension} from './cdp.mjs';

const ID='mbiopgafffcabionpcmhoonphdpbgmia',PORT=11650+Math.floor(Math.random()*80);
let count=0;const requests=[];
function ok(label,value){assert.ok(value,label);console.log('  ✓ '+label);count++;}
const math=String.raw`\(\displaystyle \lim_{x\to0}\frac{\sin x-x\cos x}{x^3}=\)（　）`;
const escape=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const options=['A. \\(0\\)','B. \\(\\frac16\\)','C. \\(\\frac13\\)','D. \\(1\\)'];
const fixture='<!doctype html><meta charset=utf-8><style>body{padding:30px;font:16px system-ui}.field-wrapper,.shadow-shell{border:1px solid #ccc;padding:16px;margin:16px;width:640px}label,.option-wrap,[role=checkbox]{display:inline-block;padding:12px}.peer{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.hidden{display:none}</style><form id=upForm>'+ 
  '<div class=field-wrapper id=math><label class=stem>'+escape(math)+'</label><div class=choices>'+options.map((v,i)=>'<label for="'+escape(math+'_'+i)+'"><input class=peer type=radio name="'+escape(math)+'" id="'+escape(math+'_'+i)+'" value="'+escape(v)+'"><div class=custom-check-box></div><span class=opt-text>'+escape(v)+'</span></label>').join('')+'</div></div>'+
  '<div class="field-wrapper hidden"><div class=stem>隐藏的旧题副本</div><label><input type=radio>A. 隐藏甲</label><label><input type=radio>B. 隐藏乙</label></div>'+
  '<div class=field-wrapper id=linked><div class=stem>请选择所有正确项</div>'+['A. 苹果','B. 香蕉'].map((v,i)=>'<div class=option-wrap><input type=checkbox class=peer aria-labelledby="linked:'+i+'"><span id="linked:'+i+'">'+v+'</span></div>').join('')+'</div>'+
  '<div class=field-wrapper id=roles><div class=stem>请选择全部字母</div><div role=checkbox aria-checked=false><span>A. 甲</span></div><div role=checkbox aria-checked=false><span>B. 乙</span></div></div></form><div class=shadow-shell id=shadow></div><div class=shadow-shell id=closed-shadow></div><label for="'+escape(math+'_blank')+'">'+escape(math)+'</label><input class=blank id="'+escape(math+'_blank')+'"><div style="height:1000px"></div>';
const dumpPath=process.env.AUTODATI_DOM_DUMP;
const server=http.createServer(async(req,res)=>{
  if(req.url==='/v1/chat/completions'){
    let data='';for await(const chunk of req)data+=chunk;requests.push(JSON.parse(data));
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"C"}}]}\n\ndata: [DONE]\n\n');return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  // Optional supplied DOM is inert test data. Never execute its scripts or fetch resources.
  if(req.url==='/dump'&&dumpPath){res.end(fs.readFileSync(dumpPath,'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'').replace(/<div id="dati-overlay-host"[^>]*><\/div>/g,''));return;}
  res.end(fixture);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
const browser=await launchBrowser({extensionPath:path.resolve('extension'),port:PORT,headless:true,extraArgs:['--window-size=1360,960']});const clients=[];
async function open(url){await createTarget(PORT,url);const {cdp}=await attachTo(PORT,v=>v===url);clients.push(cdp);return cdp;}
const rules=[
  {id:'native',name:'自绘表单',kind:'auto',rootSelector:'#upForm .field-wrapper',stemSelector:'.stem',optionSelector:'input[type=radio],input[type=checkbox]',enabled:true},
  {id:'shadow',name:'Shadow 表单',kind:'choice',rootSelector:'.shadow-shell',stemSelector:'.stem',optionSelector:'input[type=radio]',enabled:true},
  {id:'roles',name:'ARIA 多选',kind:'auto',rootSelector:'#roles',stemSelector:'.stem',optionSelector:'[role=checkbox], [role=checkbox] span',enabled:true},
  {id:'blank',name:'自身命中',kind:'blank',rootSelector:'.blank',inputSelector:'.blank',enabled:true}
];
try{
  await waitForExtension(PORT,ID,{stderrFn:browser.stderr});const settings=await open('chrome-extension://'+ID+'/ui/options.html');await until(()=>settings.eval('!!globalThis.AD?.Settings'));
  await settings.eval('AD.Settings.save('+JSON.stringify({mode:{popup:false,autoAnswer:false,hoverHint:false},api:{activeId:'test',profiles:[{id:'test',model:'mock',format:'openai-chat',baseUrl:url+'/v1',apiKey:'test',stream:true,vision:false,maxTokens:512}]},detect:{ruleCatalogVersion:1,viewportOnly:false,customRules:rules}})+')');
  const page=await open(url+'/');await page.captureMainFrameId();const ex=s=>page.evalInExtension(s,ID);await until(()=>ex('!!AD.App.state.settings'));
  await page.eval(`for(const [id,mode] of [['shadow','open'],['closed-shadow','closed']])document.getElementById(id).attachShadow({mode}).innerHTML='<div class=stem>Shadow 中的题干</div><label style="display:block"><input type=radio name=q style="opacity:0;width:1px;height:1px"><span>A. 甲</span></label><label style="display:block"><input type=radio name=q style="opacity:0;width:1px;height:1px"><span>B. 乙</span></label>'`);
  await page.eval('document.getElementById("shadow").shadowRoot.querySelector(".stem").textContent="Shadow 中的题干（开放）"');
  const summary=()=>ex('AD.Detector.scan(document,{viewportOnly:false,maxPerPage:0}).map(q=>({kind:q.kind,stem:q.stem,id:q.root.id,count:q.options.length,options:q.options.map(o=>({label:o.label,text:o.text,tag:o.el.tagName,input:!!o.input})),inputs:q.inputs.length}))');
  let all=await summary(),q=all.find(q=>q.id==='math');
  ok('隐藏的原生控件保持不可见，使用可见标签代理解析',await ex('!AD.Detector.isVisible(document.querySelector("#math input"),{viewportOnly:false})')&&q?.count===4&&q.options.every(o=>o.tag==='LABEL'&&o.input));
  ok('公式反斜线和特殊 ID 不破坏选项文字与答案对应',q.stem.includes('\\lim')&&q.options[2].label==='C'&&q.options[2].text.includes('frac13'));
  await page.eval('document.querySelector("#math .stem").style.textTransform="uppercase"');
  ok('CSS uppercase 不改变 LaTeX 指令及变量大小写',(await summary()).some(q=>q.id==='math'&&q.stem.includes('\\lim')&&q.stem.includes('x^3')));
  ok('隐藏旧题不参与自动检测',!all.some(q=>q.stem.includes('隐藏的旧题')));
  ok('aria-labelledby 自绘多选保留原控件与选项文字',all.some(q=>q.id==='linked'&&q.kind==='multi'&&q.options[1].text==='香蕉'));
  ok('ARIA 伪选项的父子重复匹配只生成两项并推断多选',all.some(q=>q.id==='roles'&&q.count===2&&q.kind==='multi'));
  ok('外层规则可以读取开放和封闭 Shadow DOM 的题干及选项',all.filter(q=>['shadow','closed-shadow'].includes(q.id)&&q.count===2&&q.stem.startsWith('Shadow 中的题干')).length===2);
  ok('输入框选择器命中题块自身，特殊字符标签可作为题干',all.some(q=>q.inputs===1&&q.stem.includes('\\lim')));
  await page.eval('(()=>{const h=document.createElement("div");h.id="complex-inputs";h.innerHTML="<div class=stem>填写输入和选择内容</div><div class=input-wrap><input type=text><input type=hidden value=tracking></div><div class=input-wrap><label for=styled-select>选择一个内容</label><select id=styled-select style=\\"display:none\\"><option>甲</option><option>乙</option></select></div><div class=input-wrap style=\\"display:none\\"><input type=text></div>";document.body.append(h)})()');
  const inputCase = await ex('(()=>{const original=AD.Settings.snapshot,s=original();s.detect.customRules=[{id:"wrapper-input",kind:"blank",rootSelector:"#complex-inputs",stemSelector:".stem",inputSelector:".input-wrap"}];AD.Settings.snapshot=()=>s;try{const q=AD.Detector.scan(document,{viewportOnly:false})[0];return q&&q.inputs.map(i=>i.type)}finally{AD.Settings.snapshot=original}})()');
  ok('输入框选择器可指定外层容器，并排除隐藏副本和跟踪字段',inputCase?.length===2&&inputCase.includes('text')&&inputCase.includes('select'));
  await page.eval('document.getElementById("complex-inputs").remove()');
  const native=rules[0];
  for(const selector of ['label, label span, input[type=radio]','.choices','.opt-text']){
    await settings.eval('AD.Settings.save({detect:{customRules:['+JSON.stringify({...native,rootSelector:'#math',optionSelector:selector})+']}})');await until(()=>ex('AD.App.state.settings.detect.customRules[0].optionSelector==='+JSON.stringify(selector)));
    q=(await summary())[0];ok('复杂选项选择器解析为四个不重复选项：'+selector,q?.count===4&&q.options[2].label==='C');
  }
  await settings.eval('AD.Settings.save({detect:{customRules:['+JSON.stringify({...native,rootSelector:'#math',optionSelector:'input[type=radio]'})+']}})');
  ok('自动弹窗关闭时不产生面板',await ex('AD.Overlay.count()===0'));
  await settings.eval('AD.Settings.save({mode:{popup:true}})');
  await until(()=>ex('AD.Overlay.count()===1'),{label:'popup after enabling'});
  await until(()=>requests.length>0&&ex('Array.from(AD.App.state.inFlight).length===0'));
  ok('通过与快捷面板相同的设置开关开启后，自动显示完整四选项面板',await ex('document.querySelector("#dati-overlay-host").shadowRoot.querySelectorAll(".dati-question-option").length===4'));
  ok('模型请求包含完整公式题干与所有选项',requests.some(r=>JSON.stringify(r.messages).includes('frac13')&&JSON.stringify(r.messages).includes('\\\\lim')));
  ok('面板可填入透明原生控件，选项 C 正确选中',await ex('(()=>{const q=AD.Detector.scan(document,{viewportOnly:false})[0];const r=AD.Filler.apply(q,"C");return r.ok&&document.querySelectorAll("#math input")[2].checked})()'));
  await sleep(800);ok('稳定页面不会重复请求或反复弹窗',requests.length===1&&await ex('AD.Overlay.count()===1'));
  if(dumpPath){
    await settings.eval('AD.Settings.save({mode:{popup:false},detect:{customRules:['+JSON.stringify({...native,stemSelector:'.field-label-content'})+']}})');
    const dump=await open(url+'/dump');await dump.captureMainFrameId();const dx=s=>dump.evalInExtension(s,ID);await until(()=>dx('!!AD.App.state.settings'));
    ok('提供的真实 DOM 能按手动规则解析出公式题及四个选项',await dx('AD.Detector.scan(document,{viewportOnly:false}).some(q=>q.options.length===4&&q.stem.includes("\\\\lim"))'));
    await dump.eval('document.querySelector("#upForm .field-wrapper").scrollIntoView({block:"center"})');
    await settings.eval('AD.Settings.save({mode:{popup:true}})');await until(()=>dx('AD.Overlay.count()===1'));
    ok('提供的真实 DOM 开启自动弹窗后可见且可交互',await dx('(()=>{const p=document.querySelector("#dati-overlay-host").shadowRoot.querySelector(".dati-panel");return p&&!p.inert&&!p.classList.contains("is-suspended")})()'));
  }
}finally{clients.forEach(c=>c.close());browser.kill();server.close();}
console.log('\n复杂手动规则：'+count+' 通过');process.exit(0);
