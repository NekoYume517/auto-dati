/**
 * AutoDati · 设置页逻辑
 * 经典脚本：依赖 AD（protocol.js / settings.js），不修改它们。
 * 在 file:// 直接打开（无 chrome API）时，AD.Settings 降级为内存默认值，页面仍完整渲染。
 */
(function (AD) {
  'use strict';

  if (!AD || !AD.Settings) return;

  var hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  var Settings = AD.Settings;

  /* ------------------------------------------------------------ 小工具 */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getPath(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function setPath(target, path, value) {
    var parts = path.split('.');
    var cur = target;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
    return target;
  }

  function num(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) n = fallback;
    if (typeof min === 'number') n = Math.max(min, n);
    if (typeof max === 'number') n = Math.min(max, n);
    return n;
  }

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function prettyBytes(n) {
    if (!isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ------------------------------------------------------------ 状态 */

  var state = Settings.snapshot();
  var editingId = (state.api && state.api.activeId) || 'p1';
  var ruleDraft = null;      // 正在编辑的自定义规则
  var ruleEditIndex = -1;    // -1 表示新增
  var resetArmed = 0;        // 恢复默认的二次确认计时
  var resetTimer = null;
  var previewPatch = null;   // file:// 预览参数（?preview=off / ?theme=light）

  /* ------------------------------------------------------------ Toast */

  var toastEl = $('#toast');
  var toastTimer = null;

  function toast(message, kind) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = 'dati-toast is-show' + (kind ? ' dati-toast--' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.className = 'dati-toast' + (kind ? ' dati-toast--' + kind : '');
    }, 2200);
  }

  /* ------------------------------------------------------------ 保存态 */

  var saveStateEl = $('#saveState');
  var saveStateText = saveStateEl ? $('.save-state__text', saveStateEl) : null;
  var saveStateTimer = null;

  function markSaving() {
    if (!saveStateEl) return;
    saveStateEl.classList.remove('is-error');
    saveStateEl.classList.add('is-saving');
    if (saveStateText) saveStateText.textContent = '保存中…';
  }

  function markSaved() {
    if (!saveStateEl) return;
    saveStateEl.classList.remove('is-saving', 'is-error');
    if (saveStateText) saveStateText.textContent = '已保存';
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(function () {
      if (saveStateText) saveStateText.textContent = '已加载';
    }, 1600);
  }

  function markError(msg) {
    if (!saveStateEl) return;
    saveStateEl.classList.remove('is-saving');
    saveStateEl.classList.add('is-error');
    if (saveStateText) saveStateText.textContent = msg || '保存失败';
  }

  /* ------------------------------------------------------------ 保存入口 */

  function save(patch, opts) {
    var next = Settings.merge(state, patch);
    state = next;
    markSaving();
    return Settings.save(patch).then(function (saved) {
      state = saved;
      markSaved();
      return saved;
    }).catch(function (err) {
      markError('保存失败');
      if (!opts || !opts.silent) toast('保存失败：' + (err && err.message ? err.message : err), 'danger');
      return state;
    });
  }

  /* ------------------------------------------------- 通用 data-path 绑定 */

  var debounceTimers = {};

  function readControl(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.type === 'range') return Number(el.value);
    return el.value;
  }

  function writeControl(el, value) {
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else if (value == null) {
      el.value = '';
    } else {
      el.value = String(value);
    }
    if (el.type === 'range') paintRange(el);
  }

  function paintRange(el) {
    var min = Number(el.min || 0);
    var max = Number(el.max || 100);
    var v = Number(el.value);
    var pct = max > min ? ((v - min) / (max - min)) * 100 : 50;
    el.style.setProperty('--range-progress', Math.max(0, Math.min(100, pct)) + '%');
  }

  function bindPaths() {
    $$('[data-path]').forEach(function (el) {
      var path = el.getAttribute('data-path');
      var evt = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'range') ? 'change' : 'input';

      function commit() {
        var value = readControl(el);
        if (el.type === 'number' || el.type === 'range') {
          value = num(value, Number(el.min) || undefined, Number(el.max) || undefined, 0);
        }
        var patch = {};
        setPath(patch, path, value);
        save(patch);
        if (el.type === 'range') paintRange(el);
        reflectDerived();
      }

      el.addEventListener(evt, function () {
        if (el.type === 'range') {
          paintRange(el);
          if (path === 'mode.scanDebounceMs' || path === 'mode.minIntervalMs') {
            // 数值型 range 无需去抖
          }
        }
        if (el.type === 'text' || el.tagName === 'TEXTAREA') {
          clearTimeout(debounceTimers[path]);
          debounceTimers[path] = setTimeout(commit, 320);
          // 立即更新本地副本，保证订阅回写不丢字
          var patch = {};
          setPath(patch, path, readControl(el));
          state = Settings.merge(state, patch);
          return;
        }
        commit();
      });

      el.addEventListener('blur', function () {
        if (el.type === 'text' || el.tagName === 'TEXTAREA') {
          clearTimeout(debounceTimers[path]);
          commit();
        }
      });
    });
  }

  function renderPaths() {
    $$('[data-path]').forEach(function (el) {
      if (el === document.activeElement) return;
      var v = getPath(state, el.getAttribute('data-path'));
      writeControl(el, v);
    });
    // 输出联动
    var tempOut = $('#pTempOut');
    var pTemp = $('#pTemp');
    if (tempOut && pTemp) tempOut.textContent = Number(pTemp.value).toFixed(2);
  }

  /* ------------------------------------------------------- 派生显示刷新 */

  function currentProfile() {
    var list = (state.api && state.api.profiles) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === state.api.activeId) return list[i];
    }
    return list[0] || null;
  }

  function editingProfile() {
    var list = (state.api && state.api.profiles) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === editingId) return list[i];
    }
    return list[0] || null;
  }

  function formatLabel(f) {
    return (AD.FORMAT_LABEL && AD.FORMAT_LABEL[f]) || f || '—';
  }

  function reflectDerived() {
    renderMaster();
    var p = currentProfile();
    var apiKeyMissing = !p || !p.apiKey;
    var apiTag = $('#navApiTag');
    if (apiTag) apiTag.classList.toggle('is-on', apiKeyMissing);

    // 概览统计
    var statModel = $('#statModel');
    var statFormat = $('#statFormat');
    if (statModel) statModel.textContent = (p && p.model) || '未设置';
    if (statFormat) statFormat.textContent = formatLabel(p && p.format);

    var sitePresets = (state.detect && state.detect.sitePresets) || {};
    var siteOn = $$('[data-site]').filter(function (el) { return sitePresets[el.getAttribute('data-site')] !== false; }).length;
    var rules = (state.detect && state.detect.customRules) || [];
    var rulesOn = rules.filter(function (rule) { return rule && rule.enabled !== false; }).length;
    var statPresets = $('#statPresets');
    if (statPresets) statPresets.textContent = String(siteOn + rulesOn);
    var statSites = $('#statSites');
    if (statSites) statSites.textContent = '已启用规则 ' + rulesOn + ' 条';
    var siteCount = $('#siteCount');
    if (siteCount) siteCount.textContent = siteOn + ' / ' + $$('[data-site]').length + ' 已启用';

    var modes = [];
    if (state.mode.autoAnswer) modes.push('自动答题');
    if (state.mode.popup) modes.push('弹窗');
    if (state.mode.autoNextPage) modes.push('自动翻页');
    var statMode = $('#statMode');
    if (statMode) statMode.textContent = modes.length ? modes.join(' + ') : '仅手动';

    var statHotkey = $('#statHotkey');
    if (statHotkey) {
      statHotkey.textContent = state.hotkey.enabled
        ? (state.hotkey.capture || '未设置') + ' 区域截图'
        : '页面快捷键已关闭';
    }

    // Hero 状态
    var heroTitle = $('#heroTitle');
    var heroDesc = $('#heroDesc');
    var heroBadge = $('#heroStateBadge');
    if (heroTitle && heroDesc && heroBadge) {
      if (apiKeyMissing) {
        heroTitle.textContent = '还差一步：填写 API 密钥';
        heroDesc.textContent = '当前配置「' + ((p && p.name) || '默认') + '」尚未设置密钥，检测与作答将无法请求模型。';
        heroBadge.textContent = '待配置';
        heroBadge.className = 'dati-badge dati-badge--dot dati-badge--warn';
      } else if (!state.mode.autoAnswer && !state.mode.popup) {
        heroTitle.textContent = '两种模式都未开启';
        heroDesc.textContent = '自动答题与弹窗模式均关闭时，只能通过快捷键手动触发。';
        heroBadge.textContent = '仅手动';
        heroBadge.className = 'dati-badge dati-badge--dot dati-badge--warn';
      } else {
        heroTitle.textContent = '准备就绪';
        heroDesc.textContent = '模型「' + ((p && p.model) || '—') + '」已配置，' +
          (state.mode.autoAnswer ? '自动答题已开启。' : '检测到题目时会弹出面板。');
        heroBadge.textContent = '运行中';
        heroBadge.className = 'dati-badge dati-badge--dot dati-badge--ok';
      }
    }

    // 存储信息
    var kvVersion = $('#kvVersion');
    if (kvVersion) kvVersion.textContent = String(state.version || 1);
    var kvSize = $('#kvSize');
    if (kvSize) {
      try { kvSize.textContent = prettyBytes(JSON.stringify(state).length * 2); }
      catch (e) { kvSize.textContent = '—'; }
    }
    var kvEnv = $('#kvEnv');
    if (kvEnv) kvEnv.textContent = hasChrome ? '扩展页面' : '本地预览';
    var metaEnv = $('#metaEnv');
    if (metaEnv) metaEnv.textContent = hasChrome ? '扩展环境' : '本地预览';

    renderEditorChrome();
  }

  /* ------------------------------------------------------------ 总开关 */

  function isEnabled() {
    return state.enabled !== false;
  }

  function renderMaster() {
    var on = isEnabled();
    var sw = $('#swMaster');
    if (sw && sw !== document.activeElement) sw.checked = on;

    var card = $('#masterCard');
    if (card) card.classList.toggle('is-off', !on);

    var view = $('.view[data-view="overview"]');
    if (view) view.classList.toggle('is-off', !on);

    var title = $('#masterTitle');
    if (title) title.textContent = on ? '扩展已启用' : '扩展已停用';

    var desc = $('#masterDesc');
    if (desc) {
      desc.textContent = on
        ? '检测、弹窗、自动答题与页面内快捷键全部正常工作。'
        : '已完全静默：不检测题目、不弹窗、不自动答题，页面内快捷键全部失效。';
    }

    var badge = $('#masterBadge');
    if (badge) {
      badge.className = 'dati-badge dati-badge--dot ' + (on ? 'dati-badge--ok' : '');
      badge.textContent = on ? '运行中' : '已停用';
    }
  }

  /* ------------------------------------------------------------ 导航 */

  var SETTING_VIEWS = ['behavior', 'feedback', 'hotkey', 'appearance', 'advanced', 'updates'];
  var VIEW_NAMES = ['overview', 'api', 'prompt', 'detect', 'statistics', 'data'].concat(SETTING_VIEWS);

  function activateView(name, animate) {
    if (VIEW_NAMES.indexOf(name) < 0) name = 'overview';
    var isSettings = SETTING_VIEWS.indexOf(name) >= 0;
    var settingsTabs = $('#settingsTabs');
    if (settingsTabs) settingsTabs.hidden = !isSettings;
    $$('[data-settings-tab]').forEach(function (tab) {
      var selected = tab.getAttribute('data-settings-tab') === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    var current = document.querySelector('[data-view="' + name + '"] h1');
    var breadcrumb = $('#currentSection');
    if (breadcrumb && current) breadcrumb.textContent = (isSettings ? '设置 / ' : '') + current.textContent;
    $$('.nav__item').forEach(function (b) {
      var active = b.getAttribute('data-nav') === name || (isSettings && b.getAttribute('data-nav') === 'behavior');
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $$('.view').forEach(function (v) {
      var on = v.getAttribute('data-view') === name;
      v.classList.toggle('is-active', on);
      v.classList.remove('is-enter');
      if (on && animate) {
        // 强制回流后重新加类，保证每次切换都能播放
        void v.offsetWidth;
        v.classList.add('is-enter');
      }
    });
    var main = $('#main');
    if (main) main.scrollTop = 0;
    try { sessionStorage.setItem('ad_options_view', name); } catch (e) { /* noop */ }
    try {
      if (location.hash !== '#' + name) {
        history.replaceState(null, '', '#' + name);
      }
    } catch (e) { /* file:// 下可能受限，忽略 */ }
    document.dispatchEvent(new CustomEvent('dati:viewchange', { detail: name }));
  }

  function viewFromHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    return VIEW_NAMES.indexOf(h) >= 0 ? h : null;
  }

  function bindNav() {
    $$('[data-settings-tab]').forEach(function (tab) {
      tab.addEventListener('click', function (event) { activateView(tab.getAttribute('data-settings-tab'), event.detail !== 0); });
      tab.addEventListener('keydown', function (event) {
        var index = SETTING_VIEWS.indexOf(tab.getAttribute('data-settings-tab'));
        var next = event.key === 'ArrowRight' ? (index + 1) % SETTING_VIEWS.length : event.key === 'ArrowLeft' ? (index + SETTING_VIEWS.length - 1) % SETTING_VIEWS.length : event.key === 'Home' ? 0 : event.key === 'End' ? SETTING_VIEWS.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); activateView(SETTING_VIEWS[next], false);
        $('[data-settings-tab="' + SETTING_VIEWS[next] + '"]').focus();
      });
    });
    $$('.nav__item').forEach(function (btn) {
      var name = btn.querySelector('span');
      if (name) { btn.setAttribute('aria-label', name.textContent); btn.title = name.textContent; }
      btn.addEventListener('click', function (event) {
        activateView(btn.getAttribute('data-nav'), event.detail !== 0);
      });
    });
    $$('[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function (event) {
        activateView(btn.getAttribute('data-goto'), event.detail !== 0);
      });
    });
  }

  /* -------------------------------------------------------- Provider 列表 */

  function providerItemHtml(p, isActive) {
    return '' +
      '<div class="provider-item' + (isActive ? ' is-active' : '') + '" data-provider="' + esc(p.id) + '" role="button" tabindex="0">' +
        '<span class="provider-item__dot"></span>' +
        '<div class="provider-item__body">' +
          '<span class="provider-item__name">' + esc(p.name || '未命名') + '</span>' +
          '<span class="provider-item__meta">' + esc(p.model || '—') + ' · ' + esc(formatLabel(p.format)) + '</span>' +
        '</div>' +
        '<div class="provider-item__actions">' +
          '<button class="dati-btn dati-btn--sm dati-btn--icon" type="button" data-act="dup" title="复制配置">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>' +
          '</button>' +
          '<button class="dati-btn dati-btn--sm dati-btn--icon" type="button" data-act="del" title="删除配置">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>';
  }

  function renderProviders() {
    var host = $('#providerList');
    if (!host) return;
    var list = (state.api && state.api.profiles) || [];
    host.innerHTML = list.map(function (p) {
      return providerItemHtml(p, p.id === state.api.activeId);
    }).join('');
  }

  function bindProviderList() {
    var host = $('#providerList');
    if (!host) return;
    host.addEventListener('click', function (ev) {
      var actBtn = ev.target.closest ? ev.target.closest('[data-act]') : null;
      var item = ev.target.closest ? ev.target.closest('[data-provider]') : null;
      if (!item) return;
      var id = item.getAttribute('data-provider');

      if (actBtn) {
        ev.stopPropagation();
        var act = actBtn.getAttribute('data-act');
        if (act === 'del') deleteProvider(id);
        else if (act === 'dup') duplicateProvider(id);
        return;
      }
      selectProvider(id);
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var item = ev.target.closest ? ev.target.closest('[data-provider]') : null;
      if (!item) return;
      ev.preventDefault();
      selectProvider(item.getAttribute('data-provider'));
    });
  }

  function selectProvider(id) {
    editingId = id;
    save({ api: { activeId: id } }).then(function () {
      renderProviders();
      renderEditor();
      reflectDerived();
    });
  }

  function newId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function duplicateProvider(id) {
    var list = clone(state.api.profiles);
    var src = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) src = list[i];
    if (!src) return;
    var copy = clone(src);
    copy.id = newId();
    copy.name = (src.name || '配置') + ' 副本';
    copy.lastTest = null;
    list.push(copy);
    editingId = copy.id;
    save({ api: { profiles: list, activeId: copy.id } }).then(function () {
      renderProviders();
      renderEditor();
      reflectDerived();
      toast('已复制配置', 'ok');
    });
  }

  function deleteProvider(id) {
    var list = clone(state.api.profiles);
    if (list.length <= 1) {
      toast('至少保留一个配置', 'danger');
      return;
    }
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) idx = i;
    if (idx < 0) return;
    var removed = list[idx];
    list.splice(idx, 1);
    var nextActive = state.api.activeId === id ? list[0].id : state.api.activeId;
    editingId = nextActive;
    save({ api: { profiles: list, activeId: nextActive } }).then(function () {
      renderProviders();
      renderEditor();
      reflectDerived();
      toast('已删除「' + (removed.name || '配置') + '」', 'ok');
    });
  }

  function addProvider() {
    var list = clone(state.api.profiles);
    var p = {
      id: newId(),
      name: '新配置',
      format: 'openai-chat',
      baseUrl: (AD.FORMAT_BASE_HINT && AD.FORMAT_BASE_HINT['openai-chat']) || 'https://api.openai.com/v1',
      path: '',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 2048,
      stream: true,
      vision: true,
      extraHeaders: {},
      extraBody: {},
      timeoutMs: 60000,
      lastTest: null
    };
    list.push(p);
    editingId = p.id;
    save({ api: { profiles: list, activeId: p.id } }).then(function () {
      renderProviders();
      renderEditor();
      reflectDerived();
      var nameEl = $('#pName');
      if (nameEl) { nameEl.focus(); nameEl.select(); }
      toast('已新增配置', 'ok');
    });
  }

  /* -------------------------------------------------------- Provider 编辑 */

  function renderEditorChrome() {
    var label = $('#editorIdLabel');
    if (!label) return;
    var p = editingProfile();
    if (!p) { label.textContent = ''; return; }
    label.textContent = p.id === state.api.activeId ? '当前使用' : '未启用';
    label.className = 'dati-card__aside';
  }

  function renderEditor() {
    var p = editingProfile();
    if (!p) return;
    var fields = {
      name: $('#pName'),
      format: $('#pFormat'),
      baseUrl: $('#pBaseUrl'),
      path: $('#pPath'),
      model: $('#pModel'),
      apiKey: $('#pApiKey'),
      temperature: $('#pTemp'),
      maxTokens: $('#pMaxTokens'),
      timeoutMs: $('#pTimeout'),
      stream: $('[data-prop="stream"]'),
      vision: $('[data-prop="vision"]'),
      extraHeaders: $('#pHeaders'),
      extraBody: $('#pBody')
    };

    Object.keys(fields).forEach(function (k) {
      var el = fields[k];
      if (!el || el === document.activeElement) return;
      var v = p[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (k === 'extraHeaders' || k === 'extraBody') el.value = JSON.stringify(v || {}, null, 2);
      else if (v == null) el.value = '';
      else el.value = String(v);
    });

    var tempOut = $('#pTempOut');
    if (tempOut) tempOut.textContent = Number(p.temperature || 0).toFixed(2);
    if (fields.temperature) paintRange(fields.temperature);

    var hint = $('#pBaseHint');
    if (hint) {
      var def = (AD.FORMAT_BASE_HINT && AD.FORMAT_BASE_HINT[p.format]) || '';
      var defPath = (AD.FORMAT_DEFAULT_PATH && AD.FORMAT_DEFAULT_PATH[p.format]) || '';
      hint.textContent = '格式默认：' + def + (defPath ? '　路径 ' + defPath : '');
    }

    var pathEl = $('#pPath');
    if (pathEl) {
      var dp = (AD.FORMAT_DEFAULT_PATH && AD.FORMAT_DEFAULT_PATH[p.format]) || '';
      pathEl.placeholder = dp || '/chat/completions';
    }

    renderModelList(p.format);
    renderLastTest(p);
    renderEditorChrome();
  }

  function renderModelList(format) {
    var dl = $('#modelList');
    var models = (AD.FORMAT_MODELS && AD.FORMAT_MODELS[format]) || [];
    if (dl) {
      dl.innerHTML = models.map(function (m) {
        return '<option value="' + esc(m) + '"></option>';
      }).join('');
    }
    renderModelChips(models);
  }

  function renderModelChips(models) {
    var host = $('#modelChips');
    if (!host) return;
    var p = editingProfile();
    var cur = (p && p.model) || '';
    host.innerHTML = models.map(function (m) {
      return '<button class="dati-chip' + (m === cur ? ' is-on' : '') + '" type="button" data-model="' +
        esc(m) + '">' + esc(m) + '</button>';
    }).join('');
  }

  function bindModelChips() {
    var host = $('#modelChips');
    if (!host) return;
    host.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-model]') : null;
      if (!btn) return;
      var model = btn.getAttribute('data-model');
      var input = $('#pModel');
      if (input) input.value = model;
      updateProfileField('model', model).then(function () {
        renderModelChips((AD.FORMAT_MODELS && AD.FORMAT_MODELS[editingProfile().format]) || []);
      });
    });
  }

  function bindPromptTabs() {
    var tabs = $('#promptTabs');
    if (!tabs) return;
    tabs.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-ptab]') : null;
      if (!btn) return;
      var key = btn.getAttribute('data-ptab');
      $$('.dati-tab', tabs).forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-ptab') === key);
      });
      $$('[data-ptab-panel]').forEach(function (panel) {
        panel.classList.toggle('is-active', panel.getAttribute('data-ptab-panel') === key);
      });
    });
  }

  function renderLastTest(p) {
    var host = $('#testResult');
    if (!host) return;
    var lt = p && p.lastTest;
    if (!lt) {
      host.innerHTML = '<span class="dati-hint">尚未测试。将发送一条极短的问候请求。</span>';
      return;
    }
    var when = '';
    try { when = new Date(lt.at).toLocaleString(); } catch (e) { when = ''; }
    if (lt.ok) {
      host.innerHTML = '' +
        '<div class="test-result__head"><span class="dati-badge dati-badge--ok dati-badge--dot">连接正常</span>' +
        '<span class="dati-hint">' + esc(lt.ms) + ' ms · ' + esc(when) + '</span></div>' +
        '<pre class="test-result__body">' + esc(lt.text || '（空响应）') + '</pre>';
    } else {
      host.innerHTML = '' +
        '<div class="test-result__head"><span class="dati-badge dati-badge--danger dati-badge--dot">测试失败</span>' +
        '<span class="dati-hint">' + esc(when) + '</span></div>' +
        '<pre class="test-result__body">' + esc(lt.error || '未知错误') + '</pre>';
    }
  }

  function updateProfileField(prop, value) {
    var list = clone(state.api.profiles);
    var hit = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === editingId) hit = list[i];
    if (!hit) return Promise.resolve();
    hit[prop] = value;
    return save({ api: { profiles: list } }).then(function () {
      renderProviders();
      reflectDerived();
    });
  }

  function bindProviderEditor() {
    $$('[data-prop]').forEach(function (el) {
      var prop = el.getAttribute('data-prop');

      function commit() {
        var value;
        if (el.type === 'checkbox') value = el.checked;
        else if (el.type === 'number' || el.type === 'range') value = num(el.value, Number(el.min) || undefined, Number(el.max) || undefined, 0);
        else value = el.value;

        if (prop === 'extraHeaders' || prop === 'extraBody') {
          var parsed = parseJsonObject(el.value);
          var hintEl = prop === 'extraHeaders' ? $('#pHeadersHint') : $('#pBodyHint');
          if (!parsed.ok) {
            el.classList.add('is-invalid');
            if (hintEl) {
              hintEl.textContent = 'JSON 解析失败：' + parsed.error;
              hintEl.className = 'dati-hint dati-hint--danger';
            }
            return;
          }
          el.classList.remove('is-invalid');
          if (hintEl) {
            hintEl.textContent = '键值对对象，会合并到' + (prop === 'extraHeaders' ? '请求头' : '请求体') + '。';
            hintEl.className = 'dati-hint';
          }
          value = parsed.value;
        }

        if (prop === 'format') {
          var hint = AD.FORMAT_BASE_HINT && AD.FORMAT_BASE_HINT[value];
          var cur = editingProfile();
          var patchExtra = {};
          if (cur && hint && (!cur.baseUrl || cur.baseUrl === AD.FORMAT_BASE_HINT[cur.format])) {
            patchExtra.baseUrl = hint;
          }
          var list = clone(state.api.profiles);
          for (var i = 0; i < list.length; i++) {
            if (list[i].id !== editingId) continue;
            list[i].format = value;
            if (patchExtra.baseUrl) list[i].baseUrl = patchExtra.baseUrl;
            var defModels = (AD.FORMAT_MODELS && AD.FORMAT_MODELS[value]) || [];
            if (defModels.length && defModels.indexOf(list[i].model) < 0) list[i].model = defModels[0];
          }
          save({ api: { profiles: list } }).then(function () {
            renderProviders();
            renderEditor();
            reflectDerived();
          });
          return;
        }

        if (el.type === 'range') paintRange(el);
        if (prop === 'temperature') {
          var out = $('#pTempOut');
          if (out) out.textContent = Number(value).toFixed(2);
        }
        updateProfileField(prop, value);
      }

      if (prop === 'extraHeaders' || prop === 'extraBody' || prop === 'baseUrl' || prop === 'path' ||
          prop === 'apiKey' || prop === 'model' || prop === 'name') {
        el.addEventListener('input', function () {
          clearTimeout(debounceTimers['prop:' + prop]);
          debounceTimers['prop:' + prop] = setTimeout(commit, 380);
        });
        el.addEventListener('blur', function () {
          clearTimeout(debounceTimers['prop:' + prop]);
          commit();
        });
      } else {
        el.addEventListener('change', commit);
      }
      if (el.type === 'range') paintRange(el);
    });
  }

  function parseJsonObject(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return { ok: true, value: {} };
    try {
      var v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, error: '必须是 JSON 对象' };
      }
      return { ok: true, value: v };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ------------------------------------------------------- Supplier models */

  function bindModelPicker() {
    var button = $('#btnFetchModels');
    var dialog = $('#modelsDialog');
    if (!button || !dialog) return;
    var models = [], selected = '', profile = null, generation = 0, loading = false;
    var search = $('#modelsSearch'), list = $('#modelsList'), count = $('#modelsCount');
    var use = $('#btnUseModel'), refresh = $('#btnRefreshModels');

    function updateSelection() {
      $('#modelsSelected').textContent = selected || '尚未选择模型';
      use.disabled = loading || !selected;
    }

    function render() {
      var query = search.value.trim().toLowerCase();
      var filtered = models.filter(function (model) {
        return (model.id + ' ' + model.name + ' ' + model.owner).toLowerCase().indexOf(query) >= 0;
      });
      list.replaceChildren();
      count.textContent = query ? filtered.length + ' / ' + models.length + ' 个模型' : models.length + ' 个可用模型';
      if (!filtered.length) {
        var empty = document.createElement('div');
        empty.className = 'models-empty';
        empty.textContent = query ? '没有找到匹配的模型，试试其他关键词。' : '供应商尚未返回可用模型，你仍可手动填写模型 ID。';
        list.appendChild(empty);
      }
      filtered.forEach(function (model) {
        var row = document.createElement('label');
        row.className = 'model-option';
        var radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'supplier-model'; radio.value = model.id;
        radio.checked = selected === model.id;
        var content = document.createElement('span'); content.className = 'model-option__body';
        var name = document.createElement('strong'); name.textContent = model.name || model.id;
        var detail = document.createElement('span'); detail.textContent = model.owner ? model.id + ' · ' + model.owner : model.id;
        content.append(name, detail);
        row.append(radio, content);
        list.appendChild(row);
      });
      updateSelection();
    }

    function showError(message) {
      list.replaceChildren();
      var box = document.createElement('div'); box.className = 'models-empty models-empty--error';
      box.textContent = message;
      list.appendChild(box);
      count.textContent = '获取失败';
      selected = ''; updateSelection();
    }

    function load() {
      var token = ++generation;
      loading = true;
      models = [];
      refresh.disabled = true;
      list.setAttribute('aria-busy', 'true');
      list.innerHTML = '<div class="models-empty"><span class="dati-spinner"></span><span>正在连接供应商，读取模型列表…</span></div>';
      count.textContent = '正在获取模型…';
      updateSelection();
      function finish(result) {
        if (token !== generation || !dialog.open) return;
        loading = false;
        refresh.disabled = false;
        list.setAttribute('aria-busy', 'false');
        if (!result || !result.ok) return showError(result && result.error || '后台无响应，请重新获取');
        models = Array.isArray(result.models) ? result.models : [];
        if (!models.some(function (model) { return model.id === selected; })) selected = '';
        render();
        if (result.warning) count.textContent += ' · ' + result.warning;
      }
      if (!hasChrome) return finish({ ok: false, error: '请在浏览器扩展的设置页中获取模型，本地文件预览不发送请求。' });
      try {
        chrome.runtime.sendMessage({ type: AD.MSG.LIST_PROVIDER_MODELS, profile: profile }, function (result) {
          if (token !== generation || !dialog.open) return;
          if (chrome.runtime.lastError) return finish({ ok: false, error: '无法连接扩展后台，请重新加载扩展后再试' });
          finish(result);
        });
      } catch (e) { finish({ ok: false, error: '无法请求模型列表，请重新获取' }); }
    }

    button.addEventListener('click', function () {
      var current = editingProfile();
      if (!current) return;
      var headers = parseJsonObject($('#pHeaders').value);
      if (!headers.ok) return toast('请先修正附加请求头的 JSON 格式', 'warn');
      profile = Object.assign({}, clone(current), { baseUrl: $('#pBaseUrl').value.trim(), apiKey: $('#pApiKey').value.trim(),
        format: $('#pFormat').value, extraHeaders: headers.value });
      if (!profile.apiKey) return toast('请先填写 API Key', 'warn');
      var endpoint;
      try {
        endpoint = new URL(profile.baseUrl);
        if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error();
      } catch (e) { return toast('请先填写有效的 Base URL', 'warn'); }
      $('#modelsSource').textContent = endpoint.origin + endpoint.pathname.replace(/\/+$/, '').replace(/\/models$/, '') + '/models';
      search.value = '';
      selected = current.model || '';
      dialog.showModal();
      search.focus({ preventScroll: true });
      load();
    });
    search.addEventListener('input', function () { if (!loading) render(); });
    list.addEventListener('change', function (event) {
      if (event.target.name !== 'supplier-model') return;
      selected = event.target.value;
      updateSelection();
    });
    $('#btnCloseModels').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('close', function () { if (!dialog.open) { generation++; loading = false; } });
    dialog.addEventListener('click', function (event) {
      if (event.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    refresh.addEventListener('click', load);
    use.addEventListener('click', function () {
      if (!selected || loading || !profile) return;
      if (editingId !== profile.id) { showError('当前配置已变化，请关闭后重新获取模型'); return; }
      clearTimeout(debounceTimers['prop:model']);
      $('#pModel').value = selected;
      use.disabled = true;
      var chosen = selected;
      updateProfileField('model', chosen).then(function () {
        renderEditor();
        dialog.close();
        button.focus({ preventScroll: true });
        toast('已使用模型 ' + chosen, 'ok');
      }).catch(function () { use.disabled = false; toast('模型保存失败，请重试', 'danger'); });
    });
  }

  function bindKeyToggle() {
    var btn = $('#btnToggleKey');
    var input = $('#pApiKey');
    if (!btn || !input) return;
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('is-on', show);
    });
  }

  /* ---------------------------------------------------------- 测试连接 */

  function bindTest() {
    var btn = $('#btnTest');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var p = editingProfile();
      if (!p) return;
      var host = $('#testResult');
      var profile = clone(p);
      profile.extraHeaders = parseJsonObject($('#pHeaders') ? $('#pHeaders').value : '{}').value || {};
      profile.extraBody = parseJsonObject($('#pBody') ? $('#pBody').value : '{}').value || {};

      if (!profile.apiKey) {
        if (host) host.innerHTML = '<span class="dati-hint dati-hint--warn">请先填写 API Key 再测试。</span>';
        toast('缺少 API Key', 'warn');
        return;
      }

      var original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="dati-spinner"></span> 测试中…';
      if (host) host.innerHTML = '<span class="dati-hint">正在发送测试请求…</span>';
      var started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

      function finish(result) {
        var elapsed = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started);
        btn.disabled = false;
        btn.innerHTML = original;
        var lastTest = {
          ok: !!result.ok,
          ms: result.ms || elapsed,
          text: result.text || '',
          error: result.error || '',
          at: Date.now()
        };
        updateProfileField('lastTest', lastTest).then(function () {
          renderLastTest({ lastTest: lastTest });
        });
        if (lastTest.ok) toast('连接正常 · ' + lastTest.ms + ' ms', 'ok');
        else toast('测试失败', 'danger');
      }

      if (!hasChrome || !chrome.runtime.sendMessage) {
        finish({
          ok: false,
          ms: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started),
          error: '当前页面未连接扩展宿主（本地预览模式）。请在浏览器扩展环境中打开设置页后再测试。'
        });
        return;
      }

      try {
        chrome.runtime.sendMessage({ type: 'AD_TEST_PROVIDER', profile: profile }, function (res) {
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (!res) {
            finish({ ok: false, error: '后台无响应' });
            return;
          }
          finish(res);
        });
      } catch (e) {
        finish({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
  }

  /* ------------------------------------------------------------ 预设开关 */

  function bindPresets() {
    $$('[data-site]').forEach(function (el) {
      el.addEventListener('change', function () {
        var key = el.getAttribute('data-site');
        var patch = { detect: { sitePresets: {} } };
        patch.detect.sitePresets[key] = el.checked;
        save(patch).then(reflectDerived);
      });
    });
  }

  function renderPresets() {
    var sites = (state.detect && state.detect.sitePresets) || {};
    $$('[data-site]').forEach(function (el) {
      el.checked = sites[el.getAttribute('data-site')] !== false;
    });
  }

  /* ------------------------------------------------------------ 自定义规则 */

  function renderRules() {
    var host = $('#ruleList');
    if (!host) return;
    var rules = (state.detect && state.detect.customRules) || [];
    if (!rules.length) {
      host.innerHTML = '<div class="dati-empty"><strong>还没有自定义站点规则</strong><span>添加目标站点的题块与选项选择器，也可以导入别人分享的 Base64 规则。</span></div>';
      return;
    }
    host.innerHTML = rules.map(function (r, i) {
      return '' +
        '<div class="rule-item' + (r.enabled === false ? ' is-off' : '') + '" data-rule-index="' + i + '">' +
          '<label class="dati-switch"><input type="checkbox" data-rule-toggle="' + i + '"' + (r.enabled === false ? '' : ' checked') + '></label>' +
          '<div class="rule-item__main">' +
            '<span class="rule-item__name">' + esc(r.name || '未命名规则') +
              '<span class="dati-badge">' + esc((AD.KIND_LABEL && AD.KIND_LABEL[r.kind]) || r.kind || '—') + '</span>' +
            '</span>' +
            '<span class="rule-item__sel">' + esc(r.rootSelector || '（未设置容器）') +
              (r.stemSelector ? ' › ' + esc(r.stemSelector) : '') + '</span>' +
            (r.domains && r.domains.length ? '<span class="rule-item__sel">🌐 ' + esc(Array.isArray(r.domains) ? r.domains.join(', ') : r.domains) + '</span>' : '') +
            (r.nextPageSelector ? '<span class="rule-item__sel">翻页' + (r.nextPageEnabled === false ? '（已停用）' : '') + '：' + esc(r.nextPageSelector) + '</span>' : '') +
          '</div>' +
          '<div class="rule-item__actions">' +
            '<button class="dati-btn dati-btn--sm" type="button" data-rule-act="edit" data-rule-index="' + i + '">编辑</button>' +
            '<button class="dati-btn dati-btn--sm dati-btn--danger dati-btn--icon" type="button" data-rule-act="del" data-rule-index="' + i + '" title="删除规则">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>';
    }).join('');
  }

  function openRuleEditor(index) {
    var rules = (state.detect && state.detect.customRules) || [];
    ruleEditIndex = typeof index === 'number' ? index : -1;
    var r = ruleEditIndex >= 0 ? rules[ruleEditIndex] : {
      name: '', kind: 'choice', rootSelector: '', stemSelector: '',
      optionSelector: '', inputSelector: '', domains: '', enabled: true
    };
    ruleDraft = clone(r);
    var editor = $('#ruleEditor');
    if (!editor) return;
    editor.classList.remove('is-hidden');
    if (!editor.open) editor.showModal();
    $('#ruleName').value = r.name || '';
    $('#ruleKind').value = r.kind || 'choice';
    $('#ruleRoot').value = r.rootSelector || '';
    $('#ruleStem').value = r.stemSelector || '';
    $('#ruleOption').value = r.optionSelector || '';
    $('#ruleInput').value = r.inputSelector || '';
    $('#ruleNextPage').value = r.nextPageSelector || '';
    $('#ruleNextPageEnabled').checked = r.nextPageEnabled !== false;
    $('#ruleDomains').value = Array.isArray(r.domains) ? r.domains.join(', ') : (r.domains || '');
    $('#ruleEnabled').checked = r.enabled !== false;
    $('#ruleName').focus();
  }

  function closeRuleEditor() {
    var editor = $('#ruleEditor');
    if (editor) { editor.close(); editor.classList.add('is-hidden'); }
    ruleDraft = null;
    ruleEditIndex = -1;
  }

  function saveRule() {
    var name = ($('#ruleName').value || '').trim();
    var root = ($('#ruleRoot').value || '').trim();
    if (!name) { toast('请填写规则名称', 'warn'); $('#ruleName').focus(); return; }
    if (!root) { toast('请填写题块容器选择器', 'warn'); $('#ruleRoot').focus(); return; }
    var nextSelector = ($('#ruleNextPage').value || '').trim();
    if (nextSelector) {
      try { document.querySelector(nextSelector); }
      catch (e) { toast('下一页按钮选择器语法有误', 'warn'); $('#ruleNextPage').focus(); return; }
    }

    var domainsRaw = ($('#ruleDomains').value || '').trim();
    var rule = {
      id: (ruleDraft && ruleDraft.id) || ('r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
      name: name,
      kind: $('#ruleKind').value,
      rootSelector: root,
      stemSelector: ($('#ruleStem').value || '').trim(),
      optionSelector: ($('#ruleOption').value || '').trim(),
      inputSelector: ($('#ruleInput').value || '').trim(),
      nextPageSelector: nextSelector,
      nextPageEnabled: !!$('#ruleNextPageEnabled').checked,
      domains: domainsRaw ? domainsRaw.split(/[,\n;]+/).map(function (s) { return s.trim(); }).filter(Boolean) : '',
      enabled: !!$('#ruleEnabled').checked
    };

    var rules = clone((state.detect && state.detect.customRules) || []);
    if (ruleEditIndex >= 0) rules[ruleEditIndex] = rule;
    else rules.push(rule);

    save({ detect: { customRules: rules } }).then(function () {
      renderRules();
      closeRuleEditor();
      toast(ruleEditIndex >= 0 ? '规则已更新' : '规则已添加', 'ok');
    });
  }

  function bindRules() {
    var addBtn = $('#btnAddRule');
    if (addBtn) addBtn.addEventListener('click', function () { openRuleEditor(-1); });
    var cancelBtn = $('#btnRuleCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeRuleEditor);
    var saveBtn = $('#btnRuleSave');
    if (saveBtn) saveBtn.addEventListener('click', saveRule);

    var host = $('#ruleList');
    if (host) {
      host.addEventListener('click', function (ev) {
        var actBtn = ev.target.closest ? ev.target.closest('[data-rule-act]') : null;
        if (!actBtn) return;
        var idx = Number(actBtn.getAttribute('data-rule-index'));
        var act = actBtn.getAttribute('data-rule-act');
        var rules = clone((state.detect && state.detect.customRules) || []);
        if (act === 'edit') { openRuleEditor(idx); return; }
        if (act === 'del') {
          var removed = rules[idx];
          rules.splice(idx, 1);
          save({ detect: { customRules: rules } }).then(function () {
            renderRules();
            if (ruleEditIndex === idx) closeRuleEditor();
            toast('已删除「' + ((removed && removed.name) || '规则') + '」', 'ok');
          });
        }
      });

      host.addEventListener('change', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute || t.getAttribute('data-rule-toggle') == null) return;
        var idx = Number(t.getAttribute('data-rule-toggle'));
        var rules = clone((state.detect && state.detect.customRules) || []);
        if (!rules[idx]) return;
        rules[idx].enabled = !!t.checked;
        save({ detect: { customRules: rules } }).then(renderRules);
      });
    }

    var transfer = $('#ruleTransfer');
    var transferText = $('#ruleTransferText');
    var transferStatus = $('#ruleTransferStatus');
    var exportBtn = $('#btnExportRules');
    var toggleImportBtn = $('#btnToggleRuleImport');
    var copyBtn = $('#btnCopyRules');
    var applyBtn = $('#btnApplyRules');
    if (toggleImportBtn && transfer) toggleImportBtn.addEventListener('click', function () {
      transfer.classList.toggle('is-hidden');
      if (!transfer.classList.contains('is-hidden')) transferText.focus();
    });
    if (exportBtn && transfer && transferText) exportBtn.addEventListener('click', function () {
      var payload = { format: 'autodati-custom-site-rules', version: 1, rules: clone((state.detect && state.detect.customRules) || []) };
      var bytes = new TextEncoder().encode(JSON.stringify(payload));
      var binary = '';
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      transferText.value = btoa(binary);
      transfer.classList.remove('is-hidden');
      transferText.focus();
      transferText.select();
      if (transferStatus) transferStatus.textContent = '已生成 ' + payload.rules.length + ' 条自定义规则编码，可复制或直接点「复制编码」。';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(transferText.value).then(function () {
          if (transferStatus) transferStatus.textContent = '编码已生成并复制到剪贴板。';
        }).catch(function () { /* 仍保留在文本框供手动复制 */ });
      }
    });
    if (copyBtn && transferText) copyBtn.addEventListener('click', function () {
      if (!transferText.value.trim()) {
        if (transferStatus) transferStatus.textContent = '先点「导出编码」生成当前规则。';
        return;
      }
      transferText.focus();
      transferText.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(transferText.value).then(function () {
          if (transferStatus) transferStatus.textContent = '编码已复制。';
        }).catch(function () { document.execCommand('copy'); });
      } else {
        document.execCommand('copy');
        if (transferStatus) transferStatus.textContent = '编码已复制。';
      }
    });
    if (applyBtn && transferText) applyBtn.addEventListener('click', function () {
      var encoded = transferText.value.replace(/\s+/g, '');
      if (!encoded) { if (transferStatus) transferStatus.textContent = '请先粘贴 Base64 编码。'; return; }
      if (encoded.length > 2800000) { if (transferStatus) transferStatus.textContent = '编码过长，无法导入。'; return; }
      var incoming;
      try {
        var binary = atob(encoded);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        incoming = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        if (transferStatus) transferStatus.textContent = '编码无效或内容不是合法 JSON。';
        return;
      }
      if (!incoming || incoming.format !== 'autodati-custom-site-rules' || incoming.version !== 1 || !Array.isArray(incoming.rules)) {
        if (transferStatus) transferStatus.textContent = '编码格式不受支持，需使用 AutoDati 自定义站点规则编码。';
        return;
      }
      var validKinds = ['auto', 'choice', 'multi', 'judge', 'blank', 'qa', 'generic'];
      var cleaned = [];
      for (var j = 0; j < incoming.rules.length; j++) {
        var r = incoming.rules[j];
        if (!r || typeof r !== 'object' || typeof r.rootSelector !== 'string' || !r.rootSelector.trim() || r.rootSelector.length > 500 || validKinds.indexOf(r.kind) < 0) {
          if (transferStatus) transferStatus.textContent = '第 ' + (j + 1) + ' 条规则缺少有效题块选择器或题型，未导入。';
          return;
        }
        var domains = r.domains;
        if (Array.isArray(domains)) domains = domains.slice(0, 100).map(function (d) { return String(d).slice(0, 300); });
        else if (typeof domains === 'string') domains = domains.slice(0, 2000);
        else domains = '';
        cleaned.push({
          id: typeof r.id === 'string' && r.id.length < 120 ? r.id : ('r_' + Date.now().toString(36) + j),
          name: String(r.name || '导入规则 ' + (j + 1)).slice(0, 120),
          kind: r.kind,
          rootSelector: r.rootSelector.trim(),
          stemSelector: typeof r.stemSelector === 'string' ? r.stemSelector.slice(0, 500) : '',
          optionSelector: typeof r.optionSelector === 'string' ? r.optionSelector.slice(0, 500) : '',
          inputSelector: typeof r.inputSelector === 'string' ? r.inputSelector.slice(0, 500) : '',
          nextPageSelector: typeof r.nextPageSelector === 'string' ? r.nextPageSelector.slice(0, 500) : '',
          nextPageEnabled: r.nextPageEnabled !== false,
          domains: domains,
          enabled: r.enabled !== false
        });
      }
      var merged = clone((state.detect && state.detect.customRules) || []);
      var ids = new Set(merged.map(function (r) { return r && r.id; }).filter(Boolean));
      var added = 0;
      cleaned.forEach(function (rule) {
        if (ids.has(rule.id)) return;
        ids.add(rule.id);
        merged.push(rule);
        added++;
      });
      save({ detect: { customRules: merged } }).then(function () {
        renderRules();
        reflectDerived();
        if (transferStatus) transferStatus.textContent = '导入完成：新增 ' + added + ' 条，跳过重复 ' + (cleaned.length - added) + ' 条。';
        toast('自定义站点规则已合并导入', 'ok');
      });
    });
  }

  /* ------------------------------------------------------------ 快捷键录制 */

  var HOTKEY_META = {
    Escape: 'Esc',
    ' ': 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Backspace: 'Backspace',
    Delete: 'Del',
    Enter: 'Enter',
    Tab: 'Tab'
  };

  var MODIFIER_KEYS = { Alt: 1, Control: 1, Shift: 1, Meta: 1 };

  function keyName(ev) {
    var k = ev.key;
    if (!k) return '';
    if (k === ' ') return 'Space';
    if (HOTKEY_META[k]) return HOTKEY_META[k];
    if (k.length === 1) return k.toUpperCase();
    if (/^F\d{1,2}$/.test(k)) return k;
    return k;
  }

  function comboFromEvent(ev) {
    var parts = [];
    if (ev.ctrlKey) parts.push('Ctrl');
    if (ev.altKey) parts.push('Alt');
    if (ev.shiftKey) parts.push('Shift');
    if (ev.metaKey) parts.push('Meta');
    var k = keyName(ev);
    if (!k || MODIFIER_KEYS[ev.key]) return { parts: parts, key: '', combo: '' };
    parts.push(k);
    return { parts: parts, key: k, combo: parts.join('+') };
  }

  function renderHotkeyBox(box, combo, recording) {
    var keysEl = $('.hotkey-input__keys', box);
    if (!keysEl) return;
    if (recording) {
      keysEl.innerHTML = '<span class="hotkey-input__empty"><span class="rec-dot"></span>按下组合键…</span>';
      return;
    }
    if (!combo) {
      keysEl.innerHTML = '<span class="hotkey-input__empty">未设置</span>';
      return;
    }
    var parts = String(combo).split('+').filter(Boolean);
    keysEl.innerHTML = parts.map(function (p) {
      return '<span class="dati-kbd">' + esc(p) + '</span>';
    }).join('<span class="hotkey-input__plus">+</span>');
  }

  function renderHotkeys() {
    $$('.hotkey-input').forEach(function (box) {
      var key = box.getAttribute('data-hotkey');
      var combo = getPath(state, 'hotkey.' + key);
      renderHotkeyBox(box, combo, box.classList.contains('is-recording'));
    });
  }

  function bindHotkeys() {
    var enabled = $('[data-path="hotkey.enabled"]');
    $$('.hotkey-input').forEach(function (box) {
      var key = box.getAttribute('data-hotkey');
      var recording = false;
      var pending = null;

      function start() {
        if (recording) return;
        recording = true;
        pending = null;
        box.classList.add('is-recording');
        renderHotkeyBox(box, null, true);
        box.focus();
      }

      function stop() {
        recording = false;
        box.classList.remove('is-recording');
        renderHotkeys();
      }

      box.addEventListener('click', start);
      box.addEventListener('focus', function () {
        if (!recording) box.classList.add('is-focused');
      });
      box.addEventListener('blur', function () {
        box.classList.remove('is-focused');
        if (recording) stop();
      });

      box.addEventListener('keydown', function (ev) {
        if (!recording) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            start();
          }
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();

        if (ev.key === 'Escape') {
          stop();
          return;
        }
        if (ev.key === 'Backspace' || ev.key === 'Delete') {
          var patch = { hotkey: {} };
          patch.hotkey[key] = '';
          save(patch).then(function () {
            stop();
            toast('已清空快捷键', 'ok');
          });
          return;
        }

        var combo = comboFromEvent(ev);
        if (!combo.combo) {
          // 仅按下了修饰键，实时显示
          var keysEl = $('.hotkey-input__keys', box);
          if (keysEl) {
            var mods = combo.parts.map(function (p) {
              return '<span class="dati-kbd">' + esc(p) + '</span>';
            }).join('<span class="hotkey-input__plus">+</span>');
            keysEl.innerHTML = mods + '<span class="hotkey-input__empty"> + …</span>';
          }
          return;
        }

        // 至少需要一个修饰键，避免抢占普通输入
        if (!ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) {
          var kEl = $('.hotkey-input__keys', box);
          if (kEl) kEl.innerHTML = '<span class="hotkey-input__empty">需包含 Ctrl / Alt / Shift / Meta</span>';
          return;
        }

        // 冲突检测
        var conflictKey = null;
        Object.keys(state.hotkey).forEach(function (k) {
          if (k === 'enabled' || k === key) return;
          if (String(state.hotkey[k]).toLowerCase() === combo.combo.toLowerCase()) conflictKey = k;
        });
        if (conflictKey) {
          toast('该组合已被其他动作占用', 'warn');
          return;
        }

        var patch2 = { hotkey: {} };
        patch2.hotkey[key] = combo.combo;
        save(patch2).then(function () {
          stop();
          reflectDerived();
          toast('快捷键已更新为 ' + combo.combo, 'ok');
        });
      });
    });

    if (enabled) {
      enabled.addEventListener('change', function () {
        $$('.hotkey-input').forEach(function (box) {
          box.style.opacity = enabled.checked ? '' : '0.5';
          box.style.pointerEvents = enabled.checked ? '' : 'none';
        });
      });
    }
  }

  /* ------------------------------------------------------------ 外观 */

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    function p(n) { var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + p(r) + p(g) + p(b);
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  function applyAccent(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return;
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    var accent2 = hslToHex(hsl.h + 26, Math.min(100, hsl.s + 6), Math.min(72, hsl.l + 10));
    var isLight = document.body.getAttribute('data-theme') === 'light';
    var softA = isLight ? 0.13 : 0.17;
    var glowA = isLight ? 0.3 : 0.44;
    var root = document.body;
    root.style.setProperty('--dati-accent', hex);
    root.style.setProperty('--dati-accent-2', accent2);
    root.style.setProperty('--dati-accent-soft', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + softA + ')');
    root.style.setProperty('--dati-accent-glow', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + glowA + ')');
    root.style.setProperty('--dati-focus', hslToHex(hsl.h, Math.min(100, hsl.s + 4), isLight ? 42 : 76));
  }

  function applyUi() {
    var ui = state.ui || {};
    var body = document.body;

    var theme = ui.theme || 'dark';
    body.setAttribute('data-theme', theme);

    var accent = ui.accent || '#6366f1';
    applyAccent(accent);

    var fs = Number(ui.fontSize) || 13;
    body.style.setProperty('--dati-fs', fs + 'px');

    var radius = Number(ui.radius) || 14;
    body.style.setProperty('--dati-r-card', radius + 'px');
    body.style.setProperty('--dati-r-md', Math.max(4, Math.round(radius * 0.85)) + 'px');
    body.style.setProperty('--dati-r-lg', Math.round(radius * 1.15) + 'px');

    var pw = Number(ui.panelWidth) || 384;
    body.style.setProperty('--dati-panel-w', Math.min(360, pw) + 'px');

    body.style.setProperty('--dati-blur', ui.blur === false ? '0px' : '18px');
    var anim = ui.animate === false;
    body.toggleAttribute('data-noanim', anim);
    $$('.switch-row input[type="checkbox"], .preset-row input[type="checkbox"]').forEach(function (input) {
      var row = input.closest('.switch-row, .preset-row');
      var label = row && row.querySelector('.switch-row__name, .preset-row__name');
      if (label) input.setAttribute('aria-label', label.textContent.trim());
    });
    body.style.setProperty('--dati-dur-fast', anim ? '1ms' : '120ms');
    body.style.setProperty('--dati-dur', anim ? '1ms' : '180ms');
    body.style.setProperty('--dati-dur-slow', anim ? '1ms' : '240ms');

    var panel = $('#previewPanel');
    if (panel) panel.classList.toggle('is-flat', ui.blur === false);

    // 控件回显
    $$('.theme-opt').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-theme-opt') === theme);
    });
    $$('.accent-dot').forEach(function (b) {
      b.classList.toggle('is-active', String(b.getAttribute('data-accent')).toLowerCase() === String(accent).toLowerCase());
    });
    var picker = $('#accentPicker');
    if (picker && picker !== document.activeElement) picker.value = accent;
    var hexInput = $('#accentHex');
    if (hexInput && hexInput !== document.activeElement) hexInput.value = accent;

    var pwEl = $('#uiPanelWidth');
    var fsEl = $('#uiFontSize');
    var rEl = $('#uiRadius');
    if (pwEl) { if (pwEl !== document.activeElement) pwEl.value = String(pw); paintRange(pwEl); }
    if (fsEl) { if (fsEl !== document.activeElement) fsEl.value = String(fs); paintRange(fsEl); }
    if (rEl) { if (rEl !== document.activeElement) rEl.value = String(radius); paintRange(rEl); }

    var pwOut = $('#uiPanelWidthOut');
    if (pwOut) pwOut.textContent = pw + ' px';
    var fsOut = $('#uiFontSizeOut');
    if (fsOut) fsOut.textContent = fs + ' px';
    var rOut = $('#uiRadiusOut');
    if (rOut) rOut.textContent = radius + ' px';
  }

  function bindAppearance() {
    $$('.theme-opt').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var theme = btn.getAttribute('data-theme-opt');
        save({ ui: { theme: theme } }).then(applyUi);
      });
    });

    $$('.accent-dot').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var hex = btn.getAttribute('data-accent');
        save({ ui: { accent: hex } }).then(applyUi);
      });
    });

    var picker = $('#accentPicker');
    if (picker) {
      picker.addEventListener('input', function () {
        applyAccent(picker.value);
        var hexInput = $('#accentHex');
        if (hexInput) hexInput.value = picker.value;
      });
      picker.addEventListener('change', function () {
        save({ ui: { accent: picker.value } }).then(applyUi);
      });
    }

    var hexInput = $('#accentHex');
    if (hexInput) {
      hexInput.addEventListener('input', function () {
        var v = hexInput.value.trim();
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
          applyAccent(v.length === 4
            ? '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]
            : v);
          if (picker) picker.value = v.length === 4
            ? '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]
            : v;
        }
      });
      hexInput.addEventListener('change', function () {
        var v = hexInput.value.trim();
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
          hexInput.value = (state.ui && state.ui.accent) || '#6366f1';
          toast('颜色格式应为 #rrggbb', 'warn');
          return;
        }
        if (v.length === 4) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
        save({ ui: { accent: v } }).then(applyUi);
      });
    }

    [['#uiPanelWidth', 'panelWidth'], ['#uiFontSize', 'fontSize'], ['#uiRadius', 'radius']].forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      el.addEventListener('input', function () {
        paintRange(el);
        var ui = Settings.merge(state.ui, {});
        ui[pair[1]] = Number(el.value);
        state.ui = ui;
        applyUi();
      });
      el.addEventListener('change', function () {
        var patch = { ui: {} };
        patch.ui[pair[1]] = Number(el.value);
        save(patch).then(applyUi);
      });
    });

    $$('[data-path="ui.blur"], [data-path="ui.animate"]').forEach(function (el) {
      el.addEventListener('change', function () {
        var patch = { ui: {} };
        patch.ui[el.getAttribute('data-path').split('.')[1]] = el.checked;
        save(patch).then(applyUi);
      });
    });
  }

  /* ------------------------------------------------------------ 数据区 */

  function bindData() {
    var exportBtn = $('#btnExport');
    if (exportBtn) {
      exportBtn.addEventListener('click', async function () {
        var data;
        try {
          exportBtn.disabled = true;
          var backup = clone(state);
          backup.statistics = await AD.StatisticsClient.get();
          backup.backupVersion = 2;
          data = JSON.stringify(backup, null, 2);
        } catch (e) {
          toast('导出失败：' + e.message, 'danger');
          return;
        } finally {
          exportBtn.disabled = false;
        }
        var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        var blob = new Blob([data], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'autodati-backup-' + stamp + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        toast('已导出设置与统计数据', 'ok');
      });
    }

    var importBtn = $('#btnImport');
    var importFile = $('#importFile');
    var importStatus = $('#importStatus');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', function () { importFile.click(); });
      importFile.addEventListener('change', function () {
        var file = importFile.files && importFile.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var raw = String(reader.result || '');
          var parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            if (importStatus) {
              importStatus.textContent = '解析失败：' + e.message;
              importStatus.className = 'dati-hint dati-hint--danger';
            }
            toast('不是合法的 JSON 文件', 'danger');
            importFile.value = '';
            return;
          }
          var problem = validateSettings(parsed);
          if (!problem && Object.prototype.hasOwnProperty.call(parsed, 'statistics')) {
            try { AD.Statistics.validate(parsed.statistics); } catch (e) { problem = e.message; }
          }
          if (problem) {
            if (importStatus) {
              importStatus.textContent = '校验未通过：' + problem;
              importStatus.className = 'dati-hint dati-hint--danger';
            }
            toast('导入文件不合法', 'danger');
            importFile.value = '';
            return;
          }
          var statistics = parsed.statistics;
          delete parsed.statistics;
          delete parsed.backupVersion;
          Promise.resolve().then(function () {
            if (!hasChrome) return Settings.replace(parsed);
            return new Promise(function (resolve, reject) {
              chrome.runtime.sendMessage({ type: 'DATI_IMPORT_BACKUP', settings: parsed, statistics: statistics }, function (result) {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                if (!result || !result.ok) return reject(new Error(result && result.error || '备份导入失败'));
                resolve(result.settings);
              });
            });
          }).then(function (saved) {
            state = saved;
            editingId = saved.api.activeId;
            renderAll();
            if (importStatus) {
              importStatus.textContent = '已导入 ' + file.name;
              importStatus.className = 'dati-hint';
            }
            toast(statistics ? '设置与统计数据已导入' : '设置已导入，现有统计已保留', 'ok');
          }).catch(function (e) {
            toast('导入失败：' + (e && e.message ? e.message : e), 'danger');
          });
          importFile.value = '';
        };
        reader.onerror = function () {
          toast('读取文件失败', 'danger');
          importFile.value = '';
        };
        reader.readAsText(file);
      });
    }

    var resetBtn = $('#btnReset');
    var resetActions = $('#resetActions');
    if (resetBtn && resetActions) {
      resetBtn.addEventListener('click', function () {
        if (!resetArmed) {
          resetArmed = 1;
          resetActions.classList.add('is-confirm');
          resetBtn.textContent = '再次点击确认恢复';
          clearTimeout(resetTimer);
          resetTimer = setTimeout(function () {
            resetArmed = 0;
            resetActions.classList.remove('is-confirm');
            resetBtn.textContent = '恢复默认';
          }, 4000);
          toast('将清空所有配置，4 秒内再次点击确认', 'warn');
          return;
        }
        clearTimeout(resetTimer);
        resetArmed = 0;
        resetActions.classList.remove('is-confirm');
        resetBtn.textContent = '恢复默认';
        Settings.reset().then(function (saved) {
          state = saved;
          editingId = saved.api.activeId;
          renderAll();
          toast('已恢复默认设置', 'ok');
        });
      });
    }

    var shortcutsBtn = $('#btnOpenShortcuts');
    if (shortcutsBtn) {
      shortcutsBtn.addEventListener('click', function () {
        if (hasChrome && chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
          return;
        }
        toast('本地预览无法打开扩展页面', 'warn');
      });
    }
  }

  function validateSettings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '顶层必须是对象';
    if (raw.api && typeof raw.api !== 'object') return 'api 字段类型错误';
    if (raw.api && raw.api.profiles && !Array.isArray(raw.api.profiles)) return 'api.profiles 必须是数组';
    if (raw.api && Array.isArray(raw.api.profiles)) {
      for (var i = 0; i < raw.api.profiles.length; i++) {
        var p = raw.api.profiles[i];
        if (!p || typeof p !== 'object') return 'profiles[' + i + '] 不是对象';
        if (p.format && !(AD.FORMAT && AD.FORMAT_LABEL && AD.FORMAT_LABEL[p.format])) {
          return 'profiles[' + i + '].format 不支持：' + p.format;
        }
      }
    }
    if (raw.detect && raw.detect.customRules && !Array.isArray(raw.detect.customRules)) {
      return 'detect.customRules 必须是数组';
    }
    if (raw.mode && typeof raw.mode !== 'object') return 'mode 字段类型错误';
    if (raw.prompt && typeof raw.prompt !== 'object') return 'prompt 字段类型错误';
    if (raw.hotkey && typeof raw.hotkey !== 'object') return 'hotkey 字段类型错误';
    if (raw.ui && typeof raw.ui !== 'object') return 'ui 字段类型错误';
    return null;
  }

  /* ------------------------------------------------------------ 渲染总入口 */

  function renderAll() {
    renderPaths();
    renderProviders();
    renderEditor();
    renderPresets();
    renderRules();
    renderHotkeys();
    applyUi();
    reflectDerived();

    var brandVer = $('#brandVersion');
    if (brandVer) brandVer.textContent = 'v' + (AD.VERSION || '0.1.0');
    var aboutVer = $('#aboutVersion');
    if (aboutVer) aboutVer.textContent = AD.VERSION || '0.1.0';
    var metaProtocol = $('#metaProtocol');
    if (metaProtocol) metaProtocol.textContent = String(AD.PROTOCOL || 1);
    var aboutProtocol = $('#aboutProtocol');
    if (aboutProtocol) aboutProtocol.textContent = String(AD.PROTOCOL || 1);
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    bindNav();
    bindPaths();
    bindProviderList();
    bindProviderEditor();
    bindModelPicker();
    bindKeyToggle();
    bindModelChips();
    bindPromptTabs();
    bindTest();
    bindPresets();
    bindRules();
    bindHotkeys();
    bindAppearance();
    bindData();

    // 本地预览（file:// 直接打开）辅助参数：?preview=off 查看总开关关闭态，?theme=light 查看浅色
    if (!hasChrome) {
      var q = String(location.search || '');
      var patch = null;
      if (/(\?|&)preview=off(&|$)/.test(q)) patch = Settings.merge(patch || {}, { enabled: false });
      var tm = q.match(/[?&]theme=(dark|light|auto)(&|$)/);
      if (tm) patch = Settings.merge(patch || {}, { ui: { theme: tm[1] } });
      previewPatch = patch;
      if (patch) state = Settings.merge(state, patch);
    }

    var addBtn = $('#btnAddProvider');
    if (addBtn) addBtn.addEventListener('click', addProvider);

    var savedView = viewFromHash();
    if (!savedView) {
      try { savedView = sessionStorage.getItem('ad_options_view'); } catch (e) { savedView = null; }
    }
    if (savedView && $('.view[data-view="' + savedView + '"]')) activateView(savedView);

    window.addEventListener('hashchange', function () {
      var v = viewFromHash();
      if (v) activateView(v, true);
    });

    // 打开设置页时浏览器会把初始焦点给第一个可聚焦元素（导航首项），
    // 会在非当前分区上留下焦点环，容易误读；这里清掉，键盘操作时仍会重新出现。
    function dropInitialNavFocus() {
      var ae = document.activeElement;
      if (ae && ae !== document.body && ae.classList && ae.classList.contains('nav__item') &&
          !ae.classList.contains('is-active')) {
        try { ae.blur(); } catch (e) { /* noop */ }
      }
    }
    setTimeout(dropInitialNavFocus, 0);
    setTimeout(dropInitialNavFocus, 150);
    window.addEventListener('load', function () { setTimeout(dropInitialNavFocus, 0); });

    Settings.subscribe(function (next, changes) {
      // 忽略自身 save 触发的回写，避免输入框被重置
      if (changes && changes.__self) return;
      state = next;
      if (!editingProfile()) editingId = (next.api && next.api.activeId) || editingId;
      renderPaths();
      renderProviders();
      renderEditor();
      renderPresets();
      renderRules();
      renderHotkeys();
      applyUi();
      reflectDerived();
    });

    renderAll();

    Settings.get().then(function (s) {
      state = s;
      if (previewPatch) state = Settings.merge(state, previewPatch);
      editingId = (s.api && s.api.activeId) || editingId;
      renderAll();
    }).catch(function () {
      /* 无存储时保持默认值渲染 */
    });

    // 数字/范围输入的初始轨道
    $$('input[type="range"]').forEach(paintRange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(globalThis.AD = globalThis.AD || {}));
