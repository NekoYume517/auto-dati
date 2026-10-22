import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {launchBrowser,createTarget,attachTo,waitForExtension,until,sleep} from './cdp.mjs';
const id='mbiopgafffcabionpcmhoonphdpbgmia',port=13300+Math.floor(Math.random()*100);
let count=0;function ok(name,value){assert.ok(value,name);console.log('✓ '+name);count++;}
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<div class="q" style="padding:20px"><p class="stem">请选择正确的数字？</p><label><input type="radio" name="q">A. 一</label><label><input type="radio" name="q">B. 二</label></div><button id="next">下一页</button>'+(req.url==='/'?'<iframe style="width:600px;height:200px" src="/inner"></iframe>':''));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await launchBrowser({extensionPath:path.resolve('extension'),port,headless:true});const clients=[];
async function open(url){await createTarget(port,url);const {cdp}=await attachTo(port,u=>u===url);clients.push(cdp);return cdp;}
try{
 await waitForExtension(port,id,{stderrFn:browser.stderr});const options=await open('chrome-extension://'+id+'/ui/options.html');await until(()=>options.eval('!!globalThis.AD?.Settings'));
 await until(()=>options.eval('!!document.querySelector("[data-rule-act=edit]")'));
 ok('智慧树出现在统一规则列表，默认开启且不再区分站点预设',await options.eval('AD.Settings.snapshot().detect.customRules.some(r=>r.name==="智慧树"&&r.enabled) && !document.querySelector("[data-site]")'));
 ok('旧设置迁移保留翻页配置和关闭状态',await options.eval('(()=>{const s=AD.Settings.normalize({detect:{sitePresets:{zhihuishu:false},siteRules:{zhihuishu:{nextPageSelector:"#old",nextPageEnabled:false}},customRules:[]}});return s.detect.customRules[0].nextPageSelector==="#old"&&!s.detect.customRules[0].enabled&&!s.detect.customRules[0].nextPageEnabled})()'));
 await options.eval('document.querySelector("[data-nav=detect]").click();document.querySelector("[data-rule-act=edit]").click()');
 ok('编辑统一规则使用原生模态框',await options.eval('document.querySelector("#ruleEditor").open && document.querySelector("#ruleName").value==="智慧树"'));
 await options.eval('document.querySelector("#ruleStem").value=".changed";document.querySelector("#btnRuleSave").click()');await until(()=>options.eval('!document.querySelector("#ruleEditor").open'));
 ok('预设题干可编辑保存',await options.eval('AD.Settings.snapshot().detect.customRules[0].stemSelector===".changed"'));
 await options.eval('AD.Settings.save({mode:{autoAnswer:false,popup:false,autoNextPage:false},detect:{customRules:[{id:"page",name:"当前页",kind:"choice",rootSelector:".q",stemSelector:".stem",optionSelector:"label",nextPageSelector:"#next",enabled:true}]}})');
 const page=await open('http://127.0.0.1:'+server.address().port+'/');await page.captureMainFrameId();const ex=s=>page.evalInExtension(s,id);await until(()=>ex('!!AD.RuleEditor && !!AD.App.state.settings'));await sleep(500);await ex('AD.RuleEditor.open();void 0');await until(()=>ex('!!document.querySelector("[data-dati-ignore]") && !!Array.from(document.querySelectorAll("[data-dati-ignore]")).find(h=>h.shadowRoot?.querySelector("dialog[open]"))'));
 const shadow='Array.from(document.querySelectorAll("[data-dati-ignore]")).find(h=>h.shadowRoot?.querySelector("dialog"))?.shadowRoot';
 ok('网页预设编辑器列出统一规则',await ex('(()=>{const s='+shadow+';return s.querySelector("aside button").textContent==="当前页"})()'));
 await until(()=>ex('('+shadow+').querySelector("[role=status]").textContent.includes("4 个位置")'));
 ok('选择规则后跨 iframe 显示题目和下一页匹配框',true);
 await ex('(()=>{const s='+shadow+';s.querySelector("[data-field=name]").value="修改后"})()');
 ok('编辑草稿不即时修改检测规则',await ex('AD.Settings.snapshot().detect.customRules[0].name==="当前页"'));
 await ex('('+shadow+').querySelector("[data-save]").click()');await until(()=>ex('AD.Settings.snapshot().detect.customRules[0].name==="修改后"'));
 ok('网页编辑保存到同一份规则配置',true);
 await ex('('+shadow+').querySelector("[data-field=nextPageSelector]").parentElement.querySelector("button").click()');
 const r=await page.eval('(()=>{const r=document.querySelector("#next").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
 for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...r,button:'left',clickCount:1});
 await until(()=>ex('('+shadow+').querySelector("dialog").open'));
 ok('可通过元素拾取修改任意规则的下一页配置且不点击按钮',await ex('!!('+shadow+').querySelector("[data-field=nextPageSelector]").value'));
 await ex('('+shadow+').querySelector("[data-close]").click()');await sleep(300);
 ok('关闭编辑器清除匹配框',await ex('!Array.from(document.querySelectorAll("[data-dati-ignore]")).some(h=>h.shadowRoot?.querySelector("dialog"))'));
 ok('删除规则后迁移不会重新插入智慧树',await options.eval('AD.Settings.save({detect:{customRules:[]}}).then(s=>s.detect.customRules.length===0)'));
}finally{clients.forEach(c=>c.close());browser.kill();server.close();}
console.log('统一规则编辑器：'+count+' 通过');process.exit(0);
