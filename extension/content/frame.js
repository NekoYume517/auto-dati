/**
 * AutoDati · 跨帧协调
 *
 * 解决三件事：
 * 1. 子框架里的元素 rect → 顶层视口坐标（同源走 frameElement 链，跨源走 postMessage 逐级转发）
 * 2. 子框架检测到题目 → 交给顶层弹面板，顶层把答案回传给子框架填入
 * 3. 截图请求永远由能拿到「顶层坐标」的一方发起（captureVisibleTab 截的是整个标签页）
 */
(function (AD) {
  'use strict';

  const IS_TOP = (function () {
    try { return window.top === window.self; } catch (e) { return false; }
  }());

  const FRAME_SEL = 'iframe, frame';

  /* ------------------------------ 工具 ------------------------------ */

  function iframes(doc) {
    try {
      const out = [];
      const scopes = [doc || document];
      for (let s = 0; s < scopes.length; s++) {
        const list = scopes[s].querySelectorAll('*');
        for (let i = 0; i < list.length; i++) {
          if (list[i].matches(FRAME_SEL)) out.push(list[i]);
          const root = AD.PresetKit && AD.PresetKit.shadowRootOf(list[i]);
          if (root) scopes.push(root);
        }
      }
      return out;
    } catch (e) { return []; }
  }

  function indexOfSource(source) {
    try {
      const frames = iframes();
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].contentWindow === source) return i;
      }
    } catch (e) { /* noop */ }
    return -1;
  }

  function frameRectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    } catch (e) {
      return null;
    }
  }

  /** 把「子框架内部坐标」按 iframe 元素换算到本框架坐标 */
  function mapThrough(el, rect, vw, vh) {
    const r = frameRectOf(el);
    if (!r) return rect;
    const sx = el.offsetWidth > 0 ? r.w / el.offsetWidth : 1;
    const sy = el.offsetHeight > 0 ? r.h / el.offsetHeight : 1;
    const kx = vw > 0 ? el.clientWidth * sx / vw : sx;
    const ky = vh > 0 ? el.clientHeight * sy / vh : sy;
    const ox = (el.clientLeft || 0) * sx;
    const oy = (el.clientTop || 0) * sy;
    return {
      x: r.x + ox + rect.x * kx,
      y: r.y + oy + rect.y * ky,
      w: rect.w * kx,
      h: rect.h * ky
    };
  }

  /* ------------------------- 坐标上溯（同源快速路径） ------------------------- */

  function syncUp(rect) {
    let mapped = rect;
    const path = [];
    let win = window;
    let guard = 0;
    while (guard++ < 64) {
      if (win === window.top) break;
      const fe = win.frameElement; // 跨域时也可能返回 null，而不是抛异常。
      if (!fe) return null;
      const index = iframes(win.parent.document).indexOf(fe);
      if (index < 0) return null;
      path.unshift(index);
      mapped = mapThrough(fe, mapped, win.innerWidth, win.innerHeight);
      win = win.parent;
    }
    return win === window.top ? { rect: mapped, path: path, viewport: { w: win.innerWidth, h: win.innerHeight } } : null;
  }

  /* ------------------------- 坐标上溯（跨源消息路径） ------------------------- */

  const pendingUp = new Map();   // reqId -> {resolve, timer}

  function asyncUp(rect) {
    return new Promise(function (resolve) {
      const id = AD.uid('rect');
      const timer = setTimeout(function () {
        pendingUp.delete(id);
        resolve(null); // 换算失败不能把本帧坐标误当顶层坐标。
      }, 2500);
      pendingUp.set(id, { resolve: resolve, timer: timer });
      try {
        window.parent.postMessage({
          type: 'AD_RECT_REQUEST',
          id: id,
          rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
          vw: window.innerWidth,
          vh: window.innerHeight
        }, '*');
      } catch (e) {
        clearTimeout(timer);
        pendingUp.delete(id);
        resolve(null);
      }
    });
  }

  /** 子框架内 rect → 顶层视口 rect */
  async function topGeometry(rect) {
    if (!rect) return rect;
    if (IS_TOP) return { rect: rect, path: [], viewport: { w: innerWidth, h: innerHeight } };
    try {
      const result = syncUp(rect);
      if (result) return result;
    } catch (e) { /* 跨源逐级换算 */ }
    return asyncUp(rect);
  }

  async function toTopRect(rect) {
    const result = await topGeometry(rect);
    return result && result.rect;
  }

  /* ------------------------- 消息处理（每一层都装） ------------------------- */

  let installed = false;

  function install() {
    if (installed) return;
    installed = true;

    window.addEventListener('message', function (ev) {
      const d = ev.data;
      if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;

      /* --- 上层回传的坐标结果 --- */
      if (d.type === 'AD_RECT_RESULT') {
        const rec = pendingUp.get(d.id);
        if (rec && ev.source === window.parent) {
          clearTimeout(rec.timer);
          pendingUp.delete(d.id);
          rec.resolve(d.geometry || null);
        }
        return;
      }

      /* --- 下层请求坐标换算 --- */
      if (d.type === 'AD_RECT_REQUEST') {
        const idx = indexOfSource(ev.source);
        if (idx < 0) return;
        const list = iframes();
        const fe = list.find(function (el) { return el.contentWindow === ev.source; });
        if (!fe) return;
        if (!d.rect || ![d.rect.x, d.rect.y, d.rect.w, d.rect.h, d.vw, d.vh].every(Number.isFinite)) return;
        const abs = mapThrough(fe, d.rect, d.vw, d.vh);
        const reply = function (geometry) {
          if (geometry) geometry.path = geometry.path.concat(idx);
          try { ev.source.postMessage({ type: 'AD_RECT_RESULT', id: d.id, geometry: geometry }, '*'); } catch (e) { /* noop */ }
        };
        if (IS_TOP) reply({ rect: abs, path: [], viewport: { w: innerWidth, h: innerHeight } });
        else {
          topGeometry(abs).then(reply).catch(function () { reply(null); });
        }
        return;
      }

      /* --- 下层把题目交给顶层弹面板 --- */
      if (d.type === 'AD_FRAME_QUESTION' && IS_TOP) {
        if (AD.App && AD.App.onFrameQuestion) {
          AD.App.onFrameQuestion(d.payload || {}, ev.source, d.qid);
        }
        return;
      }

      /* --- 顶层把答案回传给下层 --- */
      if (d.type === 'AD_FRAME_FILL' && !IS_TOP) {
        if (AD.App && AD.App.onFrameFill) {
          AD.App.onFrameFill(d.qid, d.text);
        }
        return;
      }

      /* --- 顶层广播设置变化，子框架同步（storage.onChanged 已覆盖，这里兜底） --- */
      if (d.type === 'AD_FRAME_SETTINGS' && !IS_TOP) {
        if (AD.Settings && d.settings) {
          try { AD.Settings.save({}).catch(function () { }); } catch (e) { /* noop */ }
        }
        return;
      }
    }, false);
  }

  // 元素只留在所属框架的隔离世界内，跨帧只传短期引用和显示信息。
  const pickedTargets = new Map();

  async function probeAtTop(point, opts) {
    opts = opts || {};
    const geometry = await topGeometry({ x: 0, y: 0, w: innerWidth, h: innerHeight });
    if (!geometry || !geometry.rect.w || !geometry.rect.h || !AD.Capture) return null;
    const view = geometry.rect;
    const x = (point.x - view.x) * innerWidth / view.w;
    const y = (point.y - view.y) * innerHeight / view.h;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    let el = AD.Capture.elementAt(x, y);
    if (!el) return null;
    const isFrame = el.matches(FRAME_SEL);
    const childIndex = isFrame ? indexOfSource(el.contentWindow) : -1;
    if (opts.whole && !isFrame) {
      const q = AD.Detector && AD.Detector.buildFromElement(el);
      const root = el.closest('.examPaper_subject') || (q && q.root);
      if (root && root !== document.body && root !== document.documentElement) el = root;
    }
    const r = el.getBoundingClientRect();
    const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
    const token = AD.uid('target');
    const now = Date.now();
    pickedTargets.forEach(function (entry, id) {
      if (now - entry.at > 30000) pickedTargets.delete(id);
    });
    while (pickedTargets.size >= 32) pickedTargets.delete(pickedTargets.keys().next().value);
    pickedTargets.set(token, { el: el, at: now });
    return {
      path: geometry.path, childIndex: childIndex, isFrame: isFrame, token: token,
      rect: { x: view.x + rect.x * view.w / innerWidth, y: view.y + rect.y * view.h / innerHeight,
        w: rect.w * view.w / innerWidth, h: rect.h * view.h / innerHeight },
      tag: el.tagName.toLowerCase(), text: (AD.PresetKit.txt(el) || '').slice(0, 1200),
      selector: AD.Picker ? AD.Picker.patternSelector(el, { scope: el.getRootNode() }) : '',
      context: opts.contextRect ? AD.Capture.contextNear({
        x: (opts.contextRect.x - view.x) * innerWidth / view.w,
        y: (opts.contextRect.y - view.y) * innerHeight / view.h,
        w: opts.contextRect.w * innerWidth / view.w,
        h: opts.contextRect.h * innerHeight / view.h
      }) : undefined,
      url: location.href
    };
  }

  async function probeAt(x, y, opts) {
    const point = await toTopRect({ x: x, y: y, w: 0, h: 0 });
    if (!point) return null;
    const result = await AD.Capture.sendMessage({ type: 'DATI_FRAME_PROBE', point: point, options: opts || {} });
    if (!result || !result.ok || !result.target) return null;
    const target = result.target;
    if (!IS_TOP) {
      const geometry = await topGeometry({ x: 0, y: 0, w: innerWidth, h: innerHeight });
      if (!geometry) return null;
      const view = geometry.rect, r = target.rect;
      target.rect = { x: (r.x - view.x) * innerWidth / view.w, y: (r.y - view.y) * innerHeight / view.h,
        w: r.w * innerWidth / view.w, h: r.h * innerHeight / view.h };
    }
    return target;
  }

  function activateTarget(target, action) {
    return AD.Capture.sendMessage({ type: 'DATI_FRAME_ACTIVATE', documentId: target.documentId,
      frameId: target.frameId, token: target.token, action: action });
  }

  function useTarget(token, action) {
    const entry = pickedTargets.get(token);
    pickedTargets.delete(token);
    if (!entry || Date.now() - entry.at > 30000 || !entry.el.isConnected) return { ok: false, error: '题目已更新，请重新选择' };
    const el = entry.el;
    if (action === 'template') {
      AD.Picker.open({ element: el });
    } else if (action === 'capture') {
      const r = el.getBoundingClientRect();
      AD.App.capturePicked({ el: el, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    } else return { ok: false, error: '未知拾取操作' };
    return { ok: true };
  }

  /* ------------------------- 子框架 → 顶层 题目转交 ------------------------- */

  async function relayQuestion(question) {
    if (IS_TOP || !question) return null;
    const qid = question.id || AD.uid('fq');
    const abs = await toTopRect(question.rect);
    return await new Promise(function (resolve) {
      const timer = setTimeout(function () { cleanup(); resolve(null); }, 120000);
      function onMsg(ev) {
        const d = ev.data;
        if (!d || d.type !== 'AD_FRAME_FILL' || d.qid !== qid) return;
        cleanup();
        resolve({ text: d.text });
      }
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
      }
      window.addEventListener('message', onMsg);
      try {
        window.top.postMessage({
          type: 'AD_FRAME_QUESTION',
          qid: qid,
          payload: {
            id: question.id,
            kind: question.kind,
            stem: question.stem,
            options: (question.options || []).map(function (o) {
              return { label: o.label, text: o.text };
            }),
            rect: abs,
            url: location.href
          }
        }, '*');
      } catch (e) {
        cleanup();
        resolve(null);
      }
    });
  }

  function fillFrame(source, qid, text) {
    if (source && source.documentId) {
      return AD.Capture.sendMessage({ type: 'DATI_FRAME_CAPTURE_FILL', documentId: source.documentId, qid: qid, text: text });
    }
    try {
      source.postMessage({ type: 'AD_FRAME_FILL', qid: qid, text: text }, '*');
      return true;
    } catch (e) {
      return false;
    }
  }

  AD.Frame = {
    isTop: IS_TOP,
    install: install,
    toTopRect: toTopRect,
    topGeometry: topGeometry,
    relayQuestion: relayQuestion,
    fillFrame: fillFrame,
    iframes: iframes,
    probeAtTop: probeAtTop,
    probeAt: probeAt,
    activateTarget: activateTarget,
    useTarget: useTarget
  };
}(globalThis.AD = globalThis.AD || {}));
