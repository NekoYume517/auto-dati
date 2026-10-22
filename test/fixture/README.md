# test/fixture · 检测引擎自测

本目录是 **detector-eng** 负责的端到端自测页，用于验证 `extension/content/` 下的三个经典脚本：

| 文件 | 导出 | 职责 |
|---|---|---|
| `extension/content/presets.js` | `AD.PRESETS`、`AD.PresetKit` | 通用结构推断仅供手动拾取 + 1 个智慧树站点预设 + 检测内核 |
| `extension/content/detector.js` | `AD.Detector` | `scan` / `observe` / `isVisible` / `elementKind` / `buildFromElement` |
| `extension/content/filler.js` | `AD.Filler` | `parse` / `apply` |

`fixture.html` 以 `<script src>` 顺序加载 `protocol.js → settings.js → presets.js → detector.js → filler.js`，
构造覆盖全部 kind 的题目 DOM，跑完整断言，把结果写进：

- `<body data-selftest="pass|fail">`（也写 `data-selftest-pass` / `data-selftest-fail` 计数）
- `#report` 内的可读报告
- `console.log`（`AD.SELFTEST pass | pass=N fail=0 total=N` 摘要 + 逐条明细）

无外网依赖，`file://` 直接打开即可跑（不依赖 `chrome.*`：`AD.Settings` 在没有 storage 时回落到内存缓存）。

---

## 1. 运行命令

### 1.1 语法检查

```powershell
cd D:\code\auto-dati
node --check extension\content\presets.js
node --check extension\content\detector.js
node --check extension\content\filler.js
```

### 1.2 Edge headless 端到端断言（验收命令）

```powershell
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  --headless=new --disable-gpu --no-first-run `
  --user-data-dir="$env:TEMP\edge-ad-test" `
  --virtual-time-budget=4000 `
  --dump-dom "file:///D:/code/auto-dati/test/fixture/fixture.html"
```

输出中必须出现 `data-selftest="pass"`。

> 注：`--dump-dom` 的结果只走 **stdout**。在 PowerShell 里用 `> file` 重定向可能拿到空文件，
> 要判断结果请用管道捕获，例如：
>
> ```powershell
> $out = & 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless=new `
>   --disable-gpu --no-first-run --user-data-dir="$env:TEMP\edge-ad-test" `
>   --virtual-time-budget=4000 --dump-dom "file:///D:/code/auto-dati/test/fixture/fixture.html" 2>&1 | Out-String
> if ($out -match 'data-selftest="(\w+)"') { "STATUS=$($matches[1])" }
> ```

### 1.3 报告文本提取（排查失败项）

```powershell
$m = [regex]::Match($out, '(?s)id="report">(.*?)</div>')
($m.Groups[1].Value -replace '<[^>]+>','') -split "`n" | Where-Object { $_ -match 'FAIL|SELFTEST' }
```

---

## 2. 本次实测结果

环境：Windows + Microsoft Edge（`--headless=new`），`node --check` 三个文件全部通过。

| 检查项 | 结果 |
|---|---|
| `node --check extension/content/presets.js` | ✅ 通过 |
| `node --check extension/content/detector.js` | ✅ 通过 |
| `node --check extension/content/filler.js` | ✅ 通过 |
| fixture 自测（验收命令原样） | ✅ `data-selftest="pass"` |
| 断言总数 | **185** 条 |

窗口尺寸稳定性（同一页面、不同视口，全部通过）：

| `--window-size` | 结果 |
|---|---|
| `800,600` | 历史结果：191/191（当前页面已调整站点预设断言） |
| `1280,900` | 历史结果：191/191（当前页面已调整站点预设断言） |
| `480,400` | 历史结果：191/191（当前页面已调整站点预设断言） |
| 不指定（验收命令） | 历史结果：191/191（当前页面已调整站点预设断言） |

实测输出摘要：

```
历史日志：AD.SELFTEST pass | pass=191 fail=0 total=191
```

---

## 3. 覆盖场景

### 3.1 检测结构（DOM 用例）

| 用例 id | 结构 | 断言重点 |
|---|---|---|
| `q1` | 学习通式 `.questionLi` + `.Zy_ulTop li label` 包裹 radio，选项带 `A.` 前缀，题干带 `1.` 编号 | kind=choice、4 选项、字母 A/B/C/D、剥前缀、剥题号、题干不含选项文本 |
| `q2` | `.question-item` + `B、` 前缀 radio，**已选中** | kind=choice、`answered=true`、`options[0].checked=true` |
| `q3` | `display:none` 的题 | **不被检出** |
| `q4` | 问卷星式 `.field` + `.ui-controlgroup > .ui-radio` **div 伪选项** | kind=choice、`input=null`、题干向上归并到 `.field` 且不含选项文本 |
| `q5` | 判断题 `正确` / `错误` 两个 radio | kind=judge、选项文本正确 |
| `q6` | checkbox 多选 | kind=multi、全部挂到 checkbox |
| `q7` | **多空填空**（两个 text input） | kind=blank、`inputs.length=2` |
| `q8` | **textarea 大题** | kind=qa、`inputs[0].type='textarea'` |
| `q9` | **contenteditable 大题** | kind=qa、`type='contenteditable'` |
| `q10` | **下拉题**（select，含「请选择」占位项） | kind=blank、`type='select'`、占位项被跳过、选项文本正确 |
| `q11` | 智慧树式 `.subject_node` + `.nodeLab li.optionItem`，题干带「单选题 10.」前缀 | kind=choice、剥掉「A、」与「单选题」前缀 |
| `q12` | 雨课堂式 `.option-item > .option-label + .option-text`（字母与文本**分处两个节点**） | kind=multi（题干含「【多选】」）、文本正确拆分为 `Cache-Control` / `ETag` / `Set-Cookie` |
| `q13` | 考试宝式 `.exam-item` + `.q_options > .q_option` | kind=choice、剥掉「A. 」前缀 |
| `q15` | **Shadow DOM（open）** 内的题 | 被检出；`shadowDom=false` 时少 1 题 |
| `qMinimalQA` | Lead 报告的**最小 textarea 题块** | 回归：kind=qa、`inputs.length=1` |
| `qTAAnswered` | textarea **已有内容** | 回归：`answered=true` |
| `qBelow` | 位于**视口下方**、需滚动才可见 | 回归：`viewportOnly=true` 不检出，`false` 时检出 |
| `#ignored-q` | `#ad-overlay-host` 内、且带 `[data-ad-ignore]` | **不被检出** |
| `#noise-nav` | `<nav>` 内的同名 radio 组（导航噪声） | **不被检出** |
| 动态插入 | `observe()` 期间插入的新题 | 回调被触发、`added` 含该题、重新 `scan` 能检出 |

### 3.2 检测语义

- **可见性过滤**：`getBoundingClientRect()` 尺寸为 0、`display:none`、`visibility:hidden`、`opacity<0.05`、祖先隐藏、`hidden` 属性 → 不可见；`viewportOnly` 时额外要求与视口**相交**（不是「rect 非零即可见」）。
- **去重**：同 `root` 取置信度最高（置信度相同时取选项/输入更多者）；同 `id` 再取最高；最后按**嵌套关系剪枝**（外层容器包含已接受题目时丢弃，避免「整个表单」压过单题）。
- **稳定 id**：`AD.hash(kind + stem + 选项 label/text + 输入 type/name/placeholder)`；两次扫描 id 序列完全一致。
- **文档顺序**：按 DOM 顺序排序（Shadow DOM 题目按其宿主在文档中的位置排序）。
- **截断**：`maxPerPage` 按文档顺序取前 N。
- **answered 判定**：radio/checkbox `checked`、伪选项 `selected/is-selected/checked/current` 类或 `aria-checked="true"`/`aria-selected`/`data-selected`、input/textarea 有值、contenteditable 有文本、select 选中非占位项。

### 3.3 `AD.Filler.parse`

- 纯字母 `B`；连写 `BD`；`A,B,D`；`A、C`；`A 和 C`；`选B`
- 带标签：`答案：C`、`正确答案是 D`、`答案：正确`
- 带选项文本：`B. 404 Not Found`
- 判断题归一化：`正确/错误`、`√/×`、`T/F`、`是/否` → `对` / `错`
- 多空：`1. xx\n2. yy`（编号）、`①xx ②yy`（圆圈数字）、`第一空/第二空`
- JSON：`{"answers":["D"]}`、`{"answer":["B","D"]}`、代码块包裹的 JSON
- 简答：整段保留为 1 个答案（含换行）
- 自动切掉 `解析/说明/分析` 段落；空输入 `ok=false`

### 3.4 `AD.Filler.apply`

- **radio**：完整鼠标事件序列（`pointerover/enter → mouseover/enter → pointerdown → mousedown → focus → pointerup → mouseup → click`）+ `checked` + `input`/`change`；单选互斥由浏览器原生行为保证
- **checkbox（多选）**：只勾答案项，其余显式取消（`unchecked`）
- **div 伪选项**：`el.click()` 后校验状态变化（class / `aria-checked`），无变化则尝试内部可交互子元素与父级
- **input / textarea**：原型 setter 赋值（绕过 React/Vue 的 value 拦截）+ `input` / `change` / `blur`，最后再补一次 `input`
- **contenteditable**：`textContent` + `input` / `change` / `blur`
- **select**：按精确文本 → value → 字母序号 → 去前缀比对 → 包含匹配，逐级回退，最后 `change`
- **绝不提交表单**：fixture 挂了 `submit` 监听器，断言全程 `submitted === false`
- `dryRun` 不写页面；匹配不到答案时 `ok=false` 且给出 `detail`

### 3.5 预设元数据

- 设置页只展示站点预设；题型识别规则保留在检测内核中，不提供单独开关
- 目前仅有智慧树站点预设，默认启用；其他站点规则待逐步验证后再加入
- 结构断言：每项都有 `id/name/desc/kind/enabledByDefault/site/urls/match`

---

## 4. 已修复的确定性 bug（回归覆盖）

| bug | 现象 | 修法 | 回归断言 |
|---|---|---|---|
| `presetQA.match` 误杀 textarea | `el.isContentEditable === false` 对 `<textarea>` 恒成立，`qa` 预设恒返回 `[]` | 把 textarea 与 contenteditable 分开判定：textarea 只看 `disabled/readOnly`，contenteditable 才看 `isContentEditable === true` | `qMinimalQA` 三条断言 |
| 伪选项嵌套组方向写反 | `.option-item > (.option-label + .option-text)` 被识别成 3 个独立组，`q12` 漏检 | 改为丢弃「`parent` 落在其它组成员内部」的**内层**组，保留外层 | `q12` 断言 |
| 字母与文本分处两个节点 | `innerText` 粘成 `ACache-Control` | 新增 `splitLabelNode()`：首个子元素恰为单字母时当 label，其余子节点拼正文 | `q12` 文本断言 |
| 题型前缀未剥除 | `单选题 10. …` 的「单选题」残留 | 用 `KIND_WORD` 组合出三类前缀正则（+编号 / +分隔符 / +空白） | `q11` 断言 |
| `isVisible` 忽略设置 | 不传 `opts` 时不做视口判断 | 未显式传 `viewportOnly` 时读 `AD.Settings` 快照 | `qBelow` 三条断言 |

---

## 5. 目录

```
test/fixture/
├── fixture.html   # 自测页（唯一产物，自包含）
└── README.md      # 本文件
```

> 排查用的临时探针页已清理；如需复现某个结构，直接把对应 DOM 片段加进 `fixture.html` 并补断言即可。
