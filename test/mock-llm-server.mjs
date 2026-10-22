/**
 * AutoDati · 模拟 LLM 服务（无外部依赖）
 * 覆盖四种格式的流式与非流式响应，供单元测试与端到端测试使用。
 *
 *   node test/mock-llm-server.mjs [port]
 *   GET  /_requests  查看收到的请求
 *   POST /_reset     清空记录
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 0);
const log = [];
let requestCount = 0;

/* ----------------------------- 答案生成 ----------------------------- */

function pickAnswer(prompt) {
  const p = String(prompt || '');
  if (/【题型】单选题/.test(p)) return 'B';
  if (/【题型】多选题/.test(p)) return 'A,C';
  if (/【题型】判断题/.test(p)) return '正确';
  if (/【题型】填空题/.test(p)) return '1. 光合作用\n2. 叶绿体';
  if (/【题型】问答/.test(p)) return '光合作用分为光反应和暗反应两个阶段。光反应在类囊体薄膜上进行，暗反应在叶绿体基质中进行。';
  if (/截图|image/i.test(p)) return '这是截图题目的答案。';
  return '示例答案';
}

function splitChunks(text, n = 3) {
  const out = [];
  const step = Math.max(1, Math.ceil(text.length / n));
  for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
  return out.length ? out : [''];
}

function sse(res, obj, event) {
  if (event) res.write('event: ' + event + '\n');
  res.write('data: ' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n\n');
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch { resolve({ __raw: buf }); }
    });
  });
}

function lastUserText(body) {
  if (!body) return '';
  if (typeof body.input === 'string') return body.input;
  if (Array.isArray(body.messages)) {
    const m = body.messages.filter((x) => x && x.role !== 'system').pop();
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((c) => c.text || '').join('\n');
  }
  if (Array.isArray(body.input)) {
    return body.input.map((i) => (Array.isArray(i.content) ? i.content.map((c) => c.text || '').join('\n') : i.content || '')).join('\n');
  }
  if (Array.isArray(body.contents)) {
    return body.contents.map((c) => (c.parts || []).map((p) => p.text || '').join('\n')).join('\n');
  }
  return '';
}

function hasImage(body) {
  const raw = JSON.stringify(body || {});
  return /"image_url"|"input_image"|"inline_data"|"type":"image"/.test(raw);
}

/* ----------------------------- 服务端 ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (path === '/_requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(log, null, 2));
  }
  if (path === '/_reset') {
    log.length = 0; requestCount = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  const body = await readBody(req);
  const entry = {
    n: ++requestCount,
    method: req.method,
    path,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: req.headers,
    stream: body && body.stream !== false,
    image: hasImage(body),
    prompt: lastUserText(body),
    model: body.model || body.modelName || '',
    body
  };
  log.push(entry);

  const answer = pickAnswer(entry.prompt + '\n' + (entry.image ? ' image' : ''));
  const chunks = splitChunks(answer);
  const stream = body.stream !== false;

  /* ---------------- OpenAI Chat Completions ---------------- */
  if (path.endsWith('/chat/completions')) {
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', model: body.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sse(res, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] });
    for (const c of chunks) {
      sse(res, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c } }] });
    }
    sse(res, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse(res, { id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
    sse(res, '[DONE]');
    return res.end();
  }

  /* ---------------- OpenAI Responses ---------------- */
  if (path.endsWith('/responses')) {
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_mock', object: 'response', status: 'completed', model: body.model || 'mock',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }],
        usage: { input_tokens: 14, output_tokens: 9 }
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    sse(res, { type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } }, 'response.created');
    for (const c of chunks) {
      sse(res, { type: 'response.output_text.delta', delta: c, item_id: 'msg_1', output_index: 0 }, 'response.output_text.delta');
    }
    sse(res, { type: 'response.completed', response: { id: 'resp_mock', status: 'completed', usage: { input_tokens: 14, output_tokens: 9 } } }, 'response.completed');
    return res.end();
  }

  /* ---------------- Anthropic Messages ---------------- */
  if (path.endsWith('/messages')) {
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: body.model || 'mock',
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7 }
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    sse(res, { type: 'message_start', message: { id: 'msg_mock', role: 'assistant', usage: { input_tokens: 11, output_tokens: 0 } } }, 'message_start');
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
    for (const c of chunks) {
      sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }, 'content_block_delta');
    }
    sse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
    sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }, 'message_delta');
    sse(res, { type: 'message_stop' }, 'message_stop');
    return res.end();
  }

  /* ---------------- Gemini ---------------- */
  if (/:streamGenerateContent/.test(path) || /:generateContent/.test(path)) {
    const isStream = /:streamGenerateContent/.test(path);
    if (!isStream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: answer }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6 }
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const c of chunks) {
      sse(res, { candidates: [{ content: { parts: [{ text: c }], role: 'model' } }] });
    }
    sse(res, { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6 } });
    return res.end();
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'mock: unknown path ' + path } }));
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;
  console.log('MOCK_LLM_URL=' + url);
  if (process.send) process.send({ url });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));