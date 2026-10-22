/**
 * AutoDati · Service Worker
 * 负责：设置读写、LLM 流式代理、截图裁剪、快捷键/菜单转发、状态汇总。
 */
importScripts(
  '/common/protocol.js',
  '/common/settings.js',
  '/common/release.js',
  '/common/statistics.js',
  '/background/llm.js',
  '/background/screenshot.js',
  '/background/navigation.js',
  '/background/updates.js'
);

(function (AD) {
  'use strict';

  const activeStreams = new Map();   // reqId -> {abort, port, tabId, started}
  const tabStates = new Map();       // tabId -> state
  const lastRequestByKey = new Map(); // 去重：tabId:questionId -> ts

  AD.Settings.get().then(function (s) {
    AD.setLog(!!(s.advanced && s.advanced.log));
  });

  /* ------------------------------ 工具 ------------------------------ */

  function isTabId(v) {
    return typeof v === 'number' && v >= 0;
  }

  function sendToTab(tabId, msg) {
    if (!isTabId(tabId)) return Promise.resolve(false);
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, msg, function () {
          if (chrome.runtime.lastError) return resolve(false);
          resolve(true);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function setBadge(state) {
    try {
      if (state && state.enabled === false) {
        chrome.action.setBadgeText({ text: 'off' });
        chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
        return;
      }
      if (!state || !state.count) {
        chrome.action.setBadgeText({ text: '' });
        return;
      }
      chrome.action.setBadgeText({ text: String(Math.min(99, state.count)) });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    } catch (e) { /* noop */ }
  }

  /** 角标只反映「当前激活标签页」的状态，标签页之间互不影响 */
  async function refreshBadge() {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !isTabId(tab.id)) return;
      const st = tabStates.get(tab.id) || null;
      setBadge(st);
    } catch (e) { /* noop */ }
  }

  function pickProfile(settings, profileId) {
    const list = (settings.api && settings.api.profiles) || [];
    if (profileId) {
      for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === profileId) return list[i];
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === settings.api.activeId) return list[i];
    }
    return list[0] || null;
  }

  /* ------------------------- 消息路由（一次性） ------------------------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    const tabId = sender && sender.tab ? sender.tab.id : null;

    const reply = function (payload) {
      try { sendResponse(payload); } catch (e) { /* 通道可能已关闭 */ }
    };

    switch (msg.type) {
      case 'DATI_RULE_PREVIEW':
        if (!isTabId(tabId) || sender.id !== chrome.runtime.id) { reply({ok:false}); return false; }
        chrome.scripting.executeScript({target:{tabId:tabId,allFrames:true},func:function(rule){return globalThis.AD && AD.RuleEditor ? AD.RuleEditor.paint(rule) : 0;},args:[msg.rule || null]}).then(function(frames){reply({ok:true,count:frames.reduce(function(n,f){return n+(f.result||0);},0)});}).catch(function(){reply({ok:false});});
        return true;
      case 'DATI_NAV_STATUS':
        if (sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || '').startsWith(chrome.runtime.getURL('ui/'))) { reply({ok:false}); return false; }
        chrome.tabs.query({active:true,lastFocusedWindow:true}).then(async function (tabs) {
          reply({ok:true,text:tabs[0] ? await AD.AutoNavigation.status(tabs[0].id) : '未打开网页'});
        }).catch(function () { reply({ok:false}); });
        return true;
      case 'DATI_UPDATE_STATUS':
      case 'DATI_CHECK_UPDATE':
      case 'DATI_OPEN_RELEASE':
        if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL('ui/'))) {
          reply({ ok: false, error: '仅扩展设置和快捷面板可检查更新' }); return false;
        }
        (async function () {
          const state = msg.type === 'DATI_CHECK_UPDATE' ? await AD.Updates.check(true) : await AD.Updates.status();
          if (msg.type === 'DATI_OPEN_RELEASE') await chrome.tabs.create({ url: state.releaseUrl });
          reply({ ok: true, state: state });
        }()).catch(function () { reply({ ok: false, error: '无法连接更新服务' }); });
        return true;
      case 'DATI_NAV_FILLED':
        if (!isTabId(tabId) || sender.id !== chrome.runtime.id || !sender.documentId || typeof msg.qid !== 'string') {
          reply({ ok: false }); return false;
        }
        reply({ ok: true, accepted: AD.AutoNavigation.afterFill(tabId, sender.documentId, msg.qid) });
        return false;
      case 'DATI_FRAME_CAPTURE_START':
      case 'DATI_FRAME_CAPTURE_FILL':
        if (!isTabId(tabId) || sender.id !== chrome.runtime.id) {
          reply({ ok: false, error: '无法定位题目标签页' }); return false;
        }
        if (msg.type === 'DATI_FRAME_CAPTURE_START') {
          chrome.tabs.sendMessage(tabId, { type: 'DATI_FRAME_CAPTURE_SHOW', payload: msg.payload,
            qid: msg.qid, documentId: sender.documentId }, { frameId: 0 }).then(reply).catch(function () {
            reply({ ok: false, error: '顶层页面已更新，请重新选择' });
          });
        } else {
          if (sender.frameId !== 0 || typeof msg.documentId !== 'string' || typeof msg.text !== 'string') {
            reply({ ok: false, error: '无效的框架填入操作' }); return false;
          }
          chrome.tabs.sendMessage(tabId, { type: 'DATI_FRAME_CAPTURE_APPLY', qid: msg.qid, text: msg.text },
            { documentId: msg.documentId }).then(reply).catch(function () {
            reply({ ok: false, error: '题目框架已跳转，请重新选择' });
          });
        }
        return true;

      case 'DATI_FRAME_PROBE':
        if (!isTabId(tabId) || sender.id !== chrome.runtime.id || !msg.point ||
            !Number.isFinite(msg.point.x) || !Number.isFinite(msg.point.y)) {
          reply({ ok: false, error: '无效的框架拾取位置' }); return false;
        }
        (async function () {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: async function (point, options) {
              if (!globalThis.AD || !AD.Frame || !AD.Capture) return null;
              try { return await AD.Frame.probeAtTop(point, options); }
              catch (e) { return null; }
            },
            args: [{ x: msg.point.x, y: msg.point.y }, { whole: !!(msg.options && msg.options.whole), contextRect: msg.options && msg.options.contextRect || null }]
          });
          // 只有被父框架实际命中的子框架才能继续向内选，排除遮挡层后面/隐藏的兄弟框架。
          const hits = results.filter(function (item) { return item.result && Array.isArray(item.result.path); });
          let hit = hits.find(function (item) { return item.result.path.length === 0; });
          for (let depth = 0; hit && depth < 64 && hit.result.childIndex >= 0; depth++) {
            const childPath = hit.result.path.concat(hit.result.childIndex);
            const child = hits.find(function (item) {
              return JSON.stringify(item.result.path) === JSON.stringify(childPath);
            });
            if (!child) break;
            hit = child;
          }
          reply({ ok: true, target: hit ? Object.assign({}, hit.result, { frameId: hit.frameId, documentId: hit.documentId }) : null });
        })().catch(function (e) { reply({ ok: false, error: e.message || '框架拾取失败' }); });
        return true;

      case 'DATI_FRAME_ACTIVATE':
        if (!isTabId(tabId) || sender.id !== chrome.runtime.id || !msg.documentId ||
            !['capture', 'template'].includes(msg.action) || typeof msg.token !== 'string') {
          reply({ ok: false, error: '无效的框架拾取操作' }); return false;
        }
        chrome.tabs.sendMessage(tabId, { type: 'DATI_FRAME_USE_TARGET', token: msg.token, action: msg.action },
          { documentId: msg.documentId }).then(reply).catch(function () {
          reply({ ok: false, error: '题目框架已跳转，请重新选择' });
        });
        return true;

      case 'DATI_GET_STATISTICS':
      case 'DATI_IMPORT_STATISTICS':
      case 'DATI_IMPORT_BACKUP':
        if (!sender || sender.id !== chrome.runtime.id || !sender.url ||
            !sender.url.startsWith(chrome.runtime.getURL('ui/options.html'))) {
          reply({ ok: false, error: '请从扩展设置页管理统计数据' }); return false;
        }
        Promise.resolve().then(function () {
          if (msg.type === 'DATI_IMPORT_BACKUP') return AD.Statistics.importBackup(msg.settings, msg.statistics).then(function (settings) { return { settings: settings }; });
          return msg.type === 'DATI_GET_STATISTICS' ? AD.Statistics.get() : AD.Statistics.replace(msg.statistics);
        }).then(function (data) { reply(data.settings ? { ok: true, settings: data.settings } : { ok: true, statistics: data }); }).catch(function (e) {
          reply({ ok: false, error: e.message || '统计数据读写失败' });
        });
        return true;
      case AD.MSG.PING:
        reply({ ok: true, version: AD.VERSION, protocol: AD.PROTOCOL });
        return false;

      case AD.MSG.GET_SETTINGS:
        AD.Settings.get().then(function (s) { reply({ ok: true, settings: s }); });
        return true;

      case AD.MSG.SAVE_SETTINGS:
        AD.Settings.save(msg.patch || {}).then(function (s) {
          AD.setLog(!!(s.advanced && s.advanced.log));
          reply({ ok: true, settings: s });
        }).catch(function (e) {
          reply({ ok: false, error: (e && e.message) || String(e) });
        });
        return true;

      case AD.MSG.LIST_PROVIDER_MODELS:
        if (!sender || sender.id !== chrome.runtime.id || !sender.url ||
            !sender.url.startsWith(chrome.runtime.getURL('ui/options.html'))) {
          reply({ ok: false, error: '请从扩展设置页获取模型列表' });
          return false;
        }
        AD.LLM.listModels(msg.profile || {}).then(reply).catch(function () {
          reply({ ok: false, error: '获取模型列表失败，请检查 URL 与网络连接' });
        });
        return true;

      case AD.MSG.TEST_PROVIDER:
        (async function () {
          const settings = await AD.Settings.get();
          const profile = msg.profile || pickProfile(settings);
          if (!profile) return reply({ ok: false, error: '没有可用的模型配置' });
          const result = await AD.LLM.test(profile, msg.prompt);
          // 记录测试结果
          try {
            const list = settings.api.profiles.map(function (p) {
              if (p && p.id === profile.id) {
                return Object.assign({}, p, {
                  lastTest: { ok: !!result.ok, ms: result.ms, text: result.text || '', error: result.error || '', at: Date.now() }
                });
              }
              return p;
            });
            await AD.Settings.save({ api: { profiles: list } });
          } catch (e) { /* noop */ }
          reply(result);
        })();
        return true;

      case AD.MSG.CAPTURE_TAB:
        (async function () {
          try {
            const settings = await AD.Settings.get();
            const adv = settings.advanced || {};
            // 必须确保目标窗口处于激活状态，否则 captureVisibleTab 会失败
            if (tabId != null) {
              try {
                const tab = await chrome.tabs.get(tabId);
                if (tab && !tab.active) await chrome.tabs.update(tabId, { active: true });
                if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
              } catch (e) { /* noop */ }
              await AD.sleep(60);
            }
            const shot = await AD.Shot.capture({
              rect: msg.rect,
              viewport: msg.viewport,
              dpr: msg.dpr,
              format: msg.format || adv.screenshotFormat || 'png',
              crop: msg.crop !== false,
              maxSide: msg.maxSide || adv.maxImageSide || 1600,
              quality: msg.quality
            });
            reply({ ok: true, dataUrl: shot.dataUrl, width: shot.width, height: shot.height, mime: shot.mime });
          } catch (e) {
            reply({ ok: false, error: (e && e.message) || String(e) });
          }
        })();
        return true;

      case AD.MSG.OPEN_OPTIONS:
        chrome.runtime.openOptionsPage(function () { });
        reply({ ok: true });
        return false;

      case AD.MSG.STATE_REPORT:
        if (isTabId(tabId)) {
          tabStates.set(tabId, Object.assign({ tabId: tabId, at: Date.now() }, msg.state || {}));
        }
        refreshBadge().then(function () { reply({ ok: true }); }).catch(function () { reply({ ok: true }); });
        return true;
      case AD.MSG.GET_STATE:
        (async function () {
          let id = tabId;
          if (id == null) {
            try {
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              id = tabs && tabs[0] ? tabs[0].id : null;
            } catch (e) { id = null; }
          }
          let state = id != null ? tabStates.get(id) : null;
          if (!state) {
            // 主动向内容脚本要一次实时状态
            if (id != null) {
              const got = await new Promise(function (resolve) {
                try {
                  chrome.tabs.sendMessage(id, { type: 'AD_QUERY_STATE' }, function (res) {
                    if (chrome.runtime.lastError) return resolve(null);
                    resolve(res || null);
                  });
                } catch (e) { resolve(null); }
              });
              if (got && got.state) {
                state = Object.assign({ tabId: id, at: Date.now() }, got.state);
                tabStates.set(id, state);
              }
            }
          }
          const settings = await AD.Settings.get();
          reply({
            ok: true,
            state: state || null,
            tabId: id,
            settings: { mode: settings.mode, api: { activeId: settings.api.activeId, profiles: settings.api.profiles } }
          });
        })();
        return true;

      default:
        return false;
    }
  });

  /* ------------------------- 流式端口 ------------------------- */

  chrome.runtime.onConnect.addListener(function (port) {
    if (!port || port.name !== AD.STREAM.PORT) return;

    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
    const myRequests = new Set();

    const post = function (msg) {
      try { port.postMessage(msg); } catch (e) { /* 端口已断开 */ }
    };

    const cleanup = function (reqId) {
      const rec = activeStreams.get(reqId);
      if (rec && rec.timer) clearInterval(rec.timer);
      activeStreams.delete(reqId);
      myRequests.delete(reqId);
    };

    const stopAll = function () {
      myRequests.forEach(function (reqId) {
        const rec = activeStreams.get(reqId);
        if (rec && rec.handle) { try { rec.handle.abort(); } catch (e) { /* noop */ } }
        cleanup(reqId);
      });
    };

    port.onMessage.addListener(function (msg) {
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === AD.STREAM.PING) {
        post({ type: 'AD_PONG', at: Date.now() });
        return;
      }

      if (msg.type === AD.STREAM.ABORT) {
        const rec = activeStreams.get(msg.reqId);
        if (rec && rec.handle) { try { rec.handle.abort(); } catch (e) { /* noop */ } }
        cleanup(msg.reqId);
        return;
      }

      if (msg.type !== AD.STREAM.START) return;

      const reqId = msg.reqId || AD.uid('req');
      myRequests.add(reqId);

      (async function () {
        const settings = await AD.Settings.get();
        AD.setLog(!!(settings.advanced && settings.advanced.log));

        const profile = pickProfile(settings, msg.request && msg.request.profileId);
        if (!profile) {
          post({ type: AD.STREAM.ERROR, reqId: reqId, error: '未配置模型服务，请先到设置页添加 API。', code: 'noconfig' });
          cleanup(reqId);
          return;
        }

        // 同一题目短时间内的重复请求直接拦下（防抖，避免页面抖动导致重复请求）
        const dedupeKey = (tabId || 'x') + ':' + ((msg.request && msg.request.dedupeKey) || '') + ':' + profile.id;
        const force = !!(msg.options && msg.options.force);
        if (msg.request && msg.request.dedupeKey && !force) {
          const last = lastRequestByKey.get(dedupeKey) || 0;
          const cooldown = Math.max(0, Number(settings.mode && settings.mode.cooldownMs) || 0);
          if (cooldown > 0 && Date.now() - last < cooldown) {
            post({
              type: AD.STREAM.ERROR, reqId: reqId, code: 'cooldown',
              error: '该题刚刚请求过，冷却中（' + Math.round(cooldown / 1000) + ' 秒）'
            });
            cleanup(reqId);
            return;
          }
          lastRequestByKey.set(dedupeKey, Date.now());
        }

        const started = Date.now();
        let firstChunkAt = 0;
        let recorded = false;
        function recordResult(status, result) {
          if (recorded) return;
          recorded = true;
          AD.Statistics.record({ at: started, model: profile.model, format: profile.format,
            kind: msg.request && msg.request.images && msg.request.images.length ? 'screenshot' : (msg.request && msg.request.kind) || 'generic',
            status: status, partial: !!(result && result.partial), usage: result && result.usage,
            ms: Date.now() - started, firstChunkMs: firstChunkAt ? firstChunkAt - started : null
          }).catch(function () { AD.warn('统计数据保存失败'); });
        }

        const handle = AD.LLM.stream({
          settings: settings,
          profile: profile,
          request: msg.request || {},
          options: msg.options || {}
        }, {
          onReady: function (info) {
            post({
              type: AD.STREAM.READY, reqId: reqId,
              model: info.model, format: info.format, url: info.url, stream: info.stream
            });
          },
          onDelta: function (delta, acc) {
            if (!firstChunkAt) firstChunkAt = Date.now();
            post({ type: AD.STREAM.CHUNK, reqId: reqId, delta: delta, length: acc.length });
          },
          onReasoning: function (delta) {
            if (!firstChunkAt) firstChunkAt = Date.now();
            post({ type: 'AD_STREAM_REASONING', reqId: reqId, delta: delta });
          },
          onDone: function (r) {
            recordResult('success', r);
            post({
              type: AD.STREAM.DONE, reqId: reqId,
              text: r.text, usage: r.usage, model: r.model, format: r.format,
              ms: r.ms, partial: !!r.partial, warning: r.warning || null,
              firstChunkMs: firstChunkAt ? firstChunkAt - started : null
            });
            cleanup(reqId);
          },
          onError: function (e) {
            recordResult(e && e.code === 'aborted' ? 'cancelled' : 'failed', e);
            post({
              type: AD.STREAM.ERROR, reqId: reqId,
              error: (e && e.message) || '请求失败', code: (e && e.code) || 'unknown'
            });
            cleanup(reqId);
          }
        });

        activeStreams.set(reqId, {
          handle: handle, port: port, tabId: tabId, started: started
        });
      })();
    });

    port.onDisconnect.addListener(function () {
      stopAll();
    });
  });

  /* ------------------------- 快捷键 / 菜单 ------------------------- */

  const CMD_MAP = {
    'answer-hover': 'hover-answer',
    'capture-answer': 'capture',
    'toggle-auto': 'toggle-auto',
    'toggle-popup': 'toggle-popup'
  };

  chrome.commands.onCommand.addListener(function (command) {
    const cmd = CMD_MAP[command] || command;
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return;
      sendToTab(tab.id, { type: AD.MSG.CMD, cmd: cmd }).then(function (ok) {
        if (!ok) {
          // 内容脚本尚未注入（例如扩展刚装好），尝试补注入
          try {
            chrome.scripting.executeScript({
              target: { tabId: tab.id, allFrames: false },
              files: [
                'common/protocol.js', 'common/settings.js', 'common/rule-transfer.js',
                'content/presets.js', 'content/detector.js', 'content/filler.js',
                'content/overlay.js', 'content/frame.js', 'content/picker.js',
                'content/capture.js', 'content/navigation.js', 'content/rule-editor.js', 'content/content.js'
              ]
            }, function () {
              if (chrome.runtime.lastError) return;
              setTimeout(function () { sendToTab(tab.id, { type: AD.MSG.CMD, cmd: cmd }); }, 260);
            });
          } catch (e) { /* noop */ }
        }
      });
    });
  });

  function setupMenus() {
    try {
      chrome.contextMenus.removeAll(function () {
        chrome.contextMenus.create({
          id: 'dati-answer-element',
          title: 'AutoDati：对选中区域答题',
          contexts: ['selection', 'image', 'link', 'page']
        });
        chrome.contextMenus.create({
          id: 'dati-capture',
          title: 'AutoDati：截图答题',
          contexts: ['page', 'selection', 'image']
        });
        chrome.contextMenus.create({
          id: 'dati-pick-template',
          title: 'AutoDati：拾取元素，添加题目模板',
          contexts: ['page', 'selection', 'image']
        });
        chrome.contextMenus.create({
          id: 'dati-open-options',
          title: 'AutoDati：打开设置',
          contexts: ['page']
        });
      });
    } catch (e) { /* noop */ }
  }

  chrome.runtime.onInstalled.addListener(function () {
    setupMenus();
    AD.Settings.get(true);
  });
  chrome.runtime.onStartup.addListener(function () {
    setupMenus();
  });

  chrome.contextMenus.onClicked.addListener(function (info, tab) {
    if (!tab || !tab.id) return;
    if (info.menuItemId === 'dati-open-options') {
      chrome.runtime.openOptionsPage();
      return;
    }
    const cmd = info.menuItemId === 'dati-capture' ? 'capture' : 'hover-answer';
    sendToTab(tab.id, { type: AD.MSG.CMD, cmd: cmd, payload: { selectionText: info.selectionText || '' } });
  });

  /* ------------------------- 清理 ------------------------- */

  chrome.tabs.onRemoved.addListener(function (tabId) {
    tabStates.delete(tabId);
  });

  // 切换标签页/窗口时，角标同步为当前激活页的状态（标签页之间互不串扰）
  chrome.tabs.onActivated.addListener(function () {
    refreshBadge();
  });
  chrome.windows.onFocusChanged.addListener(function () {
    refreshBadge();
  });

  chrome.action.onClicked && chrome.action.onClicked.addListener(function (tab) {
    // 有 popup 时不会触发；保留以防 popup 被移除
    if (tab && tab.id) sendToTab(tab.id, { type: AD.MSG.CMD, cmd: 'scan' });
  });

  AD.SW = { activeStreams: activeStreams, tabStates: tabStates, pickProfile: pickProfile };
}(globalThis.AD = globalThis.AD || {}));
