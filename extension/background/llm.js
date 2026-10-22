/**
 * AutoDati · LLM 适配层（仅 Service Worker）
 * 支持 openai-chat / openai-responses / anthropic / gemini，统一流式回调。
 */
(function (AD) {
  'use strict';

  /* ------------------------------ 工具函数 ------------------------------ */

  function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

  function joinUrl(base, path) {
    base = String(base || '').trim();
    path = String(path || '').trim();
    if (!base && !path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    if (!path) return base;
    if (!base) return path;
    return trimSlash(base) + '/' + path.replace(/^\/+/, '');
  }

  function num(v, dflt) {
    const n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  function dataUrlOf(img) {
    if (!img) return '';
    if (img.dataUrl) return img.dataUrl;
    return 'data:' + (img.mime || 'image/png') + ';base64,' + (img.dataBase64 || '');
  }

  function b64Of(img) {
    if (!img) return '';
    if (img.dataBase64) return img.dataBase64;
    const url = img.dataUrl || '';
    const i = url.indexOf(',');
    return i >= 0 ? url.slice(i + 1) : '';
  }

  function mimeOf(img) {
    if (!img) return 'image/png';
    if (img.mime) return img.mime;
    const m = /^data:([^;,]+)/.exec(img.dataUrl || '');
    return m ? m[1] : 'image/png';
  }

  /**
   * 按模型/格式推导「关闭/开启思考」的请求参数。
   * profile.reasoning: 'auto' 不干预；'off' 尽力关闭；'on' 显式开启。
   * 只对识别出的模型家族注入对应字段；未识别的家族交给 extraBody 自行控制。
   */
  function reasoningParams(profile) {
    const mode = String(profile.reasoning || 'auto');
    if (mode === 'auto') return null;
    const wantOff = mode === 'off';
    const model = String(profile.model || '').toLowerCase();
    const p = {};

    if (/deepseek[-_]?r1|deepseek[-_]?reasoner/.test(model)) {
      // DeepSeek-R1/reasoner 官方不支持关闭思考
      return { note: 'DeepSeek-R1 系列暂不支持关闭思考，已忽略该开关' };
    }
    if (/glm-[45]|zhipu/.test(model) || /doubao-.*-thinking/.test(model)) {
      return { thinking: { type: wantOff ? 'disabled' : 'enabled' } };
    }
    if (/qwen3|qwq/.test(model)) {
      return wantOff ? { enable_thinking: false, thinking_budget: 0 } : { enable_thinking: true };
    }
    if (profile.format === 'anthropic' && /claude-(3-7|4|opus-4|sonnet-4)/.test(model)) {
      if (wantOff) return null; // Claude 不开 thinking 即不思考
      return { thinking: { type: 'enabled', budget_tokens: Math.max(1024, Number(profile.maxTokens) || 2048) } };
    }
    if (/gpt-5|^o[1345](-mini|-preview)?$/.test(model)) {
      return { reasoning_effort: wantOff ? 'minimal' : 'medium' };
    }
    if (profile.format === 'gemini' && /gemini-2\.5/.test(model)) {
      return { generationConfig: { thinkingConfig: { thinkingBudget: wantOff ? 0 : -1 } } };
    }
    return null;
  }

  /** 把 reasoning 参数合并进 body（处理嵌套 generationConfig；note 仅提示用，不进请求体） */
  function applyReasoning(body, params) {
    if (!params) return body;
    const keys = ['thinking', 'enable_thinking', 'thinking_budget', 'reasoning_effort'];
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(params, k)) body[k] = params[k];
    }
    if (params.generationConfig) {
      body.generationConfig = Object.assign({}, body.generationConfig, params.generationConfig);
    }
    return body;
  }

  /** 从错误响应体里提炼可读信息 */
  function errorFromBody(status, text) {
    let msg = '';
    try {
      const j = JSON.parse(text);
      msg = (j.error && (j.error.message || j.error.msg || j.error.type)) ||
        j.message || j.msg || (typeof j === 'string' ? j : '');
      if (!msg) msg = JSON.stringify(j).slice(0, 300);
    } catch (e) {
      msg = String(text || '').slice(0, 300);
    }
    const code = status === 401 || status === 403 ? 'auth'
      : status === 404 ? 'notfound'
        : status === 429 ? 'ratelimit'
          : status >= 500 ? 'server' : 'http';
    return { message: 'HTTP ' + status + (msg ? ' · ' + msg : ''), code: code, status: status };
  }

  /* --------------------------- SSE 解析器 --------------------------- */

  function createSSEParser(onEvent) {
    let buf = '';

    function dispatch(raw) {
      let event = '';
      const dataLines = [];
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
        if (!line || line.charAt(0) === ':') continue;
        const ci = line.indexOf(':');
        const field = ci === -1 ? line : line.slice(0, ci);
        let value = ci === -1 ? '' : line.slice(ci + 1);
        if (value.charAt(0) === ' ') value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') dataLines.push(value);
      }
      if (!dataLines.length) return;
      const data = dataLines.join('\n');
      if (data === '[DONE]') return onEvent({ event: event, done: true, data: data, json: null });
      let json = null;
      try { json = JSON.parse(data); } catch (e) { json = null; }
      onEvent({ event: event, done: false, data: data, json: json });
    }

    return {
      push: function (chunk) {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (raw.trim()) dispatch(raw);
        }
      },
      flush: function () {
        if (buf.trim()) dispatch(buf);
        buf = '';
      }
    };
  }

  /* --------------------------- 四种格式适配 --------------------------- */

  const adapters = {
    /* -------- OpenAI Chat Completions -------- */
    'openai-chat': {
      label: 'Chat Completions',
      defaultPath: '/chat/completions',
      build: function (p, sys, userText, images, stream) {
        const content = images.length
          ? [{ type: 'text', text: userText }].concat(images.map(function (img) {
            return { type: 'image_url', image_url: { url: dataUrlOf(img) } };
          }))
          : userText;
        const body = {
          model: p.model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: content }],
          stream: !!stream,
          temperature: num(p.temperature, 0.2),
          max_tokens: num(p.maxTokens, 2048)
        };
        if (stream) body.stream_options = { include_usage: true };
        return { body: body, headers: { 'Content-Type': 'application/json' } };
      },
      extract: function (ev, state) {
        if (ev.done) return { finish: 'done' };
        const j = ev.json;
        if (!j) return {};
        if (j.error) return { error: (j.error && j.error.message) || 'API error' };
        if (j.usage) state.usage = j.usage;
        const ch = j.choices && j.choices[0];
        if (!ch) return {};
        const d = ch.delta || ch.message || {};
        let text = '';
        if (typeof d.content === 'string') text = d.content;
        else if (Array.isArray(d.content)) {
          text = d.content.map(function (part) { return part && (part.text || '') || ''; }).join('');
        }
        const reasoning = d.reasoning_content || d.reasoning || '';
        if (ch.finish_reason) state.finish = ch.finish_reason;
        return { delta: text, reasoning: reasoning };
      },
      full: function (j) {
        const ch = j && j.choices && j.choices[0];
        const c = ch && (ch.message ? ch.message.content : '');
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(function (p) { return (p && p.text) || ''; }).join('');
        return '';
      }
    },

    /* -------- OpenAI Responses API -------- */
    'openai-responses': {
      label: 'Responses API',
      defaultPath: '/responses',
      build: function (p, sys, userText, images, stream) {
        const content = [{ type: 'input_text', text: userText }].concat(images.map(function (img) {
          return { type: 'input_image', image_url: dataUrlOf(img) };
        }));
        const body = {
          model: p.model,
          instructions: sys,
          input: [{ role: 'user', content: content }],
          stream: !!stream,
          temperature: num(p.temperature, 0.2),
          max_output_tokens: num(p.maxTokens, 2048)
        };
        return { body: body, headers: { 'Content-Type': 'application/json' } };
      },
      extract: function (ev, state) {
        if (ev.done) return { finish: 'done' };
        const j = ev.json;
        if (!j) return {};
        const type = j.type || ev.event || '';
        if (type === 'response.output_text.delta') return { delta: j.delta || '' };
        if (type === 'response.refusal.delta') return { delta: j.delta || '' };
        if (type === 'response.reasoning_summary_text.delta') return { reasoning: j.delta || '' };
        if (type === 'response.completed') {
          if (j.response && j.response.usage) state.usage = j.response.usage;
          state.finish = 'completed';
          return { finish: 'completed' };
        }
        if (type === 'response.incomplete') {
          state.finish = 'incomplete';
          return { finish: 'incomplete' };
        }
        if (type === 'error' || j.error) {
          const err = j.error || j;
          return { error: (err && (err.message || err.code)) || 'API error' };
        }
        return {};
      },
      full: function (j) {
        if (!j) return '';
        if (typeof j.output_text === 'string' && j.output_text) return j.output_text;
        const out = j.output || [];
        const parts = [];
        for (let i = 0; i < out.length; i++) {
          const c = (out[i] && out[i].content) || [];
          for (let k = 0; k < c.length; k++) {
            if (c[k] && (c[k].type === 'output_text' || c[k].text)) parts.push(c[k].text || '');
          }
        }
        return parts.join('');
      }
    },

    /* -------- Anthropic Messages -------- */
    'anthropic': {
      label: 'Claude Messages',
      defaultPath: '/messages',
      build: function (p, sys, userText, images, stream) {
        const content = images.map(function (img) {
          return {
            type: 'image',
            source: { type: 'base64', media_type: mimeOf(img), data: b64Of(img) }
          };
        }).concat([{ type: 'text', text: userText }]);
        const body = {
          model: p.model,
          system: sys,
          messages: [{ role: 'user', content: content }],
          stream: !!stream,
          temperature: num(p.temperature, 0.2),
          max_tokens: num(p.maxTokens, 2048)
        };
        return {
          body: body,
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          }
        };
      },
      extract: function (ev, state) {
        const j = ev.json;
        const type = (j && j.type) || ev.event || '';
        if (ev.done) return { finish: 'done' };
        if (!j) return {};
        if (type === 'content_block_delta') {
          const d = j.delta || {};
          if (d.type === 'text_delta') return { delta: d.text || '' };
          if (d.type === 'thinking_delta') return { reasoning: d.thinking || '' };
          return {};
        }
        if (type === 'message_start' && j.message && j.message.usage) {
          state.usage = j.message.usage;
          return {};
        }
        if (type === 'message_delta') {
          if (j.usage) state.usage = Object.assign({}, state.usage, j.usage);
          if (j.delta && j.delta.stop_reason) state.finish = j.delta.stop_reason;
          return {};
        }
        if (type === 'message_stop') { state.finish = 'stop'; return { finish: 'stop' }; }
        if (type === 'error') {
          return { error: (j.error && (j.error.message || j.error.type)) || 'API error' };
        }
        return {};
      },
      full: function (j) {
        const c = (j && j.content) || [];
        return c.map(function (part) { return (part && part.text) || ''; }).join('');
      }
    },

    /* -------- Google Gemini -------- */
    'gemini': {
      label: 'Gemini',
      defaultPath: '/models/{model}:streamGenerateContent',
      build: function (p, sys, userText, images, stream) {
        const parts = images.map(function (img) {
          return { inline_data: { mime_type: mimeOf(img), data: b64Of(img) } };
        }).concat([{ text: userText }]);
        const body = {
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: 'user', parts: parts }],
          generationConfig: {
            temperature: num(p.temperature, 0.2),
            maxOutputTokens: num(p.maxTokens, 2048)
          }
        };
        return { body: body, headers: { 'Content-Type': 'application/json' } };
      },
      extract: function (ev, state) {
        if (ev.done) return { finish: 'done' };
        const j = ev.json;
        if (!j) return {};
        if (j.error) return { error: j.error.message || 'API error' };
        if (j.usageMetadata) state.usage = j.usageMetadata;
        const cand = (j.candidates && j.candidates[0]) || null;
        if (!cand) return {};
        if (cand.finishReason) state.finish = cand.finishReason;
        const parts = (cand.content && cand.content.parts) || [];
        const text = parts.map(function (p) { return (p && p.text) || ''; }).join('');
        return { delta: text };
      },
      full: function (j) {
        const cand = (j && j.candidates && j.candidates[0]) || null;
        const parts = (cand && cand.content && cand.content.parts) || [];
        return parts.map(function (p) { return (p && p.text) || ''; }).join('');
      }
    }
  };

  function adapterOf(format) {
    return adapters[format] || adapters['openai-chat'];
  }

  /* --------------------------- 请求组装 --------------------------- */

  function buildUrl(p, format, stream) {
    const a = adapterOf(format);
    let path = String(p.path || '').trim();
    if (!path) path = a.defaultPath;
    path = path.replace(/\{model\}/g, encodeURIComponent(p.model || ''));
    if (format === 'gemini') {
      if (/:streamGenerateContent/.test(path)) {
        if (!/[?&]alt=sse/.test(path)) path += (path.indexOf('?') >= 0 ? '&' : '?') + 'alt=sse';
        if (!stream) path = path.replace(':streamGenerateContent', ':generateContent').replace(/[?&]alt=sse/, '');
      } else if (/:generateContent/.test(path) && stream) {
        path = path.replace(':generateContent', ':streamGenerateContent');
        if (!/[?&]alt=sse/.test(path)) path += (path.indexOf('?') >= 0 ? '&' : '?') + 'alt=sse';
      }
    }
    return joinUrl(p.baseUrl, path);
  }

  function buildHeaders(p, format) {
    const h = { 'Accept': p.stream === false ? 'application/json' : 'text/event-stream' };
    const key = String(p.apiKey || '').trim();
    if (format === 'anthropic') {
      if (key) h['x-api-key'] = key;
      h['anthropic-version'] = '2023-06-01';
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (format === 'gemini') {
      if (key) h['x-goog-api-key'] = key;
    } else {
      if (key) h['Authorization'] = /^Bearer\s/i.test(key) ? key : 'Bearer ' + key;
    }
    const extra = p.extraHeaders;
    if (extra && typeof extra === 'object') {
      for (const k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] != null) h[k] = String(extra[k]);
      }
    }
    return h;
  }

  /** 组装提示词 */
  function buildPrompt(settings, request) {
    const prompt = (settings && settings.prompt) || {};
    const kind = request.kind || 'generic';
    const lines = [];

    const sys = String(request.systemOverride || prompt.system || '').trim();
    const hints = prompt.kindHint || {};
    const hint = String(hints[kind] || '').trim();
    const extra = String(prompt.extraInstruction || '').trim();

    const kindRule = {
      choice: '【输出要求】只输出一个选项字母（例如 B），不要输出题干、不要输出解析、不要加标点。',
      multi: '【输出要求】输出所有正确选项的字母，用英文逗号分隔（例如 A,C,D），不要输出其他内容。',
      judge: '【输出要求】只输出「正确」或「错误」两个词之一。',
      blank: '【输出要求】按空的顺序逐行输出答案，每行格式为「序号. 答案」；只有一个空时只输出答案本身。',
      qa: '【输出要求】输出完整答案正文，条理清晰，可用分点；不要复述题目。',
      generic: '【输出要求】按字段顺序逐行输出「字段名: 答案」，不要输出多余内容。'
    }[kind] || '';

    const parts = [sys, kindRule];
    if (hint) parts.push('【本题补充要求】' + hint);
    if (extra) parts.push('【通用补充要求】' + extra);
    if (prompt.includeExplain) {
      parts.push('【格式】第一行只输出答案；若需要解析，另起一行以「解析：」开头。');
    } else {
      parts.push('【格式】只输出答案，不要输出解析或思考过程。');
    }
    if (prompt.language === 'zh') parts.push('【语言】用中文作答。');
    else if (prompt.language === 'en') parts.push('【语言】Answer in English.');
    lines.push(parts.filter(Boolean).join('\n'));

    return lines[0];
  }

  function buildUserText(settings, request) {
    const prompt = (settings && settings.prompt) || {};
    const kind = request.kind || 'generic';
    const label = AD.KIND_LABEL[kind] || '题目';
    const chunks = [];

    if (request.images && request.images.length) {
      chunks.push(String(prompt.imageInstruction || '这是一张题目截图，请识别题目内容并作答。'));
      if (request.text) chunks.push('【页面附带文本】\n' + request.text);
      return chunks.join('\n\n');
    }

    chunks.push('【题型】' + label);
    chunks.push('【题目】\n' + String(request.text || '').trim());
    if (request.options && request.options.length) {
      chunks.push('【选项】\n' + request.options.map(function (o) {
        return (o.label || '') + '. ' + (o.text || '');
      }).join('\n'));
    }
    if (kind === 'blank' && request.blankCount > 1) {
      chunks.push('【空的数量】' + request.blankCount);
    }
    chunks.push('请作答。');
    return chunks.join('\n');
  }

  /* --------------------------- 流式主流程 --------------------------- */

  /**
   * @param {object} args {settings, request, options, profile}
   * @param {object} h {onReady, onDelta, onDone, onError, onReasoning}
   * @returns {{abort: Function}}
   */
  function stream(args, h) {
    const settings = args.settings || {};
    const request = args.request || {};
    const options = args.options || {};
    const profile = args.profile || AD.Settings.currentProfile() || (settings.api.profiles || [])[0];
    const fmt = (profile && profile.format) || 'openai-chat';
    const a = adapterOf(fmt);

    let aborted = false;
    const ctrl = new AbortController();
    let timer = null;
    let done = false;
    const state = { usage: null, finish: null };

    const finish = function (fn, payload) {
      if (done) return;
      done = true;
      if (payload && payload.usage == null && state.usage) payload.usage = state.usage;
      if (timer) clearTimeout(timer);
      try { fn(payload); } catch (e) { AD.error('handler error', e); }
    };

    if (!profile) {
      setTimeout(function () {
        finish(h.onError, { message: '未配置 API，请先在设置中添加模型服务。', code: 'noconfig' });
      }, 0);
      return { abort: function () { } };
    }

    const useStream = options.stream !== false && profile.stream !== false;
    const system = buildPrompt(settings, request);
    const userText = buildUserText(settings, request);
    const images = (profile.vision === false) ? [] : (request.images || []);
    const built = a.build(profile, system, userText, images, useStream);
    // 顺序：内置 body → 思考开关 → 用户 extraBody（用户配置优先级最高，可覆盖一切）
    const body = applyReasoning(Object.assign({}, built.body), reasoningParams(profile));
    Object.assign(body, profile.extraBody || {});
    if (options.temperature != null) body.temperature = num(options.temperature, 0.2);
    if (options.maxTokens != null) {
      if (fmt === 'openai-responses') body.max_output_tokens = num(options.maxTokens, 2048);
      else if (fmt === 'gemini') body.generationConfig = Object.assign({}, body.generationConfig, { maxOutputTokens: num(options.maxTokens, 2048) });
      else body.max_tokens = num(options.maxTokens, 2048);
    }

    const url = buildUrl(profile, fmt, useStream);
    const headers = Object.assign(buildHeaders(profile, fmt), built.headers || {});
    const started = Date.now();
    const timeoutMs = num(options.timeoutMs, num(profile.timeoutMs, 60000));
    let acc = '';
    let reasoningAcc = '';
    let chunkCount = 0;

    timer = setTimeout(function () {
      if (done) return;
      aborted = true;
      try { ctrl.abort(); } catch (e) { /* noop */ }
      finish(h.onError, { message: '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）', code: 'timeout' });
    }, Math.max(5000, timeoutMs));

    (async function run() {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'follow'
        });
      } catch (e) {
        if (aborted) return;
        return finish(h.onError, { message: '网络请求失败：' + ((e && e.message) || e), code: 'network' });
      }

      if (!resp.ok) {
        let text = '';
        try { text = await resp.text(); } catch (e) { text = ''; }
        const err = errorFromBody(resp.status, text);
        return finish(h.onError, { message: err.message, code: err.code, status: err.status });
      }

      try { h.onReady({ model: profile.model, format: fmt, url: url, stream: useStream }); } catch (e) { /* noop */ }

      // 非流式或没有 body
      if (!useStream || !resp.body) {
        let json = null;
        try { json = await resp.json(); } catch (e) {
          return finish(h.onError, { message: '响应解析失败：' + ((e && e.message) || e), code: 'parse' });
        }
        if (json && json.error) {
          return finish(h.onError, { message: (json.error && json.error.message) || 'API error', code: 'api' });
        }
        const text = a.full(json) || '';
        if (!text) {
          return finish(h.onError, { message: '模型没有返回内容。', code: 'empty' });
        }
        return finish(h.onDone, {
          text: text, usage: (json && (json.usage || json.usageMetadata)) || null,
          model: profile.model, format: fmt, ms: Date.now() - started
        });
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let streamError = null;

      const parser = createSSEParser(function (ev) {
        if (streamError) return;
        const out = a.extract(ev, state);
        if (!out) return;
        if (out.error) { streamError = out.error; return; }
        if (out.reasoning) {
          reasoningAcc += out.reasoning;
          if (h.onReasoning) { try { h.onReasoning(out.reasoning); } catch (e) { /* noop */ } }
        }
        if (out.delta) {
          acc += out.delta;
          chunkCount++;
          try { h.onDelta(out.delta, acc); } catch (e) { /* noop */ }
        }
      });

      try {
        while (!aborted) {
          const r = await reader.read();
          if (r.done) break;
          parser.push(decoder.decode(r.value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.flush();
      } catch (e) {
        if (!aborted) {
          // 已收到部分内容时，尽量把已有内容交付出去
          if (acc) {
            return finish(h.onDone, {
              text: acc, usage: state.usage, model: profile.model, format: fmt,
              ms: Date.now() - started, partial: true,
              warning: '流式读取中断：' + ((e && e.message) || e)
            });
          }
          return finish(h.onError, { message: '流式读取失败：' + ((e && e.message) || e), code: 'stream' });
        }
      }

      if (aborted) return;

      if (streamError && !acc) {
        return finish(h.onError, { message: String(streamError), code: 'api' });
      }
      if (!acc) {
        return finish(h.onError, { message: '模型没有返回内容。', code: 'empty' });
      }
      finish(h.onDone, {
        text: acc, usage: state.usage, model: profile.model, format: fmt,
        ms: Date.now() - started, reasoning: reasoningAcc || null, chunks: chunkCount
      });
    })();

    return {
      abort: function () {
        aborted = true;
        if (timer) clearTimeout(timer);
        try { ctrl.abort(); } catch (e) { /* noop */ }
        finish(h.onError, { message: '已停止', code: 'aborted', usage: state.usage });
      }
    };
  }

  /** 测试连接：非流式、短提示、返回耗时与文本 */
  function test(profile, prompt) {
    const started = Date.now();
    return new Promise(function (resolve) {
      let settled = false;
      const finish = function (payload) {
        if (settled) return;
        settled = true;
        resolve(Object.assign({ ms: Date.now() - started }, payload));
      };
      const settings = {
        prompt: {
          system: '你是一个连通性测试助手。',
          kindHint: {}, extraInstruction: '', language: 'auto', includeExplain: false
        }
      };
      stream({
        settings: settings,
        profile: Object.assign({}, profile, { stream: false, maxTokens: Math.min(64, Number(profile.maxTokens) || 64), timeoutMs: 25000 }),
        request: { text: prompt || '请回复：连接成功', kind: 'qa' },
        options: { stream: false, maxTokens: 64, timeoutMs: 25000 }
      }, {
        onReady: function () { },
        onDelta: function () { },
        onDone: function (r) {
          finish({ ok: true, text: String(r.text || '').slice(0, 400), model: r.model, format: r.format });
        },
        onError: function (e) {
          finish({ ok: false, error: e.message || '未知错误', code: e.code });
        }
      });
    });
  }

  /** GET <Base URL>/models; deliberately independent of the generation path/model. */
  async function listModels(profile) {
    profile = profile || {};
    let url;
    try {
      url = new URL(String(profile.baseUrl || '').trim());
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
      url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/models$/, '') + '/models';
      url.hash = '';
    } catch (e) { return { ok: false, error: '请填写有效的 HTTP 或 HTTPS Base URL' }; }
    if (!String(profile.apiKey || '').trim()) return { ok: false, error: '请先填写 API Key' };
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, Math.min(30000, Math.max(1000, num(profile.timeoutMs, 20000))));
    const models = new Map();
    const headers = Object.assign(buildHeaders(profile, profile.format || 'openai-chat'), { Accept: 'application/json' });
    try {
      for (let page = 0; page < 20; page++) {
        const response = await fetch(url.href, { method: 'GET', headers: headers, signal: controller.signal,
          credentials: 'omit', redirect: 'error', cache: 'no-store' });
        if (!response.ok) {
          const messages = { 401: '鉴权失败，请检查 API Key', 403: '当前密钥无权获取模型列表',
            404: '该地址未提供 /models 接口，请检查 Base URL', 429: '供应商请求过于频繁，请稍后重试' };
          return { ok: false, error: (messages[response.status] || '供应商暂时无法提供模型列表') + '（HTTP ' + response.status + '）' };
        }
        let data;
        try { data = await response.json(); }
        catch (e) { return { ok: false, error: '供应商返回的内容不是有效的 JSON 模型列表' }; }
        const rows = Array.isArray(data) ? data : data && (Array.isArray(data.data) ? data.data : data.models);
        if (!Array.isArray(rows)) return { ok: false, error: '无法识别供应商返回的模型列表格式' };
        rows.forEach(function (row) {
          let id = typeof row === 'string' ? row : row && (row.id || row.name);
          if (typeof id !== 'string' || !id.trim()) return;
          id = id.trim();
          if (profile.format === 'gemini') id = id.replace(/^models\//, '');
          if (models.has(id)) return;
          models.set(id, { id: id, name: typeof row === 'object' ? String(row.display_name || row.displayName || row.id && row.name || id) : id,
            owner: typeof row === 'object' ? String(row.owned_by || '') : '' });
        });
        if (data.nextPageToken) url.searchParams.set('pageToken', String(data.nextPageToken));
        else if (data.has_more && data.last_id) url.searchParams.set('after_id', String(data.last_id));
        else return { ok: true, models: Array.from(models.values()) };
      }
      return { ok: true, models: Array.from(models.values()), warning: '模型较多，已载入前 20 页，可手动填写未列出的模型 ID' };
    } catch (e) {
      return { ok: false, error: controller.signal.aborted ? '获取模型列表超时，请检查网络后重试' : '无法连接供应商，请检查 Base URL 与网络连接' };
    } finally { clearTimeout(timer); }
  }

  AD.LLM = {
    adapters: adapters,
    adapterOf: adapterOf,
    stream: stream,
    test: test,
    listModels: listModels,
    buildPrompt: buildPrompt,
    buildUserText: buildUserText,
    buildUrl: buildUrl,
    createSSEParser: createSSEParser,
    reasoningParams: reasoningParams,
    applyReasoning: applyReasoning
  };
}(globalThis.AD = globalThis.AD || {}));
