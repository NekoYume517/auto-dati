/**
 * AutoDati · iframe / 元素拾取 / 视觉兜底 测试
 *   node test/frames.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, attachTo, createTarget, sleep, until, waitForExtension, Cdp } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(path.resolve(__dirname, '..'), 'extension');
const EXT_ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 9900 + Math.floor(Math.random() * 90);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' — ' + extra : '')); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const site = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(__dirname, 'e2e', u.pathname === '/' ? 'page.html' : u.pathname);
    fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(b);
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-llm-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const mockUrl = await new Promise((res) => {
  mock.stdout.on('data', (d) => { const m = /MOCK_LLM_URL=(\S+)/.exec(String(d)); if (m) res(m[1]); });
});

const browser = await launchBrowser({
  extensionPath: EXT, port: PORT, headless: true,
  extraArgs: ['--window-size=1280,1600', '--force-device-scale-factor=1']
});
await waitForExtension(PORT, EXT_ID, { stderrFn: browser.stderr });

const optT = await createTarget(PORT, `chrome-extension://${EXT_ID}/ui/options.html`);
const { cdp: opt } = await attachTo(PORT, (u) => u.includes('/ui/options.html'));
await sleep(700);

async function setSettings(over) {
  const s = Object.assign({
    enabled: true,
    mode: { autoAnswer: false, popup: true, autoFillAfterStream: false, scanDebounceMs: 250, minIntervalMs: 250, maxPerPage: 20, skipAnswered: false, cooldownMs: 0, noticeToast: false, hoverHint: false },
    api: { activeId: 'e2e', profiles: [{ id: 'e2e', name: 'mock', format: 'openai-chat', baseUrl: mockUrl, path: '', apiKey: 'k', model: 'mock-vision', temperature: 0.2, maxTokens: 512, stream: true, vision: true, extraHeaders: {}, extraBody: {}, timeoutMs: 15000, lastTest: null }] },
    prompt: { system: '答题助手', extraInstruction: '', kindHint: {}, language: 'zh', includeExplain: false, imageInstruction: '截图作答' },
    detect: { sitePresets: {}, customRules: [
      { id: 'frame-choice', enabled: true, kind: 'choice', rootSelector: '#fq1,#topq', stemSelector: '.stem', optionSelector: '.opt' },
      { id: 'frame-blank', enabled: true, kind: 'blank', rootSelector: '#fq2', stemSelector: '.stem', inputSelector: 'input' },
      { id: 'frame-qa', enabled: true, kind: 'qa', rootSelector: '#fq3', stemSelector: '.stem', inputSelector: 'textarea' }
    ], minTextLen: 4, viewportOnly: true, shadowDom: true },
    hotkey: { enabled: true, capture: 'Alt+Q', hover: 'Alt+Shift+Q', picker: 'Alt+Shift+E', toggleAuto: 'Alt+Shift+Z', togglePopup: 'Alt+Shift+X' },
    ui: { theme: 'dark', accent: '#6366f1', panelWidth: 384, fontSize: 13, radius: 14, blur: true, animate: true, panelPosition: 'auto' },
    advanced: { log: true, areaPicker: true, maxImageSide: 1200, screenshotFormat: 'png', showScreenshotThumb: true }
  }, over || {});
  await opt.eval(`new Promise(r=>chrome.storage.local.set({ad_settings:${JSON.stringify(s)}},r))`);
  await sleep(400);
}

/* ------------------------------ iframe 场景 ------------------------------ */

console.log('[1] iframe：扩展注入到子框架');
await setSettings({ mode: { autoAnswer: true, popup: true, autoFillAfterStream: false, scanDebounceMs: 250, minIntervalMs: 250, maxPerPage: 20, skipAnswered: false, cooldownMs: 0, noticeToast: false, hoverHint: false } });
await createTarget(PORT, site.url + '/frames.html');
const { cdp: page, target: pageTarget } = await attachTo(PORT, (u) => u.includes('/frames.html'));
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false }).catch(() => null);
await sleep(2200);

const contexts = page.listExtensionContexts(EXT_ID);
ok('子框架里也有扩展上下文', contexts.length >= 2, 'contexts=' + contexts.length);

// 子框架的隔离世界（排除主框架）
const frameCtx = contexts.filter((c) => c.auxData && c.auxData.frameId && c.auxData.frameId !== page.mainFrameId);
ok('能定位到子框架隔离世界', frameCtx.length >= 1, 'frame contexts=' + frameCtx.length + ' mainFrame=' + page.mainFrameId);

/* ------------------------------ 子框架填入 ------------------------------ */

console.log('\n[2] 子框架题目被作答（经顶层弹窗回传填入）');
const filled = await until(async () => {
  // 在子框架上下文里读 DOM
  for (const c of frameCtx) {
    try {
      const res = await page.eval(`(function(){
        var q = document.querySelector('input[name=fq1][value=B]');
        if (!q) return null;
        return { q1: q.checked,
                 blank: (document.querySelector('input[name=fq2]')||{}).value || '',
                 qa: ((document.querySelector('textarea[name=fq3]')||{}).value || '').slice(0,40) };
      })()`, { contextId: c.id });
      if (res && (res.q1 || res.blank || res.qa)) return res;
    } catch (e) { /* context 可能已失效 */ }
  }
  return null;
}, { timeout: 25000, label: '子框架填入' }).catch(() => null);

ok('子框架单选题已填 B', !!(filled && filled.q1), JSON.stringify(filled));
ok('子框架填空题已填', !!(filled && filled.blank), filled && filled.blank);
ok('子框架大题已填', !!(filled && filled.qa), filled && filled.qa);

console.log('\n[3] 顶层面板承载子框架题目');
const topPanels = await page.eval(`(function(){
  var h = document.getElementById('dati-overlay-host');
  if (!h || !h.shadowRoot) return { n: 0 };
  var list = h.shadowRoot.querySelectorAll('.dati-panel');
  var stems = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i].querySelector('.dati-panel__stem');
    if (s) stems.push(s.textContent.slice(0, 40));
  }
  return { n: list.length, stems: stems };
})()`);
ok('顶层出现面板', topPanels.n > 0, 'panels=' + topPanels.n);
ok('面板内容来自子框架题目', (topPanels.stems || []).some((s) => /子框架|首都|卫星|牛顿/.test(s)), JSON.stringify(topPanels.stems));

/* ------------------------------ 坐标换算 ------------------------------ */

console.log('\n[4] 子框架坐标 → 顶层视口坐标');
const rectCheck = await page.eval(`(async function(){
  var iframe = document.getElementById('f1');
  var r = iframe.getBoundingClientRect();
  // 用子框架内部的隔离世界来算，才能验证真实链路
  return { iframeRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
})()`);
const innerAbs = await (async () => {
  for (const c of frameCtx) {
    try {
      const v = await page.eval(`(async function(){
        var innerRect = { x: 14, y: 60, w: 200, h: 30 };
        var abs = await AD.Frame.toTopRect(innerRect);
        return { inner: innerRect, abs: { x: Math.round(abs.x), y: Math.round(abs.y), w: Math.round(abs.w), h: Math.round(abs.h) } };
      })()`, { contextId: c.id });
      if (v && v.abs) return v;
    } catch (e) { /* noop */ }
  }
  return null;
})();
const combined = { iframeRect: rectCheck.iframeRect, inner: innerAbs && innerAbs.inner, abs: innerAbs && innerAbs.abs };
console.log('    ', JSON.stringify(combined));
const okRect = innerAbs && innerAbs.abs &&
  innerAbs.abs.x > rectCheck.iframeRect.x - 2 &&
  innerAbs.abs.y > rectCheck.iframeRect.y - 2 &&
  innerAbs.abs.y < rectCheck.iframeRect.y + rectCheck.iframeRect.h;
ok('子框架坐标被正确加上 iframe 偏移', !!okRect, JSON.stringify(combined));

console.log('\n[5] 子框架截图（顶层发起 + 裁剪）');
const frameShot = await (async () => {
  // 由子框架算出顶层坐标，再由顶层发起截图
  let abs = null;
  for (const c of frameCtx) {
    try {
      abs = await page.eval(`(async function(){
        return await AD.Frame.toTopRect({ x: 10, y: 10, w: 300, h: 120 });
      })()`, { contextId: c.id });
      if (abs) break;
    } catch (e) { /* noop */ }
  }
  if (!abs) return { ok: false, error: 'no abs rect' };
  return page.evalInExtension(`(function(){
    return new Promise(function(resolve){
      chrome.runtime.sendMessage({
        type: 'AD_CAPTURE_TAB',
        rect: { x: Math.round(${abs.x}), y: Math.round(${abs.y}), w: Math.round(${abs.w}), h: Math.round(${abs.h}) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        dpr: window.devicePixelRatio || 1, crop: true, format: 'png', maxSide: 800
      }, function(res){ resolve({ ok: res.ok, w: res.width, h: res.height, error: res.error || null, isPng: /^data:image\\/png;base64,/.test(res.dataUrl || '') }); });
    });
  })()`, EXT_ID);
})();
console.log('    ', JSON.stringify(frameShot));
ok('子框架区域截图成功', !!(frameShot && frameShot.ok), frameShot && frameShot.error);
ok('截图尺寸符合子框架区域', !!(frameShot && frameShot.w > 100 && frameShot.h > 40), frameShot && frameShot.w + 'x' + frameShot.h);
ok('返回 PNG data URL', !!(frameShot && frameShot.isPng));

/* ------------------------------ 元素拾取 ------------------------------ */

console.log('\n[6] 元素拾取（pickElement）');
await setSettings();
const pickResult = await page.evalInExtension(`(function(){
  return new Promise(function(resolve){
    // 直接调用底层拾取器，用真实鼠标事件点一下顶层题目
    var stem = document.querySelector('#topq .stem');
    var r = stem.getBoundingClientRect();
    var p = AD.Capture.pickElement({ hint: 'test' });
    setTimeout(function(){
      var host = document.getElementById('dati-elem-picker-host');
      if (!host || !host.shadowRoot) return resolve({ error: 'no picker host' });
      var wrap = host.shadowRoot.querySelector('.wrap');
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      function fire(type, extra){
        var ev = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }, extra || {}));
        wrap.dispatchEvent(ev);
      }
      fire('mousemove');
      setTimeout(function(){
        fire('click');
        setTimeout(function(){
          p.then(function(res){ resolve({ picked: !!res, rect: res && res.rect, selector: res && res.selector, text: res && res.el ? (res.el.innerText||'').slice(0,30) : '' }); });
        }, 120);
      }, 80);
    }, 120);
  });
})()`, EXT_ID).catch((e) => ({ error: e.message }));
console.log('    ', JSON.stringify(pickResult));
ok('元素拾取返回结果', !!(pickResult && pickResult.picked), JSON.stringify(pickResult));
ok('拾取结果带 rect', !!(pickResult && pickResult.rect && pickResult.rect.w > 0));
ok('拾取结果带选择器', !!(pickResult && pickResult.selector), pickResult && pickResult.selector);
ok('拾取到正确元素', !!(pickResult && /平方|3 的平方/.test(pickResult.text || '')), pickResult && pickResult.text);

/* ------------------------------ 模板拾取器 ------------------------------ */

console.log('\n[7] 模板拾取器（AD.Picker）推断结构');
const infer = await page.evalInExtension(`(function(){
  var root = document.querySelector('#topq');
  var s = AD.Picker.inferStructure(root);
  return {
    kind: s.kind,
    stemSelector: s.stemSelector,
    optionSelector: s.optionSelector,
    inputSelector: s.inputSelector,
    counts: s.counts,
    stem: (s.stem || '').slice(0, 40),
    rootSel: AD.Picker.patternSelector(root)
  };
})()`, EXT_ID).catch((e) => ({ error: e.message }));
console.log('    ', JSON.stringify(infer));
ok('推断出题型', !!(infer && (infer.kind === 'choice' || infer.kind === 'multi')), JSON.stringify(infer));
ok('推断出选项选择器', !!(infer && infer.optionSelector), infer && infer.optionSelector);
ok('推断出题干', !!(infer && /平方/.test(infer.stem || '')), infer && infer.stem);
ok('根选择器能命中多个同类元素', !!(infer && infer.rootSel), infer && infer.rootSel);

/* ------------------------------ 视觉兜底 ------------------------------ */

console.log('\n[8] 视觉兜底：模型支持图片时把图发过去');
await fetch(mockUrl + '/_reset', { method: 'POST' });
const vision = await page.evalInExtension(`(function(){
  return new Promise(function(resolve){
    var r = document.querySelector('#topq').getBoundingClientRect();
    chrome.runtime.sendMessage({
      type: 'AD_CAPTURE_TAB',
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio || 1, crop: true, format: 'png', maxSide: 900
    }, function(shot){
      if (!shot || !shot.ok) return resolve({ ok:false, error: shot && shot.error });
      var m = /^data:([^;,]+);base64,(.*)$/.exec(shot.dataUrl);
      var port = chrome.runtime.connect({ name: 'AD_STREAM' });
      var reqId = 'vision_test';
      var text = '';
      port.onMessage.addListener(function(msg){
        if (msg.reqId !== reqId) return;
        if (msg.type === 'AD_STREAM_CHUNK') text += msg.delta;
        if (msg.type === 'AD_STREAM_DONE') { resolve({ ok:true, text: text || msg.text }); port.disconnect(); }
        if (msg.type === 'AD_STREAM_ERROR') { resolve({ ok:false, error: msg.error }); port.disconnect(); }
      });
      port.postMessage({
        type: 'AD_STREAM_START', reqId: reqId,
        request: {
          text: '顶层题目：3 的平方是多少？',
          kind: 'choice',
          images: [{ mime: m[1], dataBase64: m[2] }],
          options: [{ label: 'A', text: '6' }, { label: 'B', text: '9' }]
        },
        options: { force: true }
      });
      setTimeout(function(){ resolve({ ok:false, error:'timeout' }); }, 15000);
    });
  });
})()`, EXT_ID);
ok('视觉请求成功', !!(vision && vision.ok), vision && vision.error);
const vreqs = await (await fetch(mockUrl + '/_requests')).json();
const withImg = vreqs.filter((r) => r.image);
ok('mock 收到带图片的请求', withImg.length >= 1, 'image reqs=' + withImg.length);
if (withImg.length) {
  const raw = JSON.stringify(withImg[withImg.length - 1].body);
  ok('图片以 data URL 传输', /"image_url":\{"url":"data:image\/png;base64,/.test(raw));
  ok('同时携带了题干文本', /3 的平方/.test(withImg[withImg.length - 1].prompt || ''), (withImg[withImg.length - 1].prompt || '').slice(0, 80));
}

console.log('\n[9] 模型不支持视觉时不发图（只发文本）');
await setSettings({
  api: { activeId: 'e2e', profiles: [{ id: 'e2e', name: 'mock', format: 'openai-chat', baseUrl: mockUrl, path: '', apiKey: 'k', model: 'mock-text-only', temperature: 0.2, maxTokens: 512, stream: true, vision: false, extraHeaders: {}, extraBody: {}, timeoutMs: 15000, lastTest: null }] }
});
await fetch(mockUrl + '/_reset', { method: 'POST' });
const noVision = await page.evalInExtension(`(function(){
  return new Promise(function(resolve){
    var port = chrome.runtime.connect({ name: 'AD_STREAM' });
    var reqId = 'novision_test';
    port.onMessage.addListener(function(msg){
      if (msg.reqId !== reqId) return;
      if (msg.type === 'AD_STREAM_DONE') { resolve({ ok:true, text: msg.text }); port.disconnect(); }
      if (msg.type === 'AD_STREAM_ERROR') { resolve({ ok:false, error: msg.error }); port.disconnect(); }
    });
    port.postMessage({
      type: 'AD_STREAM_START', reqId: reqId,
      request: { text: '纯文本题目：1+1=?', kind: 'choice', images: [{ mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }] },
      options: { force: true }
    });
    setTimeout(function(){ resolve({ ok:false, error:'timeout' }); }, 12000);
  });
})()`, EXT_ID);
ok('无视觉配置时请求仍成功', !!(noVision && noVision.ok), noVision && noVision.error);
const nvreqs = await (await fetch(mockUrl + '/_requests')).json();
ok('没有把图片发出去', nvreqs.every((r) => !r.image), 'image reqs=' + nvreqs.filter((r) => r.image).length);

/* ------------------------------ 结果 ------------------------------ */

console.log('\n[10] 视觉留档');
const shot = await page.send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.join(__dirname, 'screens'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'screens', 'e2e-frames.png'), Buffer.from(shot.data, 'base64'));
console.log('  已保存 test/screens/e2e-frames.png');

console.log('\n' + '='.repeat(52));
console.log(`结果：${pass} 通过, ${fail} 失败`);
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }

browser.kill(); mock.kill(); site.server.close();
process.exit(fail ? 1 : 0);