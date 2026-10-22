/* ECharts is bundled locally for MV3 CSP and offline use. */
(function (AD) {
  'use strict';
  const Stats = AD.Statistics;
  const charts = new Map();
  let snapshot = Stats.empty(), active = false, generation = 0;
  const names = { input: '输入 Token', output: '输出 Token', cacheRead: '缓存读取', cacheWrite: '缓存写入', cacheMiss: '缓存未命中', reasoning: '推理 Token', toolInput: '工具输入', total: '总 Token' };
  const $ = id => document.getElementById(id);
  const fmt = v => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(v);
  const duration = ms => ms < 1000 ? fmt(ms) + ' ms' : fmt(ms / 1000) + ' s';
  function send(type, extra) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.id) return resolve(Stats.empty());
      chrome.runtime.sendMessage(Object.assign({ type }, extra), result => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!result || !result.ok) return reject(new Error(result && result.error || '无法读取统计数据'));
        resolve(result.statistics);
      });
    });
  }
  AD.StatisticsClient = {
    get: () => send('DATI_GET_STATISTICS'),
    replace: raw => send('DATI_IMPORT_STATISTICS', { statistics: Stats.validate(raw) })
  };
  function chart(id, option, text, hasData) {
    const node = $(id);
    node.setAttribute('aria-label', text);
    if (!globalThis.echarts) { node.textContent = '图表引擎未加载，仍可查看上方汇总与下方明细。'; return; }
    let instance = charts.get(id);
    if (!instance) { instance = echarts.init(node, null, { renderer: 'svg' }); charts.set(id, instance); }
    const light = document.body.dataset.theme === 'light' || (document.body.dataset.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
    const color = light ? '#677080' : '#a6aebb', line = light ? '#e7eaef' : '#30353c';
    const motion = document.body.dataset.noanim !== '1' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const base = { animation: motion, animationDuration: 220, animationDurationUpdate: 180,
      textStyle: { fontFamily: 'system-ui, Microsoft YaHei, sans-serif', color },
      aria: { enabled: true, description: text },
      tooltip: { trigger: 'axis', renderMode: 'richText', backgroundColor: light ? '#ffffff' : '#22262d', borderColor: line, textStyle: { color: light ? '#20242d' : '#edf0f5' } },
      legend: { bottom: 0, textStyle: { color }, itemWidth: 10, itemHeight: 8 },
      graphic: hasData ? [] : [{ type: 'text', left: 'center', top: '42%', style: { text: '暂无数据，完成一次请求后显示', fill: color, font: '13px system-ui' } }],
      grid: { top: 26, right: 12, bottom: 56, left: 54 },
      xAxis: { type: 'category', axisLabel: { color, fontSize: 10 }, axisLine: { lineStyle: { color: line } }, axisTick: { show: false } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color, fontSize: 10 }, splitLine: { lineStyle: { color: line, type: 'dashed' } } }
    };
    const config = Object.assign({}, base, option);
    config.xAxis = Object.assign({}, base.xAxis, option.xAxis);
    config.yAxis = Object.assign({}, base.yAxis, option.yAxis);
    instance.setOption(config, true);
    instance.resize();
  }
  function render() {
    if (!active) return;
    const days = Number($('statsPeriod').value) || 30;
    const start = new Date(); start.setDate(start.getDate() - days + 1);
    const from = Stats.day(start), today = Stats.day();
    const groups = snapshot.groups.filter(g => g.day >= from && g.day <= today);
    const total = Stats.bucket(), byDay = new Map(), models = new Map(), kinds = new Map();
    for (let i = 0; i < days; i++) { const d = new Date(start); d.setDate(d.getDate() + i); byDay.set(Stats.day(d), Stats.bucket()); }
    for (const g of groups) {
      Stats.add(total, g); Stats.add(byDay.get(g.day), g);
      if (!models.has(g.model)) models.set(g.model, Stats.bucket());
      Stats.add(models.get(g.model), g); kinds.set(g.kind, (kinds.get(g.kind) || 0) + g.requests);
    }
    $('statsRequests').textContent = fmt(total.requests);
    $('statsSuccess').textContent = total.requests ? fmt(total.success / total.requests * 100) + '%' : '—';
    $('statsFailures').textContent = total.failed + ' 次失败 · ' + total.cancelled + ' 次停止';
    const latency = total.metrics.ms;
    $('statsLatency').textContent = latency.samples ? duration(latency.sum / latency.samples) : '—';
    const first = total.metrics.firstChunkMs;
    $('statsFirst').textContent = first.samples ? '首个响应 ' + duration(first.sum / first.samples) : '首个响应暂无数据';
    const tokens = total.metrics.total;
    $('statsTotal').textContent = tokens.samples ? fmt(tokens.sum) : total.requests ? '未提供' : '0';
    $('statsCoverage').textContent = tokens.samples + ' / ' + total.requests + ' 次请求有 Token 用量';
    $('statsUpdated').textContent = '本地统计 · 最近 ' + days + ' 天 · ' + total.partial + ' 次返回不完整';
    const host = $('statsMetrics'); host.replaceChildren();
    for (const [key, label] of Object.entries(names)) {
      const m = total.metrics[key], card = document.createElement('div'); card.className = 'usage-metric';
      const title = document.createElement('span'), value = document.createElement('strong'), note = document.createElement('small');
      title.textContent = label; value.textContent = m.samples ? fmt(m.sum) : total.requests ? '未提供' : '—';
      note.textContent = m.samples ? m.samples + ' 次请求已上报' : '取决于供应商返回字段';
      card.append(title, value, note); host.appendChild(card);
    }
    const data = Array.from(byDay.values()), labels = Array.from(byDay.keys()).map(v => v.slice(5));
    const bar = (name, key, color) => ({ name, type: 'bar', stack: 'requests', barMaxWidth: 16, itemStyle: { color }, data: data.map(v => v[key]) });
    chart('statsRequestsChart', { xAxis: { data: labels }, series: [bar('完成', 'success', '#818cf8'), bar('失败', 'failed', '#e58989'), bar('停止', 'cancelled', '#7e8796')] }, '每日请求数量，按完成、失败、停止分组', !!total.requests);
    chart('statsTokensChart', { xAxis: { data: labels }, series: [
      { name: '输入', type: 'bar', stack: 'tokens', barMaxWidth: 16, itemStyle: { color: '#818cf8' }, data: data.map(v => v.metrics.input.samples ? v.metrics.input.sum : null) },
      { name: '输出（含推理）', type: 'bar', stack: 'tokens', barMaxWidth: 16, itemStyle: { color: '#5cbfae' }, data: data.map(v => v.metrics.output.samples ? v.metrics.output.sum : null) }
    ] }, '每日 Token 用量，输入和输出分开；缓存是输入子项，推理是输出子项，不再重复叠加', !!(total.metrics.input.samples || total.metrics.output.samples));
    const body = $('statsModels'); body.replaceChildren();
    const ordered = Array.from(models.entries()).sort((a, b) => b[1].requests - a[1].requests);
    if (!ordered.length) { const row = body.insertRow(), cell = row.insertCell(); cell.colSpan = 5; cell.textContent = '暂无模型用量。请求完成后自动记录。'; cell.className = 'stats-empty'; }
    for (const [model, m] of ordered) {
      const row = body.insertRow();
      [model, fmt(m.requests), fmt(m.success), m.metrics.total.samples ? fmt(m.metrics.total.sum) : '未提供', m.metrics.ms.samples ? duration(m.metrics.ms.sum / m.metrics.ms.samples) : '—'].forEach(v => { row.insertCell().textContent = v; });
    }
    $('statsKinds').textContent = Array.from(kinds.entries()).map(([kind, count]) => ((AD.KIND_LABEL || {})[kind] || (kind === 'screenshot' ? '截图搜题' : kind)) + ' ' + count).join(' · ') || '暂无题型记录';
  }
  async function refresh() {
    const id = ++generation;
    try { const data = await AD.StatisticsClient.get(); if (id !== generation) return; snapshot = Stats.validate(data); render(); }
    catch (e) { if (id === generation) $('statsUpdated').textContent = '读取失败：' + e.message; }
  }
  document.addEventListener('DOMContentLoaded', function () {
    $('statsPeriod').addEventListener('change', render);
    $('btnRefreshStatistics').addEventListener('click', refresh);
    document.addEventListener('dati:viewchange', function (e) { active = e.detail === 'statistics'; if (active) refresh(); });
    new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'data-noanim', 'style'] });
    const observer = new ResizeObserver(() => { if (active) charts.forEach(c => c.resize()); });
    ['statsRequestsChart', 'statsTokensChart'].forEach(id => observer.observe($(id)));
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', render);
    if (globalThis.chrome && chrome.storage) chrome.storage.onChanged.addListener(function (changes, area) { if (area === 'local' && changes[Stats.KEY] && active) refresh(); });
  });
}(globalThis.AD = globalThis.AD || {}));
