/** Local, aggregated usage only. No questions, answers, URLs or API credentials. */
(function (AD) {
  'use strict';
  const KEY = 'dati_statistics';
  const METRICS = ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'cacheMiss', 'reasoning', 'toolInput', 'ms', 'firstChunkMs'];
  let queue = Promise.resolve();
  function number(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null; }
  function first() { for (const v of arguments) if (number(v) !== null) return v; return null; }
  function sumKnown(a, b) { return a === null || b === null ? null : a + b; }
  function day(date) {
    const d = new Date(date == null ? Date.now() : date);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function usage(raw, format) {
    const u = raw && typeof raw === 'object' ? raw : {};
    const inputDetails = u.prompt_tokens_details || u.input_tokens_details || {};
    const outputDetails = u.completion_tokens_details || u.output_tokens_details || {};
    const result = {
      input: first(u.prompt_tokens, u.input_tokens), output: first(u.completion_tokens, u.output_tokens),
      total: first(u.total_tokens), cacheRead: first(inputDetails.cached_tokens, u.prompt_cache_hit_tokens, u.cache_read_input_tokens),
      cacheWrite: first(inputDetails.cache_write_tokens, u.cache_creation_input_tokens), cacheMiss: first(u.prompt_cache_miss_tokens),
      reasoning: first(outputDetails.reasoning_tokens), toolInput: null
    };
    if (format === 'anthropic') {
      // Claude input_tokens excludes cache reads and writes. Missing cache fields in
      // uncached responses mean no cache contribution, but remain unreported in UI.
      result.input = result.input === null ? null : result.input + (result.cacheRead || 0) + (result.cacheWrite || 0);
    } else if (format === 'gemini') {
      result.toolInput = first(u.toolUsePromptTokenCount);
      result.input = first(u.promptTokenCount);
      if (result.input !== null) result.input += result.toolInput || 0;
      result.reasoning = first(u.thoughtsTokenCount);
      result.output = first(u.candidatesTokenCount);
      if (result.output !== null) result.output += result.reasoning || 0;
      result.cacheRead = first(u.cachedContentTokenCount);
      result.total = first(u.totalTokenCount);
    }
    if (result.total === null) result.total = sumKnown(result.input, result.output);
    return result;
  }
  function empty() { return { version: 1, groups: [] }; }
  function bucket() {
    const b = { requests: 0, success: 0, failed: 0, cancelled: 0, partial: 0, metrics: {} };
    METRICS.forEach(k => { b.metrics[k] = { sum: 0, samples: 0 }; });
    return b;
  }
  function add(target, source) {
    ['requests', 'success', 'failed', 'cancelled', 'partial'].forEach(k => { target[k] += source[k]; });
    METRICS.forEach(k => { target.metrics[k].sum += source.metrics[k].sum; target.metrics[k].samples += source.metrics[k].samples; });
    return target;
  }
  function validate(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.groups) || raw.groups.length > 12000) throw new Error('统计数据格式或版本不受支持');
    const groups = raw.groups.map(g => {
      if (!g || !/^\d{4}-\d{2}-\d{2}$/.test(g.day) || day(new Date(g.day + 'T12:00:00')) !== g.day) throw new Error('统计日期不合法');
      const b = bucket();
      for (const k of ['requests', 'success', 'failed', 'cancelled', 'partial']) {
        if (!Number.isSafeInteger(g[k]) || g[k] < 0) throw new Error('统计请求数不合法');
        b[k] = g[k];
      }
      if (b.success + b.failed + b.cancelled !== b.requests || b.partial > b.success) throw new Error('统计请求数不一致');
      METRICS.forEach(k => {
        const m = g.metrics && g.metrics[k];
        if (!m || number(m.sum) === null || !Number.isSafeInteger(m.samples) || m.samples < 0 || m.samples > b.requests || (!m.samples && m.sum)) throw new Error('统计指标不合法：' + k);
        b.metrics[k] = { sum: m.sum, samples: m.samples };
      });
      for (const k of ['model', 'kind', 'format']) {
        if (typeof g[k] !== 'string' || g[k].length > 160) throw new Error('统计标签不合法');
        b[k] = g[k];
      }
      b.day = g.day;
      return b;
    });
    // Coalesce imported duplicates rather than letting a repeated import multiply data.
    const unique = new Map();
    for (const g of groups) {
      const key = JSON.stringify([g.day, g.model, g.kind, g.format]);
      if (unique.has(key)) add(unique.get(key), g); else unique.set(key, g);
    }
    return { version: 1, groups: Array.from(unique.values()) };
  }
  async function read() {
    const saved = await chrome.storage.local.get(KEY);
    return saved[KEY] ? validate(saved[KEY]) : empty();
  }
  function serial(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }
  function record(event) {
    return serial(async function () {
      const data = await read();
      const date = day(event.at);
      const model = String(event.model || '未知模型').slice(0, 160);
      const kind = String(event.kind || 'generic').slice(0, 160);
      const format = String(event.format || 'openai-chat').slice(0, 160);
      let g = data.groups.find(v => v.day === date && v.model === model && v.kind === kind && v.format === format);
      if (!g) { g = Object.assign(bucket(), { day: date, model, kind, format }); data.groups.push(g); }
      g.requests++;
      if (event.status === 'success') { g.success++; if (event.partial) g.partial++; }
      else if (event.status === 'cancelled') g.cancelled++;
      else g.failed++;
      const values = Object.assign(usage(event.usage, format), { ms: number(event.ms), firstChunkMs: number(event.firstChunkMs) });
      METRICS.forEach(k => { if (number(values[k]) !== null) { g.metrics[k].sum += values[k]; g.metrics[k].samples++; } });
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 364);
      data.groups = data.groups.filter(v => v.day >= day(cutoff)).sort((a, b) => a.day.localeCompare(b.day)).slice(-12000);
      await chrome.storage.local.set({ [KEY]: data });
      return data;
    });
  }
  AD.Statistics = { KEY, METRICS, usage, empty, bucket, add, day, validate, record,
    get: function () { return serial(read); },
    replace: function (raw) { const data = validate(raw); return serial(async () => { await chrome.storage.local.set({ [KEY]: data }); return data; }); },
    importBackup: function (settings, raw) {
      const normalized = AD.Settings.normalize(settings);
      const data = raw === undefined ? undefined : validate(raw);
      return serial(async function () {
        const patch = { [AD.Settings.STORAGE_KEY]: normalized };
        if (data !== undefined) patch[KEY] = data;
        await chrome.storage.local.set(patch);
        return normalized;
      });
    }
  };
}(globalThis.AD = globalThis.AD || {}));
