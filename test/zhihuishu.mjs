/**
 * 智慧树真实页面回归
 *   node test/zhihuishu.mjs
 *
 * 验证：
 *  1) 智慧树预设按 URL 自动启用（无需手动开站点预设）
 *  2) 题干空（Vue 未渲染）时不出题，杜绝「Question missing」瞎猜
 *  3) 右侧答题卡（.answerCard 剩余时间/完成率/题号）不再被误判
 *  4) 单选题不被误判成判断题
 *  5) 自定义规则域名限定生效
 *  6) 思考开关按模型家族注入请求参数
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser, attachTo, createTarget, sleep, until, waitForExtension } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const EXT_ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 10800 + Math.floor(Math.random() * 80);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' — ' + extra : '')); }
}

// 本地复刻智慧树 DOM 的测试页（结构与用户提供的 DOM-DUMP 一致）
const FIXTURE = path.join(__dirname, 'e2e', 'zhihuishu.html');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const site = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(path.dirname(FIXTURE), u.pathname === '/' ? 'zhihuishu.html' : u.pathname);
    fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(b);
    });
  });
  s.listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
});

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-llm-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const mockUrl = await new Promise((res) => {
  mock.stdout.on('data', (d) => { const m = /MOCK_LLM_URL=(\S+)/.exec(String(d)); if (m) res(m[1]); });
});

const browser = await launchBrowser({ extensionPath: EXT, port: PORT, headless: true, extraArgs: ['--window-size=1400,1000'] });
await waitForExtension(PORT, EXT_ID, { stderrFn: browser.stderr });

const optT = await createTarget(PORT, `chrome-extension://${EXT_ID}/ui/options.html`);
const { cdp: opt } = await attachTo(PORT, (u) => u.includes('/ui/options.html'));
await sleep(600);
const S = {
  enabled: true,
  mode: { autoAnswer: false, popup: true, autoFillAfterStream: false, scanDebounceMs: 250, minIntervalMs: 250, maxPerPage: 20, skipAnswered: false, cooldownMs: 0, noticeToast: false, hoverHint: false },
  api: { activeId: 'e2e', profiles: [{ id: 'e2e', name: 'm', format: 'openai-chat', baseUrl: mockUrl, path: '', apiKey: 'k', model: 'glm-4-plus', temperature: 0.2, maxTokens: 512, stream: true, vision: true, reasoning: 'auto', extraHeaders: {}, extraBody: {}, timeoutMs: 15000, lastTest: null }] },
  prompt: { system: 'x', extraInstruction: '', kindHint: {}, language: 'zh', includeExplain: false, imageInstruction: 'x' },
  detect: { sitePresets: { zhihuishu: true }, customRules: [], minTextLen: 4, viewportOnly: true, shadowDom: true },
  hotkey: { enabled: true, capture: 'Alt+Q', hover: 'Alt+Shift+Q', picker: 'Alt+Shift+E', toggleAuto: 'Alt+Shift+Z', togglePopup: 'Alt+Shift+X' },
  ui: { theme: 'dark', accent: '#6366f1', panelWidth: 384, fontSize: 13, radius: 14, blur: true, animate: true, panelPosition: 'auto' },
  advanced: { log: true, areaPicker: true, maxImageSide: 1200, screenshotFormat: 'png', showScreenshotThumb: true }
};
await opt.eval('new Promise(function(r){chrome.storage.local.set({ad_settings:' + JSON.stringify(S) + '},r)})');

await createTarget(PORT, site.url + '/zhihuishu.html');
const { cdp: page } = await attachTo(PORT, (u) => u.includes('127.0.0.1'));
await page.captureMainFrameId();
await sleep(2500);
await until(async () => {
  try { return await page.evalInExtension('!!(globalThis.AD && AD.Detector)', EXT_ID); }
  catch (e) { return false; }
}, { timeout: 15000, interval: 300, label: 'ctx' }).catch(() => false);

console.log('\n[1] 智慧树预设按 URL 自动启用');
const scan1 = await page.evalInExtension(`(function(){
  var list = AD.Detector.scan(document, {});
  return {
    n: list.length,
    items: list.map(function(q){ return { kind: q.kind, stem: (q.stem||'').slice(0,30), opts: (q.options||[]).length, conf: q.confidence, preset: q.presetId, answered: q.answered }; })
  };
})()`, EXT_ID);
console.log('   ', JSON.stringify(scan1));
ok('检测到智慧树题目', scan1.n >= 2, JSON.stringify(scan1.items));
ok('题干非空（不再是 Question missing）', scan1.items.every((q) => (q.stem || '').length > 2), JSON.stringify(scan1.items.map((q) => q.stem)));
ok('预设 id 是 zhihuishu（站点开关启用）', scan1.items.some((q) => q.preset === 'zhihuishu'), JSON.stringify(scan1.items.map((q) => q.preset)));
ok('题型正确（单选/多选，不是全判断）', scan1.items.some((q) => q.kind === 'choice') && scan1.items.some((q) => q.kind === 'multi'), JSON.stringify(scan1.items.map((q) => q.kind)));
ok('答题卡/剩余时间没被当成题', scan1.items.every((q) => !/剩余时间|完成率/.test(q.stem || '')), JSON.stringify(scan1.items.map((q) => q.stem)));

console.log('\n[2] 题干为空的智慧树题块不出题（空 Vue 占位）');
const emptyCheck = await page.evalInExtension(`(function(){
  // 构造一个题干为空的 .examPaper_subject（模拟 Vue 未渲染完）
  var d = document.createElement('div');
  d.className = 'examPaper_subject mt20';
  d.innerHTML = '<div class="subject_stem clearfix"><div class="subject_type_describe fl"><div class="subject_num fl"><span>9.</span></div>' +
    '<div class="subject_type_annex"><span class="subject_type"><span>【单选题】</span><span>(2分)</span></span></div>' +
    '<div class="subject_describe dynamic-fonts"><div data-v-x=""><div data-v-x=""></div></div></div></div></div>' +
    '<div class="subject_node"><div class="nodeLab"><span class="mr10 ABCase">A.</span><div class="node_detail examquestions-answer"><p>选项一</p></div></div>' +
    '<div class="nodeLab"><span class="mr10 ABCase">B.</span><div class="node_detail examquestions-answer"><p>选项二</p></div></div></div>';
  document.body.appendChild(d);
  var list = AD.Detector.scan(document, {});
  var hit = list.filter(function(q){ return q.root === d; });
  d.remove();
  return { detected: hit.length, total: list.length };
})()`, EXT_ID);
ok('空题干题块被跳过', emptyCheck.detected === 0, JSON.stringify(emptyCheck));

console.log('\n[3] 自定义规则域名限定');
// 规则只对 example.com 生效 → 当前 127.0.0.1 不应命中
const domCheck = await page.evalInExtension(`(function(){
  var rule = {
    id: 'domtest', name: '域名限定规则', enabled: true, kind: 'choice',
    rootSelector: '#topq', domains: ['example.com']
  };
  var before = AD.Detector.scan(document, {}).length;
  // 直接构造 settings 注入单条规则验证
  return new Promise(function(resolve){
    chrome.storage.local.get('ad_settings', function(r){
      var s = r.ad_settings;
      s.detect.customRules = [rule];
      chrome.storage.local.set({ ad_settings: s }, function(){
        setTimeout(function(){
          var list = AD.Detector.scan(document, {});
          var hit = list.filter(function(q){ return q.presetId === 'custom:domtest'; });
          // 恢复
          chrome.storage.local.get('ad_settings', function(r2){
            var s2 = r2.ad_settings;
            s2.detect.customRules = [];
            chrome.storage.local.set({ ad_settings: s2 });
          });
          resolve({ before: before, hit: hit.length });
        }, 500);
      });
    });
  });
})()`, EXT_ID);
ok('域名不匹配时规则不生效', domCheck.hit === 0, JSON.stringify(domCheck));

console.log('\n[4] 心跳重扫去重（cooldownMs=0）与手动重试');
const requestCount = async () => (await (await fetch(mockUrl + '/_requests')).json()).length;
await until(async () => await page.evalInExtension('AD.App.state.active === 0 && AD.App.state.queue.length === 0', EXT_ID), { timeout: 8000 }).catch(() => false);
const beforeHeartbeat = await requestCount();
await sleep(6500);
ok('心跳不重复请求已展示的题目', beforeHeartbeat > 0 && await requestCount() === beforeHeartbeat);
await opt.eval('AD.Settings.save({mode:{cooldownMs:60000}})');
await sleep(300);
await page.eval(`document.getElementById('dati-overlay-host').shadowRoot.querySelector('[data-act=retry]').click()`);
const retried = await until(async () => await requestCount() > beforeHeartbeat, { timeout: 5000 }).catch(() => false);
ok('60 秒冷却内手动重试仍可重新请求', !!retried);

console.log('\n[5] 封闭 Shadow DOM 题干、模板和选中标记');
const shadowCheck = await page.evalInExtension(`(function(){
  AD.Overlay.closeAll();
  var root = document.querySelector('.examPaper_subject');
  document.querySelectorAll('.examPaper_subject').forEach(function(q){ if(q !== root) q.style.display = 'none'; });
  var stem = root.querySelector('.subject_describe');
  stem.innerHTML = '<div><div id="closed-stem"></div></div>';
  var host = stem.querySelector('#closed-stem');
  var shadow = host.attachShadow({mode:'closed'});
  shadow.innerHTML = '<style>p { color: black }</style><p>封闭组件中的完整题干是什么？</p>';
  AD._testShadow = shadow;
  AD._testQuestionRoot = root;
  var q = AD.Detector.scan(document, {})[0];
  var inferred = AD.Picker.inferStructure(root);
  var picked = AD.Detector.buildFromElement(root.querySelector('.node_detail'));
  root.querySelector('.node_detail').classList.add('onChecked');
  var answered = AD.Detector.scan(document, {})[0];
  root.querySelector('.node_detail').classList.remove('onChecked');
  return { api: !!(chrome.dom && chrome.dom.openOrClosedShadowRoot), closed: host.shadowRoot === null,
    stem: q && q.stem, opts: q && q.options.map(function(o){return o.text;}),
    inferred: inferred, picked: picked && picked.root === root, answered: answered && answered.answered };
})()`, EXT_ID);
ok('真实扩展能读取封闭根（普通 shadowRoot 为 null）', shadowCheck.api && shadowCheck.closed);
ok('封闭根题干完整且排除样式文本', shadowCheck.stem === '封闭组件中的完整题干是什么？', JSON.stringify(shadowCheck));
ok('选项正文完整', shadowCheck.opts.length === 3 && shadowCheck.opts[0] === '生理唤醒');
ok('拾取模板使用完整选项容器和真实题干', shadowCheck.inferred.optionSelector === '.nodeLab' && shadowCheck.inferred.stemSelector === '.subject_describe' && shadowCheck.inferred.stem === shadowCheck.stem);
ok('点选项能归并到单道题目', shadowCheck.picked);
ok('onChecked 标记识别为已答', shadowCheck.answered);

console.log('\n[6] 封闭根文本更新能及时识别，题目稳定后才请求');
await sleep(1000);
await until(async () => await page.evalInExtension('AD.App.state.active === 0', EXT_ID), { timeout: 8000 }).catch(() => false);
const beforeMutation = await requestCount();
await page.evalInExtension(`AD._testShadow.querySelector('p').firstChild.nodeValue = '异步题干先加载，选项随后更新？'`, EXT_ID);
await sleep(290);
await page.evalInExtension(`AD._testQuestionRoot.querySelector('.node_detail p').firstChild.nodeValue = '异步更新后的选项正文'`, EXT_ID);
ok('题目尚未稳定时没有提前请求', await requestCount() === beforeMutation);
const textDetected = await until(async () => await requestCount() > beforeMutation, { timeout: 2500, interval: 100 }).catch(() => false);
ok('文本节点变化在心跳前被监听到', !!textDetected);
const mutationLog = await (await fetch(mockUrl + '/_requests')).json();
ok('请求包含更新后的题干和选项', /异步题干先加载/.test(mutationLog.at(-1).prompt) && /异步更新后的选项正文/.test(mutationLog.at(-1).prompt));
await sleep(700);
ok('连续更新最终只发一次新题请求', await requestCount() === beforeMutation + 1);

console.log('\n[7] 旧自定义模板不能绕过空题干/整页保护');
const legacyCheck = await page.evalInExtension(`(function(){
  var root = AD._testQuestionRoot;
  var original = AD.Settings.snapshot;
  var s = original();
  var copy = JSON.parse(JSON.stringify(s));
  copy.detect.customRules = [{id:'legacy',kind:'multi',rootSelector:'.paper',stemSelector:'.subject_stem',optionSelector:'.fl.ffff'}];
  AD.Settings.snapshot = function(){return copy;};
  var broad = AD.Detector.scan(document, {viewportOnly:false}).filter(function(q){return q.presetId === 'custom:legacy';}).length;
  copy.detect.customRules[0].rootSelector = '.examPaper_subject';
  var good = AD.Detector.scan(document, {}).find(function(q){return q.root === root;});
  AD._testShadow.querySelector('p').textContent = '';
  var empty = AD.Detector.scan(document, {}).filter(function(q){return q.root === root;}).length;
  AD.Settings.snapshot = original;
  return { broad:broad, good:good && good.stem, options:good && good.options.length, empty:empty };
})()`, EXT_ID);
ok('整页模板不能合并多道题', legacyCheck.broad === 0);
ok('旧错误选项选择器自动按站点结构读取', /异步题干/.test(legacyCheck.good) && legacyCheck.options === 3);
ok('旧规则也不能把题型标签当题干', legacyCheck.empty === 0);

console.log('\n[8] 思考开关按模型家族注入（本地装载 background/llm.js 验证）');
const { default: vm } = await import('node:vm');
const sandbox = { console, fetch, AbortController, TextDecoder, TextEncoder, URL, setTimeout, clearTimeout, setInterval, clearInterval, Date, Object, Array, String, Number, JSON, Math, RegExp, Error, Map, Set, isFinite, parseInt, parseFloat };
sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
for (const rel of ['extension/common/protocol.js', 'extension/common/settings.js', 'extension/background/llm.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
const LLM = sandbox.AD.LLM;
const reasoning = (function () {
  function probe(model, mode, format) {
    const p = { id: 'x', format: format || 'openai-chat', model: model, reasoning: mode, maxTokens: 2048 };
    const params = LLM.reasoningParams(p);
    if (!params) return null;
    return LLM.applyReasoning({}, params);
  }
  return {
    glmOff: probe('glm-4-plus', 'off'),
    glmOn: probe('glm-4-plus', 'on'),
    glmAuto: probe('glm-4-plus', 'auto'),
    qwenOff: probe('qwen3-max', 'off'),
    dsR1Off: (function () { const p = { id: 'x', format: 'openai-chat', model: 'deepseek-r1', reasoning: 'off', maxTokens: 2048 }; return LLM.reasoningParams(p) || {}; })(),
    gpt5Off: probe('gpt-5', 'off'),
    geminiOff: probe('gemini-2.5-flash', 'off', 'gemini'),
    claudeOn: probe('claude-sonnet-4-5', 'on', 'anthropic')
  };
})();
console.log('   ', JSON.stringify(reasoning));
ok('GLM off → thinking.disabled', reasoning.glmOff && reasoning.glmOff.thinking && reasoning.glmOff.thinking.type === 'disabled', JSON.stringify(reasoning.glmOff));
ok('GLM on → thinking.enabled', reasoning.glmOn && reasoning.glmOn.thinking && reasoning.glmOn.thinking.type === 'enabled');
ok('GLM auto → 不注入', reasoning.glmAuto === null);
ok('Qwen3 off → enable_thinking=false', reasoning.qwenOff && reasoning.qwenOff.enable_thinking === false, JSON.stringify(reasoning.qwenOff));
ok('DeepSeek-R1 提示不支持关闭', reasoning.dsR1Off && /不支持/.test(reasoning.dsR1Off.note || ''), JSON.stringify(reasoning.dsR1Off));
ok('DeepSeek-R1 不注入请求参数', Object.keys(reasoning.dsR1Off).length === 1, JSON.stringify(reasoning.dsR1Off));
ok('GPT-5 off → reasoning_effort=minimal', reasoning.gpt5Off && reasoning.gpt5Off.reasoning_effort === 'minimal');
ok('Gemini off → thinkingBudget=0', reasoning.geminiOff && reasoning.geminiOff.generationConfig && reasoning.geminiOff.generationConfig.thinkingConfig && reasoning.geminiOff.generationConfig.thinkingConfig.thinkingBudget === 0, JSON.stringify(reasoning.geminiOff));
ok('Claude on → thinking.enabled', reasoning.claudeOn && reasoning.claudeOn.thinking && reasoning.claudeOn.thinking.type === 'enabled');

console.log('\n[9] 截图题目复现：DOM → 模型请求 → 弹窗选项');
const expectedOptions = ['被理解、被倾听', '陪伴、同情', '成就感、荣誉感', '安全感、掌控感'];
await page.evalInExtension(`(function(){
  AD.Overlay.closeAll();
  document.querySelector('.paper').innerHTML = '<h2>题目选项显示验证（模拟模型）</h2>' +
    '<div class="examPaper_subject"><div class="subject_stem"><span class="subject_type">【单选题】 (2分)</span>' +
    '<div class="subject_describe">当我们感到焦虑时，背后可能隐藏的需求是（ ）。</div></div><div class="subject_node">' +
    ${JSON.stringify(expectedOptions)}.map(function(text, i){ return '<div class="nodeLab"><div class="label clearfix">' +
      '<div class="fl ffff"><input type="radio" style="display:none"' + (i === 0 ? ' checked' : '') + '></div>' +
      '<span class="ABCase">' + String.fromCharCode(65+i) + '.</span><div class="node_detail"><p>' + text + '</p></div></div></div>'; }).join('') +
    '</div></div>';
})()`, EXT_ID);
const optionPanelReady = await until(async () => await page.eval(`(function(){
  var host = document.getElementById('dati-overlay-host');
  var panel = host && Array.from(host.shadowRoot.querySelectorAll('.dati-panel')).find(function(el){
    return el.querySelector('.dati-panel__stem').textContent === '当我们感到焦虑时，背后可能隐藏的需求是（ ）。';
  });
  return panel && panel.classList.contains('is-done');
})()`), { timeout: 8000, interval: 100 }).catch(() => false);
ok('题目自动识别并生成答案', !!optionPanelReady);
const optionChain = await page.evalInExtension(`(function(){
  var q = AD.Detector.scan(document, {})[0];
  var panel = Array.from(document.getElementById('dati-overlay-host').shadowRoot.querySelectorAll('.dati-panel')).find(function(el){
    return el.querySelector('.dati-panel__stem').textContent === q.stem;
  });
  return { labels: q.options.map(function(o){return o.label;}), texts: q.options.map(function(o){return o.text;}),
    shown: Array.from(panel.querySelectorAll('.dati-question-option__text')).map(function(el){return el.textContent;}),
    shownLabels: Array.from(panel.querySelectorAll('.dati-question-option__label')).map(function(el){return el.textContent;}),
    answer: panel.querySelector('.dati-answer-chip').textContent,
    highlighted: Array.from(panel.querySelectorAll('.dati-question-option.is-answer')).map(function(el){return el.textContent;}) };
})()`, EXT_ID);
ok('解析出 A/B/C/D，保持页面顺序', optionChain.labels.join(',') === 'A,B,C,D');
ok('解析出四项完整正文', JSON.stringify(optionChain.texts) === JSON.stringify(expectedOptions));
ok('弹窗显示四项完整正文', JSON.stringify(optionChain.shown) === JSON.stringify(expectedOptions));
ok('弹窗字母和正文一一对应', optionChain.shownLabels.join(',') === 'A.,B.,C.,D.');
const optionRequests = await (await fetch(mockUrl + '/_requests')).json();
ok('实际模型请求带有四项字母和正文', expectedOptions.every((text, i) => optionRequests.at(-1).prompt.includes(String.fromCharCode(65+i) + '. ' + text)));
ok('模拟模型的 B 对应完整选项内容', optionChain.answer === 'B · 陪伴、同情');
ok('高亮模型答案与原网页已选 A 不混淆', optionChain.highlighted.length === 1 && optionChain.highlighted[0] === 'B.陪伴、同情');
await sleep(250);
const optionShot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.mkdirSync(path.join(__dirname, 'screens'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'screens', 'zhihuishu-options.png'), Buffer.from(optionShot.data, 'base64'));

const refreshedOptions = await page.evalInExtension(`(function(){
  var q = AD.Detector.scan(document, {})[0];
  var id = AD.Overlay.show({question:q});
  var updated = Object.assign({},q,{options:[{label:'D',text:'<b>原样显示的选项</b>'},{label:'A',text:'另一个选项'}]});
  AD.Overlay.setQuestion(id, updated);
  AD.Overlay.done(id, {text:'D'});
  var s = AD.Overlay.session(id);
  var result = {texts:Array.from(s.optionsEl.querySelectorAll('.dati-question-option__text')).map(function(el){return el.textContent;}),
    label:s.optionsEl.querySelector('.dati-question-option__label').textContent, markup:s.optionsEl.querySelectorAll('b').length,
    answer:s.chips.querySelector('.dati-answer-chip').textContent};
  AD.Overlay.setQuestion(id, Object.assign({},q,{kind:'qa',options:[]}));
  result.noOptionsHidden = s.optionsEl.hidden;
  return result;
})()`, EXT_ID);
ok('更新题目时刷新选项，字母不按下标重排', refreshedOptions.texts.length === 2 && refreshedOptions.label === 'D.');
ok('选项按纯文本显示，避免 HTML 注入', refreshedOptions.texts[0] === '<b>原样显示的选项</b>' && refreshedOptions.markup === 0);
ok('答案映射按选项字母查找', refreshedOptions.answer === 'D · <b>原样显示的选项</b>');
ok('无选项的问答题隐藏选项区域', refreshedOptions.noOptionsHidden);

console.log('\n' + '='.repeat(52));
console.log(`结果：${pass} 通过, ${fail} 失败`);
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
browser.kill(); mock.kill(); site.server.close();
process.exit(fail ? 1 : 0);
