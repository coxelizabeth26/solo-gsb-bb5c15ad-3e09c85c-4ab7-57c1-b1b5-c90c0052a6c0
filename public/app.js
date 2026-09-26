'use strict';

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

function fmt(mhz) {
  // 最多 6 位小数，去掉尾随零
  return parseFloat(Number(mhz).toFixed(6)).toString();
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let devices = [];
let lastCoordResult = null; // 最近一次协调结果（用于保存方案）

/* ---------- 设备列表 ---------- */

async function loadDevices() {
  const data = await api('/api/devices');
  devices = data.devices;
  renderDevices(data.max);
  await refreshConflicts();
}

function renderDevices(max) {
  const tbody = $('#device-tbody');
  $('#device-count').textContent = `${devices.length} / ${max}`;
  $('#btn-add').disabled = devices.length >= max;
  $('#btn-seed').style.display = devices.length === 0 ? '' : 'none';

  if (devices.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">尚未录入设备，请在下方添加或载入示例数据</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  devices.forEach((d, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="muted">${i + 1}</td>
      <td><input type="text" data-field="name" value="" maxlength="60"></td>
      <td><input type="number" data-field="frequency" step="0.000001" min="0.000001" class="freq"></td>
      <td><input type="number" data-field="guard" step="0.000001" min="0" class="freq"></td>
      <td><input type="checkbox" data-field="locked"></td>
      <td>
        <button class="btn btn-sm btn-primary" data-act="save">保存</button>
        <button class="btn btn-sm btn-danger" data-act="del">删除</button>
      </td>`;
    tr.querySelector('[data-field="name"]').value = d.name;
    tr.querySelector('[data-field="frequency"]').value = d.frequency;
    tr.querySelector('[data-field="guard"]').value = d.guard;
    tr.querySelector('[data-field="locked"]').checked = d.locked;

    tr.querySelector('[data-act="save"]').addEventListener('click', async () => {
      try {
        await api(`/api/devices/${d.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: tr.querySelector('[data-field="name"]').value,
            frequency: Number(tr.querySelector('[data-field="frequency"]').value),
            guard: Number(tr.querySelector('[data-field="guard"]').value),
            locked: tr.querySelector('[data-field="locked"]').checked,
          }),
        });
        toast(`已保存「${d.name}」`);
        await loadDevices();
      } catch (e) { toast(e.message, true); }
    });

    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`确定删除设备「${d.name}」？`)) return;
      try {
        await api(`/api/devices/${d.id}`, { method: 'DELETE' });
        toast('已删除');
        await loadDevices();
      } catch (e) { toast(e.message, true); }
    });

    tbody.appendChild(tr);
  });
}

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/devices', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#add-name').value,
        frequency: Number($('#add-freq').value),
        guard: Number($('#add-guard').value),
        locked: $('#add-locked').checked,
      }),
    });
    $('#add-name').value = '';
    $('#add-freq').value = '';
    $('#add-locked').checked = false;
    toast('设备已添加');
    await loadDevices();
  } catch (err) { toast(err.message, true); }
});

$('#btn-seed').addEventListener('click', async () => {
  try {
    await api('/api/seed', { method: 'POST' });
    toast('已载入示例数据');
    await loadDevices();
  } catch (e) { toast(e.message, true); }
});

/* ---------- 互调冲突 ---------- */

async function refreshConflicts() {
  const data = await api('/api/conflicts');
  const box = $('#conflict-result');
  const badge = $('#conflict-count');

  if (devices.length < 2) {
    badge.textContent = '—';
    badge.className = 'badge';
    box.innerHTML = '<p class="empty-state">至少需要 2 个设备才能进行互调分析</p>';
    return;
  }

  badge.textContent = data.count === 0 ? '无冲突' : `${data.count} 处冲突`;
  badge.className = `badge ${data.count === 0 ? 'ok' : 'danger'}`;

  if (data.count === 0) {
    box.innerHTML = '<p class="ok-text" style="margin:10px 0 0">✓ 当前频率配置无互调冲突</p>';
    return;
  }

  const rows = data.conflicts.map((c) => `
    <tr>
      <td><span class="tag">${c.productType}</span></td>
      <td class="freq">${fmt(c.product)}</td>
      <td>${esc(c.source[0].name)} <span class="freq muted">(${fmt(c.source[0].frequency)})</span>
        × ${esc(c.source[1].name)} <span class="freq muted">(${fmt(c.source[1].frequency)})</span></td>
      <td class="danger-text">${esc(c.victim.name)} <span class="freq">(${fmt(c.victim.frequency)} ± ${fmt(c.victim.guard)})</span></td>
      <td class="freq">${(c.deviation * 1000).toFixed(1)} kHz</td>
    </tr>`).join('');

  box.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>互调类型</th><th>互调积 (MHz)</th><th>来源频道</th>
        <th>受影响频道（保护区）</th><th>偏差</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

$('#btn-recalc').addEventListener('click', () => refreshConflicts().catch((e) => toast(e.message, true)));

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------- 自动协调 ---------- */

/* 现场占用频段（临时参数，仅随协调请求提交，不改动设备数据） */
function addOccupiedRow(lo = '', hi = '') {
  const wrap = $('#occupied-rows');
  const row = document.createElement('div');
  row.className = 'occupied-row';
  row.innerHTML = `
    <span class="muted">占用</span>
    <input type="number" class="occ-lo" step="0.000001" placeholder="下限 MHz" />
    <span class="muted">–</span>
    <input type="number" class="occ-hi" step="0.000001" placeholder="上限 MHz" />
    <button type="button" class="btn btn-sm btn-danger" data-act="del-occ">移除</button>`;
  row.querySelector('.occ-lo').value = lo;
  row.querySelector('.occ-hi').value = hi;
  row.querySelector('[data-act="del-occ"]').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

$('#btn-add-occupied').addEventListener('click', () => addOccupiedRow());

/** 读取占用区间：整行留空则忽略；仅填一端或下限大于上限时报错 */
function readOccupiedBands() {
  const bands = [];
  for (const row of $('#occupied-rows').querySelectorAll('.occupied-row')) {
    const loRaw = row.querySelector('.occ-lo').value.trim();
    const hiRaw = row.querySelector('.occ-hi').value.trim();
    if (loRaw === '' && hiRaw === '') continue;
    if (loRaw === '' || hiRaw === '') {
      throw new Error('占用区间需同时填写下限与上限（MHz），或整行留空');
    }
    const lo = Number(loRaw);
    const hi = Number(hiRaw);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('占用频段必须是有效数值（MHz）');
    }
    if (lo > hi) throw new Error(`占用区间无效：下限 ${lo} 不能大于上限 ${hi}`);
    bands.push({ lo, hi });
  }
  return bands;
}

/** 实际参与避让（已合并）的占用区间摘要文本 */
function occupiedSummary(bands) {
  if (!bands || bands.length === 0) return '';
  return bands.map((b) => `${fmt(b.lo)}–${fmt(b.hi)} MHz`).join('、');
}

$('#coord-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let occupiedBands;
  try {
    occupiedBands = readOccupiedBands();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const btn = $('#btn-coordinate');
  btn.disabled = true;
  btn.textContent = '协调中…';
  try {
    const result = await api('/api/coordinate', {
      method: 'POST',
      body: JSON.stringify({
        bandMin: Number($('#band-min').value),
        bandMax: Number($('#band-max').value),
        step: Number($('#step').value),
        maxOffset: Number($('#max-offset').value),
        occupiedBands,
      }),
    });
    lastCoordResult = result;
    renderCoordResult(result);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始协调';
  }
});

function renderCoordResult(r) {
  const box = $('#coord-result');
  const rows = r.assignments.map((a) => {
    const moved = a.offset > 0;
    return `<tr>
      <td>${esc(a.name)} ${a.locked ? '<span class="tag locked">锁定</span>' : ''}</td>
      <td class="freq">${fmt(a.original)}</td>
      <td class="freq ${moved ? 'ok-text' : ''}">${fmt(a.frequency)}</td>
      <td class="freq">${moved ? `±${fmt(a.offset)}`.replace('+', '') : '0'}</td>
      <td>${moved ? '<span class="tag moved">已调整</span>' : '<span class="muted">不变</span>'}</td>
    </tr>`;
  }).join('');

  const table = `
    <div class="table-wrap"><table>
      <thead><tr><th>频道</th><th>原频率 (MHz)</th><th>新频率 (MHz)</th><th>偏移 (MHz)</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  const occText = occupiedSummary(r.params && r.params.occupiedBands);
  const occLine = occText
    ? `<p class="muted" style="margin:0 0 6px">🚧 现场占用频段（已避让）：${esc(occText)}</p>`
    : '';

  if (r.solved) {
    box.innerHTML = `
      <div class="result-box success">
        <p class="ok-text" style="margin:0 0 4px">✓ 协调成功：找到无冲突方案，总偏移 ${fmt(r.totalOffset)} MHz
          ${r.capped ? '<span class="warn-text">（搜索已截断，可能非全局最优）</span>' : ''}</p>
        ${r.reason ? `<p class="warn-text" style="margin:0 0 4px">${esc(r.reason)}</p>` : ''}
        ${occLine}
        ${table}
        <div class="save-plan-row">
          <button class="btn btn-primary" id="btn-apply-result">应用到设备</button>
          <input type="text" id="plan-name" placeholder="方案名称，如：主舞台 A 组" maxlength="60">
          <button class="btn" id="btn-save-plan">保存方案</button>
        </div>
      </div>`;
    $('#btn-apply-result').addEventListener('click', () => applyAssignments(r.assignments));
    $('#btn-save-plan').addEventListener('click', () => savePlan(r));
  } else {
    box.innerHTML = `
      <div class="result-box failure">
        <p class="warn-text" style="margin:0 0 4px">✗ 未找到无冲突方案，已保持原有频率</p>
        <p class="muted" style="margin:0 0 8px">${esc(r.reason || '')}</p>
        ${occLine}
        ${table}
      </div>`;
  }
}

async function applyAssignments(assignments) {
  try {
    for (const a of assignments) {
      const dev = devices.find((d) => d.id === a.id);
      if (!dev) continue;
      await api(`/api/devices/${a.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: dev.name,
          frequency: a.frequency,
          guard: dev.guard,
          locked: dev.locked,
        }),
      });
    }
    toast('已将协调结果应用到设备');
    await loadDevices();
  } catch (e) { toast(e.message, true); }
}

async function savePlan(r) {
  const nameInput = $('#plan-name');
  const name = nameInput.value.trim() || `方案 ${new Date().toLocaleString('zh-CN')}`;
  try {
    await api('/api/plans', {
      method: 'POST',
      body: JSON.stringify({
        name,
        params: r.params,
        assignments: r.assignments,
        totalOffset: r.totalOffset,
        solved: r.solved,
      }),
    });
    toast(`方案「${name}」已保存`);
    nameInput.value = '';
    await loadPlans();
  } catch (e) { toast(e.message, true); }
}

/* ---------- 已保存方案 ---------- */

async function loadPlans() {
  const plans = await api('/api/plans');
  $('#plan-count').textContent = plans.length;
  const box = $('#plan-list');
  if (plans.length === 0) {
    box.innerHTML = '<p class="empty-state">暂无保存的方案</p>';
    return;
  }
  box.innerHTML = '';
  for (const p of plans) {
    const div = document.createElement('div');
    div.className = 'plan-item';
    const assignments = Array.isArray(p.assignments) ? p.assignments : [];
    const params = p.params || {};
    const rows = assignments.map((a) => `
      <tr>
        <td>${esc(a.name || `设备 ${a.id}`)} ${a.locked ? '<span class="tag locked">锁定</span>' : ''}</td>
        <td class="freq">${a.original === undefined || a.original === null ? '—' : fmt(a.original)}</td>
        <td class="freq">${a.frequency === undefined || a.frequency === null ? '—' : fmt(a.frequency)}</td>
        <td class="freq">${a.offset > 0 ? fmt(a.offset) : '0'}</td>
      </tr>`).join('');
    const num = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? '—' : fmt(Number(v)));
    div.innerHTML = `
      <details>
        <summary><strong>${esc(p.name)}</strong>
          <span class="badge ${p.solved ? 'ok' : 'danger'}">${p.solved ? '无冲突' : '无解'}</span>
        </summary>
        <p class="plan-meta">
          保存时间：${esc(p.createdAt)} ｜ 频段 ${num(params.bandMin)}–${num(params.bandMax)} MHz ｜
          步进 ${num(params.step)} MHz ｜ 最大偏移 ${num(params.maxOffset)} MHz ｜
          总偏移 <span class="freq">${num(p.totalOffset)}</span> MHz
        </p>
        <p class="plan-meta">现场占用频段：${occupiedSummary(params.occupiedBands) ? '🚧 ' + esc(occupiedSummary(params.occupiedBands)) : '无'}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>频道</th><th>原频率 (MHz)</th><th>方案频率 (MHz)</th><th>偏移 (MHz)</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div class="plan-actions">
          <button class="btn btn-sm btn-primary" data-act="apply">预览后应用</button>
          <button class="btn btn-sm btn-danger" data-act="del">删除方案</button>
        </div>
      </details>`;
    div.querySelector('[data-act="apply"]').addEventListener('click', () => openPreview(p.id));
    div.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`确定删除方案「${p.name}」？`)) return;
      try {
        await api(`/api/plans/${p.id}`, { method: 'DELETE' });
        toast('方案已删除');
        await loadPlans();
      } catch (e) { toast(e.message, true); }
    });
    box.appendChild(div);
  }
}

$('#btn-refresh-plans').addEventListener('click', () => loadPlans().catch((e) => toast(e.message, true)));

/* ---------- 方案应用前预览 ---------- */

let previewState = null; // { planId, token, data }

const modal = $('#preview-modal');

function closePreview() {
  modal.hidden = true;
  previewState = null;
}

/** 渲染预览结果（检查通过 / 失败均用同一套明细） */
function renderPreviewBody(payload, failed) {
  const body = $('#preview-body');
  const p = payload.plan || {};
  const rows = (payload.devices || []).map((d) => `
    <tr>
      <td>${esc(d.name)} ${d.locked ? '<span class="tag locked">锁定</span>' : ''}</td>
      <td class="freq">${fmt(d.current)}</td>
      <td class="freq ${d.changed ? 'ok-text' : ''}">${d.target === null ? '—' : fmt(d.target)}</td>
      <td>${d.changed ? '<span class="tag moved">将调整</span>' : '<span class="muted">不变</span>'}</td>
    </tr>`).join('');

  const occText = occupiedSummary(payload.occupiedBands);
  const checkLines = (payload.checks || []).map((c) => `
    <li class="${c.ok ? 'ok-text' : 'danger-text'}">${c.ok ? '✓' : '✗'} ${esc(c.name)}</li>`).join('');

  const reasonsHtml = failed && payload.reasons && payload.reasons.length
    ? `<div class="preview-reasons">
        <p class="danger-text" style="margin:0 0 6px"><strong>检查未通过，已禁止应用：</strong></p>
        <ul>${payload.reasons.map((r) => `<li class="danger-text">${esc(r)}</li>`).join('')}</ul>
      </div>`
    : '';

  const successHtml = failed ? '' : `
    <p class="ok-text" style="margin:0 0 8px">✓ 预览检查全部通过：目标配置无互调冲突、保护区不侵入占用区间，确认后将一次性写入全部设备。</p>
    <p class="hint" style="margin:0 0 8px">确认凭据仅本次有效，有效期 10 分钟；若期间设备或方案发生变化，确认将被拒绝并提示重新预览。</p>`;

  body.innerHTML = `
    ${failed
      ? `<div class="preview-banner failure">方案「${esc(p.name || '')}」预览失败，以下问题处理后请重新预览。</div>`
      : `<div class="preview-banner success">方案「${esc(p.name || '')}」预览成功，可确认应用。</div>`}
    ${reasonsHtml}
    ${successHtml}
    <ul class="check-list">${checkLines}</ul>
    <p class="plan-meta" style="margin:8px 0">
      现场占用频段：${occText ? '🚧 ' + esc(occText) : '无（旧方案缺省按空数组处理）'}
    </p>
    <div class="table-wrap"><table>
      <thead><tr><th>设备（按设备 ID）</th><th>当前频率 (MHz)</th><th>目标频率 (MHz)</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

async function openPreview(planId) {
  modal.hidden = false;
  previewState = { planId, token: null };
  $('#btn-confirm-apply').disabled = true;
  $('#btn-repreview').disabled = true;
  $('#preview-body').innerHTML = '<p class="empty-state">正在检查…</p>';
  try {
    const data = await api(`/api/plans/${planId}/preview`, { method: 'POST' });
    previewState = { planId, token: data.token, data };
    renderPreviewBody(data, false);
    $('#btn-confirm-apply').disabled = false;
  } catch (e) {
    if (e.status === 422) {
      renderPreviewBody(e.data, true);
    } else {
      $('#preview-body').innerHTML = `<p class="danger-text">预览失败：${esc(e.message)}</p>`;
    }
  } finally {
    $('#btn-repreview').disabled = false;
  }
}

$('#btn-preview-close').addEventListener('click', closePreview);
$('#btn-repreview').addEventListener('click', () => {
  if (previewState) openPreview(previewState.planId).catch((e) => toast(e.message, true));
});
modal.addEventListener('click', (e) => { if (e.target === modal) closePreview(); });

$('#btn-confirm-apply').addEventListener('click', async () => {
  if (!previewState || !previewState.token) return;
  const btn = $('#btn-confirm-apply');
  btn.disabled = true;
  try {
    const res = await api(`/api/plans/${previewState.planId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ token: previewState.token }),
    });
    closePreview();
    toast(`已应用方案：写入 ${res.applied} 个设备，其中 ${res.changed} 个频率变化`);
    await loadDevices();
  } catch (e) {
    // 409：状态变化或凭据缺失/失效，未写入任何设备，提示重新预览
    if (e.status === 409) {
      toast(`应用被拒绝：${e.message}`, true);
      previewState.token = null;
      $('#btn-confirm-apply').disabled = true;
      const body = $('#preview-body');
      body.insertAdjacentHTML('afterbegin', `
        <div class="preview-banner failure">⚠ ${esc(e.message)}${(e.data.reasons || []).length ? '' : ''}
          ${(e.data.reasons || []).map((r) => `<br>· ${esc(r)}`).join('')}
          <br>请点击「重新预览」后再应用。
        </div>`);
    } else {
      btn.disabled = false;
      toast(e.message, true);
    }
  }
});

/* ---------- 启动 ---------- */

(async () => {
  addOccupiedRow(); // 默认提供一行（留空即不启用避让）
  try {
    await loadDevices();
    await loadPlans();
  } catch (e) {
    toast(`初始化失败：${e.message}`, true);
  }
})();
