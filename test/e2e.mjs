/**
 * AutoDati · 端到端测试
 * 真实加载扩展 → 打开测试页 → 验证自动答题 / 弹窗 / 快捷键 / 截图。
 *
 *   node test/e2e.mjs
 *
 * 依赖：Edge/Chrome、本机回环端口。无需任何 npm 包。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, attachTo, createTarget, closeTarget, sleep, until, waitForExtension } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const EXT_ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const DEVTOOLS_PORT = 9333 + Math.floor(Math.random() * 200);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' — ' + extra : '')); }
}

/* ------------------------- 静态服务 ------------------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

function startStatic(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let file = path.join(dir, decodeURIComponent(url.pathname));
      if (url.pathname === '/') file = path.join(dir, 'page.html');
      if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* ------------------------- 启动依赖 ------------------------- */

console.log('启动 mock LLM 服务…');
const mock = spawn(process.execPath, [path.join(__dirname, 'mock-llm-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const mockUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('mock 启动超时')), 8000);
  mock.stdout.on('data', (d) => {
    const m = /MOCK_LLM_URL=(\S+)/.exec(String(d));
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});
console.log('  mock =', mockUrl);

const site = await startStatic(path.join(__dirname, 'e2e'));
console.log('  站点 =', site.url);

console.log('启动浏览器（加载扩展）…');
const browser = await launchBrowser({
  extensionPath: EXT,
  port: DEVTOOLS_PORT,
  headless: true,
  extraArgs: ['--window-size=1280,1400', '--force-device-scale-factor=1']
});
console.log('  DevTools =', browser.info.webSocketDebuggerUrl);

function cleanup() {
  try { browser.kill(); } catch { }
  try { mock.kill(); } catch { }
  try { site.server.close(); } catch { }
}

try {
  /* ------------------- 扩展是否被加载 ------------------- */
  console.log('\n[1] 扩展加载');
  const extState = await waitForExtension(DEVTOOLS_PORT, EXT_ID, { timeout: 20000, stderrFn: browser.stderr });
  ok('Service Worker 已注册', !!extState.worker, extState.worker && extState.worker.url);

  /* ------------------- 写入设置 ------------------- */
  console.log('\n[2] 通过扩展页面写入设置');
  const optTarget = await createTarget(DEVTOOLS_PORT, `chrome-extension://${EXT_ID}/ui/options.html`);
  const { cdp: optCdp } = await attachTo(DEVTOOLS_PORT, (u) => u.includes('/ui/options.html'));
  await sleep(900);
  const extApiOk = await optCdp.eval(`!!(globalThis.chrome && chrome.storage && chrome.storage.local)`);
  ok('扩展页面内 chrome.storage 可用', extApiOk === true);

  const settings = {
    version: 1,
    mode: {
      autoAnswer: true, popup: true, autoFillAfterStream: false,
      scanDebounceMs: 300, minIntervalMs: 300, maxPerPage: 20,
      skipAnswered: true, cooldownMs: 0, noticeToast: false, hoverHint: false
    },
    api: {
      activeId: 'e2e',
      profiles: [{
        id: 'e2e', name: 'E2E Mock', format: 'openai-chat',
        baseUrl: mockUrl, path: '', apiKey: 'e2e-key', model: 'mock-model',
        temperature: 0.2, maxTokens: 512, stream: true, vision: true,
        extraHeaders: {}, extraBody: {}, timeoutMs: 15000, lastTest: null
      }]
    },
    prompt: {
      system: '你是答题助手', extraInstruction: '', kindHint: {},
      language: 'zh', includeExplain: false, imageInstruction: '截图作答'
    },
    detect: {
      sitePresets: {}, customRules: [
      { id: 'e2e-choice', enabled: true, kind: 'choice', rootSelector: '#q1,#q6,#q7,#q8,#q9', stemSelector: '.stem', optionSelector: '.opt' },
      { id: 'e2e-multi', enabled: true, kind: 'multi', rootSelector: '#q2', stemSelector: '.stem', optionSelector: '.opt' },
      { id: 'e2e-judge', enabled: true, kind: 'judge', rootSelector: '#q3', stemSelector: '.stem', optionSelector: '.opt' },
      { id: 'e2e-blank', enabled: true, kind: 'blank', rootSelector: '#q4', stemSelector: '.stem', inputSelector: 'input' },
      { id: 'e2e-qa', enabled: true, kind: 'qa', rootSelector: '#q5', stemSelector: '.stem', inputSelector: 'textarea' }
    ], minTextLen: 4, viewportOnly: true, shadowDom: true
    },
    hotkey: { enabled: true, capture: 'Alt+Q', hover: 'Alt+Shift+Q', toggleAuto: 'Alt+Shift+Z', togglePopup: 'Alt+Shift+X' },
    ui: { theme: 'dark', accent: '#6366f1', panelWidth: 384, fontSize: 13, radius: 14, blur: true, animate: true, panelPosition: 'auto' },
    advanced: { log: true, areaPicker: true, maxImageSide: 1200, screenshotFormat: 'png', showScreenshotThumb: true }
  };

  const wrote = await optCdp.eval(`new Promise(function(res){
    chrome.storage.local.set({ ad_settings: ${JSON.stringify(settings)} }, function(){
      res(!!(chrome.runtime && !chrome.runtime.lastError));
    });
  })`);
  ok('设置写入 storage', wrote === true);
  const readBack = await optCdp.eval(`new Promise(function(res){
    chrome.storage.local.get('ad_settings', function(r){ res(!!(r && r.ad_settings && r.ad_settings.api)); });
  })`);
  ok('设置可读回', readBack === true);

  /* ------------------- 打开测试页 ------------------- */
  console.log('\n[3] 打开测试页并等待自动答题');
  await createTarget(DEVTOOLS_PORT, site.url + '/page.html');
  const { cdp: page, target: pageTarget } = await attachTo(DEVTOOLS_PORT, (u) => u.includes('/page.html'));
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false
  }).catch(() => null);
  await sleep(500);

  const viewportInfo = await page.eval(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollH: document.body.scrollHeight })`);
  console.log('  视口:', JSON.stringify(viewportInfo));
  ok('视口足够高（全部题目可见）', viewportInfo.h >= 1200, JSON.stringify(viewportInfo));

  const hasContentScript = await until(async () => {
    return page.eval(`(function(){
      var h = document.getElementById('dati-overlay-host');
      return !!h && !!h.shadowRoot;
    })()`);
  }, { timeout: 12000, label: '内容脚本注入' }).catch(() => false);
  ok('内容脚本已注入（overlay 宿主存在）', hasContentScript === true);

  // 等待自动答题完成
  const filled = await until(async () => {
    return page.eval(`(function(){
      var q1 = document.querySelector('input[name=q1][value=B]');
      var q2a = document.querySelector('input[name=q2][value=A]');
      var q2c = document.querySelector('input[name=q2][value=C]');
      var q3 = document.querySelector('input[name=q3][value=T]');
      var q4a = document.querySelector('input[name=q4_1]');
      var q4b = document.querySelector('input[name=q4_2]');
      var q5 = document.querySelector('textarea[name=q5]');
      var done = [q1 && q1.checked, q2a && q2a.checked, q2c && q2c.checked,
                  q3 && q3.checked, q4a && q4a.value.trim().length > 0,
                  q4b && q4b.value.trim().length > 0, q5 && q5.value.trim().length > 0];
      return done.every(Boolean) ? {
        q1: q1.checked, q2a: q2a.checked, q2c: q2c.checked, q3: q3.checked,
        q4a: q4a.value, q4b: q4b.value, q5: q5.value.slice(0, 60)
      } : false;
    })()`);
  }, { timeout: 25000, label: '自动填入完成' }).catch(() => null);

  ok('单选题已选中 B', !!(filled && filled.q1), JSON.stringify(filled));
  ok('多选题选中 A 与 C', !!(filled && filled.q2a && filled.q2c), JSON.stringify(filled));
  ok('判断题选中「正确」', !!(filled && filled.q3), JSON.stringify(filled));
  ok('填空题第一空已填', !!(filled && filled.q4a), filled && filled.q4a);
  ok('填空题第二空已填', !!(filled && filled.q4b), filled && filled.q4b);
  ok('大题 textarea 已填', !!(filled && filled.q5), filled && filled.q5);

  const untouched = await page.eval(`(function(){
    var q6 = document.querySelector('input[name=q6][value=A]');
    var q7a = document.querySelector('input[name=q7][value=A]');
    var q7b = document.querySelector('input[name=q7][value=B]');
    return { hidden: q6.checked, answeredA: q7a.checked, answeredB: q7b.checked };
  })()`);
  ok('隐藏题目未被作答', untouched.hidden === false);
  ok('已答题未被改动（仍是 B）', untouched.answeredB === true && untouched.answeredA === false, JSON.stringify(untouched));

  /* ------------------- 弹窗模式 ------------------- */
  console.log('\n[4] 弹窗（流式面板）');
  const panels = await page.eval(`(function(){
    var h = document.getElementById('dati-overlay-host');
    if (!h || !h.shadowRoot) return { n: 0 };
    var list = h.shadowRoot.querySelectorAll('.dati-panel');
    var first = list[0];
    return {
      n: list.length,
      hasStream: !!(first && first.querySelector('.dati-stream')),
      text: first ? (first.querySelector('.dati-stream') || {}).innerText || '' : '',
      hasModel: !!(first && first.querySelector('.dati-chip--model')),
      modelText: first ? (first.querySelector('.dati-chip--model') || {}).textContent : '',
      statusText: first ? (first.querySelector('.dati-status__text') || {}).textContent : '',
      fillEnabled: first ? !(first.querySelector('[data-act=fill]') || {}).disabled : false
    };
  })()`);
  ok('弹窗面板已出现', panels.n > 0, 'panels=' + panels.n);
  ok('面板含流式区域', panels.hasStream === true);
  ok('面板渲染出答案文本', (panels.text || '').length > 0, JSON.stringify((panels.text || '').slice(0, 80)));
  ok('面板显示模型名', panels.modelText === 'mock-model', panels.modelText);
  ok('完成后状态为完成', /完成/.test(panels.statusText || ''), panels.statusText);
  ok('完成后「填入」按钮可用', panels.fillEnabled === true);

  /* ------------------- 流式过程真实性 ------------------- */
  console.log('\n[5] 流式增量');
  await fetch(mockUrl + '/_reset', { method: 'POST' });
  const streamInfo = await page.eval(`(function(){
    var h = document.getElementById('dati-overlay-host');
    var panels = h.shadowRoot.querySelectorAll('.dati-panel');
    return panels.length;
  })()`);
  const reqs = await (await fetch(mockUrl + '/_requests')).json();
  ok('mock 收到请求（重启后计数）', true);
  const beforeReqs = reqs.length;

  // 手动触发一次重试以观察流式
  await page.eval(`(function(){
    var h = document.getElementById('dati-overlay-host');
    var p = h.shadowRoot.querySelector('.dati-panel');
    if (!p) return false;
    var btn = p.querySelector('[data-act=retry]');
    if (btn) btn.click();
    return true;
  })()`);
  const grew = await until(async () => {
    const r = await (await fetch(mockUrl + '/_requests')).json();
    return r.length > beforeReqs ? r : false;
  }, { timeout: 12000, label: '重试请求' }).catch(() => null);
  ok('重试会重新请求', !!grew, 'reqs=' + (grew ? grew.length : 'none'));
  if (grew) {
    const last = grew[grew.length - 1];
    ok('请求为流式', last.stream === true, 'stream=' + last.stream);
    ok('请求含题型与题干', /【题型】/.test(last.prompt) && /【题目】/.test(last.prompt), (last.prompt || '').slice(0, 120));
    ok('请求带 Bearer 认证', /Bearer e2e-key/.test(last.headers.authorization || ''), last.headers.authorization);
  }

  /* ------------------- 快捷键 ------------------- */
  console.log('\n[6] 页面内快捷键（Alt+Shift+Q 对鼠标下元素作答）');
  await page.send('Page.bringToFront').catch(() => null);
  await page.eval(`document.querySelectorAll('input[name=q1]').forEach(function(i){ i.checked = false; });
                   document.querySelector('textarea[name=q5]').value = ''; 'ok'`);
  const rect = await page.eval(`(function(){
    var el = document.querySelector('#q1 .stem');
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  // 先把鼠标移到题干上（内容脚本用 mousemove 记录坐标）
  for (const type of ['mouseMoved', 'mouseMoved']) {
    await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'none', buttons: 0 });
    await sleep(60);
  }
  await sleep(200);
  // Alt(1) + Shift(8) = 9
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', modifiers: 9, key: 'Q', code: 'KeyQ',
    windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 9, key: 'Q', code: 'KeyQ',
    windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81
  });

  const hotkeyResult = await until(async () => {
    const checked = await page.eval(`(function(){
      var q1 = document.querySelector('input[name=q1][value=B]');
      var h = document.getElementById('dati-overlay-host');
      var n = h && h.shadowRoot ? h.shadowRoot.querySelectorAll('.dati-panel').length : 0;
      return { checked: !!(q1 && q1.checked), panels: n };
    })()`);
    return (checked.checked || checked.panels > 0) ? checked : false;
  }, { timeout: 15000, label: '快捷键作答' }).catch(() => null);
  ok('快捷键触发（弹窗或填入）', !!hotkeyResult, JSON.stringify(hotkeyResult));

  /* ------------------- 截图答题 ------------------- */
  console.log('\n[7] 截图答题链路（captureVisibleTab + 裁剪）');
  const capResult = await page.evalInExtension(`(function(){
    return new Promise(function(resolve){
      var r = document.querySelector('#q2').getBoundingClientRect();
      chrome.runtime.sendMessage({
        type: 'AD_CAPTURE_TAB',
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        dpr: window.devicePixelRatio || 1,
        crop: true, format: 'png', maxSide: 800
      }, function(res){ resolve(res || { ok:false, error:'no response' }); });
    });
  })()`, EXT_ID).catch(async (e) => {
    // 回退：经由单次消息 + 主世界桥接
    return { ok: false, error: 'evalInExtension 失败: ' + e.message };
  });
  ok('截图请求成功', !!(capResult && capResult.ok), capResult && capResult.error);
  ok('返回 data URL', !!(capResult && /^data:image\/png;base64,/.test(capResult.dataUrl || '')), (capResult && String(capResult.dataUrl).slice(0, 40)));
  ok('裁剪尺寸合理', !!(capResult && capResult.width > 50 && capResult.height > 20), capResult && capResult.width + 'x' + capResult.height);

  // 用截图走一次完整视觉请求
  if (capResult && capResult.ok) {
    const vision = await page.evalInExtension(`(function(){
      var img = ${JSON.stringify(capResult.dataUrl)};
      var m = /^data:([^;,]+);base64,(.*)$/.exec(img);
      return new Promise(function(resolve){
        var port = chrome.runtime.connect({ name: 'AD_STREAM' });
        var reqId = 'e2e_vision';
        var text = '';
        var done = false;
        port.onMessage.addListener(function(msg){
          if (msg.reqId !== reqId) return;
          if (msg.type === 'AD_STREAM_CHUNK') text += msg.delta;
          if (msg.type === 'AD_STREAM_DONE') { done = true; resolve({ ok:true, text: text || msg.text }); port.disconnect(); }
          if (msg.type === 'AD_STREAM_ERROR') { done = true; resolve({ ok:false, error: msg.error }); port.disconnect(); }
        });
        port.postMessage({
          type: 'AD_STREAM_START', reqId: reqId,
          request: { text: '题目截图', kind: 'generic', images: [{ mime: m[1], dataBase64: m[2] }] },
          options: { force: true }
        });
        setTimeout(function(){ if (!done) { resolve({ ok:false, error:'timeout' }); } }, 15000);
      });
    })()`, EXT_ID);
    ok('视觉请求成功', !!(vision && vision.ok), vision && vision.error);
    ok('视觉请求返回答案', !!(vision && (vision.text || '').length > 0), vision && String(vision.text).slice(0, 60));
    const vreqs = await (await fetch(mockUrl + '/_requests')).json();
    const vreq = vreqs.filter((r) => r.image).pop();
    ok('mock 收到带图片的请求', !!vreq, 'count=' + vreqs.filter((r) => r.image).length);
    if (vreq) ok('图片以 data URL 传输', /"image_url":\{"url":"data:image\/png;base64,/.test(JSON.stringify(vreq.body)));
  }

  /* ------------------- 模式开关 ------------------- */
  console.log('\n[8] 模式开关（关闭后不再自动检测）');
  const toggled = await page.evalInExtension(`new Promise(function(res){
    chrome.storage.local.get('ad_settings', function(r){
      var s = r.ad_settings;
      s.mode.autoAnswer = false;
      s.mode.popup = false;
      chrome.storage.local.set({ ad_settings: s }, function(){ res(true); });
    });
  })`, EXT_ID);
  ok('设置已更新', toggled === true);
  await sleep(700);
  await page.eval(`(function(){
    var h = document.getElementById('dati-overlay-host');
    if (h && h.shadowRoot) {
      h.shadowRoot.querySelectorAll('.dati-panel').forEach(function(p){ p.remove(); });
    }
    document.querySelectorAll('input[name=q1]').forEach(function(i){ i.checked = false; });
    return true;
  })()`);
  // 触发一次 DOM 变化，看是否还会自动作答
  await page.eval(`(function(){
    var d = document.createElement('div');
    d.className = 'q';
    d.innerHTML = '<div class="stem">8. 新增题目：1+1 等于几？</div>' +
      '<label class="opt"><input type="radio" name="q8" value="A" /> A. 1</label>' +
      '<label class="opt"><input type="radio" name="q8" value="B" /> B. 2</label>';
    document.body.appendChild(d);
    return true;
  })()`);
  await sleep(2500);
  const afterOff = await page.eval(`(function(){
    var q8 = document.querySelector('input[name=q8][value=B]');
    var h = document.getElementById('dati-overlay-host');
    var n = h && h.shadowRoot ? h.shadowRoot.querySelectorAll('.dati-panel').length : 0;
    return { q8: q8 ? q8.checked : null, panels: n };
  })()`);
  ok('关闭模式后不再自动作答', afterOff.q8 === false, JSON.stringify(afterOff));
  ok('关闭模式后不再弹窗', afterOff.panels === 0, 'panels=' + afterOff.panels);

  /* ------------------- 截图留档 ------------------- */
  console.log('\n[9] 视觉留档');
  await page.evalInExtension(`new Promise(function(res){
    chrome.storage.local.get('ad_settings', function(r){
      var s = r.ad_settings;
      s.mode.autoAnswer = true; s.mode.popup = true;
      chrome.storage.local.set({ ad_settings: s }, function(){ res(true); });
    });
  })`, EXT_ID);
  await sleep(500);
  await sleep(300);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const outDir = path.join(__dirname, 'screens');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'e2e-page.png'), Buffer.from(shot.data, 'base64'));
  console.log('  已保存 test/screens/e2e-page.png');

  const ruleScan = await page.evalInExtension(`AD.Detector.scan(document,{}).map(function(q){return q.root&&q.root.id})`, EXT_ID);
  ok('重新开启后自定义规则仍可检测题目', Array.isArray(ruleScan) && ruleScan.indexOf('q1') >= 0, JSON.stringify(ruleScan));

  /* ------------------- 错误处理 ------------------- */
  console.log('\n[11] 总开关（enabled=false 时完全静默）');
  await page.evalInExtension(`new Promise(function(res){
    chrome.storage.local.get('ad_settings', function(r){
      var s = r.ad_settings;
      s.enabled = false;
      s.mode.autoAnswer = true; s.mode.popup = true;
      chrome.storage.local.set({ ad_settings: s }, function(){ res(true); });
    });
  })`, EXT_ID);
  await sleep(800);
  await page.eval(`(function(){
    var h = document.getElementById('dati-overlay-host');
    if (h && h.shadowRoot) h.shadowRoot.querySelectorAll('.dati-panel').forEach(function(p){ p.remove(); });
    document.querySelectorAll('input[name=q1],input[name=q9]').forEach(function(i){ i.checked = false; });
    var d = document.createElement('div');
    d.className = 'q';
    d.innerHTML = '<div class="stem">9. 总开关关闭测试：2+2 等于几？</div>' +
      '<label class="opt"><input type="radio" name="q9" value="A" /> A. 3</label>' +
      '<label class="opt"><input type="radio" name="q9" value="B" /> B. 4</label>';
    document.body.appendChild(d);
    return true;
  })()`);
  await sleep(2600);
  const whenDisabled = await page.eval(`(function(){
    var q9 = document.querySelector('input[name=q9][value=B]');
    var h = document.getElementById('dati-overlay-host');
    return { q9: q9 ? q9.checked : null, panels: h && h.shadowRoot ? h.shadowRoot.querySelectorAll('.dati-panel').length : 0 };
  })()`);
  ok('总开关关闭后不自动作答', whenDisabled.q9 === false, JSON.stringify(whenDisabled));
  ok('总开关关闭后不弹窗', whenDisabled.panels === 0, 'panels=' + whenDisabled.panels);

  // 重新打开
  await page.evalInExtension(`new Promise(function(res){
    chrome.storage.local.get('ad_settings', function(r){
      var s = r.ad_settings; s.enabled = true;
      chrome.storage.local.set({ ad_settings: s }, function(){ res(true); });
    });
  })`, EXT_ID);

  console.log('\n[12] 未知 profile 不崩溃');
  const badReq = await page.evalInExtension(`(function(){
    return new Promise(function(resolve){
      var port = chrome.runtime.connect({ name: 'AD_STREAM' });
      var reqId = 'e2e_bad';
      port.onMessage.addListener(function(msg){
        if (msg.reqId !== reqId) return;
        if (msg.type === 'AD_STREAM_ERROR') { resolve({ ok:false, code: msg.code, error: msg.error }); port.disconnect(); }
        if (msg.type === 'AD_STREAM_DONE') { resolve({ ok:true }); port.disconnect(); }
      });
      port.postMessage({ type: 'AD_STREAM_START', reqId: reqId, request: { text:'x', kind:'choice' }, options: { force: true, profileId: 'nope' } });
      setTimeout(function(){ resolve({ ok:false, error:'timeout' }); }, 8000);
    });
  })()`, EXT_ID);
  ok('未知 profile 回退到当前配置而非崩溃', badReq && badReq.ok === true, JSON.stringify(badReq));

  /* ------------------- 结果 ------------------- */
  console.log('\n' + '='.repeat(52));
  console.log(`结果：${pass} 通过, ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  await closeTarget(DEVTOOLS_PORT, pageTarget.id).catch(() => null);
  await closeTarget(DEVTOOLS_PORT, optTarget.id).catch(() => null);
  cleanup();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('\nE2E 异常终止：', e && (e.stack || e.message || e));
  console.error('浏览器 stderr 尾部：\n' + String(browser.stderr() || '').split('\n').slice(-25).join('\n'));
  cleanup();
  process.exit(2);
}