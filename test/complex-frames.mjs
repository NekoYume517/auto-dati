/** Nested cross-origin / opaque srcdoc / closed Shadow DOM picking regression. */
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser, attachTo, createTarget, waitForExtension, until, sleep } from './cdp.mjs';

const ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 10900 + Math.floor(Math.random() * 100);
let originA, originB, count = 0;
const requests = [];
function ok(label, condition) { assert.ok(condition, label); count++; console.log('  ✓ ' + label); }
function near(a, b) { return Math.abs(a - b) < 1.5; }

const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, 'http://x').pathname;
  if (route === '/v1/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '光合作用包括光反应和暗反应两个阶段。' } }] }) + '\n\ndata: [DONE]\n\n');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const base = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}iframe{position:absolute;box-sizing:border-box;transform-origin:0 0}</style>';
  if (route === '/leaf') return res.end(base + '<style>.q{position:absolute;box-sizing:border-box;left:12px;top:18px;width:460px;height:180px;padding:12px;border:1px solid #ddd}.stem{height:28px}textarea{width:300px;height:60px}</style><div id="deepq" class="q"><div class="stem">深层框架题目：简述光合作用的过程。</div><textarea></textarea></div>');
  if (route === '/middle') {
    const srcdoc = base + '<div id="leaf-host"></div><script>const root=document.querySelector("#leaf-host").attachShadow({mode:"closed"});root.innerHTML=' + JSON.stringify('<iframe src="' + originA + '/leaf" style="position:absolute;box-sizing:border-box;left:20px;top:25px;width:550px;height:360px;border:4px solid #888"></iframe>') + '</script>';
    return res.end(base + '<iframe sandbox="allow-scripts" srcdoc="' + srcdoc.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '" style="left:30px;top:40px;width:650px;height:500px;border:5px solid #888;transform:scale(.9)"></iframe>');
  }
  if (route === '/empty') return res.end(base + '<p>对照框架</p>');
  return res.end(base + '<iframe src="/empty" style="display:none"></iframe><div id="outer-host"></div><script>setTimeout(()=>{const root=document.querySelector("#outer-host").attachShadow({mode:"closed"});root.innerHTML=' + JSON.stringify('<iframe src="' + originB + '/middle" style="position:absolute;box-sizing:border-box;left:40px;top:80px;width:800px;height:650px;border:10px solid #888;transform-origin:0 0;transform:scale(.8)"></iframe>') + '},100)</script>');
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
originA = 'http://127.0.0.1:' + server.address().port;
originB = 'http://localhost:' + server.address().port;
const browser = await launchBrowser({ extensionPath: path.resolve('extension'), port: PORT, headless: true, extraArgs: ['--window-size=1280,960'] });
const clients = [];
async function open(url) { await createTarget(PORT, url); const { cdp } = await attachTo(PORT, v => v === url); clients.push(cdp); return cdp; }
try {
  await waitForExtension(PORT, ID, { stderrFn: browser.stderr });
  const options = await open('chrome-extension://' + ID + '/ui/options.html');
  await until(() => options.eval('!!globalThis.AD?.Settings'));
  await options.eval('AD.Settings.save({mode:{autoAnswer:false,popup:false,hoverHint:false},detect:{customRules:[]}})');
  const page = await open(originA + '/complex');
  await page.captureMainFrameId();
  const tabId = await options.eval(`chrome.tabs.query({}).then(t=>t.find(t=>t.url===${JSON.stringify(originA + '/complex')}).id)`);
  async function frames(expression) {
    return options.eval(`chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},func:async()=>{${expression}}})`);
  }
  const loaded = await until(async () => {
    const all = await frames('return {url:location.href,frame:!!globalThis.AD?.Frame,q:!!document.querySelector("#deepq")}');
    return all.some(x => x.result?.q && x.result.frame) && all;
  }, { timeout: 20000, label: 'deep iframe injection' });
  ok('动态插入、跨域、sandbox srcdoc 和封闭 Shadow DOM 的深层题目均有扩展上下文', loaded.filter(x => x.result.frame).length >= 5);
  const geometry = await frames('if(document.querySelector("#deepq"))return AD.Frame.toTopRect({x:12,y:18,w:460,h:180});return null');
  const rect = geometry.find(x => x.result)?.result;
  ok('三级框架的边框和 CSS 缩放坐标换算正确', rect && near(rect.x, 101.52) && near(rect.y, 157.44) && near(rect.w, 331.2) && near(rect.h, 129.6));
  const ex = expression => page.evalInExtension(expression, ID);
  const point = { x: 121.68, y: 184.08 };
  const target = await ex(`AD.Frame.probeAt(${point.x},${point.y},{whole:true})`);
  const contextTarget = await ex(`AD.Frame.probeAt(${point.x},${point.y},{contextRect:${JSON.stringify({x:point.x-15,y:point.y-15,w:90,h:90})}})`);
  ok('跨域深层框架的区域上下文保留 HTML 和目标标记', contextTarget.context.html.includes('深层框架题目') && contextTarget.context.html.includes('textarea') && contextTarget.context.html.includes('data-context-target'));
  const regionContext = await ex(`AD.Capture.collectContext(${JSON.stringify({x:point.x-15,y:point.y-15,w:90,h:90})})`);
  ok('顶层自由框选自动补充跨域 iframe 内的题目 HTML', regionContext.html.includes('深层框架题目') && regionContext.html.includes('textarea'));
  ok('从顶层能直接命中最深层题块，跳过隐藏兄弟框架', target && !target.isFrame && /深层框架题目/.test(target.text) && target.path.length === 3 && target.documentId);
  ok('远程元素保留完整选择器和题块矩形', target?.selector && near(target.rect.x, 101.52) && near(target.rect.w, 331.2));
  // 真实鼠标事件：顶层遮罩可操作，但命中查询进入深层框架。
  await ex('globalThis.__picked=null;AD.Capture.pickElement().then(r=>{globalThis.__picked=r});void 0');
  await page.send('Page.bringToFront');
  await sleep(150);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await until(() => ex('document.querySelector("#dati-elem-picker-host")?.shadowRoot.querySelector(".tag").textContent.includes("深层框架题目")'));
  ok('统一拾取高亮显示深层元素，而不是只高亮 iframe 容器', true);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await until(() => ex('!!globalThis.__picked?.remote'));
  ok('单击返回归属于实际文档的元素引用，并清理顶层遮罩', await ex('!document.querySelector("#dati-elem-picker-host") && !!__picked.remote.documentId'));
  const used = await ex('AD.Frame.activateTarget(__picked.remote,"template")');
  ok('远程元素可直接进入所属框架的模板配置', used?.ok);
  const cards = await frames('const h=document.querySelector("#dati-template-picker");return h?{url:location.href,stem:h.shadowRoot.querySelector("[data-role=stemPreview]").textContent,kind:h.shadowRoot.querySelector("[data-role=kind]").value}:null');
  const card = cards.find(x => x.result)?.result;
  ok('题型、题干在叶子文档中推断，配置操作不会落到父页面', card?.url === originA + '/leaf' && card.kind === 'qa' && /光合作用/.test(card.stem));
  await frames('document.querySelector("#dati-template-picker")?.shadowRoot.querySelector("[data-act=cancel]").click();return true');
  await ex('AD.Picker.open();void 0');
  await sleep(150);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await until(async () => (await frames('return !!document.querySelector("#dati-template-picker")?.shadowRoot.querySelector(".card.show")')).some(x => x.result));
  ok('添加模板入口同样可以一键穿透多层跨域框架', await ex('!AD.Picker.isOpen()'));
  await frames('document.querySelector("#dati-template-picker")?.shadowRoot.querySelector("[data-act=cancel]").click();return true');
  // 父页面遮挡时，不能误选被盖住的子框架内容。
  await page.eval('const cover=document.createElement("div");cover.id="cover";cover.style="position:fixed;inset:0;background:white;z-index:100";cover.textContent="父页面遮挡";document.body.append(cover)');
  const covered = await ex(`AD.Frame.probeAt(${point.x},${point.y},{whole:true})`);
  ok('命中路径检查尊重父页面遮挡，不会选中后面的 iframe', covered?.path.length === 0 && covered.text.includes('父页面遮挡'));
  await page.eval('document.querySelector("#cover").remove()');
  // 拖动仍属于截图框选，不会被跨帧查询中途抢走。
  await ex('globalThis.__region=null;AD.Capture.pickElement().then(r=>{globalThis.__region=r});void 0');
  await sleep(150);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 105, y: 160, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 280, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 280, button: 'left', clickCount: 1 });
  ok('跨 iframe 拖动继续得到自由框选区域', await until(() => ex('globalThis.__region?.mode==="region" && __region.rect.w===295')));
  await ex('globalThis.__cancelled=false;AD.Capture.pickElement().then(r=>{globalThis.__cancelled=r===null});void 0');
  await sleep(150);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await sleep(150);
  ok('跨帧查询尚未完成时 Esc 退出也不会残留或重新出现遮罩', await ex('globalThis.__cancelled && !AD.Capture.isPicking() && !document.querySelector("#dati-elem-picker-host")'));
  const shots = await frames('if(!document.querySelector("#deepq"))return null;const rect=await AD.Frame.toTopRect({x:12,y:18,w:460,h:180});const shot=await AD.Capture.capture(rect);return {ok:shot.ok,width:shot.width,height:shot.height}');
  const shot = shots.find(x => x.result)?.result;
  ok('深层框架截图使用顶层视口比例，裁剪尺寸不被重复放大', shot?.ok && near(shot.width, 331) && near(shot.height, 130));
  await options.eval(`AD.Settings.save({api:{activeId:'iframe-test',profiles:[{id:'iframe-test',name:'test',format:'openai-chat',baseUrl:${JSON.stringify(originA + '/v1')},path:'',apiKey:'test',model:'test',stream:true,vision:true,extraHeaders:{},extraBody:{},timeoutMs:15000}]}})`);
  await sleep(200);
  const capture = await ex(`AD.Frame.probeAt(${point.x},${point.y},{whole:true}).then(t=>AD.Frame.activateTarget(t,'capture'))`);
  ok('深层题块可直接发起截图答题', capture?.ok);
  await until(() => ex('document.querySelector("#dati-overlay-host")?.shadowRoot.querySelector(".dati-stream")?.textContent.includes("光反应")'));
  ok('截图答题在顶层只生成一个面板，模型请求包含真实题干和图片', await ex('document.querySelector("#dati-overlay-host").shadowRoot.querySelectorAll(".dati-panel").length===1') && requests.some(r => JSON.stringify(r.messages).includes('深层框架题目') && JSON.stringify(r.messages).includes('image_url')));
  ok('跨 iframe 截图请求同时将完整题块 HTML 交给模型', requests.some(r=>JSON.stringify(r.messages).includes('textarea') && JSON.stringify(r.messages).includes('data-context-target')));
  const childPanels = await frames('return window!==top && !!document.querySelector("#dati-overlay-host")?.shadowRoot.querySelector(".dati-panel")');
  ok('截图作答没有在每层 iframe 重复创建面板', childPanels.every(x => !x.result));
  await ex('document.querySelector("#dati-overlay-host").shadowRoot.querySelector("[data-act=fill]").click()');
  await until(async () => (await frames('return document.querySelector("#deepq textarea")?.value.includes("光反应")')).some(x => x.result));
  ok('顶层答案准确填回最深层文档中的原输入框', true);
  await until(() => ex('document.querySelector("#dati-overlay-host").shadowRoot.querySelectorAll(".dati-panel").length===0'));
  await frames('const q=document.querySelector("#deepq");if(q){q.querySelector(".stem").textContent="仅弹窗模式：请说明光反应的过程。";q.querySelector("textarea").value=""}return true');
  await options.eval('AD.Settings.save({mode:{popup:true,autoAnswer:false},detect:{customRules:[{id:"deep-rule",enabled:true,kind:"qa",rootSelector:"#deepq",stemSelector:".stem",inputSelector:"textarea"}]}})');
  await until(() => ex('document.querySelector("#dati-overlay-host")?.shadowRoot.querySelector(".dati-panel__stem")?.textContent.includes("仅弹窗模式")'));
  ok('只开启弹窗模式也能透传深层题目，无需同时开启自动填入', true);
  const unfilled = await frames('if(document.querySelector("#deepq"))return document.querySelector("textarea").value;return null');
  ok('弹窗模式不会自动填入深层输入框', unfilled.find(x => x.result !== null)?.result === '');
  await options.eval('AD.Settings.save({mode:{popup:false}})');
  const stale = await ex(`AD.Frame.probeAt(${point.x},${point.y},{whole:true})`);
  await frames('document.querySelector("#deepq")?.remove();return true');
  const staleResult = await ex(`AD.Frame.activateTarget(${JSON.stringify(stale)},'template')`);
  ok('框架内容被替换后拒绝已失效的元素引用', staleResult?.ok === false);
} finally {
  for (const client of clients) client.close();
  browser.kill(); server.close();
}
console.log('\n复杂 iframe 回归：' + count + ' 通过');
process.exit(0);
