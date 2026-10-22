/**
 * AutoDati · 设置层
 * 默认值 / 深合并 / 持久化 / 订阅。经典脚本，可在任意扩展上下文加载。
 */
(function (AD) {
  'use strict';

  const STORAGE_KEY = 'ad_settings';
  const WISDOM_RULE = { id: 'site-zhihuishu', name: '智慧树', enabled: true, kind: 'auto', domains: ['zhihuishu.com', 'zhihuishu.cn'], rootSelector: '.examPaper_subject', stemSelector: '.subject_describe', optionSelector: '.nodeLab', inputSelector: '', nextPageEnabled: true, nextPageSelector: '.switch-btn-box button:nth-of-type(2)' };

  const DEFAULTS = {
    version: 1,
    updates: { autoCheck: true },
    // 总开关：false 时扩展完全静默（不检测、不弹窗、不自动答题、页面快捷键失效）
    enabled: true,
    mode: {
      autoAnswer: false,
      autoNextPage: false,
      highlightNextPage: false,
      nextPageDelayMs: 800,
      popup: true,
      autoFillAfterStream: false,
      scanDebounceMs: 600,
      minIntervalMs: 1500,
      maxPerPage: 6,
      // 默认不跳过已作答的题：已填过的题仍会弹面板（带「已作答」标记），
      // 想要「只答没填过的」再到设置里打开这个开关。
      skipAnswered: false,
      cooldownMs: 60000,
      noticeToast: true,
      hoverHint: false
    },
    api: {
      activeId: 'p1',
      profiles: [{
        id: 'p1',
        name: '默认',
        format: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        path: '',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0.2,
        maxTokens: 2048,
        stream: true,
        vision: true,
        // 思考模式：auto=跟随服务端默认；off=尽力关闭推理（DeepSeek-R1/Glm 等支持时）；
        // on=显式开启。仅对支持的模型生效。
        reasoning: 'auto',
        extraHeaders: {},
        extraBody: {},
        timeoutMs: 60000,
        lastTest: null
      }]
    },
    prompt: {
      system: [
        '你是一名严谨、准确的答题助手。用户会给你一道题目（可能来自网页表单或截图）。',
        '请直接给出正确答案，不要复述题目，不要输出与答案无关的客套话。',
        '如果有多个空或多个选项，请按题目顺序逐项作答。'
      ].join('\n'),
      extraInstruction: '',
      kindHint: { choice: '', multi: '', judge: '', blank: '', qa: '', generic: '' },
      language: 'auto',
      includeExplain: false,
      imageInstruction: '这是一张题目截图，请识别题目内容并作答。'
    },
    detect: {
      sitePresets: { zhihuishu: true },
      siteRules: { zhihuishu: { nextPageEnabled: true, nextPageSelector: '.switch-btn-box button:nth-of-type(2)' } },
      customRules: [clone(WISDOM_RULE)],
      ruleCatalogVersion: 1,
      minTextLen: 4,
      viewportOnly: true,
      shadowDom: true,
      frameRelay: true,
      showDetectionBoxes: false
    },
    hotkey: {
      enabled: true,
      capture: 'Alt+Q',
      hover: 'Alt+Shift+Q',
      picker: 'Alt+Shift+E',
      toggleAuto: 'Alt+Shift+Z',
      togglePopup: 'Alt+Shift+X'
    },
    ui: {
      theme: 'dark',
      accent: '#6366f1',
      panelWidth: 384,
      showQuestion: true,
      showOptions: true,
      fontSize: 13,
      radius: 14,
      blur: true,
      animate: true,
      panelPosition: 'auto'
    },
    advanced: {
      log: false,
      areaPicker: true,
      maxImageSide: 1600,
      screenshotFormat: 'png',
      showScreenshotThumb: true
    }
  };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (isPlainObject(v)) {
      const out = {};
      for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = clone(v[k]);
      return out;
    }
    return v;
  }

  /** 深合并：对象递归；数组与标量整体替换 */
  function merge(base, patch) {
    if (!isPlainObject(patch)) {
      return patch === undefined ? clone(base) : clone(patch);
    }
    const out = isPlainObject(base) ? clone(base) : {};
    for (const k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      const pv = patch[k];
      if (pv === undefined) continue;
      if (isPlainObject(pv) && isPlainObject(out[k])) out[k] = merge(out[k], pv);
      else out[k] = clone(pv);
    }
    return out;
  }

  let cache = clone(DEFAULTS);
  let loaded = false;
  const listeners = new Set();

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      if (!hasStorage()) return resolve(undefined);
      try {
        chrome.storage.local.get(key, function (res) {
          if (chrome.runtime && chrome.runtime.lastError) {
            AD.warn('storage.get failed:', chrome.runtime.lastError.message);
            return resolve(undefined);
          }
          resolve(res ? res[key] : undefined);
        });
      } catch (e) {
        AD.warn('storage.get threw:', e && e.message);
        resolve(undefined);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise(function (resolve, reject) {
      if (!hasStorage()) return resolve();
      try {
        const obj = {};
        obj[key] = value;
        chrome.storage.local.set(obj, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function normalize(raw) {
    const merged = merge(DEFAULTS, raw || {});
    // 移除旧版自动题型预设开关，自动扫描只用站点规则和用户自定义规则。
    delete merged.detect.presets;
    // 目前只维护智慧树站点预设；丢弃旧版已下线站点的开关，且默认启用智慧树。
    const configuredSites = merged.detect && merged.detect.sitePresets || {};
    if (!raw || !raw.detect || raw.detect.ruleCatalogVersion !== 1) {
      const rules = Array.isArray(raw && raw.detect && raw.detect.customRules) ? clone(raw.detect.customRules) : [];
      if (!rules.some(function (r) { return r.id === WISDOM_RULE.id; })) rules.unshift(Object.assign(clone(WISDOM_RULE), merged.detect.siteRules.zhihuishu, { enabled: configuredSites.zhihuishu !== false }));
      merged.detect.customRules = rules;
    }
    merged.detect.ruleCatalogVersion = 1;
    merged.detect.sitePresets = { zhihuishu: false };
    // 旧版全局按钮配置迁移到已有自定义规则，之后只按命中规则定位。
    const legacyNext = String(merged.mode.nextPageSelector || '').trim();
    if (legacyNext && Array.isArray(merged.detect.customRules)) {
      merged.detect.customRules = merged.detect.customRules.map(function (rule) {
        return rule.nextPageSelector === undefined ? Object.assign({}, rule, { nextPageSelector: legacyNext, nextPageEnabled: true }) : rule;
      });
    }
    delete merged.mode.nextPageSelector;
    // 保证至少有一个 provider，且 activeId 有效
    if (!Array.isArray(merged.api.profiles) || !merged.api.profiles.length) {
      merged.api.profiles = clone(DEFAULTS.api.profiles);
    }
    const ids = merged.api.profiles.map(function (p) { return p && p.id; });
    if (ids.indexOf(merged.api.activeId) < 0) merged.api.activeId = ids[0];
    merged.version = 1;
    return merged;
  }

  const Settings = {
    DEFAULTS: DEFAULTS,
    STORAGE_KEY: STORAGE_KEY,
    merge: merge,
    clone: clone,

    get: function (force) {
      if (loaded && !force) return Promise.resolve(clone(cache));
      return storageGet(STORAGE_KEY).then(function (raw) {
        cache = normalize(raw);
        loaded = true;
        return clone(cache);
      });
    },

    /** 同步快照；未加载时返回默认值克隆 */
    snapshot: function () {
      return clone(cache);
    },

    isLoaded: function () { return loaded; },

    save: function (patch) {
      const next = normalize(merge(cache, patch || {}));
      cache = next;
      loaded = true;
      return storageSet(STORAGE_KEY, next).then(function () {
        Settings.emit(next, patch || {});
        return clone(next);
      }).catch(function (e) {
        AD.warn('save failed:', e && e.message);
        Settings.emit(next, patch || {});
        return clone(next);
      });
    },

    /** 整对象替换（导入用） */
    normalize: normalize,
    replace: function (raw) {
      const next = normalize(raw);
      cache = next;
      loaded = true;
      return storageSet(STORAGE_KEY, next).then(function () {
        Settings.emit(next, next);
        return clone(next);
      });
    },

    reset: function () {
      return Settings.replace({});
    },

    defaults: function () {
      return clone(DEFAULTS);
    },

    subscribe: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    },

    emit: function (settings, changes) {
      listeners.forEach(function (fn) {
        try { fn(clone(settings), changes); } catch (e) { AD.warn('listener failed:', e && e.message); }
      });
    },

    currentProfile: function () {
      const s = cache;
      const list = (s.api && s.api.profiles) || [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === s.api.activeId) return clone(list[i]);
      }
      return list[0] ? clone(list[0]) : null;
    }
  };

  // 外部（options 页 / 其他标签页）变更时同步缓存
  if (hasStorage() && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      const raw = changes[STORAGE_KEY].newValue;
      cache = normalize(raw);
      loaded = true;
      Settings.emit(cache, changes[STORAGE_KEY]);
    });
  }

  AD.DEFAULTS = DEFAULTS;
  AD.Settings = Settings;
}(globalThis.AD = globalThis.AD || {}));
