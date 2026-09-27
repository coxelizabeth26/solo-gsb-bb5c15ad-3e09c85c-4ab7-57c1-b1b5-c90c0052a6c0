'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { mhzToHz, hzToMhz, computeConflicts, coordinate, normalizeOccupiedBands } = require('./lib/intermod');
const { searchSwitchOrder } = require('./lib/switchguide');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_DEVICES = 8;
// 预览凭据有效期（毫秒），默认 10 分钟
const PREVIEW_TTL_MS = Number(process.env.PREVIEW_TTL_MS) || 10 * 60 * 1000;
const FREQ_MAX_MHZ = 10000;

/** 已签发的预览确认凭据：token -> { planId, planHash, devicesHash, createdAt } */
const previewTokens = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 工具 ----------

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 全部设备当前状态的指纹（任一字段变化都会导致预览凭据失效） */
function devicesStateHash(devices) {
  const canon = devices.map((d) => [d.id, d.name, d.frequency, d.guard, d.locked ? 1 : 0, d.position]);
  return sha256(JSON.stringify(canon));
}

/** 方案存储内容指纹（params/assignments 以库内原始 JSON 文本为准） */
function planRowHash(row) {
  return sha256([row.name, row.params, row.assignments, row.total_offset, row.solved].join('|'));
}

function prunePreviewTokens(now = Date.now()) {
  for (const [token, info] of previewTokens) {
    if (now - info.createdAt > PREVIEW_TTL_MS) previewTokens.delete(token);
  }
}

function rowToDevice(row) {
  return {
    id: row.id,
    name: row.name,
    frequency: row.frequency, // MHz
    guard: row.guard,         // MHz
    locked: !!row.locked,
    position: row.position,
  };
}

function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY position, id').all().map(rowToDevice);
}

/** 转为核心库使用的 Hz 通道模型（保持录入顺序） */
function toChannels(devices) {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    freqHz: mhzToHz(d.frequency),
    guardHz: mhzToHz(d.guard),
    locked: d.locked,
  }));
}

function conflictToJson(c) {
  return {
    productType: c.productType,
    product: hzToMhz(c.productHz),
    source: c.source.map((s) => ({ id: s.id, name: s.name, frequency: hzToMhz(s.freqHz) })),
    victim: {
      id: c.victim.id,
      name: c.victim.name,
      frequency: hzToMhz(c.victim.freqHz),
      guard: hzToMhz(c.victim.guardHz),
    },
    deviation: hzToMhz(c.deviationHz),
  };
}

function assignmentToJson(a) {
  return {
    id: a.id,
    name: a.name,
    locked: a.locked,
    original: hzToMhz(a.originalHz),
    frequency: hzToMhz(a.freqHz),
    offset: hzToMhz(a.offsetHz),
  };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/** 校验设备录入字段，返回错误消息或 null */
function validateDeviceInput(body) {
  const { name, frequency, guard } = body;
  if (typeof name !== 'string' || name.trim().length === 0) return '设备名称不能为空';
  if (name.trim().length > 60) return '设备名称过长（最多 60 字符）';
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0 || f > 10000) return '工作频率必须是 0 ~ 10000 MHz 之间的数值';
  const g = Number(guard);
  if (!Number.isFinite(g) || g < 0 || g > 100) return '保护间隔必须是 0 ~ 100 MHz 之间的数值';
  return null;
}

// ---------- 设备管理 ----------

app.get('/api/devices', (req, res) => {
  res.json({ devices: listDevices(), max: MAX_DEVICES });
});

app.post('/api/devices', (req, res) => {
  const err = validateDeviceInput(req.body || {});
  if (err) return badRequest(res, err);

  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count >= MAX_DEVICES) return badRequest(res, `最多只能录入 ${MAX_DEVICES} 个设备`);

  const { name, frequency, guard, locked } = req.body;
  const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM devices').get().m) + 1;
  const info = db
    .prepare('INSERT INTO devices (name, frequency, guard, locked, position) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), Number(frequency), Number(guard), locked ? 1 : 0, pos);
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToDevice(row));
});

app.put('/api/devices/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '设备不存在' });
  const err = validateDeviceInput(req.body || {});
  if (err) return badRequest(res, err);

  const { name, frequency, guard, locked } = req.body;
  db.prepare('UPDATE devices SET name = ?, frequency = ?, guard = ?, locked = ? WHERE id = ?')
    .run(name.trim(), Number(frequency), Number(guard), locked ? 1 : 0, row.id);
  res.json(rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(row.id)));
});

app.delete('/api/devices/:id', (req, res) => {
  const info = db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '设备不存在' });
  res.json({ ok: true });
});

// ---------- 互调冲突分析 ----------

app.get('/api/conflicts', (req, res) => {
  const channels = toChannels(listDevices());
  const conflicts = computeConflicts(channels).map(conflictToJson);
  res.json({ count: conflicts.length, conflicts });
});

// ---------- 自动协调 ----------

app.post('/api/coordinate', (req, res) => {
  const body = req.body || {};
  const bandMin = Number(body.bandMin);
  const bandMax = Number(body.bandMax);
  const step = Number(body.step);
  const maxOffset = Number(body.maxOffset);

  if (!Number.isFinite(bandMin) || !Number.isFinite(bandMax) || bandMin >= bandMax) {
    return badRequest(res, '频段范围无效：下限必须小于上限');
  }
  if (!Number.isFinite(step) || step <= 0) return badRequest(res, '步进必须为正数（MHz）');
  if (!Number.isFinite(maxOffset) || maxOffset < 0) return badRequest(res, '最大偏移必须为非负数（MHz）');

  // 现场占用频段（本次协调参数，不写入设备数据）：校验有限数值、下限 ≤ 上限并合并重叠区间
  let occupiedBands = [];
  if (body.occupiedBands !== undefined && body.occupiedBands !== null) {
    try {
      occupiedBands = normalizeOccupiedBands(body.occupiedBands);
    } catch (e) {
      return badRequest(res, e.message);
    }
  }

  const devices = listDevices();
  if (devices.length === 0) return badRequest(res, '尚未录入任何设备');

  const result = coordinate(toChannels(devices), {
    bandMinHz: mhzToHz(bandMin),
    bandMaxHz: mhzToHz(bandMax),
    stepHz: mhzToHz(step),
    maxOffsetHz: mhzToHz(maxOffset),
    occupiedHz: occupiedBands.map((b) => ({ loHz: mhzToHz(b.lo), hiHz: mhzToHz(b.hi) })),
  });

  // 方案对应的冲突复核（成功时应为 0）
  const solvedChannels = result.assignments.map((a, i) => ({
    id: a.id,
    name: a.name,
    freqHz: a.freqHz,
    guardHz: mhzToHz(devices[i].guard),
    locked: a.locked,
  }));
  const resultConflicts = computeConflicts(solvedChannels).map(conflictToJson);

  res.json({
    solved: result.solved,
    reason: result.reason,
    capped: result.capped,
    totalOffset: hzToMhz(result.totalOffsetHz),
    assignments: result.assignments.map(assignmentToJson),
    conflicts: resultConflicts,
    params: { bandMin, bandMax, step, maxOffset, occupiedBands },
  });
});

// ---------- 方案保存 / 读取 ----------

/** 方案行 → JSON。旧方案缺省字段按空值处理：占用区间缺省为空数组 */
function planToJson(row) {
  let params = {};
  try {
    params = JSON.parse(row.params) || {};
  } catch {
    params = {};
  }
  if (!Array.isArray(params.occupiedBands)) params.occupiedBands = [];
  let assignments = [];
  try {
    assignments = JSON.parse(row.assignments);
  } catch {
    assignments = [];
  }
  return {
    id: row.id,
    name: row.name,
    params,
    assignments,
    totalOffset: row.total_offset,
    solved: !!row.solved,
    createdAt: row.created_at,
  };
}

/**
 * 解析方案 params 中保存的占用区间（MHz）：缺省（null/undefined）按空数组处理；
 * 格式非法时返回 parseOk=false 与可读原因。供应用检查与安全改频指引共用。
 */
function parsePlanOccupiedBands(planRow) {
  let params = {};
  try {
    params = JSON.parse(planRow.params) || {};
  } catch {
    params = {};
  }
  if (params.occupiedBands === undefined || params.occupiedBands === null) {
    return { bands: [], parseOk: true };
  }
  try {
    return { bands: normalizeOccupiedBands(params.occupiedBands), parseOk: true };
  } catch (e) {
    return {
      bands: [],
      parseOk: false,
      reason: `方案所存占用区间无法解析（${e.message}），禁止应用。`,
    };
  }
}

/**
 * 安全改频指引的起始配置检查：当前配置必须无互调冲突，
 * 且每台设备的保护区不与方案所存占用区间闭区间相交（端点相接也算）。
 *
 * @param {Array} devices 当前设备（rowToDevice 之后）
 * @param {{bands:Array, parseOk:boolean}} occupied parsePlanOccupiedBands 的结果
 */
function checkStartingConfig(devices, occupied) {
  const checks = [];
  const reasons = [];
  const check = (name, ok) => { checks.push({ name, ok }); return ok; };

  const channels = toChannels(devices);
  const conflicts = computeConflicts(channels);
  if (!check('当前配置无互调冲突', conflicts.length === 0)) {
    const shown = conflicts.slice(0, 5).map((c) =>
      `${c.productType} 积 ${hzToMhz(c.productHz)} MHz（${c.source.map((s) => s.name).join(' × ')}）` +
      ` 落入「${c.victim.name}」保护区（${hzToMhz(c.victim.freqHz)} ± ${hzToMhz(c.victim.guardHz)} MHz）`);
    reasons.push(
      `当前配置存在 ${conflicts.length} 处互调冲突：${shown.join('；')}` +
      `${conflicts.length > 5 ? `；等共 ${conflicts.length} 处` : ''}。` +
      `起始状态不安全，无法生成安全改频指引，请先消除当前冲突。`,
    );
  }

  const occupiedHz = occupied.bands.map((b) => ({ loHz: mhzToHz(b.lo), hiHz: mhzToHz(b.hi) }));
  const hits = [];
  if (!occupied.parseOk) {
    reasons.push(occupied.reason || '方案所存占用区间无法解析，禁止生成改频指引。');
  }
  if (occupied.parseOk) {
    for (const d of devices) {
      const f = mhzToHz(d.frequency);
      const g = mhzToHz(d.guard);
      const hit = occupiedHz.find((o) => f - g <= o.hiHz && o.loHz <= f + g);
      if (hit) hits.push({ device: d, band: hit });
    }
  }
  if (!check('当前配置避开方案所存占用区间（闭区间相交检查）', occupied.parseOk && hits.length === 0)) {
    for (const h of hits) {
      reasons.push(
        `当前配置中设备「${h.device.name}」频率 ${h.device.frequency} MHz 的保护区` +
        `（${hzToMhz(mhzToHz(h.device.frequency) - mhzToHz(h.device.guard))}–` +
        `${hzToMhz(mhzToHz(h.device.frequency) + mhzToHz(h.device.guard))} MHz）` +
        `与方案所存占用区间 ${hzToMhz(h.band.loHz)}–${hzToMhz(h.band.hiHz)} MHz 相交（闭区间，端点相接也算）。`,
      );
    }
  }

  return { ok: checks.every((c) => c.ok), checks, reasons, conflicts };
}

/**
 * 应用前检查：核对已保存方案与当前设备状态，收集全部失败原因。
 * 预览与确认应用共用本函数，保证两次检查口径一致。
 *
 * @param {object} planRow  plans 表行
 * @param {Array}  devices  当前设备列表（rowToDevice 之后）
 * @returns {{ok:boolean, reasons:string[], checks:Array<{name:string, ok:boolean}>,
 *            previewDevices:Array, conflicts:Array, occupiedBands:Array,
 *            occupiedParseOk:boolean, targets:Map<number, number>}}
 */
function evaluatePlan(planRow, devices) {
  const reasons = [];
  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok }); return ok; };

  // 1. 方案须标记为已求解
  check('方案已求解', !!planRow.solved);
  if (!planRow.solved) reasons.push('方案未标记为已求解（solved），禁止应用。');

  // 2. 分配数据须为数组
  let assignments;
  try {
    assignments = JSON.parse(planRow.assignments);
  } catch {
    assignments = null;
  }
  const assignmentsOk = check('分配数据完整', Array.isArray(assignments));
  if (!assignmentsOk) {
    reasons.push('方案中的分配数据缺失或不是数组，无法应用。');
    assignments = [];
  }

  // 3. 目标频率须为 0～10000 MHz 内的有限正数
  const freqValid = assignments.every((a) => {
    const f = a && Number(a.frequency);
    return Number.isFinite(f) && f > 0 && f <= FREQ_MAX_MHZ;
  });
  check('目标频率有效（0～10000 MHz 有限正数）', freqValid);
  if (!freqValid) {
    reasons.push('存在非法的目标频率：每个分配项的 frequency 必须是 0～10000 MHz 内的有限正数。');
  }

  // 4. 分配与当前设备一一对应且无重复
  const ids = assignments.map((a) => a && a.id);
  const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const noDup = check('分配无重复设备', dupIds.length === 0);
  if (!noDup) reasons.push(`分配中存在重复的设备 ID：${dupIds.join('、')}。`);

  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const missing = assignments.filter((a) => a && !deviceById.has(a.id)).map((a) => a.id);
  const uncovered = devices.filter((d) => !assignments.some((a) => a && a.id === d.id));
  const nonEmpty = devices.length > 0 && assignments.length > 0;
  const matched = check('分配与当前设备一一对应', nonEmpty && missing.length === 0 && uncovered.length === 0);
  if (!nonEmpty) reasons.push('当前没有可应用的设备（或方案不含任何分配）。');
  if (missing.length > 0) reasons.push(`分配指向不存在的设备 ID：${missing.join('、')}。`);
  if (uncovered.length > 0) {
    reasons.push(`以下当前设备在方案中没有对应分配：${uncovered.map((d) => `「${d.name}」(ID ${d.id})`).join('、')}。`);
  }

  // 5. 锁定设备不得改频
  const lockedChanged = devices.filter((d) => {
    if (!d.locked) return false;
    const a = assignments.find((x) => x && x.id === d.id);
    if (!a) return false;
    const f = Number(a.frequency);
    return Number.isFinite(f) && mhzToHz(f) !== mhzToHz(d.frequency);
  });
  const lockedOk = check('锁定设备未改频', lockedChanged.length === 0);
  for (const d of lockedChanged) {
    const a = assignments.find((x) => x && x.id === d.id);
    reasons.push(`锁定设备「${d.name}」(ID ${d.id}) 的目标频率 ${a.frequency} MHz 与当前频率 ${d.frequency} MHz 不一致，锁定设备不得改频。`);
  }

  // 预览明细：按设备 ID 展示当前频率与目标频率
  const previewDevices = devices.map((d) => {
    const a = assignments.find((x) => x && x.id === d.id);
    const target = a ? Number(a.frequency) : null;
    const targetValid = Number.isFinite(target) && target > 0 && target <= FREQ_MAX_MHZ;
    return {
      id: d.id,
      name: d.name,
      locked: d.locked,
      current: d.frequency,
      target: a ? a.frequency : null,
      changed: targetValid && mhzToHz(target) !== mhzToHz(d.frequency),
    };
  });

  // 后续检查仅在分配与设备一一对应且目标频率全部有效时才有意义
  const correspondenceOk = assignmentsOk && freqValid && noDup && matched;
  const targets = new Map();
  if (correspondenceOk) {
    for (const a of assignments) targets.set(a.id, Number(a.frequency));
  }

  // 6. 用当前保护间隔复算目标配置的互调冲突
  let conflicts = [];
  if (correspondenceOk) {
    const channels = devices.map((d) => ({
      id: d.id,
      name: d.name,
      freqHz: mhzToHz(targets.get(d.id)),
      guardHz: mhzToHz(d.guard),
      locked: d.locked,
    }));
    conflicts = computeConflicts(channels);
  }
  const intermodOk = check('目标配置无互调冲突（按当前保护间隔复算）', correspondenceOk && conflicts.length === 0);
  if (correspondenceOk && conflicts.length > 0) {
    const shown = conflicts.slice(0, 5).map((c) =>
      `${c.productType} 积 ${hzToMhz(c.productHz)} MHz（${c.source.map((s) => s.name).join(' × ')}）` +
      ` 落入「${c.victim.name}」保护区（${hzToMhz(c.victim.freqHz)} ± ${hzToMhz(c.victim.guardHz)} MHz）`);
    reasons.push(
      `目标配置按当前保护间隔复算存在 ${conflicts.length} 处互调冲突：` +
      `${shown.join('；')}${conflicts.length > 5 ? `；等共 ${conflicts.length} 处` : ''}。`,
    );
  }

  // 7. 保护区与方案所存占用区间的闭区间相交检查（占用区间缺省按空数组处理）
  const occupied = parsePlanOccupiedBands(planRow);
  const occupiedBands = occupied.bands;
  const occupiedParseOk = occupied.parseOk;
  if (!occupiedParseOk) reasons.push(occupied.reason);
  let occupiedHits = [];
  if (occupiedParseOk && correspondenceOk) {
    const occupiedHz = occupiedBands.map((b) => ({ loHz: mhzToHz(b.lo), hiHz: mhzToHz(b.hi) }));
    occupiedHits = devices
      .map((d) => {
        const f = mhzToHz(targets.get(d.id));
        const g = mhzToHz(d.guard);
        const hit = occupiedHz.find((o) => f - g <= o.hiHz && o.loHz <= f + g);
        return hit ? { device: d, band: hit } : null;
      })
      .filter(Boolean);
  }
  const occupiedOk = check('保护区不与占用区间相交', occupiedParseOk && (!correspondenceOk || occupiedHits.length === 0));
  for (const h of occupiedHits) {
    reasons.push(
      `设备「${h.device.name}」目标频率 ${targets.get(h.device.id)} MHz 的保护区` +
      `（${hzToMhz(mhzToHz(targets.get(h.device.id)) - mhzToHz(h.device.guard))}–` +
      `${hzToMhz(mhzToHz(targets.get(h.device.id)) + mhzToHz(h.device.guard))} MHz）` +
      `与方案所存占用区间 ${hzToMhz(h.band.loHz)}–${hzToMhz(h.band.hiHz)} MHz 相交（闭区间，端点相接也算）。`,
    );
  }

  const ok = checks.every((c) => c.ok);
  return { ok, reasons, checks, previewDevices, conflicts, occupiedBands, occupiedParseOk, targets };
}

app.post('/api/plans', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  if (!name) return badRequest(res, '方案名称不能为空');
  if (!body.params || !Array.isArray(body.assignments)) {
    return badRequest(res, '缺少协调参数或分配结果');
  }
  const info = db
    .prepare('INSERT INTO plans (name, params, assignments, total_offset, solved) VALUES (?, ?, ?, ?, ?)')
    .run(
      name,
      JSON.stringify(body.params),
      JSON.stringify(body.assignments),
      Number(body.totalOffset) || 0,
      body.solved === false ? 0 : 1,
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/plans', (req, res) => {
  const rows = db.prepare('SELECT * FROM plans ORDER BY id DESC').all();
  res.json(rows.map(planToJson));
});

app.delete('/api/plans/:id', (req, res) => {
  const info = db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '方案不存在' });
  res.json({ ok: true });
});

/**
 * 应用前预览：核对方案与当前设备状态，列出全部失败原因。
 * 成功时签发绑定方案内容与全部设备状态的确认凭据（token）。
 */
app.post('/api/plans/:id/preview', (req, res) => {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '方案不存在' });

  const devices = listDevices();
  const result = evaluatePlan(row, devices);
  if (!result.ok) {
    return res.status(422).json({
      error: '预览检查未通过，禁止应用',
      plan: planToJson(row),
      devices: result.previewDevices,
      occupiedBands: result.occupiedBands,
      reasons: result.reasons,
      checks: result.checks,
      conflicts: result.conflicts.map(conflictToJson),
    });
  }

  prunePreviewTokens();
  const token = crypto.randomBytes(32).toString('hex');
  previewTokens.set(token, {
    planId: row.id,
    planHash: planRowHash(row),
    devicesHash: devicesStateHash(devices),
    createdAt: Date.now(),
  });

  res.json({
    token,
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    plan: planToJson(row),
    devices: result.previewDevices,
    occupiedBands: result.occupiedBands,
    checks: result.checks,
    conflicts: result.conflicts.map(conflictToJson),
  });
});

/**
 * 确认应用：在同一 SQLite 事务中核对凭据、重做全部检查并一次性更新全部设备频率。
 * 凭据缺失/失效、状态变化或任一检查失败均返回 409 且不写入任何设备。
 */
app.post('/api/plans/:id/apply', (req, res) => {
  const body = req.body || {};
  const token = typeof body.token === 'string' ? body.token : null;
  if (!token) {
    return res.status(409).json({ error: '缺少确认凭据，请先预览方案后再应用。', repreview: true });
  }
  const cred = previewTokens.get(token);
  if (!cred) {
    return res.status(409).json({ error: '确认凭据无效或已过期，请重新预览。', repreview: true });
  }
  if (cred.planId !== Number(req.params.id)) {
    return res.status(409).json({ error: '确认凭据与当前方案不匹配，请重新预览。', repreview: true });
  }
  if (Date.now() - cred.createdAt > PREVIEW_TTL_MS) {
    previewTokens.delete(token);
    return res.status(409).json({ error: '确认凭据已过期，请重新预览。', repreview: true });
  }

  let outcome;
  const fail = (message, reasons) => {
    const e = new Error(message);
    e.code = 'REPREVIEW';
    e.reasons = reasons || [];
    return e;
  };
  try {
    outcome = db.transaction(() => {
      // 凭据核对与全部检查均在事务内完成，与写入原子地发生
      const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(cred.planId);
      if (!row) throw fail('方案已不存在，请重新预览。');
      if (planRowHash(row) !== cred.planHash) {
        throw fail('方案内容自预览后已变化，请重新预览。');
      }
      const devices = listDevices();
      if (devicesStateHash(devices) !== cred.devicesHash) {
        throw fail('设备状态自预览后已变化，请重新预览。');
      }
      const result = evaluatePlan(row, devices);
      if (!result.ok) {
        throw fail('应用前检查未通过，请重新预览。', result.reasons);
      }

      const update = db.prepare('UPDATE devices SET frequency = ? WHERE id = ?');
      let changed = 0;
      for (const d of devices) {
        update.run(result.targets.get(d.id), d.id);
        if (mhzToHz(result.targets.get(d.id)) !== mhzToHz(d.frequency)) changed += 1;
      }
      return { applied: devices.length, changed };
    })();
  } catch (err) {
    // 事务抛错即整体回滚，不写入任何设备
    if (err && err.code === 'REPREVIEW') {
      return res.status(409).json({ error: err.message, reasons: err.reasons || [], repreview: true });
    }
    throw err;
  }
  // 一次性凭据：确认成功（或失败回滚后状态已不同）即作废
  previewTokens.delete(token);
  res.json({ ok: true, applied: outcome.applied, changed: outcome.changed });
});

// ---------- 安全改频指引（只读，不写回设备或方案） ----------

/**
 * 安全改频指引：以当前设备与选定方案生成只读的逐步改频顺序。
 *
 * 前置条件：
 *   1. 目标配置通过现有应用检查（evaluatePlan：已求解、一一对应、目标频率合法、
 *      锁定设备不改频、目标无互调冲突、目标保护区不与方案所存占用区间相交）；
 *   2. 当前配置无互调冲突，且当前保护区避开方案所存占用区间（闭区间）。
 * 满足后穷举改频排列：每步仅将一台未锁定设备由当前频率直接改到目标频率
 * （不用临时频率、每台至多一次），每个中间配置都必须无互调冲突、
 * 且全部设备保护区避开占用区间；多解取设备 ID 序列字典序最小者。
 * 本接口只读：不修改任何设备或方案数据。
 */
app.post('/api/plans/:id/switch-guide', (req, res) => {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '方案不存在' });

  const devices = listDevices();

  // 1. 目标配置走现有应用检查
  const plan = evaluatePlan(row, devices);
  if (!plan.ok) {
    return res.status(422).json({
      error: '目标配置未通过应用检查，无法生成安全改频指引',
      plan: planToJson(row),
      devices: plan.previewDevices,
      occupiedBands: plan.occupiedBands,
      targetReasons: plan.reasons,
      targetChecks: plan.checks,
      conflicts: plan.conflicts.map(conflictToJson),
      feasible: false,
      stage: 'target',
    });
  }

  // 2. 当前配置必须无互调冲突且避开方案所存占用区间
  const occupied = parsePlanOccupiedBands(row);
  const start = checkStartingConfig(devices, occupied);
  if (!start.ok) {
    return res.status(422).json({
      error: '当前配置不满足安全改频起始条件，无法生成指引',
      plan: planToJson(row),
      devices: plan.previewDevices,
      occupiedBands: plan.occupiedBands,
      startReasons: start.reasons,
      startChecks: start.checks,
      conflicts: start.conflicts.map(conflictToJson),
      feasible: false,
      stage: 'start',
    });
  }

  // 3. 划分待改设备与固定设备（Hz 精度比较，复用 mhzToHz）
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const movers = [];
  const fixed = [];
  for (const d of devices) {
    const currentHz = mhzToHz(d.frequency);
    const targetHz = mhzToHz(plan.targets.get(d.id));
    if (currentHz === targetHz) {
      fixed.push({
        id: d.id, name: d.name, freqHz: currentHz, guardHz: mhzToHz(d.guard), locked: d.locked,
      });
    } else {
      movers.push({
        id: d.id, name: d.name, freqHz: currentHz, targetHz,
        guardHz: mhzToHz(d.guard), locked: d.locked,
      });
    }
  }

  const occupiedHz = plan.occupiedBands.map((b) => ({ loHz: mhzToHz(b.lo), hiHz: mhzToHz(b.hi) }));
  const frequencyTable = (freqHzById) => devices.map((d) => ({
    id: d.id,
    name: d.name,
    locked: d.locked,
    guard: d.guard,
    frequency: hzToMhz(freqHzById.get(d.id)),
  }));

  // 4. 频率完全相同：无需改频
  if (movers.length === 0) {
    return res.json({
      feasible: true,
      stage: 'done',
      noChange: true,
      message: '当前频率与方案目标频率完全相同，无需改频。',
      plan: planToJson(row),
      devices: plan.previewDevices,
      occupiedBands: plan.occupiedBands,
      targetChecks: plan.checks,
      startChecks: start.checks,
      initialTable: frequencyTable(new Map(devices.map((d) => [d.id, mhzToHz(d.frequency)]))),
      steps: [],
    });
  }

  // 5. 穷举全部改频顺序
  const result = searchSwitchOrder(movers, fixed, occupiedHz);

  if (!result.feasible) {
    // 组装逐设备的不可行原因
    const nameOf = (id) => (deviceById.get(id) || {}).name || `设备 ${id}`;
    const reasons = result.blocked.map((b) => {
      const d = deviceById.get(b.id);
      const parts = [];
      const seen = new Set();
      // |2f1-f2| 的两种有序组合会产生同型同频冲突，合并展示，避免原因重复
      for (const c of b.conflicts) {
        const key = `${c.productType}@${c.productHz}#${c.victim.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(
          `${c.productType} 积 ${hzToMhz(c.productHz)} MHz（${c.source.map((s) => s.name).join(' × ')}）` +
          ` 落入「${c.victim.name}」保护区（${hzToMhz(c.victim.freqHz)} ± ${hzToMhz(c.victim.guardHz)} MHz）`,
        );
      }
      for (const h of b.occupiedHits) {
        const f = mhzToHz(plan.targets.get(b.id));
        const g = mhzToHz(d.guard);
        parts.push(
          `目标保护区（${hzToMhz(f - g)}–${hzToMhz(f + g)} MHz）与占用区间` +
          ` ${hzToMhz(h.bandHz.loHz)}–${hzToMhz(h.bandHz.hiHz)} MHz 闭区间相交`,
        );
      }
      return `设备「${nameOf(b.id)}」(ID ${b.id}) 若首先由 ${d.frequency} MHz 改到 ` +
        `${plan.targets.get(b.id)} MHz：${parts.join('；')}。`;
    });
    const movableFirst = movers
      .filter((m) => !result.blocked.some((b) => b.id === m.id))
      .map((m) => m.id);
    if (movableFirst.length > 0) {
      reasons.push(
        `设备 ${movableFirst.map((id) => `「${nameOf(id)}」(ID ${id})`).join('、')} 虽可作为第一步，` +
        `但其后的任意改频顺序都会使某个中间配置出现互调冲突或侵入占用区间。`,
      );
    }
    if (reasons.length === 0) {
      reasons.push('不存在满足全部中间配置安全约束的改频顺序。');
    }
    reasons.push('不存在任何安全改频顺序（每台设备只允许直接改到目标频率、不得使用临时频率）。');
    return res.json({
      feasible: false,
      stage: 'order',
      plan: planToJson(row),
      devices: plan.previewDevices,
      occupiedBands: plan.occupiedBands,
      targetChecks: plan.checks,
      startChecks: start.checks,
      initialTable: frequencyTable(new Map(devices.map((d) => [d.id, mhzToHz(d.frequency)]))),
      reasons,
      steps: [],
    });
  }

  // 6. 组装逐步指引
  const steps = result.order.map((id, idx) => {
    const d = deviceById.get(id);
    const before = result.states.get(idx);
    const after = result.states.get(idx + 1);
    return {
      step: idx + 1,
      deviceId: id,
      deviceName: d.name,
      from: hzToMhz(before.get(id)),
      to: hzToMhz(after.get(id)),
      tableBefore: frequencyTable(before),
      tableAfter: frequencyTable(after),
    };
  });

  res.json({
    feasible: true,
    stage: 'ordered',
    plan: planToJson(row),
    devices: plan.previewDevices,
    occupiedBands: plan.occupiedBands,
    targetChecks: plan.checks,
    startChecks: start.checks,
    initialTable: frequencyTable(result.states.get(0)),
    order: result.order,
    steps,
  });
});

// ---------- 示例数据（便于快速体验） ----------

app.post('/api/seed', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count > 0) return badRequest(res, '已有设备数据，示例数据仅在空库时载入');
  const samples = [
    ['领夹麦 A', 512.000, 0.25, 0],
    ['领夹麦 B', 512.200, 0.25, 0],
    ['手持麦 C', 520.000, 0.25, 0],
    ['头戴麦 D', 536.500, 0.25, 0],
    ['吉他无线 E', 548.000, 0.25, 0],
    ['贝斯无线 F', 560.250, 0.25, 0],
    ['主持麦 G', 574.000, 0.25, 1],
    ['备份麦 H', 590.500, 0.25, 0],
  ];
  const insert = db.prepare('INSERT INTO devices (name, frequency, guard, locked, position) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction(() => samples.forEach((s, i) => insert.run(...s, i + 1)));
  tx();
  res.status(201).json({ devices: listDevices() });
});

// ---------- 启动 ----------

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`无线麦克风频率协调工具已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
