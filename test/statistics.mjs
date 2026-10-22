import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let storage = {}, writes = 0;
const sandbox = { console, chrome: { storage: { local: {
  get: async key => { await new Promise(r => setTimeout(r, 2)); return structuredClone({ [key]: storage[key] }); },
  set: async patch => { writes++; Object.assign(storage, structuredClone(patch)); }
} } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('extension/common/statistics.js', 'utf8'), sandbox);
const S = sandbox.AD.Statistics;
let count = 0;
function test(name, fn) { fn(); count++; console.log('  ✓ ' + name); }
const chat = S.usage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 25 } }, 'openai-chat');
test('Chat 缓存和推理都不重复加入总量', () => { assert.equal(chat.input, 100); assert.equal(chat.output, 40); assert.equal(chat.total, 140); assert.equal(chat.cacheRead, 80); assert.equal(chat.reasoning, 25); });
const responses = S.usage({ input_tokens: 100, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 130 }, 'openai-responses');
test('Responses 读取与写入明细独立提取，仍包含在输入量内', () => { assert.equal(responses.cacheRead, 50); assert.equal(responses.cacheWrite, 20); assert.equal(responses.total, 130); });
const claude = S.usage({ input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 30, output_tokens: 40 }, 'anthropic');
test('Claude 三种输入相加后再计算总量', () => { assert.equal(claude.input, 130); assert.equal(claude.total, 170); });
const gemini = S.usage({ promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 20, thoughtsTokenCount: 30, toolUsePromptTokenCount: 5, totalTokenCount: 155 }, 'gemini');
test('Gemini 总输出包含思考，总输入包含工具提示', () => { assert.equal(gemini.input, 105); assert.equal(gemini.output, 50); assert.equal(gemini.total, 155); });
const ds = S.usage({ prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 }, 'openai-chat');
test('DeepSeek 命中和未命中不重复累计', () => { assert.equal(ds.cacheRead, 70); assert.equal(ds.cacheMiss, 30); assert.equal(ds.total, 140); });
test('未返回的字段保持未知，包括完全没有 usage 的响应', () => { assert.equal(S.usage(null).input, null); assert.equal(S.usage(null).total, null); assert.equal(ds.cacheWrite, null); });
test('真实 0 Token 与未知字段有区别', () => { const u = S.usage({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }); assert.equal(u.total, 0); assert.equal(u.cacheRead, 0); assert.equal(u.cacheWrite, null); });
test('无效和恶意数值不会产生负数、NaN 或伪造用量', () => { const u = S.usage({ prompt_tokens: -1, completion_tokens: '100', total_tokens: Infinity }); assert.equal(u.input, null); assert.equal(u.output, null); assert.equal(u.total, null); });
await Promise.all(Array.from({ length: 24 }, (_, i) => S.record({ model: '__proto__', kind: 'choice', format: 'openai-chat', status: i < 20 ? 'success' : i === 20 ? 'cancelled' : 'failed', usage: i < 20 ? { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } : null, ms: 100, firstChunkMs: i < 20 ? 20 : null })));
const saved = await S.get(), g = saved.groups[0];
test('并发请求持久化不会覆盖或漏计', () => { assert.equal(g.requests, 24); assert.equal(g.success, 20); assert.equal(g.failed, 3); assert.equal(g.cancelled, 1); });
test('只累计已上报用量，保留覆盖请求数', () => { assert.equal(g.metrics.total.sum, 300); assert.equal(g.metrics.total.samples, 20); assert.equal(g.metrics.cacheRead.samples, 20); assert.equal(g.metrics.cacheWrite.samples, 0); });
test('统计仅含汇总指标，无题干、密钥和网页地址', () => { assert.equal(g.model, '__proto__'); assert.ok(!JSON.stringify(saved).includes('apiKey')); assert.equal(Object.getPrototypeOf(g).polluted, undefined); });
await S.replace(saved); await S.replace(saved);
test('同一备份重复恢复使用替换语义，不翻倍', () => { assert.equal(storage[S.KEY].groups[0].requests, 24); });
for (const [name, mutate] of [
  ['无效版本', v => { v.version = 8; }], ['负数', v => { v.groups[0].metrics.input.sum = -5; }],
  ['无效日期', v => { v.groups[0].day = '2026-02-31'; }], ['请求总数不一致', v => { v.groups[0].requests++; }],
  ['样本数超出请求', v => { v.groups[0].metrics.total.samples = 500; }], ['无限值', v => { v.groups[0].metrics.total.sum = Infinity; }]
]) {
  const value = JSON.parse(JSON.stringify(saved)); mutate(value); const before = writes;
  test('拒绝 ' + name + '，不改动现有数据', () => { assert.throws(() => S.replace(value)); assert.equal(writes, before); });
}
console.log('\n统计测试：' + count + ' 通过');
