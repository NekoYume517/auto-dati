/** Global next-page regression, using the Zhihuishu button DOM and unrelated custom-rule sites. */
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser, createTarget, attachTo, waitForExtension, until, sleep } from './cdp.mjs';
const ID = 'mbiopgafffcabionpcmhoonphdpbgmia', PORT = 12000 + Math.floor(Math.random() * 100);
let count = 0;
const requests = [];
function ok(label, value) { assert.ok(value, label); count++; console.log('  ✓ ' + label); }
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), route = u.pathname;
  if (route === '/v1/chat/completions') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), text = JSON.stringify(body.messages);
    requests.push(text);
    if (text.includes('FAIL')) { res.writeHead(500); res.end('{"error":"test failure"}'); return; }
    if (text.includes('第2小题')) await sleep(650);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'B' } }] }) + '\n\ndata: [DONE]\n\n');
    return;
  }
  const mode = route.slice(1);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (mode === 'framed') {
    res.end(`<!doctype html><iframe id="exam" style="width:800px;height:440px" src="/frame-inner?index=1"></iframe><div class="switch-btn-box"><button id="next">下一页</button></div><button id="submit">提交作业</button><script>
      window.pageIndex=1;window.clicks=0;window.submits=0;window.badSaves=0;
      document.querySelector('#next').onclick=()=>{clicks++;if(document.querySelector('#exam').contentDocument.querySelector('input:checked')?.value!=='B')badSaves++;pageIndex++;document.querySelector('#exam').src='/frame-inner?index='+pageIndex;if(pageIndex===3)document.querySelector('#next').remove()};document.querySelector('#submit').onclick=()=>submits++;
    </script>`); return;
  }
  res.end(`<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;margin:20px}.q{padding:16px;margin:10px 0;border:1px solid #ddd}.opt{display:block;padding:4px}button{padding:8px 16px}</style>
  <div id="questions"></div><div class="switch-btn-box"><button disabled>上一题</button><button id="next" type="button">${mode === 'custom' ? '继续学习' : '下一题'}</button></div><button id="submit">提交作业</button>
  <script>
  const mode=${JSON.stringify(mode)};window.pageIndex=${Number(u.searchParams.get('index')) || 1};window.clicks=0;window.submits=0;window.saved=[];window.badSaves=0;
  function render(){
    const n=mode==='multi'?2:1;let markup='';
    for(let i=1;i<=n;i++)markup+='<div class="q" id="q'+i+'"><div class="stem">'+(mode==='error'?'FAIL ':'')+'第'+pageIndex+'页 第'+i+'小题：以下哪个是质数？</div><label class="opt"><input type="radio" name="p'+pageIndex+'q'+i+'" value="A">A. 4</label><label class="opt"><input type="radio" name="p'+pageIndex+'q'+i+'" value="B">B. 7</label></div>';
    if(mode==='wisdom')markup=markup.replaceAll('class="q"','class="q examPaper_subject"').replaceAll('class="stem"','class="stem subject_describe"').replaceAll('class="opt"','class="opt nodeLab"');
    document.querySelector('#questions').innerHTML=markup;
    if(mode==='frame-inner')document.querySelector('#next')?.remove();
    else if(pageIndex===3){if(mode==='disabled')document.querySelector('#next').disabled=true;else document.querySelector('#next').remove()}
  }
  document.querySelector('#submit').onclick=()=>submits++;
  document.querySelector('#next').onclick=()=>{
    clicks++;const values=Array.from(document.querySelectorAll('.q')).map(q=>q.querySelector('input:checked')?.value||'');saved.push(values);if(values.some(v=>v!=='B'))badSaves++;
    if(mode==='unchanged')return;
    document.querySelector('#questions').innerHTML='<div>加载中</div>';
    setTimeout(()=>{pageIndex++;render()},160);
  };
  render();
  </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
const browser = await launchBrowser({ extensionPath: path.resolve('extension'), port: PORT, headless: true, extraArgs: ['--window-size=1280,960'] });
const clients = [];
async function open(url) { await createTarget(PORT, url); const { cdp } = await attachTo(PORT, v => v === url); clients.push(cdp); return cdp; }
try {
  await waitForExtension(PORT, ID, { stderrFn: browser.stderr });
  const options = await open('chrome-extension://' + ID + '/ui/options.html');
  const popup = await open('chrome-extension://' + ID + '/ui/popup.html');
  await until(() => options.eval('!!globalThis.AD?.Settings'));
  const initial = {
    enabled: true,
    mode: { autoAnswer: false, popup: false, autoNextPage: false, nextPageDelayMs: 300, nextPageSelector: '', hoverHint: false, noticeToast: false, cooldownMs: 0, scanDebounceMs: 100, minIntervalMs: 200, skipAnswered: true },
    detect: { customRules: [{ id: 'global-site-rule', enabled: true, kind: 'choice', rootSelector: '.q', stemSelector: '.stem', optionSelector: '.opt', nextPageSelector: '#next', nextPageEnabled: true }] },
    api: { activeId: 'next-test', profiles: [{ id: 'next-test', name: 'test', format: 'openai-chat', baseUrl: baseUrl + '/v1', path: '', apiKey: 'test', model: 'test', stream: true, vision: false, extraHeaders: {}, extraBody: {}, timeoutMs: 10000 }] }
  };
  await options.eval(`AD.Settings.save(${JSON.stringify(initial)})`);
  ok('自动翻页默认关闭，完整设置与快捷设置均与另外两个开关放在同一组', await popup.eval('AD.Settings.DEFAULTS.mode.autoNextPage===false && !!document.querySelector(".pop-modes #swAutoNextPage") && !!document.querySelector(".pop-modes #swAuto") && !!document.querySelector(".pop-modes #swPopup")') && await options.eval('!!document.querySelector("[data-view=behavior] [data-path=\\"mode.autoNextPage\\"]")'));
  // 快捷设置写入同一份全局配置。
  await popup.eval('document.querySelector("#swAutoNextPage").click()');
  await until(() => options.eval('AD.Settings.snapshot().mode.autoNextPage'));
  ok('快捷设置的翻页开关同步到全局设置', true);
  let page;
  async function scenario(route, modePatch = {}, rulePatch = {}) {
    if (page) {
      await page.evalInExtension('AD.Settings.save({enabled:false})', ID).catch(() => {});
      await page.send('Page.close').catch(() => {});
    }
    await options.eval(`AD.Settings.save({enabled:true,mode:${JSON.stringify(Object.assign({}, initial.mode, { autoAnswer: true, autoNextPage: true }, modePatch))},detect:{customRules:${JSON.stringify(initial.detect.customRules.map(r => Object.assign({}, r, rulePatch)))}}})`);
    page = await open(baseUrl + '/' + route);
    await page.captureMainFrameId();
    await until(() => page.evalInExtension('!!globalThis.AD?.App?.state.settings', ID));
    return page;
  }
  await scenario('wisdom', {}, { enabled: false });
  await until(() => page.eval('pageIndex===3 && !!document.querySelector("input:checked")'), { timeout: 15000, label: 'three automatic pages' });
  const completed = await page.eval('({page:pageIndex,clicks,submits,badSaves,saved})');
  ok('智慧树相同的下一题按钮结构可连续翻页、识别和填入', completed.page === 3 && completed.clicks === 2 && completed.badSaves === 0);
  ok('智慧树直接使用站点规则的按钮配置，不借用自定义或全局选择器', await page.evalInExtension('AD.Detector.scan(document,{skipAnswered:false})[0].presetId==="zhihuishu" && AD.Navigation.inspect().navigation[0].selector===AD.Settings.snapshot().detect.siteRules.zhihuishu.nextPageSelector', ID));
  await sleep(900);
  ok('下一题按钮消失后停止，不点击提交作业', await page.eval('clicks===2 && submits===0'));
  ok('翻页中加载占位不会被当题目或重复请求', requests.filter(r => r.includes('第1小题')).length === 3);
  await scenario('disabled');
  await until(() => page.eval('pageIndex===3 && !!document.querySelector("input:checked")'), { timeout: 15000 });
  await sleep(600);
  ok('最后一页按钮被禁用时停止', await page.eval('clicks===2 && document.querySelector("#next").disabled && submits===0'));
  await scenario('framed');
  await until(() => page.eval('pageIndex===3 && !!document.querySelector("#exam").contentDocument?.querySelector("input:checked")'), { timeout: 15000 });
  ok('题目在 iframe 内、下一页按钮在父页面时仍能连续运行', await page.eval('clicks===2 && badSaves===0 && submits===0'));
  await scenario('multi');
  await until(() => page.eval('pageIndex===3 && document.querySelectorAll("input:checked").length===2'), { timeout: 15000 });
  ok('同页多道题全部填入成功后才翻页', await page.eval('clicks===2 && badSaves===0 && saved.every(row=>row.length===2&&row.every(v=>v==="B"))'));
  await scenario('error');
  await until(() => requests.some(r => r.includes('FAIL')));
  await sleep(800);
  ok('模型请求失败时不跳过当前题', await page.eval('pageIndex===1 && clicks===0'));
  await scenario('custom');
  await until(() => page.eval('pageIndex===3 && !!document.querySelector("input:checked")'), { timeout: 15000 });
  ok('自定义选择器可适配其他网站的按钮文案', await page.eval('clicks===2 && submits===0'));
  await scenario('cancel', { nextPageDelayMs: 1800 });
  await until(() => page.eval('!!document.querySelector("input:checked")'));
  await options.eval('AD.Settings.save({mode:{autoNextPage:false}})');
  await sleep(1900);
  ok('等待期间关闭自动翻页会取消点击', await page.eval('clicks===0 && pageIndex===1'));
  await scenario('unchanged');
  await until(() => page.eval('clicks===1'));
  await page.evalInExtension('chrome.runtime.sendMessage({type:"DATI_NAV_FILLED",qid:AD.Detector.scan(document,{skipAnswered:false})[0].id})', ID);
  await sleep(900);
  ok('点击后题目不变时等待，重复填入通知也不会连续点按钮', await page.eval('clicks===1'));
  await scenario('submit-only', {}, { nextPageSelector: '#submit' });
  await until(() => page.eval('!!document.querySelector("input:checked")'));
  await sleep(800);
  ok('即使自定义选择器误指向提交按钮，也不会自动提交', await page.eval('submits===0 && clicks===0'));
  await scenario('manual', { autoAnswer: false, popup: true });
  await until(() => page.evalInExtension('!!document.querySelector("#dati-overlay-host")?.shadowRoot.querySelector("[data-act=fill]:not(:disabled)")', ID));
  await sleep(500);
  ok('只开启自动弹窗时等待用户确认填入，不提前翻页', await page.eval('clicks===0 && !document.querySelector("input:checked")'));
  await page.evalInExtension('document.querySelector("#dati-overlay-host").shadowRoot.querySelector("[data-act=fill]").click()', ID);
  await until(() => page.eval('pageIndex===2'));
  ok('手动成功填入后也能使用同一个全局翻页功能', await page.eval('clicks===1 && badSaves===0'));
  await scenario('enable-later', { autoNextPage: false });
  await until(() => page.eval('!!document.querySelector("input:checked")'));
  await options.eval('AD.Settings.save({mode:{autoAnswer:false,autoNextPage:true,highlightNextPage:true,nextPageDelayMs:800}})');
  await until(() => page.eval('!!document.querySelector("#dati-navigation-highlight")'));
  ok('已填入后开启自动翻页会启动，点击前显示按钮高亮', await page.eval('clicks===0 && getComputedStyle(document.querySelector("#dati-navigation-highlight")).pointerEvents==="none"'));
  await until(() => page.eval('pageIndex===2'));
  ok('高亮不拦截点击，成功进入下一题', await page.eval('clicks===1 && badSaves===0'));
  await options.eval('AD.Settings.save({mode:{highlightNextPage:false}})');
  await until(() => page.eval('!document.querySelector("#dati-navigation-highlight")'));
  ok('关闭点击高亮立即移除标记', true);
  await popup.eval('document.querySelector(".pop-feedback").open=true; document.querySelector("#swHighlightNextPage").click()');
  await until(() => options.eval('AD.Settings.snapshot().mode.highlightNextPage'));
  ok('完整设置和快捷设置共用点击高亮配置，题目高亮配置独立', await options.eval('!!document.querySelector("[data-path=\\"mode.highlightNextPage\\"]") && AD.Settings.DEFAULTS.mode.highlightNextPage===false'));
  await scenario('rule-disabled', {}, { nextPageEnabled: false });
  await until(() => page.eval('!!document.querySelector("input:checked")'));
  await sleep(900);
  ok('规则关闭翻页时，总开关开启也不会点击', await page.eval('clicks===0'));
  await scenario('rule-empty', {}, { nextPageSelector: '' });
  await until(() => page.eval('!!document.querySelector("input:checked")'));
  await sleep(900);
  ok('未配置翻页按钮的规则不回退到全局文字猜测', await page.eval('clicks===0'));
  await options.eval('AD.Settings.save({detect:{customRules:[{id:"other",enabled:true,kind:"choice",rootSelector:".absent",nextPageSelector:"#next"},{id:"global-site-rule",enabled:true,kind:"choice",rootSelector:".q",stemSelector:".stem",optionSelector:".opt",nextPageSelector:"",nextPageEnabled:true}]}})');
  await sleep(800);
  ok('未命中的规则不会借用按钮配置触发翻页', await page.eval('clicks===0'));
  await options.eval('AD.Settings.save({detect:{customRules:[{id:"global-site-rule",enabled:true,kind:"choice",rootSelector:".q",stemSelector:".stem",optionSelector:".opt",nextPageSelector:"#next",nextPageEnabled:true}]}})');
  await until(() => page.eval('pageIndex===2'));
  ok('修改当前规则的按钮配置立即生效', await page.eval('clicks===1'));
  await scenario('framed', { highlightNextPage: true });
  await until(() => page.eval('!!document.querySelector("#dati-navigation-highlight")'));
  await options.eval('AD.Settings.save({detect:{customRules:[{id:"global-site-rule",enabled:true,kind:"choice",rootSelector:".q",stemSelector:".stem",optionSelector:".opt",nextPageSelector:"#next",nextPageEnabled:false}]}})');
  await sleep(700);
  ok('iframe 外按钮预览期间关闭题目规则翻页，会取消点击', await page.eval('clicks===0'));
} finally {
  for (const client of clients) client.close();
  browser.kill(); server.close();
}
console.log('\n全局自动翻页回归：' + count + ' 通过');
process.exit(0);
