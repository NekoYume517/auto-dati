/**
 * 极简 CDP 客户端（Node ≥ 22 自带 WebSocket，零依赖）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

export function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome 可执行文件');
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 轮询直到 fn 返回真值或超时 */
export async function until(fn, { timeout = 15000, interval = 120, label = 'condition' } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error('等待超时: ' + label + (lastErr ? ' (' + lastErr.message + ')' : ''));
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.contexts = new Map(); // id -> {id, name, origin, auxData}
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        if (msg.method === 'Runtime.executionContextCreated') {
          this.contexts.set(msg.params.context.id, msg.params.context);
        } else if (msg.method === 'Runtime.executionContextDestroyed') {
          this.contexts.delete(msg.params.executionContextId);
        } else if (msg.method === 'Runtime.executionContextsCleared') {
          this.contexts.clear();
        }
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('CDP 连接超时: ' + url)), 10000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(new Cdp(ws)); });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('CDP 连接失败')); });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** 求值，返回 JSON 化的结果 */
  async eval(expression, opts = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...opts
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('页面异常: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    return res.result ? res.result.value : undefined;
  }

  /** 找到扩展内容脚本（隔离世界）的 executionContextId */
  findExtensionContext(extId, { mainFrameOnly = true } = {}) {
    const scores = [];
    for (const ctx of this.contexts.values()) {
      const n = String(ctx.name || '');
      const o = String(ctx.origin || '');
      if (!n.includes(extId) && !o.includes(extId)) continue;
      const isIsolated = ctx.auxData && ctx.auxData.type === 'isolated';
      const frameId = ctx.auxData && ctx.auxData.frameId;
      scores.push({ ctx, isIsolated, frameId });
    }
    if (!scores.length) return null;
    let pool = scores.filter((s) => s.isIsolated);
    if (!pool.length) pool = scores;
    if (mainFrameOnly && this.mainFrameId) {
      const mainPool = pool.filter((s) => s.frameId === this.mainFrameId);
      if (mainPool.length) return mainPool[0].ctx.id;
    }
    return pool[0].ctx.id;
  }

  /** 记录主框架 id，用于区分同名的子框架隔离世界 */
  async captureMainFrameId() {
    try {
      const tree = await this.send('Page.getFrameTree');
      this.mainFrameId = tree && tree.frameTree && tree.frameTree.frame ? tree.frameTree.frame.id : null;
    } catch (e) { this.mainFrameId = null; }
    return this.mainFrameId;
  }

  /** 在扩展内容脚本的隔离世界中求值（默认主框架） */
  async evalInExtension(expression, extId) {
    const ctxId = this.findExtensionContext(extId);
    if (!ctxId) throw new Error('找不到扩展内容脚本的执行上下文');
    return this.eval(expression, { contextId: ctxId });
  }

  /** 列出所有扩展隔离世界上下文（含子框架） */
  listExtensionContexts(extId) {
    const out = [];
    for (const ctx of this.contexts.values()) {
      const n = String(ctx.name || '');
      const o = String(ctx.origin || '');
      if (!n.includes(extId) && !o.includes(extId)) continue;
      out.push(ctx);
    }
    return out;
  }

  close() { try { this.ws.close(); } catch { } }
}

export async function launchBrowser({ extensionPath, port, userDataDir, headless = true, extraArgs = [] }) {
  const exe = findBrowser();
  const dir = userDataDir || path.join(os.tmpdir(), 'dati-e2e-' + Date.now());
  const args = [
    headless ? '--headless=new' : '',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + dir,
    extensionPath ? '--load-extension=' + extensionPath : '',
    extensionPath ? '--disable-extensions-except=' + extensionPath : '',
    ...extraArgs,
    'about:blank'
  ].filter(Boolean);

  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += String(d); });

  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  const info = await until(async () => {
    const r = await fetch(versionUrl).catch(() => null);
    if (!r || !r.ok) return null;
    return r.json();
  }, { timeout: 30000, label: 'DevTools 端口就绪' });

  return { proc, info, userDataDir: dir, stderr: () => stderr, kill: () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else proc.kill('SIGKILL');
    } catch { }
  } };
}

/** 拿到指定 URL 前缀的 target 并连上 */
export async function attachTo(port, urlPredicate, { timeout = 20000 } = {}) {
  const target = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (!r || !r.ok) return null;
    const list = await r.json();
    return list.find((t) => t.type === 'page' && urlPredicate(t.url)) || null;
  }, { timeout, label: '等待目标页面' });
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.captureMainFrameId();
  return { cdp, target };
}

/**
 * 确认扩展真正加载：service worker 存在 + 扩展页面里 chrome.storage 可用。
 * 失败时抛出带浏览器日志的可读错误。
 */
export async function waitForExtension(port, extId, { timeout = 20000, stderrFn = null } = {}) {
  const started = Date.now();
  let lastTargets = [];
  while (Date.now() - started < timeout) {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (r && r.ok) {
      lastTargets = await r.json();
      const sw = lastTargets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
      if (sw) return { worker: sw, targets: lastTargets };
    }
    await sleep(200);
  }
  let detail = '';
  if (stderrFn) {
    const lines = String(stderrFn() || '').split('\n')
      .filter((l) => /Extension error|manifest|load_error_reporter/i.test(l));
    if (lines.length) detail = '\n浏览器报错：\n' + lines.slice(-6).join('\n');
  }
  throw new Error(
    '扩展未加载（找不到 service_worker ' + extId + '）。' +
    '当前 targets: ' + lastTargets.map((t) => t.type + ':' + t.url).join(', ') + detail
  );
}

export async function createTarget(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error('创建标签页失败: ' + r.status);
  return r.json();
}

export async function closeTarget(port, id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => null);
}
