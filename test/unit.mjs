/**
 * AutoDati · 适配层单元/集成测试
 * 用 vm 把经典脚本装进沙箱，对着 mock 服务跑四种格式的流式与非流式。
 *
 *   node test/unit.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' — ' + extra : '')); }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

/* ------------------------- 启动 mock 服务 ------------------------- */

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-llm-server.mjs')], {
  stdio: ['ignore', 'pipe', 'inherit']
});
const mockUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('mock server timeout')), 8000);
  mock.stdout.on('data', (d) => {
    const m = /MOCK_LLM_URL=(\S+)/.exec(String(d));
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});
console.log('mock server:', mockUrl);

/* ------------------------- 装载扩展脚本 ------------------------- */

const sandbox = {
  console,
  fetch,
  AbortController,
  TextDecoder,
  TextEncoder,
  URL,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Map,
  Set,
  isFinite,
  parseInt,
  parseFloat,
  queueMicrotask,
  chrome: undefined
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

for (const rel of ['extension/common/protocol.js', 'extension/common/settings.js', 'extension/background/llm.js']) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}
const AD = sandbox.AD;
ok('AD.LLM 已装载', !!AD && !!AD.LLM && typeof AD.LLM.stream === 'function');

/* ------------------------- 工具 ------------------------- */

const SETTINGS = {
  prompt: {
    system: '你是答题助手',
    extraInstruction: '',
    kindHint: {},
    language: 'zh',
    includeExplain: false,
    imageInstruction: '截图作答'
  }
};

function profile(format, extra) {
  return Object.assign({
    id: 'p_' + format,
    name: format,
    format,
    baseUrl: mockUrl,
    path: '',
    apiKey: 'test-key',
    model: format === 'gemini' ? 'gemini-2.5-flash' : (format === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini'),
    temperature: 0.2,
    maxTokens: 512,
    stream: true,
    vision: true,
    extraHeaders: {},
    extraBody: {},
    timeoutMs: 15000
  }, extra || {});
}

function runStream(p, request, options) {
  return new Promise((resolve) => {
    let text = '';
    let ready = null;
    const deltas = [];
    AD.LLM.stream({ settings: SETTINGS, profile: p, request, options: options || {} }, {
      onReady: (i) => { ready = i; },
      onDelta: (d) => { deltas.push(d); text += d; },
      onDone: (r) => resolve({ ok: true, ready, text: r.text, deltas, usage: r.usage, ms: r.ms, format: r.format }),
      onError: (e) => resolve({ ok: false, error: e.message, code: e.code, deltas, text })
    });
  });
}

/* ------------------------- 用例 ------------------------- */

console.log('\n[1] SSE 解析器');
{
  const events = [];
  const p = AD.LLM.createSSEParser((ev) => events.push(ev));
  p.push('data: {"a":1}\n\n');
  p.push('event: foo\ndata: {"b":2}\n\n');
  p.push('data: [DO');
  p.push('NE]\n\n');
  p.push(': comment\n\n');
  p.push('data: {"c":3}');
  p.flush();
  eq('事件数量', events.length, 4);
  eq('普通 data', events[0].json, { a: 1 });
  eq('event 字段', events[1].event, 'foo');
  ok('DONE 标记', events[2].done === true);
  eq('flush 收尾事件', events[3].json, { c: 3 });
}

console.log('\n[2] 四种格式流式');
for (const fmt of ['openai-chat', 'openai-responses', 'anthropic', 'gemini']) {
  const r = await runStream(profile(fmt), { text: '1+1=?', kind: 'choice' });
  ok(fmt + ' 请求成功', r.ok, r.error);
  ok(fmt + ' 有内容', (r.text || '').length > 0, 'text=' + JSON.stringify(r.text));
  ok(fmt + ' 多分片流式', r.deltas.length >= 1, 'deltas=' + r.deltas.length);
  ok(fmt + ' ready 回调', !!r.ready && !!r.ready.model);
}

console.log('\n[3] 答案内容符合题型约定');
{
  const choice = await runStream(profile('openai-chat'), { text: '题干', kind: 'choice', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }] });
  eq('单选题答案', choice.text.trim(), 'B');
  const multi = await runStream(profile('openai-chat'), { text: '题干', kind: 'multi' });
  eq('多选题答案', multi.text.trim(), 'A,C');
  const judge = await runStream(profile('openai-chat'), { text: '题干', kind: 'judge' });
  eq('判断题答案', judge.text.trim(), '正确');
  const blank = await runStream(profile('openai-chat'), { text: '填空', kind: 'blank', blankCount: 2 });
  ok('填空题多空', /1\./.test(blank.text) && /2\./.test(blank.text), blank.text);
}

console.log('\n[4] 非流式回退');
for (const fmt of ['openai-chat', 'openai-responses', 'anthropic', 'gemini']) {
  const p = profile(fmt, { stream: false });
  const r = await runStream(p, { text: '题干', kind: 'qa' }, { stream: false });
  ok(fmt + ' 非流式成功', r.ok, r.error);
  ok(fmt + ' 非流式有内容', (r.text || '').length > 0, JSON.stringify(r.text));
}

console.log('\n[5] 图片输入');
for (const fmt of ['openai-chat', 'openai-responses', 'anthropic', 'gemini']) {
  const img = { mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
  const r = await runStream(profile(fmt), { text: '', kind: 'generic', images: [img] });
  ok(fmt + ' 图片请求成功', r.ok, r.error);
}
const reqs = await (await fetch(mockUrl + '/_requests')).json();
const imgReq = reqs.filter((r) => r.image);
ok('四种格式都带上了图片', imgReq.length >= 4, 'image requests=' + imgReq.length);
{
  const chat = reqs.find((r) => r.path.endsWith('/chat/completions') && r.image);
  const raw = JSON.stringify(chat.body);
  ok('chat 图片用 data URL', /"image_url":\{"url":"data:image\/png;base64,/.test(raw));
  const ant = reqs.find((r) => r.path.endsWith('/messages') && r.image);
  ok('anthropic 图片用 base64 source', /"type":"image","source":\{"type":"base64","media_type":"image\/png"/.test(JSON.stringify(ant.body)));
  const gem = reqs.find((r) => /:streamGenerateContent/.test(r.path) && r.image);
  ok('gemini 使用 inline_data', /"inline_data":\{"mime_type":"image\/png"/.test(JSON.stringify(gem.body)));
}

console.log('\n[6] 请求头与 URL 组装');
{
  const chat = reqs.find((r) => r.path.endsWith('/chat/completions'));
  ok('Bearer 认证', /^Bearer test-key$/.test(chat.headers.authorization || ''), chat.headers.authorization);
  const ant = reqs.find((r) => r.path.endsWith('/messages'));
  eq('anthropic x-api-key', ant.headers['x-api-key'], 'test-key');
  eq('anthropic version', ant.headers['anthropic-version'], '2023-06-01');
  ok('anthropic 浏览器直连头', !!ant.headers['anthropic-dangerous-direct-browser-access']);
  const gem = reqs.find((r) => /:streamGenerateContent/.test(r.path));
  eq('gemini alt=sse', gem.query.alt, 'sse');
  eq('gemini x-goog-api-key', gem.headers['x-goog-api-key'], 'test-key');
  ok('gemini 模型名进 URL', /gemini-2\.5-flash/.test(gem.path), gem.path);
  const resp = reqs.find((r) => r.path.endsWith('/responses'));
  ok('responses 用 instructions', typeof resp.body.instructions === 'string' && resp.body.instructions.length > 0);
  ok('responses input 结构', Array.isArray(resp.body.input) && resp.body.input[0].content[0].type === 'input_text');
}

console.log('\n[7] 提示词构建');
{
  const sys = AD.LLM.buildPrompt(SETTINGS, { kind: 'choice' });
  ok('含输出约束', /只输出一个选项字母/.test(sys), sys);
  const multiSys = AD.LLM.buildPrompt(SETTINGS, { kind: 'multi' });
  ok('多选题约束', /英文逗号分隔/.test(multiSys));
  const user = AD.LLM.buildUserText(SETTINGS, {
    kind: 'choice', text: '下列哪个是质数？',
    options: [{ label: 'A', text: '4' }, { label: 'B', text: '7' }]
  });
  ok('用户消息含题干', /下列哪个是质数/.test(user));
  ok('用户消息含选项', /A\. 4[\s\S]*B\. 7/.test(user), user);
  ok('题型标签', /【题型】单选题/.test(user), user);
}

console.log('\n[8] 错误处理');
{
  const bad = profile('openai-chat', { path: '/no-such-endpoint' });
  const r = await runStream(bad, { text: 'x', kind: 'choice' });
  ok('404 报错', !r.ok && /404/.test(r.error || ''), r.error);
  ok('错误码 notfound', r.code === 'notfound', r.code);

  const refused = profile('openai-chat', { baseUrl: 'http://127.0.0.1:1' });
  const r2 = await runStream(refused, { text: 'x', kind: 'choice' });
  ok('连接失败报错', !r2.ok && /网络请求失败/.test(r2.error || ''), r2.error);
}

console.log('\n[9] 中止');
{
  const p = profile('openai-chat');
  const handle = AD.LLM.stream({ settings: SETTINGS, profile: p, request: { text: 'x', kind: 'qa' }, options: {} }, {
    onReady: () => { },
    onDelta: () => { },
    onDone: () => { },
    onError: () => { }
  });
  handle.abort();
  await new Promise((r) => setTimeout(r, 60));
  ok('abort 不抛异常', true);
}

console.log('\n[10] 设置层');
{
  const S = AD.Settings;
  const merged = S.merge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } });
  eq('深合并', merged, { a: { b: 1, c: [3] } });
  const d = S.defaults();
  ok('默认值含四个格式', d.api.profiles[0].format === 'openai-chat');
  ok('默认模式字段齐全', 'autoAnswer' in d.mode && 'popup' in d.mode);
  const snap = S.snapshot();
  ok('未加载时 snapshot 可用', !!snap.api && Array.isArray(snap.api.profiles));
}

/* ------------------------- 收尾 ------------------------- */

mock.kill();
console.log('\n' + '='.repeat(52));
console.log(`结果：${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
process.exit(0);