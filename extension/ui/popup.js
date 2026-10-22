/**
 * AutoDati · 工具栏弹窗逻辑
 * 经典脚本：依赖 AD（protocol.js / settings.js）。
 * 无 chrome API（file:// 直接打开）时降级为只读展示 + 提示，界面仍完整渲染。
 */
(function (AD) {
  'use strict';

  if (!AD || !AD.Settings) return;

  var Settings = AD.Settings;
  var hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  var hasTabs = hasChrome && !!chrome.tabs;

  function $(sel) { return document.querySelector(sel); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var state = Settings.snapshot();
  var toastEl = $('#toast');
  var toastTimer = null;

  function toast(msg, kind) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'dati-toast is-show' + (kind ? ' dati-toast--' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.className = 'dati-toast' + (kind ? ' dati-toast--' + kind : '');
    }, 2000);
  }

  /* ------------------------------------------------------------ 渲染 */

  function currentProfile() {
    var list = (state.api && state.api.profiles) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === state.api.activeId) return list[i];
    }
    return list[0] || null;
  }

  function formatLabel(f) {
    return (AD.FORMAT_LABEL && AD.FORMAT_LABEL[f]) || f || '未配置';
  }

  function renderProfile() {
    document.body.toggleAttribute('data-noanim', state.ui && state.ui.animate === false);
    document.body.setAttribute('data-theme', (state.ui && state.ui.theme) || 'dark');
    if (state.ui && state.ui.accent) {
      document.body.style.setProperty('--dati-accent', state.ui.accent);
      document.body.style.setProperty('--dati-accent-2', state.ui.accent);
      document.body.style.setProperty('--dati-accent-soft', 'color-mix(in srgb, ' + state.ui.accent + ' 14%, transparent)');
    }
    var p = currentProfile();
    var nameEl = $('#modelName');
    var fmtEl = $('#modelFormat');
    var provEl = $('#modelProvider');
    var stateEl = $('#modelState');

    if (nameEl) nameEl.textContent = (p && p.model) || '未选择模型';
    if (fmtEl) fmtEl.textContent = formatLabel(p && p.format);
    if (provEl) provEl.textContent = (p && p.name) || '默认配置';

    var missing = !p || !p.apiKey;
    if (stateEl) {
      stateEl.textContent = missing ? '缺少密钥' : '就绪';
      stateEl.style.color = missing ? 'var(--dati-warn)' : '';
    }

    var badge = $('#connBadge');
    if (badge) {
      badge.className = 'dati-badge dati-badge--dot ' + (hasChrome ? 'dati-badge--ok' : 'dati-badge--warn');
      badge.textContent = hasChrome ? '已连接' : '未连接';
    }

    var hint = $('#popHint');
    if (hint) {
      var cap = state.hotkey && state.hotkey.capture;
      var hov = state.hotkey && state.hotkey.hover;
      var parts = [];
      if (cap) parts.push(kbdRow(cap) + ' 框选区域');
      if (hov) parts.push(kbdRow(hov) + ' 直接作答');
      if (!parts.length) parts.push('页面快捷键已关闭');
      hint.innerHTML = parts.join(' · ');
    }

    var ver = $('#popVersion');
    if (ver) ver.textContent = 'v' + (AD.VERSION || '0.1.0');
  }

  function kbdRow(combo) {
    return String(combo).split('+').filter(Boolean).map(function (k) {
      return '<span class="dati-kbd">' + esc(k) + '</span>';
    }).join('');
  }

  function renderModes() {
    var auto = $('#swAuto');
    var popup = $('#swPopup');
    if (auto) auto.checked = !!state.mode.autoAnswer;
    if (popup) popup.checked = !!state.mode.popup;
    var hint = $('#swHoverHint');
    if (hint) hint.checked = !!state.mode.hoverHint;
    var next = $('#swAutoNextPage');
    if (next) next.checked = !!state.mode.autoNextPage;
    var nextHighlight = $('#swHighlightNextPage');
    if (nextHighlight) nextHighlight.checked = !!state.mode.highlightNextPage;
    var nextRow = $('#modeAutoNextPage');
    if (nextRow) nextRow.classList.toggle('is-on', !!state.mode.autoNextPage);
    var autoRow = $('#modeAuto');
    var popupRow = $('#modePopup');
    if (autoRow) autoRow.classList.toggle('is-on', !!state.mode.autoAnswer);
    if (popupRow) popupRow.classList.toggle('is-on', !!state.mode.popup);
  }

  /* ------------------------------------------------------------ 总开关 */

  var lastEnabled = null;

  function isEnabled() {
    return state.enabled !== false;
  }

  function renderMaster(animate) {
    var on = isEnabled();
    var sw = $('#swMaster');
    if (sw && sw !== document.activeElement) sw.checked = on;

    var card = $('#masterCard');
    if (card) card.classList.toggle('is-off', !on);

    var title = $('#masterTitle');
    if (title) title.textContent = on ? '已启用' : '已停用';

    var desc = $('#masterDesc');
    if (desc) {
      desc.textContent = on
        ? '检测、弹窗与页面快捷键均正常工作'
        : '扩展已完全静默：不检测、不弹窗、快捷键失效';
    }

    var body = $('#popBody');
    if (body) body.classList.toggle('is-muted', !on);

    var badge = $('#connBadge');
    if (badge) {
      if (!hasChrome) {
        badge.className = 'dati-badge dati-badge--dot dati-badge--warn';
        badge.textContent = '未连接';
      } else if (!on) {
        badge.className = 'dati-badge dati-badge--dot';
        badge.textContent = '已停用';
      } else {
        badge.className = 'dati-badge dati-badge--dot dati-badge--ok';
        badge.textContent = '已连接';
      }
    }

    if (!on) {
      setStateView('idle', '总开关已关闭', '打开总开关后才会检测题目', 0);
    } else if (animate) {
      refreshState();
    }
  }

  function bindMaster() {
    var sw = $('#swMaster');
    if (!sw) return;
    sw.addEventListener('change', function () {
      var on = sw.checked;
      save({ enabled: on }).then(function () {
        lastEnabled = on;
        renderMaster(false);
        if (on) refreshState();
        else setStateView('idle', '总开关已关闭', '打开总开关后才会检测题目', 0);
      });
    });
  }

  function setStateView(kind, title, sub, count) {
    var dot = $('#stateDot');
    if (dot) dot.className = 'pop-state__dot is-' + kind;
    var t = $('#stateTitle');
    if (t) t.textContent = title;
    var s = $('#stateSub');
    if (s) s.textContent = sub;
    var c = $('#stateCount');
    if (c) c.textContent = String(count == null ? 0 : count);
  }

  /* ------------------------------------------------------------ 状态读取 */

  function getActiveTab() {
    return new Promise(function (resolve) {
      if (!hasTabs || !chrome.tabs.query) return resolve(null);
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve((tabs && tabs[0]) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sendToBackground(msg) {
    return new Promise(function (resolve) {
      if (!hasChrome || !chrome.runtime.sendMessage) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function refreshState() {
    if (hasChrome) chrome.runtime.sendMessage({type:"DATI_NAV_STATUS"}).then(function(r){ var el=document.querySelector("#navigationStatus");if(el && r && r.ok) el.textContent=r.text; }).catch(function(){});
    if (!isEnabled()) {
      setStateView('idle', '总开关已关闭', '打开总开关后才会检测题目', 0);
      return Promise.resolve();
    }
    if (!hasChrome) {
      setStateView('warn', '未连接扩展', '本地预览模式，状态不可用', 0);
      return Promise.resolve();
    }
    setStateView('busy', '正在读取状态…', '等待后台响应', '—');
    return getActiveTab().then(function (tab) {
      return sendToBackground({ type: 'AD_GET_STATE' }).then(function (res) {
        if (!res || !res.ok || !res.states) {
          setStateView('warn', '未连接', '后台无响应或内容脚本未注入', 0);
          return;
        }
        var key = tab ? String(tab.id) : null;
        var st = key && res.states[key];
        if (!st && tab) {
          // 尝试所有键里匹配 tabId 的项
          Object.keys(res.states).forEach(function (k) {
            var cand = res.states[k];
            if (cand && (cand.tabId === tab.id || cand.url === tab.url)) st = cand;
          });
        }
        if (!st) {
          setStateView('idle', '本页未注入脚本', '刷新页面或打开普通网页后重试', 0);
          return;
        }
        var count = Number(st.count != null ? st.count : (st.questions != null ? st.questions : 0)) || 0;
        var enabled = st.enabled !== false;
        if (!enabled) {
          setStateView('warn', '脚本已停用', st.url ? shortUrl(st.url) : '当前页面不适用', 0);
          return;
        }
        if (count > 0) {
          setStateView('ok', '检测到 ' + count + ' 道题', shortUrl(st.url || (tab && tab.url) || ''), count);
        } else {
          setStateView('ok', '脚本就绪', '未检测到题目，可点击「立即扫描」', 0);
        }
      });
    });
  }

  function shortUrl(url) {
    if (!url) return '当前页面';
    try {
      var u = new URL(url);
      var p = u.pathname === '/' ? '' : u.pathname;
      var s = u.hostname + p;
      return s.length > 42 ? s.slice(0, 40) + '…' : s;
    } catch (e) {
      return url.length > 42 ? url.slice(0, 40) + '…' : url;
    }
  }

  /* ------------------------------------------------------------ 保存 */

  function save(patch) {
    var next = Settings.merge(state, patch);
    state = next;
    return Settings.save(patch).then(function (saved) {
      state = saved;
      renderModes();
      renderProfile();
      renderMaster(false);
      return saved;
    }).catch(function () {
      renderModes();
      renderProfile();
      renderMaster(false);
      return state;
    });
  }

  /* ------------------------------------------------------------ 动作 */

  /**
   * 直接把 AD_CMD 发给当前标签页的内容脚本。
   * 注意：popup 发出的 AD_CMD 只到后台，不会自动进页面，因此这里直连 tabs.sendMessage。
   */
  function sendTabCommand(cmd) {
    return getActiveTab().then(function (tab) {
      if (!tab || tab.id == null) return { ok: false, error: '没有可用的活动标签页' };
      if (!hasTabs || !chrome.tabs.sendMessage) return { ok: false, error: '当前环境不支持标签页通信' };
      var url = tab.url || '';
      if (/^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source):/i.test(url)) {
        return { ok: false, error: '当前页面不支持（请在普通网页上使用）' };
      }
      return new Promise(function (resolve) {
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'AD_CMD', cmd: cmd }, function (res) {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: '当前页面不支持（请在普通网页上使用）' });
              return;
            }
            resolve(res || { ok: true });
          });
        } catch (e) {
          resolve({ ok: false, error: '当前页面不支持（请在普通网页上使用）' });
        }
      });
    });
  }

  function bindActions() {
    var swAuto = $('#swAuto');
    var swPopup = $('#swPopup');
    var swHoverHint = $('#swHoverHint');
    var swAutoNextPage = $('#swAutoNextPage');
    var swHighlightNextPage = $('#swHighlightNextPage');
    if (swHighlightNextPage) swHighlightNextPage.addEventListener('change', function () {
      save({ mode: { highlightNextPage: swHighlightNextPage.checked } });
    });
    if (swAutoNextPage) swAutoNextPage.addEventListener('change', function () {
      var on = swAutoNextPage.checked;
      save({ mode: { autoNextPage: on } }).then(function () { toast(on ? '已开启自动翻页，成功填入后生效' : '已关闭自动翻页', 'ok'); });
    });
    if (swHoverHint) swHoverHint.addEventListener('change', function () {
      var on = swHoverHint.checked;
      save({ mode: { hoverHint: on } }).then(function () { toast(on ? '已显示题目角标' : '已隐藏题目角标', 'ok'); });
    });

    if (swAuto) {
      swAuto.addEventListener('change', function () {
        var on = swAuto.checked;
        save({ mode: { autoAnswer: on } }).then(function () {
          toast(on ? '已开启自动答题' : '已关闭自动答题', 'ok');
        });
      });
    }
    if (swPopup) {
      swPopup.addEventListener('change', function () {
        var on = swPopup.checked;
        save({ mode: { popup: on } }).then(function () {
          toast(on ? '已开启弹窗模式' : '已关闭弹窗模式', 'ok');
        });
      });
    }

    var scanBtn = $('#btnScan');
    if (scanBtn) {
      scanBtn.addEventListener('click', function () {
        if (!isEnabled()) { toast('总开关已关闭，请先启用', 'warn'); return; }
        if (!hasChrome) { toast('本地预览模式无法扫描', 'warn'); return; }
        var original = scanBtn.innerHTML;
        scanBtn.classList.add('is-busy');
        scanBtn.innerHTML = '<span class="dati-spinner"></span> 扫描中…';
        sendTabCommand('scan').then(function (res) {
          scanBtn.classList.remove('is-busy');
          scanBtn.innerHTML = original;
          if (res && res.ok === false) {
            toast(res.error || '当前页面不支持（请在普通网页上使用）', 'danger');
            setStateView('warn', '未连接', res.error || '内容脚本未注入', 0);
            return;
          }
          toast('已触发扫描', 'ok');
          setTimeout(refreshState, 700);
        });
      });
    }

    var capBtn = $('#btnCapture');
    if (capBtn) {
      capBtn.addEventListener('click', function () {
        if (!isEnabled()) { toast('总开关已关闭，请先启用', 'warn'); return; }
        if (!hasChrome) { toast('本地预览模式无法截图', 'warn'); return; }
        sendTabCommand('capture').then(function (res) {
          if (res && res.ok === false) {
            toast(res.error || '当前页面不支持（请在普通网页上使用）', 'danger');
            return;
          }
          toast('单击选题目，拖动框选区域', 'ok');
          setTimeout(function () {
            try { window.close(); } catch (e) { /* noop */ }
          }, 260);
        });
      });
    }

    var pickBtn = $('#btnPickTemplate');
    if (pickBtn) {
      pickBtn.addEventListener('click', function () {
        if (!isEnabled()) { toast('总开关已关闭，请先启用', 'warn'); return; }
        if (!hasChrome) { toast('本地预览模式无法拾取', 'warn'); return; }
        sendTabCommand('pick-template').then(function (res) {
          if (res && res.ok === false) {
            toast(res.error || '当前页面不支持（请在普通网页上使用）', 'danger');
            return;
          }
          toast('已进入拾取模式', 'ok');
          setTimeout(function () {
            try { window.close(); } catch (e) { /* noop */ }
          }, 260);
        });
      });
    }

    var optBtn = $('#btnOptions');
    if (optBtn) {
      optBtn.addEventListener('click', function () {
        if (hasChrome && chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
          try { window.close(); } catch (e) { /* noop */ }
          return;
        }
        if (hasTabs && chrome.tabs.create && chrome.runtime.getURL) {
          chrome.tabs.create({ url: chrome.runtime.getURL('ui/options.html') });
          return;
        }
        toast('本地预览模式无法打开设置页', 'warn');
      });
    }

    var switchBtn = $('#btnSwitchModel');
    if (switchBtn) {
      switchBtn.addEventListener('click', function () {
        if (hasChrome && chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
          return;
        }
        if (hasTabs && chrome.tabs.create && chrome.runtime.getURL) {
          chrome.tabs.create({ url: chrome.runtime.getURL('ui/options.html#api') });
          return;
        }
        toast('本地预览模式无法打开设置页', 'warn');
      });
    }

    var refreshBtn = $('#btnRefreshState');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        refreshState().then(function () { toast('状态已刷新', 'ok'); });
      });
    }
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    bindActions();
    bindMaster();

    // 本地预览（file:// 直接打开）时可用 ?preview=off / ?theme=light 查看不同状态，仅影响渲染
    var previewOff = !hasChrome && /(\?|&)preview=off(&|$)/.test(String(location.search || ''));
    var previewTheme = !hasChrome ? String(location.search || '').match(/[?&]theme=(dark|light|auto)(&|$)/) : null;
    if (previewOff) state = Settings.merge(state, { enabled: false });
    if (previewTheme) {
      state = Settings.merge(state, { ui: { theme: previewTheme[1] } });
      document.body.setAttribute('data-theme', previewTheme[1]);
    }

    renderProfile();
    renderModes();
    renderMaster(false);
    lastEnabled = isEnabled();

    if (!hasChrome) {
      setStateView('warn', '未连接扩展', '本地预览模式，状态不可用', 0);
    } else if (!isEnabled()) {
      setStateView('idle', '总开关已关闭', '打开总开关后才会检测题目', 0);
    } else {
      setStateView('busy', '正在读取状态…', '等待后台响应', '—');
    }

    Settings.subscribe(function (next) {
      var wasEnabled = lastEnabled;
      state = next;
      renderProfile();
      renderModes();
      renderMaster(false);
      lastEnabled = isEnabled();
      if (wasEnabled === false && isEnabled()) refreshState();
    });

    Settings.get().then(function (s) {
      state = s;
      if (previewOff) state = Settings.merge(state, { enabled: false });
      if (previewTheme) {
        state = Settings.merge(state, { ui: { theme: previewTheme[1] } });
        document.body.setAttribute('data-theme', previewTheme[1]);
      }
      lastEnabled = isEnabled();
      renderProfile();
      renderModes();
      renderMaster(false);
      if (hasChrome && isEnabled()) refreshState();
    }).catch(function () { /* 保持默认渲染 */ });

    if (hasChrome && isEnabled()) refreshState();

    // 监听来自后台的状态推送（若后台主动广播）
    if (hasChrome && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg.type !== 'AD_STATE_REPORT' || !msg.state) return;
        if (!isEnabled()) return;
        var st = msg.state;
        var count = Number(st.count || 0);
        if (count > 0) setStateView('ok', '检测到 ' + count + ' 道题', shortUrl(st.url || ''), count);
        else setStateView('ok', '脚本就绪', '未检测到题目', 0);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(globalThis.AD = globalThis.AD || {}));
