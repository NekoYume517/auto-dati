# AutoDati · 自动答题浏览器插件

[源码仓库](https://github.com/NekoYume517/auto-dati) · [下载最新版本](https://github.com/NekoYume517/auto-dati/releases/latest) · [发布维护](docs/RELEASING.md) · [MIT 许可证](LICENSE)

一个**纯浏览器扩展**（Manifest V3）的答题助手：仅按已配置的站点规则或用户自定义规则自动识别题目，调用你自己的 LLM API 自动作答或弹窗流式作答，并支持区域截图答题。

> **纯插件，零后端。** 没有任何本地服务、原生客户端、Python/Node 守护进程或额外的安装步骤。所有模型请求由扩展的 Service Worker 直接发往你填写的 API 地址；截图在本机内存里裁剪，不上传到任何第三方。

---

## 安装与更新

在 [Releases](https://github.com/NekoYume517/auto-dati/releases/latest) 下载带版本号的 CRX 或 ZIP。CRX3 使用固定私钥签名；是否允许直接安装取决于浏览器策略，普通 Windows/macOS Chrome 不支持直接安装任意站外 CRX。ZIP 可解压到固定目录，在扩展管理页开启开发者模式并“加载已解压的扩展”。

扩展会每 6 小时检查 GitHub 正式版本，也可以在 **设置 → 关于与更新** 或工具栏面板手动检查。发现新版本后跳转 Releases，下载并确认安装；不会远程执行代码或自动覆盖已解压目录。使用 ZIP 更新时覆盖原目录，再点击扩展的“重新加载”。

Release ZIP 与 CRX 使用同一个发布 ID；源码开发版保留原开发 ID。切换 ID 前请在“数据”中导出配置与统计，再导入新安装。签名私钥不在开源仓库或发布附件中。

浏览器分发限制见 [Chrome 官方说明](https://developer.chrome.com/docs/extensions/how-to/distribute/) 与 [Edge 官方说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/hosting-and-updating)。

## 功能

### 两种模式

| 模式 | 行为 |
|---|---|
| **自动答题** | 检测到页面上的题目后直接请求模型并**自动填入**答案，不弹面板。关掉即完全不检测。 |
| **弹窗模式** | 检测到题目后在题块旁弹出面板，答案**流式**打字输出，由你点「填入」确认。 |

两个模式可独立开关，也可同时开启。面板支持拖拽、缩放、Ctrl+Enter 填入、Esc 关闭、重试、停止、复制。

完整设置的一级「设置」入口下，按「常规、弹窗设置、截图与快捷键、外观、高级」二级 Tab 分类，每项配置只出现一次。快捷设置保留自动弹窗、自动答题、自动翻页三个常用开关，反馈项默认折叠。自动翻页总开关默认关闭；按钮定位随命中的答题规则生效，不再全局猜测“下一页”文字。智慧树规则自带下一题按钮配置，自定义规则可编辑、点选按钮并随 Base64 编码导入导出。按钮缺失、禁用或页面未切换时停止，不自动提交作业。

题目角标默认隐藏，可在快捷设置的「页面反馈」或完整设置 → 弹窗设置 中切换。题目位置框和自动翻页点击高亮也集中在这里，互相独立。

### 站点预设与自定义规则

站点与答题规则只提供站点预设和自定义站点规则，不再展示通用题型预设开关。当前内置站点预设只有智慧树，默认开启；其他站点规则会在逐步验证后加入。自定义规则支持 Base64 文本导出与粘贴导入，导入时合并规则并跳过重复 ID。

### 截图搜题（单击选择 / 拖动框选）

快捷键 `Alt+Q`（或点击扩展图标 → 「截图搜题」）→ **单击选择元素，拖动框选区域** → 扩展自动截图、在本机裁剪 → 发给模型流式作答 → 显示答案预览。

- 单击题干或选项任意位置，自动向上归并到整道题；拖动则选取自由矩形，无需切换模式。两种操作都支持 Esc / 右键退出，背景仅压暗。
- **视觉兜底**：若当前模型配置开启了「视觉」（vision），会把裁剪后的图片与页面文本**一起**发送；模型不支持视觉时只发文本，不会浪费额度。
- 若点选区域落在题块上，面板的「填入」可直接把答案写回表单。

### 识别不了？用元素拾取器快速加模板

快捷键 `Alt+Shift+E`（或右键菜单「拾取元素，添加题目模板」）：

1. 点击页面上题目所在的整块区域（自动归并到题块，而不是一小段文字）
2. 扩展自动推断 **题型 / 题干选择器 / 选项选择器 / 输入框选择器**，并生成能命中**所有同类题目**的根选择器（优先 `div.q` 这类模式选择器，而不是 `#q1` 这种只中一题的 ID）
3. 可手动改题型、改选择器，「预览命中」当场看能识别出几道题
4. 「保存模板」写入自定义站点规则，立即生效；之后可在 站点与答题规则 → 自定义站点规则 里管理

### iframe / 嵌套框架

扩展注入所有框架（含 `about:blank` 与 `srcdoc`）：

- 子框架里检测到的题目会**转交顶层**统一弹面板，答案回传给子框架填入
- 默认保持 iframe 题目透传；可在 设置 → 高级 → 高级识别与扫描 关闭。跨源或站点策略禁止扩展脚本注入时，浏览器本身可能无法访问该框架
- 同一位置可选开启「显示题目位置框」，用绿色边框快速检查实际识别到的题块
- 截图坐标会沿 `frameElement` 链（同源）或 `postMessage` 逐级换算（跨源）到顶层视口坐标，保证裁剪区域准确
- 元素拾取和添加模板支持逐层进入跨域、动态加载、`sandbox/srcdoc` 以及 Shadow DOM 内的 iframe；顶层按实际命中路径定位，避免选到被遮挡的框架。缩放和边框会参与坐标换算。
- 框架内截图作答统一在顶层显示答案，并将答案回填到所属文档；仅开启弹窗模式也能转交子框架题目。
- 顶层面板只出现一份，不会每个 iframe 各弹一个

### 界面与滚动

- 设置页、工具栏弹窗和题目助手使用统一的工作台设计，支持深色、浅色、自定义强调色及窄屏布局。
- 默认答案面板停靠在右侧滚动条内侧，按题块的实时位置跟随滚动，也支持拖动调整位置。
- 题目滚出视口或被滚动容器裁切时，面板暂时隐藏；滚回后恢复原答案，不重新请求。题块删除或内容切换时，旧面板自动关闭。
- 进出场、切页与操作反馈均支持关闭，并尊重系统的「减少动态效果」设置。

### 快捷键

| 动作 | 默认键 |
|---|---|
| 截图搜题（单击选元素 / 拖动框选） | `Alt+Q` |
| 对鼠标下的题目作答 | `Alt+Shift+Q` |
| 拾取元素加模板 | `Alt+Shift+E` |
| 切换自动答题 | `Alt+Shift+Z` |
| 切换弹窗模式 | `Alt+Shift+X` |

页面内快捷键可在设置页录制修改；也可以在 `chrome://extensions/shortcuts` 里改扩展级快捷键。

### 支持的 API 格式

| 格式 | 默认路径 | 认证 |
|---|---|---|
| **Chat Completions** | `/chat/completions` | `Authorization: Bearer <key>` |
| **Responses API** | `/responses` | `Authorization: Bearer <key>` |
| **Claude Messages** | `/messages` | `x-api-key` + `anthropic-version` |
| **Gemini** | `/models/{model}:streamGenerateContent` | `x-goog-api-key` |

四种格式均支持 SSE 流式与非流式回退、图片输入、自定义请求头与额外 body 字段。可保存多套配置随时切换。

「从供应商获取模型」使用当前 URL 与 Key 访问 `/models`，在模态框中搜索并选择使用；支持四种协议的鉴权和常见分页格式。

### 统计与备份

- 「统计数据」使用本地 ECharts 展示请求量、完成率、耗时、每日趋势、模型用量，以及输入、输出、缓存读取/写入、未命中、推理、工具输入与总 Token。
- 未返回的 Token 字段显示「未提供」；缓存与推理不重复累计。各协议的字段定义见 [统计口径](docs/USAGE-METRICS.md)。
- 导出同时包含设置与统计；导入完整备份同时恢复两者，重复导入不会累加。旧版设置文件保留当前统计。
- 页面 UI 使用 `dati-` 前缀，减少广告过滤器对 `ad-` 标识的误判；原配置存储键保留兼容。
- 覆盖层 CSS 随内容脚本同步装载，Toast 不再等待异步样式请求。编辑 `overlay.css` 后运行 `node tools/build-overlay-style.mjs` 同步生成脚本，可用 `--check` 检查一致性。

---

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 **`extension/`** 目录
4. 点浏览器工具栏的 AutoDati 图标 → 快捷设置面板 → 「打开完整设置」
5. 在「模型 API」里填入 Base URL、API Key、模型名，点「测试连接」确认可用

首次使用请先配置 API 并测试连接，概览页会一直提示「待配置」直到密钥可用。

---

## 目录结构

```
extension/
  manifest.json           MV3 清单（固定 key，扩展 ID 稳定）
  common/
    protocol.js           消息/常量/哈希/日志
    settings.js           设置默认值、深合并、持久化、订阅
    theme.css             设计令牌与公共组件类
  background/
    service-worker.js     消息路由、流式端口、快捷键、右键菜单
    llm.js                四种 API 格式适配 + SSE 解析
    screenshot.js         captureVisibleTab + OffscreenCanvas 裁剪
  content/
    presets.js            题型识别内核与站点预设（检测规则）
    detector.js           题块识别、可见性过滤、去重、MutationObserver
    filler.js             答案解析与写回页面
    overlay.js            Shadow DOM 面板、流式渲染、轻提示、避让排布
    overlay.css           面板样式（自包含，不污染宿主页）
    frame.js              跨帧坐标换算与子框架题目转交
    picker.js             元素拾取器：推断结构 + 快速生成题目模板
    capture.js            元素点选、页面内快捷键、截图请求
    content.js            主控：模式调度、请求队列、填入、指令
  ui/
    options.html/js/css   完整设置页
    popup.html/js/css     点击图标的快捷设置面板
test/
  unit.mjs                适配层单元/集成测试（对 mock 服务）
  e2e.mjs                 真实加载扩展的端到端测试
  frames.mjs              iframe / 元素拾取 / 视觉兜底测试
  complex-frames.mjs      多层跨域 / sandbox / Shadow DOM / 缩放 / 拾取回填测试
  hover-hint.mjs          角标误识别 / 隐藏与设置同步测试
  auto-navigation.mjs     全局翻页 / 加载等待 / 多题填写 / 停止条件测试
  integration.mjs         预设单独启用 / 自定义规则测试
  shots.mjs               真实扩展环境下的 UI 截图
  mock-llm-server.mjs     四种格式的模拟 LLM 服务
  e2e/page.html           测试题目页
  e2e/frames.html         iframe 测试页
  fixture/                检测引擎自测页（185 条断言）
docs/CONTRACT.md          接口契约
```

---

## 开发与测试

```bash
# 适配层：四种格式 × 流式/非流式 × 图片输入 × 错误处理
node test/unit.mjs            # 64 项

# 端到端：真实加载扩展 → 自动答题/弹窗/快捷键/截图/总开关
node test/e2e.mjs             # 40 项

# iframe / 元素拾取 / 视觉兜底
node test/frames.mjs          # 25 项

# 预设单独启用 / 自定义规则 / 站点预设
node test/integration.mjs     # 18 项

# 检测引擎自测（fixture 页内断言）
# 直接打开 test/fixture/fixture.html 查看结果    # 185 项
```

合计 **338 项断言**全部通过。`e2e.mjs` 用 Edge/Chrome 的 DevTools 协议驱动，不依赖任何 npm 包（Node ≥ 22 自带 `WebSocket` 与 `fetch`）。它会启动 mock LLM 服务、加载未打包扩展、写入测试配置，然后断言 DOM 的真实状态。

---

## 设计要点

- **扩展 ID 固定**：manifest 内置 `key`，加载路径变化不会重置 ID，设置与快捷键不丢。
- **样式隔离**：面板与框选器全部挂在 Shadow DOM 里，自带令牌与 reset，不受宿主页 CSS 影响。
- **不自动提交**：只填入答案，绝不点提交按钮。
- **跳过已答题**：默认跳过已作答的题，并对同一道题做冷却，避免重复请求。
- **总开关**：一键让扩展完全静默（不检测、不弹窗、快捷键失效）。
- **失败可读**：鉴权失败、限流、超时、网络错误都会在面板里给出可读原因，而不是静默失败。

## 常见问题

### AdGuard / 广告拦截器把扩展拦了

AdGuard 等拦截器的「可疑扩展名/注入脚本」过滤规则可能拦掉本扩展的内容脚本（表现为：设置页正常，但网页上毫无反应）。任选其一解决：

1. **AdGuard 浏览器扩展** → 设置 → 「保护」→ 排除管理 → 把本扩展的 ID 加入排除（或临时暂停 AdGuard 后刷新页面验证是不是它拦的）。
2. AdGuard **桌面版** → 「设置」→「扩展」/「反横幅」高级规则里加放行规则：
   `#@%#//scriptlet('abort-on-property-read', 'AD')` 不需要；直接对本扩展 ID 所在站点关用：
   在 AdGuard 的「用户规则」加 `@@||zhihuishu.com^$extension` 不生效的话，最直接的是在 AdGuard 设置 → 「浏览安全」→ 排除站点列表中加入学习站点域名。
3. 验证方法：打开 `edge://extensions` → AutoDati → 「服务工作进程」点开看有没有报错；再在目标页面按 F12 控制台过滤 `AutoDati`，出现 `[AutoDati] ready` 即注入成功。

### 智慧树页面没弹出题目

- 扩展会按域名 `*.zhihuishu.com / *.zhihuishu.cn` **自动启用**智慧树专属规则（题干 `.subject_describe`、选项 `.nodeLab`），无需手动打开站点预设开关。
- 智慧树题干可能位于封闭的 Shadow DOM 中。扩展通过浏览器的 `chrome.dom.openOrClosedShadowRoot` 读取并监听题干，无需修改网页脚本。
- 题干确实未加载、选项正文不完整时不请求模型；内容稳定后才触发。文本更新、滚动和切题会重扫，心跳每 6 秒兜底。
- 同一道题在当前页面生命周期内只自动请求一次，避免冷却结束、请求失败或 DOM 重绘后反复弹窗；需要再次作答时可手动「重试」，手动重试可绕过题目冷却。
- 拾取模板会使用单题 `.examPaper_subject`、真实题干 `.subject_describe` 和完整选项 `.nodeLab`，并兼容旧模板中的错误选项选择器；覆盖多道题的整页模板会被跳过。
- 右侧「剩余时间 / 完成率 / 答题卡题号」面板已按结构排除，不会被判成题目。

### 推理模型想关掉思考

设置 → 模型 API → 「思考模式」：**关闭思考**。按模型家族自动注入对应参数（GLM/豆包 `thinking.disabled`、Qwen3 `enable_thinking:false`、GPT-5/o 系 `reasoning_effort:minimal`、Gemini 2.5 `thinkingBudget:0`、Claude 不开 thinking）。DeepSeek-R1 官方不支持关闭，会自动忽略。

### 自定义规则只想在特定网站生效

编辑规则时填「**生效域名**」：支持多个（逗号/换行分隔）、自动匹配子域（`example.com` 含 `a.example.com`）、`*.example.com`（仅子域）、完整 URL 前缀、`/正则/`。留空=所有站点。

## 隐私

API Key 保存在 `chrome.storage.local`（仅本机）。题目文本与截图只发送到你自己配置的 API 地址。扩展不包含任何统计、遥测或第三方域名请求。
