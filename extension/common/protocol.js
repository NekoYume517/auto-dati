/**
 * AutoDati · 协议层
 * 经典脚本，可在 Service Worker / content script / 扩展页面中加载。
 */
(function (AD) {
  'use strict';

  AD.PROTOCOL = 1;
  AD.VERSION = '0.1.0';

  /** 本次会话内唯一的请求 ID */
  let seq = 0;
  AD.uid = function (prefix) {
    seq = (seq + 1) % 1e9;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + seq.toString(36) +
      Math.random().toString(36).slice(2, 6);
  };

  /** 稳定短哈希（用于题目 ID），FNV-1a 32bit */
  AD.hash = function (str) {
    str = String(str == null ? '' : str);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  };

  AD.clamp = function (v, min, max) {
    v = Number(v);
    if (!isFinite(v)) v = min;
    return Math.min(max, Math.max(min, v));
  };

  AD.sleep = function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };

  let logEnabled = false;
  AD.setLog = function (on) { logEnabled = !!on; };
  AD.log = function () {
    if (!logEnabled) return;
    const args = Array.prototype.slice.call(arguments);
    args.unshift('%c[AutoDati]', 'color:#6366f1;font-weight:bold');
    try { console.log.apply(console, args); } catch (e) { /* noop */ }
  };
  AD.warn = function () {
    const args = Array.prototype.slice.call(arguments);
    args.unshift('%c[AutoDati]', 'color:#f59e0b;font-weight:bold');
    try { console.warn.apply(console, args); } catch (e) { /* noop */ }
  };
  AD.error = function () {
    const args = Array.prototype.slice.call(arguments);
    args.unshift('%c[AutoDati]', 'color:#ef4444;font-weight:bold');
    try { console.error.apply(console, args); } catch (e) { /* noop */ }
  };

  /* ------------------------------- 消息类型 ------------------------------- */

  AD.MSG = {
    PING: 'AD_PING',
    GET_SETTINGS: 'AD_GET_SETTINGS',
    SAVE_SETTINGS: 'AD_SAVE_SETTINGS',
    TEST_PROVIDER: 'AD_TEST_PROVIDER',
    LIST_PROVIDER_MODELS: 'AD_LIST_PROVIDER_MODELS',
    CAPTURE_TAB: 'AD_CAPTURE_TAB',
    OPEN_OPTIONS: 'AD_OPEN_OPTIONS',
    STATE_REPORT: 'AD_STATE_REPORT',
    GET_STATE: 'AD_GET_STATE',
    CMD: 'AD_CMD',
    MENU_ANSWER: 'AD_MENU_ANSWER'
  };

  AD.STREAM = {
    PORT: 'AD_STREAM',
    READY: 'AD_STREAM_READY',
    START: 'AD_STREAM_START',
    CHUNK: 'AD_STREAM_CHUNK',
    DONE: 'AD_STREAM_DONE',
    ERROR: 'AD_STREAM_ERROR',
    ABORT: 'AD_STREAM_ABORT',
    PING: 'AD_STREAM_PING'
  };

  AD.KIND = {
    CHOICE: 'choice',
    MULTI: 'multi',
    JUDGE: 'judge',
    BLANK: 'blank',
    QA: 'qa',
    GENERIC: 'generic'
  };

  AD.KIND_LABEL = {
    choice: '单选题',
    multi: '多选题',
    judge: '判断题',
    blank: '填空题',
    qa: '问答/大题',
    generic: '通用表单'
  };

  AD.FORMAT = {
    OPENAI_CHAT: 'openai-chat',
    OPENAI_RESPONSES: 'openai-responses',
    ANTHROPIC: 'anthropic',
    GEMINI: 'gemini'
  };

  AD.FORMAT_LABEL = {
    'openai-chat': 'Chat Completions',
    'openai-responses': 'Responses API',
    'anthropic': 'Claude Messages',
    'gemini': 'Gemini GenerateContent'
  };

  AD.FORMAT_DEFAULT_PATH = {
    'openai-chat': '/chat/completions',
    'openai-responses': '/responses',
    'anthropic': '/messages',
    'gemini': '/models/{model}:streamGenerateContent'
  };

  AD.FORMAT_MODELS = {
    'openai-chat': ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'deepseek-chat', 'qwen-plus', 'glm-4-plus', 'moonshot-v1-8k'],
    'openai-responses': ['gpt-5', 'gpt-4.1', 'o4-mini', 'gpt-4o'],
    'anthropic': ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
    'gemini': ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']
  };

  AD.FORMAT_BASE_HINT = {
    'openai-chat': 'https://api.openai.com/v1',
    'openai-responses': 'https://api.openai.com/v1',
    'anthropic': 'https://api.anthropic.com/v1',
    'gemini': 'https://generativelanguage.googleapis.com/v1beta'
  };
}(globalThis.AD = globalThis.AD || {}));
