/**
 * AutoDati · 内容脚本主控
 * 负责：模式调度、流式请求、自动填入、弹窗、快捷键、截图答题。
 */
(function (AD) {
  'use strict';

  const IS_TOP = (function () {
    try { return window.top === window.self; } catch (e) { return false; }
  }());

  const state = {
    started: false,
    settings: null,
    stopObserve: null,
    queue: [],
    active: 0,
    doneKeys: new Map(),   // questionKey -> ts
    attempted: new Set(),  // 已自动请求过的题；重扫/失败/冷却结束不会重新请求
    inFlight: new Set(),
    candidates: new Map(),
    dismissed: new Map(),  // questionKey -> ts（用户手动关闭，不再自动弹出）
    scanning: false,
    lastScanAt: 0,
    lastCount: 0,
    requestSeq: 0
  };

  const requests = new Map(); // reqId -> {port, abort}
  const sessionAborts = new Map(); // sessionId -> {abort}
  let settleTimer = 0;

  function isManual(source) {
    return source === 'manual' || source === 'hotkey' || source === 'retry';
  }

  // 排队期间 DOM 可能已换题：只使用当前扫描中的同一道题及其最新节点。
  function currentQuestion(question, allowAnswered) {
    if (!question || !question.root || !question.root.isConnected) return null;
    const list = AD.Detector.scan(document, { maxPerPage: 0, skipAnswered: !allowAnswered && state.settings.mode.skipAnswered });
    return list.find(function (q) { return q.id === question.id && q.root === question.root; }) || null;
  }

  /* ------------------------------ 基础工具 ------------------------------ */

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  function isEnabled() {
    return !!(state.settings && state.settings.enabled !== false);
  }

  function reportState() {
    try {
      send({
        type: AD.MSG.STATE_REPORT,
        state: {
          count: state.lastCount,
          enabled: isEnabled(),
          autoAnswer: !!(state.settings && state.settings.mode.autoAnswer),
          popup: !!(state.settings && state.settings.mode.popup),
          active: state.active,
          top: IS_TOP,
          url: location.href,
          title: document.title,
          at: Date.now()
        }
      });
    } catch (e) { /* noop */ }
  }

  function questionKey(q) {
    return (q && q.id) || '';
  }

  function isCoolingDown(q) {
    const key = questionKey(q);
    if (!key) return false;
    const ts = state.doneKeys.get(key) || 0;
    const cd = Math.max(0, Number(state.settings.mode.cooldownMs) || 0);
    return cd > 0 && Date.now() - ts < cd;
  }

  /** 用户手动关掉过面板的题：不再自动弹窗/自动作答（手动操作仍可用） */
  function isDismissed(q) {
    const key = questionKey(q);
    return !!(key && state.dismissed.has(key));
  }

  function markDone(q) {
    const key = questionKey(q);
    if (key) state.doneKeys.set(key, Date.now());
    // 控制 Map 体积
    if (state.doneKeys.size > 400) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      state.doneKeys.forEach(function (v, k) {
        if (v < cutoff) state.doneKeys.delete(k);
      });
    }
  }

  /* ------------------------------ 请求构建 ------------------------------ */

  function buildRequest(question, extra) {
    extra = extra || {};
    const q = question || {};
    const req = {
      text: q.stem || '',
      kind: q.kind || 'generic',
      options: (q.options || []).map(function (o) {
        return { label: o.label || '', text: o.text || '' };
      }),
      blankCount: (q.inputs || []).length || undefined,
      dedupeKey: q.id || '',
      profileId: extra.profileId || ''
    };
    if (extra.images && extra.images.length) req.images = extra.images;
    if (extra.text) req.text = extra.text;
    if (extra.kind) req.kind = extra.kind;
    return req;
  }

  /**
   * 发起流式请求
   * @returns {Promise<{text, usage, ms}>} 并回调 onDelta
   */
  function streamRequest(request, handlers) {
    handlers = handlers || {};
    return new Promise(function (resolve, reject) {
      const reqId = AD.uid('req');
      let port;
      let settled = false;
      let acc = '';

      const cleanup = function () {
        try { port && port.disconnect(); } catch (e) { /* noop */ }
        requests.delete(reqId);
      };

      const fail = function (err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err && err.message || err)));
      };

      try {
        port = chrome.runtime.connect({ name: AD.STREAM.PORT });
      } catch (e) {
        return fail('无法连接后台服务：' + ((e && e.message) || e));
      }

      requests.set(reqId, {
        port: port,
        abort: function () {
          try { port.postMessage({ type: AD.STREAM.ABORT, reqId: reqId }); } catch (e) { /* noop */ }
          fail(new Error('已停止'));
        }
      });
      if (handlers.onRequest) {
        try { handlers.onRequest(requests.get(reqId).abort); } catch (e) { /* noop */ }
      }

      port.onMessage.addListener(function (msg) {
        if (!msg || msg.reqId !== reqId) return;
        switch (msg.type) {
          case AD.STREAM.READY:
            handlers.onReady && handlers.onReady(msg);
            break;
          case AD.STREAM.CHUNK:
            acc += msg.delta || '';
            handlers.onDelta && handlers.onDelta(msg.delta || '', acc);
            break;
          case 'AD_STREAM_REASONING':
            handlers.onReasoning && handlers.onReasoning(msg.delta || '');
            break;
          case AD.STREAM.DONE:
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
              text: msg.text || acc,
              usage: msg.usage || null,
              model: msg.model || '',
              format: msg.format || '',
              ms: msg.ms || 0,
              partial: !!msg.partial,
              warning: msg.warning || ''
            });
            break;
          case AD.STREAM.ERROR:
            if (settled) return;
            if (msg.code === 'aborted') return fail(new Error('已停止'));
            fail(new Error(msg.error || '请求失败'));
            break;
          default:
            break;
        }
      });

      port.onDisconnect.addListener(function () {
        if (settled) return;
        // 后台可能被回收
        if (acc) {
          settled = true;
          requests.delete(reqId);
          resolve({ text: acc, usage: null, model: '', format: '', ms: 0, partial: true, warning: '后台连接中断' });
        } else {
          fail('后台连接已断开，请重试');
        }
      });

      try {
        port.postMessage({
          type: AD.STREAM.START,
          reqId: reqId,
          request: request,
          options: handlers.options || {}
        });
      } catch (e) {
        fail('发送请求失败：' + ((e && e.message) || e));
      }
    });
  }

  /* ------------------------------ 填入答案 ------------------------------ */

  function applyAnswer(question, text, opts) {
    opts = opts || {};
    if (!AD.Filler || !AD.Filler.apply) return { ok: false, detail: '填入模块未加载' };
    try {
      const res = AD.Filler.apply(question, text, opts);
      if (res && res.ok && state.settings.mode.autoNextPage) send({ type: 'DATI_NAV_FILLED', qid: question.id });
      if (state.settings.mode.noticeToast) {
        if (res && res.ok) {
          AD.Overlay.toast('已填入答案' + (res.detail ? ' · ' + res.detail : ''), { tone: 'success' });
        } else {
          AD.Overlay.toast('填入失败：' + ((res && res.detail) || '未知原因'), { tone: 'warn' });
        }
      }
      return res;
    } catch (e) {
      AD.warn('apply failed', e);
      return { ok: false, detail: (e && e.message) || String(e) };
    }
  }

  /* --------------------------- 元素拾取 / 模板 --------------------------- */

  async function openPicker() {
    if (!AD.Picker) {
      AD.Overlay.toast('拾取器未加载', { tone: 'danger' });
      return;
    }
    if (AD.Picker.isOpen()) return;
    const rule = await AD.Picker.open();
    if (rule) {
      // 新模板保存后立即按当前设置重扫，并把结果交给模式处理
      state.doneKeys.clear();
      const list = scanOnce({ force: true });
      processQuestions(list, 'manual');
    }
  }

  /* --------------------------- 跨帧：子框架题目转交 --------------------------- */

  const frameQuestions = new Map(); // qid -> {source, payload, sessionId}

  /** 顶层收到子框架的题目 → 弹面板；用户点填入时把答案回传子框架 */
  function onFrameQuestion(payload, source, qid, manualCapture) {
    if (!isEnabled()) return;
    if (!manualCapture && (!state.settings.detect || state.settings.detect.frameRelay === false)) return;
    if (!manualCapture && !state.settings.mode.popup && !state.settings.mode.autoAnswer) return;
    if (!qid) return;

    const key = payload.id || qid;
    if (state.attempted.has(key) || state.inFlight.has(key) || isDismissed({ id: key })) return;
    if (state.doneKeys.has(key) && isCoolingDown({ id: key })) return;
    state.attempted.add(key);
    state.inFlight.add(key);

    const question = {
      id: key,
      kind: payload.kind || 'generic',
      stem: payload.stem || '',
      options: payload.options || [],
      inputs: [],
      rect: payload.rect || null,
      anchor: null,
      presetId: 'frame'
    };

    if (manualCapture || state.settings.mode.popup) {
      const sessionId = AD.Overlay.show({
        question: question,
        rect: payload.rect,
        source: manualCapture ? 'capture' : 'detect',
        onFill: async function (s) {
          const text = s.answerText || s.text;
          if (!text) return;
          const result = await AD.Frame.fillFrame(source, qid, text);
          if (result === false || (result && result.ok === false)) {
            AD.Overlay.toast((result && result.error) || '题目已更新，请重新选择', { tone: 'warn' });
            return;
          }
          markDone({ id: key });
          s._autoClosing = true;
          AD.Overlay.close(s.id);
        },
        onClose: function (s, info) {
          if (info && info.userClosed) state.dismissed.set(key, Date.now());
        },
        onRetry: function (s) {
          AD.Overlay.close(s.id);
          if (state.inFlight.has(key)) return;
          state.attempted.delete(key);
          state.dismissed.delete(key);
          state.doneKeys.delete(key);
          onFrameQuestion(payload, source, qid, manualCapture);
        }
      });
      frameQuestions.set(qid, { source: source, payload: payload, sessionId: sessionId });
      if (manualCapture && payload.images && payload.images[0] && AD.Overlay.updateScreenshot) {
        const img = payload.images[0];
        AD.Overlay.updateScreenshot(sessionId, 'data:' + img.mime + ';base64,' + img.dataBase64);
      }

      streamRequest({
        text: question.stem,
        kind: question.kind,
        options: question.options,
        images: manualCapture ? payload.images || [] : [],
        dedupeKey: key
      }, {
        onReady: function (info) { AD.Overlay.ready(sessionId, info); },
        onDelta: function (d) { AD.Overlay.append(sessionId, d); },
        onReasoning: function (d) { AD.Overlay.setReasoning(sessionId, d); }
      }).then(function (result) {
        AD.Overlay.done(sessionId, result);
        if (!manualCapture && state.settings.mode.autoAnswer && result.text && !result.partial) {
          AD.Frame.fillFrame(source, qid, result.text);
          markDone({ id: key });
        }
      }).catch(function (e) {
        AD.Overlay.fail(sessionId, (e && e.message) || String(e));
      }).finally(function () {
        state.inFlight.delete(key);
      });
    } else {
      // 只有自动答题模式：直接作答并回传，不弹面板
      streamRequest({
        text: question.stem,
        kind: question.kind,
        options: question.options,
        dedupeKey: key
      }, {}).then(function (result) {
        if (result.text && !result.partial) {
          AD.Frame.fillFrame(source, qid, result.text);
          markDone({ id: key });
        }
      }).catch(function (e) {
        if (state.settings.mode.noticeToast) {
          AD.Overlay.toast('子框架题目作答失败：' + ((e && e.message) || e), { tone: 'danger' });
        }
      }).finally(function () {
        state.inFlight.delete(key);
      });
    }
  }

  /** 子框架收到顶层回传的答案 → 填入本帧 DOM */
  function onFrameFill(qid, text) {
    if (!text) return;
    const q = pendingFrameFills.get(qid);
    if (q) {
      applyAnswer(q, text);
      pendingFrameFills.delete(qid);
      return;
    }
    // 没有缓存时，按最近检测到的题目尽力填入
    const list = scanOnce({ force: true });
    if (list.length) applyAnswer(list[0], text);
  }

  const pendingFrameFills = new Map();

  /* ------------------------------ 队列调度 ------------------------------ */

  function enqueue(question, source) {
    if (!question || !question.id) return;
    if (state.inFlight.has(question.id)) return;
    if (!isManual(source) && (state.attempted.has(question.id) || isCoolingDown(question) || isDismissed(question))) return;
    if (state.settings.mode.skipAnswered && question.answered) return;
    if (state.queue.some(function (it) { return it.question.id === question.id; })) return;
    if (state.queue.length >= 24) return;
    state.queue.push({ question: question, source: source || 'detect', at: Date.now() });
    pump();
  }

  function pump() {
    if (!state.queue.length) return;
    if (state.active >= 1) return;
    const item = state.queue.shift();
    if (!isManual(item.source)) {
      const fresh = currentQuestion(item.question);
      if (!fresh || state.attempted.has(fresh.id) || isDismissed(fresh)) {
        setTimeout(pump, 0);
        return;
      }
      item.question = fresh;
    }
    state.active++;
    handleQuestion(item.question, item.source).catch(function (e) {
      AD.warn('handleQuestion failed', e);
    }).then(function () {
      state.active--;
      setTimeout(pump, 180);
    });
  }

  async function handleQuestion(question, source) {
    const settings = state.settings;
    if (!settings) return;
    if (!isEnabled()) return;
    const mode = settings.mode;
    const relay = !IS_TOP && AD.Frame && AD.Frame.relayQuestion && settings.detect.frameRelay !== false;
    const wantPopup = !!mode.popup && (IS_TOP || relay);
    const wantAuto = !!mode.autoAnswer;

    if (!wantPopup && !wantAuto) return;
    if (state.inFlight.has(question.id)) return;
    if (!isManual(source) && state.attempted.has(question.id)) return;
    state.inFlight.add(question.id);
    state.attempted.add(question.id);

    let sessionId = null;
    const holder = { abort: null };

    // 子框架：把题目转交顶层统一弹面板，答案回来后再填入本帧
    if (relay) {
      pendingFrameFills.set(question.id, question);
      if (wantPopup) {
        AD.Overlay.toast('题目位于子框架，已交给顶层显示', { ms: 1500 });
      }
      try {
        const answered = await AD.Frame.relayQuestion(question);
        if (answered && answered.text && currentQuestion(question)) {
          applyAnswer(question, answered.text);
          markDone(question);
        } else if (!answered) {
          pendingFrameFills.delete(question.id);
        }
      } finally {
        state.inFlight.delete(question.id);
      }
      return;
    }

    try {
      if (wantPopup) {
        sessionId = AD.Overlay.show({
          question: question,
          rect: question.rect,
          source: source || 'detect',
          onFill: function (s) {
            const text = s.answerText || s.text;
            if (!text) return;
            const fresh = currentQuestion(question, true);
            if (!fresh) {
              AD.Overlay.toast('题目已切换或内容已更新，请对当前题重新作答', { tone: 'warn' });
              return;
            }
            const filled = applyAnswer(fresh, text);
            if (!filled || !filled.ok) return;
            markDone(fresh);
            s._autoClosing = true;
            AD.Overlay.close(s.id);
          },
          onRetry: function (s) {
            // 重试不算「用户关闭」：标记后关闭，再清标记重新排队
            s._retrying = true;
            AD.Overlay.close(s.id);
            state.dismissed.delete(questionKey(question));
            state.doneKeys.delete(questionKey(question));
            setTimeout(function () { enqueue(question, 'retry'); }, 30);
          },
          onStop: function (s) {
            if (holder.abort) holder.abort();
          },
          onClose: function (s, info) {
            sessionAborts.delete(s.id);
            if (holder.abort) holder.abort();
            // 用户手动关闭（点 × / Esc）→ 本题冷却，不再自动弹出；「重试」「填入」不受影响
            if (info && info.userClosed && question && question.id) {
              state.dismissed.set(question.id, Date.now());
              if (state.dismissed.size > 300) {
                const cutoff = Date.now() - 60 * 60 * 1000;
                state.dismissed.forEach(function (v, k) {
                  if (v < cutoff) state.dismissed.delete(k);
                });
              }
            }
          }
        });
        if (sessionId) sessionAborts.set(sessionId, holder);
      }

      if (!wantPopup && wantAuto && settings.mode.noticeToast) {
        AD.Overlay.toast('正在作答 · ' + (AD.KIND_LABEL[question.kind] || '题目'), { ms: 1400 });
      }

      const result = await streamRequest(buildRequest(question), {
        options: { force: isManual(source) },
        onRequest: function (abort) { holder.abort = abort; },
        onReady: function (info) {
          if (sessionId) AD.Overlay.ready(sessionId, info);
        },
        onDelta: function (delta) {
          if (sessionId) AD.Overlay.append(sessionId, delta);
        },
        onReasoning: function (delta) {
          if (sessionId) AD.Overlay.setReasoning(sessionId, delta);
        }
      });

      if (sessionId) AD.Overlay.done(sessionId, result);

      // 自动收起：流式完成且已自动填入时，面板缩短停留时间后自动关闭，避免刷屏
      if (mode.autoAnswer && sessionId) {
        const s = AD.Overlay.session(sessionId);
        if (s) s._autoClosing = true;
        setTimeout(function () {
          const cur = AD.Overlay.session(sessionId);
          if (cur && !cur.userInteracted) AD.Overlay.close(sessionId);
        }, 12000);
      }

      if (wantAuto && result.text && !result.partial && isEnabled() && state.settings.mode.autoAnswer && currentQuestion(question)) {
        const filled = applyAnswer(question, result.text);
        if (filled && filled.ok) markDone(question);
        if (mode.autoFillAfterStream && sessionId) {
          const s = AD.Overlay.session(sessionId);
          if (s) s._autoClosing = true;
          AD.Overlay.close(sessionId);
        }
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (sessionId) AD.Overlay.fail(sessionId, msg);
      if (!sessionId && settings.mode.noticeToast) {
        AD.Overlay.toast('答题失败：' + msg, { tone: 'danger', ms: 3600 });
      }
    } finally {
      state.inFlight.delete(question.id);
      reportState();
    }
  }

  /* ------------------------------ 扫描 ------------------------------ */

  function scanOnce(opts) {
    if (!AD.Detector) return [];
    if (!isEnabled()) {
      if (AD.Overlay.setDetectionBoxes) AD.Overlay.setDetectionBoxes([], false);
      return [];
    }
    const now = Date.now();
    const minInterval = Math.max(200, Number(state.settings.mode.minIntervalMs) || 1500);
    if (!opts || !opts.force) {
      if (state.scanning || now - state.lastScanAt < minInterval) return [];
    }
    state.scanning = true;
    state.lastScanAt = now;
    let list = [];
    try {
      list = AD.Detector.scan(document, {});
    } catch (e) {
      AD.warn('scan failed', e);
      list = [];
    }
    state.scanning = false;
    state.lastCount = list.length;
    if (AD.Overlay.setDetectionBoxes) {
      AD.Overlay.setDetectionBoxes(list, !!(state.settings.detect && state.settings.detect.showDetectionBoxes));
    }
    reportState();
    return list || [];
  }

  function processQuestions(list, source) {
    if (!isEnabled() || !(state.settings.mode.autoAnswer || state.settings.mode.popup)) return;
    const mode = state.settings.mode;
    const max = Math.max(1, Number(mode.maxPerPage) || 6);
    let n = 0;
    const now = Date.now();
    const live = new Set(list.map(function (q) { return q.id; }));
    state.candidates.forEach(function (v, k) { if (!live.has(k)) state.candidates.delete(k); });
    for (let i = 0; i < list.length && n < max; i++) {
      const q = list[i];
      if (!q) continue;
      if (!isManual(source) && state.attempted.has(q.id)) continue;
      if (mode.skipAnswered && q.answered) continue;
      if (isCoolingDown(q)) continue;
      if (isDismissed(q) && source !== 'manual') continue; // 手动关闭过：只允许手动触发再答
      if (!isManual(source)) {
        let candidate = state.candidates.get(q.id);
        if (!candidate || candidate.root !== q.root) {
          candidate = { root: q.root, at: now };
          state.candidates.set(q.id, candidate);
        }
        if (now - candidate.at < 350) {
          if (!settleTimer) settleTimer = setTimeout(function () {
            settleTimer = 0;
            processQuestions(scanOnce({ force: true }), 'detect');
          }, 360);
          continue;
        }
      }
      enqueue(q, source);
      n++;
    }
  }

  function startObserve() {
    stopObserve();
    if (!AD.Detector) return;
    if (!isEnabled()) return;
    if (!(state.settings.mode.autoAnswer || state.settings.mode.popup)) return;
    startHeartbeat();
    state.stopObserve = AD.Detector.observe(function (info) {
      const list = (info && info.questions) || [];
      state.lastCount = list.length;
      if (AD.Overlay.setDetectionBoxes) {
        AD.Overlay.setDetectionBoxes(list, !!(state.settings.detect && state.settings.detect.showDetectionBoxes));
      }
      processQuestions(list, 'detect');
      reportState();
    });
    // 首次立即扫一遍
    setTimeout(function () {
      processQuestions(scanOnce({ force: true }), 'detect');
    }, 420);
  }

  function stopObserve() {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    state.candidates.clear();
    state.queue.length = 0;
    if (state.stopObserve) {
      try { state.stopObserve(); } catch (e) { /* noop */ }
      state.stopObserve = null;
    }
    stopHeartbeat();
  }

  /* --------------------------- 快捷键 / 指令 --------------------------- */

  function toggleMode(key) {
    const patch = {};
    if (key === 'auto') {
      patch.mode = { autoAnswer: !state.settings.mode.autoAnswer };
    } else {
      patch.mode = { popup: !state.settings.mode.popup };
    }
    return AD.Settings.save(patch).then(function (s) {
      state.settings = s;
      const on = key === 'auto' ? s.mode.autoAnswer : s.mode.popup;
      AD.Overlay.toast((key === 'auto' ? '自动答题' : '弹窗模式') + '：' + (on ? '已开启' : '已关闭'), {
        tone: on ? 'success' : 'warn'
      });
      applyModes();
      return s;
    });
  }

  function applyModes() {
    if (!isEnabled()) {
      stopObserve();
      AD.Overlay.closeAll();
      AD.Overlay.hideHint();
      state.queue.length = 0;
      return;
    }
    const m = state.settings.mode;
    if (m.autoAnswer || m.popup) startObserve();
    else stopObserve();
  }

  /** 心跳重扫：有些页面的出现动画/延迟渲染不会触发 MutationObserver，兜底每 6 秒扫一次 */
  let heartbeatTimer = 0;

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (!isEnabled()) return;
      if (!state.settings.mode.autoAnswer && !state.settings.mode.popup) return;
      if (document.hidden) return;
      // 心跳与 DOM 监听共用主控去重，已处理的题不会再次请求。
      try {
        const list = AD.Detector.scan(document, {});
        state.lastCount = list.length;
        processQuestions(list, 'heartbeat');
      } catch (e) { /* noop */ }
    }, 6000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = 0; }
  }

  async function doHoverAnswer() {
    const pos = AD.Capture.lastMouse();
    const el = AD.Capture.elementAt(pos.x, pos.y);
    if (!el) {
      AD.Overlay.toast('没找到题目元素，试试把鼠标移到题目上', { tone: 'warn' });
      return;
    }
    const q = AD.Detector.buildFromElement(el);
    if (!q) {
      AD.Overlay.toast('这个位置识别不到题目结构', { tone: 'warn' });
      return;
    }
    state.doneKeys.delete(q.id);
    await handleQuestion(q, 'hotkey');
  }

  async function doCaptureAnswer(payload) {
    // 同一个拾取入口：单击选元素，拖动框选任意区域。
    const picked = payload && payload.picked || await AD.Capture.pickElement();
    if (!picked) return;
    if (picked.remote) {
      const result = await AD.Frame.activateTarget(picked.remote, 'capture');
      if (!result || !result.ok) AD.Overlay.toast((result && result.error) || '框架已更新，请重新选择', { tone: 'warn' });
      return;
    }

    const rectLocal = picked.rect;
    // 换算到顶层视口坐标（iframe 兼容）
    const rectTop = await AD.Frame.toTopRect(rectLocal);
    if (!rectTop) {
      AD.Overlay.toast('无法定位题目所在的框架，请重新选择', { tone: 'warn' });
      return;
    }

    // 找到框选区域所属题块（用于「填入」）
    let question = null;
    try {
      question = AD.Detector.buildFromElement(picked.el);
    } catch (e) { /* noop */ }
    if (!question) {
      question = {
        id: 'shot_' + AD.hash(rectTop.x + ',' + rectTop.y + ',' + rectTop.w + ',' + rectTop.h),
        kind: 'generic',
        stem: '',
        options: [],
        inputs: [],
        rect: rectTop,
        anchor: null,
        presetId: 'screenshot'
      };
    }

    const nearby = AD.Capture.textNear(rectLocal) || (question.stem || '');
    const profile = (state.settings.api.profiles || []).filter(function (p) {
      return p.id === state.settings.api.activeId;
    })[0] || (state.settings.api.profiles || [])[0] || null;
    const visionOk = !profile || profile.vision !== false;

    if (!IS_TOP) {
      // 元素与表单留在所属文档，截图和答案面板交给顶层。通过扩展消息路由，页面脚本不能触发此入口。
      const shot = visionOk ? await AD.Capture.capture(rectTop, { crop: true }) : null;
      const img = shot && shot.ok ? AD.Capture.splitDataUrl(shot.dataUrl) : null;
      const qid = AD.uid('frameCapture');
      pendingFrameFills.set(qid, question);
      const result = await AD.Capture.sendMessage({ type: 'DATI_FRAME_CAPTURE_START', qid: qid, payload: {
        id: qid, kind: question.kind, stem: nearby || question.stem || '（截图识别）', rect: rectTop,
        options: (question.options || []).map(function (o) { return { label: o.label, text: o.text }; }),
        images: img ? [{ mime: img.mime, dataBase64: img.dataBase64 }] : []
      } });
      if (!result || !result.ok) {
        pendingFrameFills.delete(qid);
        AD.Overlay.toast((result && result.error) || '无法在顶层显示答案，请重新选择', { tone: 'warn' });
      }
      setTimeout(function () { pendingFrameFills.delete(qid); }, 120000);
      return;
    }

    const sessionId = AD.Overlay.show({
      question: Object.assign({}, question, { stem: nearby || '（截图识别）' }),
      rect: rectTop,
      source: 'capture',
      onFill: function (s) {
        const text = s.answerText || s.text;
        if (!text) return;
        const res = applyAnswer(question, text);
        if (!res || !res.ok) {
          AD.Overlay.toast('这段区域没有可填入的输入框，已复制到剪贴板', { tone: 'warn' });
          try { navigator.clipboard.writeText(text); } catch (e) { /* noop */ }
        }
        s._autoClosing = true;
        AD.Overlay.close(s.id);
      }
    });

    AD.Overlay.ready(sessionId, { model: (profile && profile.model) || '' });

    // 截图：需要顶层发起（captureVisibleTab 截整个标签页）
    let shot = null;
    if (visionOk) {
      shot = await AD.Capture.capture(rectTop, { crop: true });
      if (shot && shot.ok && AD.Overlay.updateScreenshot) {
        AD.Overlay.updateScreenshot(sessionId, shot.dataUrl);
      }
      if (!shot || !shot.ok) {
        AD.Overlay.toast('截图失败，改为按页面文本作答：' + ((shot && shot.error) || ''), { tone: 'warn', ms: 3000 });
      }
    }

    const img = (shot && shot.ok) ? AD.Capture.splitDataUrl(shot.dataUrl) : null;

    // 视觉兜底策略：
    // - 模型支持视觉且有截图 → 文本 + 图片一起发（图片兜底，识别不出的文字靠图）
    // - 模型不支持视觉 → 只发文本
    const request = {
      text: nearby || '',
      kind: question.kind || 'generic',
      images: (visionOk && img) ? [{ mime: img.mime, dataBase64: img.dataBase64 }] : [],
      dedupeKey: '',
      options: (question.options || []).map(function (o) {
        return { label: o.label || '', text: o.text || '' };
      })
    };

    try {
      const result = await streamRequest(request, {
        onRequest: function (abort) {
          const s = AD.Overlay.session(sessionId);
          if (s) s.onStop = function () { abort(); };
        },
        onReady: function (info) { AD.Overlay.ready(sessionId, info); },
        onDelta: function (d) { AD.Overlay.append(sessionId, d); },
        onReasoning: function (d) { AD.Overlay.setReasoning(sessionId, d); },
        options: { force: true }
      });
      AD.Overlay.done(sessionId, result);
    } catch (e) {
      AD.Overlay.fail(sessionId, (e && e.message) || String(e));
    }
  }

  function onKeyDown(e) {
    if (!state.settings || !state.settings.hotkey.enabled) return;
    if (!isEnabled()) return;
    const hk = state.settings.hotkey;
    // 输入框内只允许带 Alt/Ctrl/Meta 的组合
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    const combos = [
      { combo: hk.capture, fn: function () { doCaptureAnswer(); } },
      { combo: hk.hover, fn: function () { doHoverAnswer(); } },
      { combo: hk.picker, fn: function () { openPicker(); } },
      { combo: hk.toggleAuto, fn: function () { toggleMode('auto'); } },
      { combo: hk.togglePopup, fn: function () { toggleMode('popup'); } }
    ];

    for (let i = 0; i < combos.length; i++) {
      const parsed = AD.Capture.parseCombo(combos[i].combo);
      if (!parsed) continue;
      if (typing && !(parsed.alt || parsed.ctrl || parsed.meta)) continue;
      if (!AD.Capture.comboMatches(parsed, e)) continue;
      e.preventDefault();
      e.stopPropagation();
      combos[i].fn();
      return;
    }
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'DATI_FRAME_USE_TARGET') {
      if (!isEnabled()) { sendResponse({ ok: false, error: 'AutoDati 已停用' }); return false; }
      sendResponse(AD.Frame.useTarget(msg.token, msg.action));
      return false;
    }
    if (msg.type === 'DATI_FRAME_CAPTURE_SHOW' && IS_TOP) {
      onFrameQuestion(msg.payload || {}, { documentId: msg.documentId }, msg.qid, true);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'DATI_FRAME_CAPTURE_APPLY') {
      const question = pendingFrameFills.get(msg.qid);
      if (!question || !question.root || !question.root.isConnected) {
        sendResponse({ ok: false, error: '题目已更新，请重新选择' });
        return false;
      }
      const result = applyAnswer(question, msg.text);
      if (result && result.ok) pendingFrameFills.delete(msg.qid);
      sendResponse(result || { ok: false });
      return false;
    }

    if (msg.type === AD.MSG.CMD) {
      // 总开关关闭时，除了「关闭面板」以外全部忽略
      if (!isEnabled() && msg.cmd !== 'close-overlays') {
        AD.Overlay.toast('AutoDati 已停用，点击扩展图标可重新启用', { tone: 'warn' });
        sendResponse && sendResponse({ ok: false, disabled: true });
        return false;
      }
      switch (msg.cmd) {
        case 'capture':
          if (IS_TOP) doCaptureAnswer();
          break;
        case 'hover-answer':
          doHoverAnswer();
          break;
        case 'toggle-auto':
          toggleMode('auto');
          break;
        case 'toggle-popup':
          toggleMode('popup');
          break;
        case 'scan':
          processQuestions(scanOnce({ force: true }), 'manual');
          break;
        case 'auto-next-scan':
          processQuestions(scanOnce({ force: true }), 'detect');
          break;
        case 'pick-template':
          if (IS_TOP) openPicker();
          break;
        case 'close-overlays':
          AD.Overlay.closeAll();
          break;
        default:
          break;
      }
      sendResponse && sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'AD_QUERY_STATE') {
      const list = scanOnce({ force: false });
      sendResponse({
        ok: true,
        state: {
          count: state.lastCount,
          enabled: isEnabled(),
          autoAnswer: !!state.settings.mode.autoAnswer,
          popup: !!state.settings.mode.popup,
          active: state.active,
          top: IS_TOP,
          url: location.href,
          title: document.title
        }
      });
      return false;
    }

    return false;
  }

  /* ------------------------------ 悬停提示 ------------------------------ */

  let hoverTimer = 0;

  function hideHoverHint() {
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    AD.Overlay.hideHint();
  }

  function onMouseMove() {
    function picking() {
      return (AD.Picker && AD.Picker.isOpen()) || (AD.Capture.isPicking && AD.Capture.isPicking());
    }
    if (picking() || !state.settings || !state.settings.mode.hoverHint || !isEnabled()) { hideHoverHint(); return; }
    if (!AD.Detector) return;
    if (hoverTimer) return;
    hoverTimer = setTimeout(function () {
      hoverTimer = 0;
      if (picking()) { AD.Overlay.hideHint(); return; }
      if (!isEnabled() || !state.settings.mode.hoverHint) { hideHoverHint(); return; }
      const pos = AD.Capture.lastMouse();
      const el = AD.Capture.elementAt(pos.x, pos.y);
      if (!el) return AD.Overlay.hideHint();
      const q = AD.Detector.questionAt(el);
      if (!q) return AD.Overlay.hideHint();
      const r = q.root ? q.root.getBoundingClientRect() : el.getBoundingClientRect();
      AD.Overlay.hint(
        { x: r.left, y: r.top, w: r.width, h: r.height },
        (AD.KIND_LABEL[q.kind] || '题目') + ' · ' + (state.settings.hotkey.hover || 'Alt+Shift+Q'),
        q.root
      );
    }, 160);
  }

  /* ------------------------------ 初始化 ------------------------------ */

  function bindHotkeys() {
    document.addEventListener('keydown', onKeyDown, true);
  }

  function init() {
    if (state.started) return;
    state.started = true;

    if (AD.Frame) AD.Frame.install();
    AD.Overlay.init();
    AD.Capture.trackMouse();
    bindHotkeys();
    document.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
    document.addEventListener('mouseout', function (e) { if (!e.relatedTarget) hideHoverHint(); }, true);
    window.addEventListener('blur', hideHoverHint);
    window.addEventListener('scroll', hideHoverHint, { passive: true, capture: true });

    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    AD.Settings.get().then(function (s) {
      state.settings = s;
      AD.setLog(!!(s.advanced && s.advanced.log));
      AD.Overlay.retheme(s);
      // 设置变化立即清理已显示角标和等待中的悬停任务，无需刷新页面。
      hideHoverHint();
      applyModes();
      reportState();
      AD.log('ready', { top: IS_TOP, auto: s.mode.autoAnswer, popup: s.mode.popup });
    });

    AD.Settings.subscribe(function (s) {
      const prev = state.settings;
      state.settings = s;
      AD.setLog(!!(s.advanced && s.advanced.log));
      AD.Overlay.retheme(s);
      hideHoverHint();
      if (AD.Overlay.setDetectionBoxes) {
        if (!s.enabled || !s.detect || !s.detect.showDetectionBoxes) AD.Overlay.setDetectionBoxes([], false);
        else setTimeout(function () { scanOnce({ force: true }); }, 0);
      }
      if (!prev ||
        prev.enabled !== s.enabled ||
        prev.mode.autoAnswer !== s.mode.autoAnswer ||
        prev.mode.popup !== s.mode.popup ||
        JSON.stringify(prev.detect) !== JSON.stringify(s.detect) ||
        prev.mode.scanDebounceMs !== s.mode.scanDebounceMs ||
        prev.mode.minIntervalMs !== s.mode.minIntervalMs ||
        prev.mode.skipAnswered !== s.mode.skipAnswered ||
        prev.mode.maxPerPage !== s.mode.maxPerPage) {
        applyModes();
      }
      reportState();
    });

    // 页面卸载时关闭面板，避免残留
    window.addEventListener('pagehide', function () {
      try { AD.Overlay.closeAll(); } catch (e) { /* noop */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  AD.App = {
    init: init,
    scan: function () { return scanOnce({ force: true }); },
    answerQuestion: handleQuestion,
    capturePicked: function (picked) { return doCaptureAnswer({ picked: picked }); },
    openPicker: openPicker,
    onFrameQuestion: onFrameQuestion,
    onFrameFill: onFrameFill,
    state: state
  };
}(globalThis.AD = globalThis.AD || {}));
