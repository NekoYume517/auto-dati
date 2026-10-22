# AutoDati 接口契约（冻结版 v1）

> 本文件是并行开发的唯一真相来源。任何一方**不得**修改本文件中的接口名、字段名、CSS 变量名、消息类型；只能新增。
> 所有脚本均为**经典脚本**（classic script，不使用 `import`/`export`），通过全局对象 `AD` 互相通信。
> Service Worker 通过 `importScripts()` 加载，UI 页面通过 `<script src>` 顺序加载，content script 通过 manifest 顺序注入。

---

## 0. 目录与归属（写作用域，互不重叠）

| 路径 | 归属 |
|---|---|
| `extension/manifest.json`、`extension/icons/**` | Lead |
| `extension/common/protocol.js`、`extension/common/settings.js` | Lead |
| `extension/common/theme.css` | **ui-designer**（A） |
| `extension/background/**` | Lead |
| `extension/content/content.js`、`overlay.js`、`overlay.css`、`capture.js` | Lead |
| `extension/content/frame.js`、`picker.js` | Lead |
| `extension/content/presets.js`、`detector.js`、`filler.js` | **detector-eng**（B） |
| `extension/ui/**`（options + popup） | **ui-designer**（A） |
| `test/fixture/**` | **detector-eng**（B） |
| `test/mock-llm-server.mjs`、`test/**`（其余） | Lead |
| `docs/**`、`README.md` | Lead |

---

## 1. 全局命名空间

```js
globalThis.AD = {
  PROTOCOL: 1,
  DEFAULTS,            // 默认设置（settings.js）
  PRESETS,             // 内置检测预设（presets.js）
  Settings: { get, snapshot, save, reset, defaults, subscribe, merge },
  LLM: { adapters, stream, buildMessages, test },   // 仅 SW 可见
  Detector, Filler, Overlay, Picker, Capture, App,
  uid(), log(), clamp()
}
```

每个文件用 IIFE 包裹，只挂载自己的命名空间，例如：

```js
(function (AD) {
  'use strict';
  AD.uid = function () { ... };
}(globalThis.AD = globalThis.AD || {}));
```

---

## 2. 设置数据模型（`chrome.storage.local` key: `ad_settings`）

```js
{
  version: 1,
  mode: {
    autoAnswer: false,        // 自动答题模式：检测到题目 → 自动请求并填入
    popup: true,              // 弹窗模式：检测到题目 → 自动弹窗（流式）
    autoFillAfterStream: false, // 弹窗流式结束后自动填入
    scanDebounceMs: 600,      // DOM 变化去抖
    minIntervalMs: 1500,      // 扫描最小间隔
    maxPerPage: 6,            // 单页最多处理题目数
    skipAnswered: true,       // 跳过已作答的题
    cooldownMs: 60000,        // 同题重答冷却
    noticeToast: true,        // 自动答题时右下角轻提示
    hoverHint: true           // 悬停题块显示小角标
  },
  api: {
    activeId: 'p1',
    profiles: [{
      id: 'p1', name: '默认',
      format: 'openai-chat',  // openai-chat | openai-responses | anthropic | gemini
      baseUrl: 'https://api.openai.com/v1',
      path: '',               // 留空使用格式默认路径
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 2048,
      stream: true,
      vision: true,           // 是否支持图片输入
      extraHeaders: {},       // 附加请求头
      extraBody: {},          // 附加 body 字段
      timeoutMs: 60000,
      lastTest: null          // {ok, ms, text, error, at}
    }]
  },
  prompt: {
    system: '你是一个严谨的答题助手…',
    extraInstruction: '',
    kindHint: { choice: '', multi: '', judge: '', blank: '', qa: '', generic: '' },
    language: 'auto',         // auto | zh | en
    includeExplain: false,    // 输出是否附带解析
    imageInstruction: '这是一张题目截图，请识别题目并作答。'
  },
  detect: {
    presets: {                // 内置预设开关（可单独启用）
      choice: true, multi: true, judge: true, blank: true, qa: true, generic: false
    },
    sitePresets: {},          // { presetId: boolean }
    customRules: [],          // [{id, name, rootSelector, stemSelector, optionSelector, inputSelector, kind, enabled}]
    minTextLen: 4,
    viewportOnly: true,       // 只处理视口内/可见元素
    shadowDom: true
  },
  hotkey: {
    enabled: true,
    capture: 'Alt+Q',         // 截图搜题（点选元素，页面内快捷键）
    hover: 'Alt+Shift+Q',     // 直接对鼠标下元素作答
    picker: 'Alt+Shift+E',    // 拾取元素，添加题目模板
    toggleAuto: 'Alt+Shift+Z',
    togglePopup: 'Alt+Shift+X'
  },
  ui: {
    theme: 'dark',            // dark | light | auto
    accent: '#6366f1',
    panelWidth: 384,
    fontSize: 13,
    radius: 14,
    blur: true,
    animate: true,
    panelPosition: 'auto'     // auto | below | above | cursor
  },
  advanced: {
    log: false,
    areaPicker: true,
    maxImageSide: 1600,
    screenshotFormat: 'png',  // png | jpeg
    showScreenshotThumb: true
  }
}
```

`AD.Settings.get()` → `Promise<settings>`（深合并默认值，带缓存）。
`AD.Settings.snapshot()` → 同步读取最近一次结果（未加载时返回 `DEFAULTS` 的克隆）。
`AD.Settings.save(patch)` → 深合并写入并返回最新值，触发订阅者。
`AD.Settings.subscribe(fn)` → 返回取消订阅函数；`fn(settings, changes)`。
`AD.Settings.merge(base, patch)` → 纯函数深合并（数组按元素替换，不做拼接）。

---

## 3. 消息协议

### 3.1 一次性消息（content/popup/options → background）

| type | 载荷 | 返回 |
|---|---|---|
| `AD_PING` | — | `{ok:true, version, protocol}` |
| `AD_GET_SETTINGS` | — | `{ok, settings}` |
| `AD_SAVE_SETTINGS` | `{patch}` | `{ok, settings}` |
| `AD_TEST_PROVIDER` | `{profile, prompt?}` | `{ok, ms, text, error}` |
| `AD_CAPTURE_TAB` | `{rect:{x,y,w,h}, dpr, format, crop:boolean}` | `{ok, dataUrl, width, height, error}` |
| `AD_OPEN_OPTIONS` | — | `{ok}` |
| `AD_STATE_REPORT` | `{state}` | `{ok}` |
| `AD_GET_STATE` | — | `{ok, states:{[tabId]:state}}` |

`rect` 使用 **CSS 像素 + 视口坐标**（captureVisibleTab 只截可视区域，不滚动）。`dpr = devicePixelRatio`。
background 端裁剪使用 `x*dpr, y*dpr, w*dpr, h*dpr`。

### 3.2 流式端口（content → background）

端口名：`AD_STREAM`

content → bg：
```js
port.postMessage({ type:'AD_STREAM_START', reqId, request, options });
port.postMessage({ type:'AD_STREAM_ABORT', reqId });
port.postMessage({ type:'AD_STREAM_PING' });  // 心跳，保活
```

`request`：
```js
{
  text: '题干文本…',          // 必填（可为空字符串，此时必须有 images）
  images: [{ mime:'image/png', dataBase64:'...' }],   // 可选
  kind: 'choice'|'multi'|'judge'|'blank'|'qa'|'generic',
  systemOverride: '',          // 可选，覆盖默认 system
  profileId: ''                // 可选，覆盖 active profile
}
```
`options`：`{ stream: true, temperature, maxTokens, signalTag: 'custom' }`

bg → content：
```js
{ type:'AD_STREAM_READY', reqId, model, format }
{ type:'AD_STREAM_CHUNK', reqId, delta }
{ type:'AD_STREAM_DONE',  reqId, text, usage, model, ms }
{ type:'AD_STREAM_ERROR', reqId, error, code }
```

### 3.3 background → content 指令（快捷键 / 菜单）

```js
{ type:'AD_CMD', cmd: 'capture'|'hover-answer'|'toggle-auto'|'toggle-popup'|'scan'|'close-overlays', payload? }
```

---

## 4. 检测引擎 API（`AD.Detector` / `AD.Filler` / `AD.PRESETS`）

```js
ADQuestion = {
  id: 'q_<hash>',      // 稳定 ID（同题重复扫描不变）
  kind: 'choice'|'multi'|'judge'|'blank'|'qa'|'generic',
  root: Element,       // 题块容器
  anchor: Element,     // 弹窗锚点（一般为 root 或题干元素）
  stem: '题干文本',
  options: [{ label:'A', text:'选项文本', el:Element, input:Element|null, checked:boolean }],
  inputs: [{ el:Element, type:'text'|'textarea'|'select'|'contenteditable', name:'', placeholder:'' }],
  presetId: 'choice',
  confidence: 0.0,     // 0..1
  rect: { x, y, w, h },// 视口坐标
  answered: false
}
```

- `AD.Detector.scan(root = document, opts = {}) → ADQuestion[]`（同步；内部去重 + 可见性过滤 + 排序）
- `AD.Detector.observe(cb) → stop()`，`cb({questions, added, removed})`；内部去抖使用 `mode.scanDebounceMs`。
- `AD.Detector.isVisible(el) → boolean`
- `AD.Detector.elementKind(el) → kind|null`（供快捷键对鼠标下元素判定）
- `AD.Detector.buildFromElement(el) → ADQuestion|null`（把任意元素向上归并成题块）
- `AD.Filler.parse(kind, text, question) → { answers: string[], raw, ok }`
- `AD.Filler.apply(question, text, opts = {}) → { ok, applied: n, detail: '...' }`

内置预设（`AD.PRESETS`，数组，每项含 `enabledByDefault`）：
```js
{ id, name, desc, kind, enabledByDefault, site: '', urls: [], match(root, ctx) → ADQuestion[] }
```
预设清单（必须全部实现）：`choice` 单选题、`multi` 多选题、`judge` 判断题、`blank` 填空题、`qa` 问答/大题、`generic` 通用表单（默认关）。
站点预设（默认关，`site` 字段标记）：`chaoxing` 学习通/超星、`zhihuishu` 智慧树、`yuketang` 雨课堂、`wenjuanxing` 问卷星、`examcoo` 考试宝。

---

## 5. 覆盖层 API（`AD.Overlay`，Lead 实现，UI 侧可调用）

```js
AD.Overlay.show({ question, rect, source:'detect'|'capture'|'hotkey', screenshot:dataUrl|null,
                  pinned:boolean }) → sessionId
AD.Overlay.append(sessionId, delta)
AD.Overlay.done(sessionId, { text, usage, ms })
AD.Overlay.fail(sessionId, error)
AD.Overlay.close(sessionId?)
AD.Overlay.count()
AD.Overlay.closeAll()
```
覆盖层必须使用 **Shadow DOM**（避免宿主页面样式污染），`dati-root` 命名；
必须支持：拖拽、流式打字机、填入/复制/重试/停止、Esc 关闭、锚点定位（下方优先，空间不足翻到上方，视口内 clamp）、截图缩略图、主题（dark/light/auto）、`prefers-reduced-motion`。

---

## 6. 设计令牌（`common/theme.css`，**变量名冻结**）

选择器作用域：`.dati-root`（UI 页面把 `dati-root` 类放在 `<body>` 上；覆盖层放在 shadow 宿主根节点上）。
令牌必须同时定义在 `.dati-root`、`.dati-root[data-theme="light"]`，并支持 `@media (prefers-color-scheme: light)` 下的 `[data-theme="auto"]`。

```
颜色：--dati-bg, --dati-bg-soft, --dati-bg-elev, --dati-glass, --dati-border, --dati-border-strong,
      --dati-text, --dati-text-dim, --dati-text-mute,
      --dati-accent, --dati-accent-2, --dati-accent-fg, --dati-accent-soft, --dati-accent-glow,
      --dati-success, --dati-success-soft, --dati-warn, --dati-warn-soft, --dati-danger, --dati-danger-soft,
      --dati-focus
圆角：--dati-r-xs(6px) --dati-r-sm(8px) --dati-r-md(12px) --dati-r-lg(16px) --dati-r-xl(20px) --dati-r-full(999px)
阴影：--dati-shadow-sm, --dati-shadow-md, --dati-shadow-lg
字体：--dati-font, --dati-font-mono, --dati-fs(13px), --dati-lh(1.6)
动效：--dati-dur-fast(120ms), --dati-dur(180ms), --dati-dur-slow(240ms),
      --dati-ease(cubic-bezier(.23,1,.32,1)), --dati-ease-in-out(cubic-bezier(.77,0,.175,1))
杂项：--dati-z(2147483000), --dati-blur(18px)
```

公共类（UI 页面与覆盖层共用，**类名冻结**）：
`.dati-btn` `.dati-btn--primary` `.dati-btn--ghost` `.dati-btn--danger` `.dati-btn--icon` `.dati-btn--sm`
`.dati-input` `.dati-textarea` `.dati-select` `.dati-switch` `.dati-field` `.dati-label` `.dati-hint`
`.dati-card` `.dati-card__title` `.dati-badge` `.dati-chip` `.dati-tabs` `.dati-tab`
`.dati-spinner` `.dati-skeleton` `.dati-empty` `.dati-toast` `.dati-scroll` `.dati-kbd` `.dati-divider`

交互规范（必须遵守）：
- `:active` 反馈 `transform: scale(.97)`，`transition: transform 120ms var(--dati-ease)`
- 只对 `transform` / `opacity` / `color` / `background-color` / `box-shadow` 写 transition，禁止 `transition: all`
- 入场用 `ease-out`（`--dati-ease`），禁止 `ease-in`；UI 动效 < 300ms；入场不得从 `scale(0)` 起步
- hover 动效必须包在 `@media (hover:hover) and (pointer:fine)`
- `@media (prefers-reduced-motion: reduce)` 下移除去位移动画

---

## 7. LLM 适配（背景层，格式细节）

| format | 默认路径 | 认证头 | 流式事件 → delta |
|---|---|---|---|
| `openai-chat` | `/chat/completions` | `Authorization: Bearer <key>` | `data:` JSON → `choices[0].delta.content`（兼容 `reasoning_content`，`[DONE]` 结束） |
| `openai-responses` | `/responses` | `Authorization: Bearer <key>` | `data:` JSON → `type==='response.output_text.delta'` 时取 `delta`；结束于 `response.completed` |
| `anthropic` | `/messages` | `x-api-key` + `anthropic-version: 2023-06-01` + `anthropic-dangerous-direct-browser-access: true` | `event: content_block_delta` → `delta.text`（`text_delta`），结束于 `message_stop` |
| `gemini` | `/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key: <key>`（也兼容 `?key=`） | `data:` JSON → `candidates[0].content.parts[*].text` |

非流式回退：`options.stream === false` 时以 `Accept: application/json` 请求并整体解析，返回同一 `AD_STREAM_DONE`。

图片输入：
- `openai-chat`：`content: [{type:'text',text},{type:'image_url',image_url:{url:'data:<mime>;base64,<b64>'}}]`
- `openai-responses`：`content: [{type:'input_text',text},{type:'input_image',image_url:'data:...'}]`
- `anthropic`：`content: [{type:'image',source:{type:'base64',media_type:'image/png',data:'<b64>'}},{type:'text',text}]`
- `gemini`：`parts: [{inline_data:{mime_type:'image/png',data:'<b64>'}},{text}]`

---

## 8. 跨帧协调（v1 追加，Lead 实现）

`content/frame.js` → `AD.Frame`，`all_frames` 注入，每层都安装监听：

| 消息（window.postMessage） | 方向 | 语义 |
|---|---|---|
| `{type:'AD_RECT_REQUEST', id, rect, vw, vh}` | 子 → 父 | 子框架内视口坐标请求换算到父框架坐标 |
| `{type:'AD_RECT_RESULT', id, rect}` | 父 → 子 | 换算结果；`toTopRect` 逐级上溯直到顶层 |
| `{type:'AD_FRAME_QUESTION', qid, payload}` | 子 → 顶层 | 子框架题目转交顶层统一弹面板 |
| `{type:'AD_FRAME_FILL', qid, text}` | 顶层 → 子 | 顶层把答案回传子框架填入 |

- `AD.Frame.toTopRect(rect)`：同源走 `frameElement` 链（同步），跨源走 postMessage 逐级转发（异步，超时 900ms 退化为原 rect）。
- 顶层通过 `event.source` 与 `window.frames[i]` 比对定位 iframe 元素，`clientLeft/Top` 与内容缩放比都参与换算。

## 9. 元素拾取与模板（v1 追加，Lead 实现）

`content/picker.js` → `AD.Picker`：

```js
AD.Picker.open()                 // Promise<rule|null>，全流程拾取 + 保存
AD.Picker.inferStructure(root)   // {kind, stemSelector, optionSelector, inputSelector, stem, counts}
AD.Picker.patternSelector(el)    // 优先「能命中 2..400 个同类元素」的模式选择器，最后才退回唯一 id
AD.Picker.relativeSelector(root, el, {many})
```

保存的规则写入 `detect.customRules`：`{id, name, enabled, kind, rootSelector, stemSelector, optionSelector, inputSelector}`，与设置页「自定义规则」共用同一结构。

## 10. 命中测试约定（v1 追加）

扩展的全屏覆盖层（`#dati-overlay-host` / `#dati-elem-picker-host` / `#dati-picker-host`）都带 `data-dati-ignore`。
对页面做 `elementFromPoint` 命中测试**必须**临时把这些宿主 `pointer-events:none`（`AD.Capture.probeElement` 已封装），否则只会命中覆盖层自身。

## 11. 验证口径（Lead 与 teammates 都必须遵守）

1. `node --check` 全部 JS；`JSON.parse` manifest / package。
2. 检查 manifest 中引用的每个文件真实存在。
3. `test/mock-llm-server.mjs` 提供 `/chat/completions`、`/responses`、`/messages`、`/models/...:streamGenerateContent` 的 SSE 假服务。
4. Edge/Chrome headless + `--load-extension=extension --dump-dom --virtual-time-budget` 对 `test/fixture/fixture.html` 做端到端断言（fixture 把结果写进 DOM，断言脚本只需 grep）。