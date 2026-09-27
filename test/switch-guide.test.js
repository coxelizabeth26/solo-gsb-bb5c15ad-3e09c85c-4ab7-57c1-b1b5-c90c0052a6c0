'use strict';

// 安全改频指引接口测试（POST /api/plans/:id/switch-guide）。
// 使用独立临时 DATA_DIR，通过 HTTP 调用导出的 app（监听随机端口）。
process.env.DATA_DIR = require('node:path').join(
  require('node:os').tmpdir(),
  `mic-guide-test-${process.pid}-${Date.now()}`,
);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../db');
const app = require('../server');
const { mhzToHz, computeConflicts } = require('../lib/intermod');

let server;
let port;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  db.exec('DELETE FROM devices; DELETE FROM plans;');
});

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const BASE_PARAMS = { bandMin: 470, bandMax: 608, step: 0.025, maxOffset: 5, occupiedBands: [] };

async function createDevice(name, frequency, guard = 0.25, locked = false) {
  const res = await request('POST', '/api/devices', { name, frequency, guard, locked });
  assert.equal(res.status, 201, res.data.error);
  return res.data;
}

async function savePlan(plan) {
  const body = {
    name: plan.name || '测试方案',
    params: plan.params || BASE_PARAMS,
    assignments: plan.assignments,
    totalOffset: plan.totalOffset ?? 0,
    solved: plan.solved !== undefined ? plan.solved : true,
  };
  const res = await request('POST', '/api/plans', body);
  assert.equal(res.status, 201, res.data.error);
  return res.data.id;
}

test('方案不存在 → 404', async () => {
  const res = await request('POST', '/api/plans/424242/switch-guide');
  assert.equal(res.status, 404);
});

test('当前配置存在互调冲突 → 422 并列出当前配置原因', async () => {
  // 当前 {500, 500.1} 三阶互调 499.9 距 500 为 0.1 ≤ 0.25 → 冲突
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 500.1);
  // 目标 {502, 504} 本身无冲突，确保 422 是由当前配置引起的
  const id = await savePlan({
    assignments: [
      { id: a.id, name: 'A', frequency: 502 },
      { id: b.id, name: 'B', frequency: 504 },
    ],
  });
  const res = await request('POST', `/api/plans/${id}/switch-guide`);
  assert.equal(res.status, 422);
  assert.ok(res.data.reasons.some((r) => /当前配置/.test(r) && /互调冲突/.test(r)));
  assert.ok(Array.isArray(res.data.currentConflicts) && res.data.currentConflicts.length > 0);
});

test('当前配置保护区与方案所存占用区间相交 → 422 并列出原因', async () => {
  const a = await createDevice('A', 500, 0.25);
  // 当前保护区 [499.75, 500.25] 与占用 [500.2, 500.4] 相交；目标 510 安全
  const id = await savePlan({
    params: { ...BASE_PARAMS, occupiedBands: [{ lo: 500.2, hi: 500.4 }] },
    assignments: [{ id: a.id, name: 'A', frequency: 510 }],
  });
  const res = await request('POST', `/api/plans/${id}/switch-guide`);
  assert.equal(res.status, 422);
  assert.ok(res.data.reasons.some((r) => /当前频率/.test(r) && /占用区间/.test(r)));
  assert.equal(res.data.currentOccupiedHits.length, 1);
  assert.equal(res.data.currentOccupiedHits[0].device.id, a.id);
});

test('目标未通过应用检查（方案未求解 / 锁定设备改频）→ 422 并列出原因', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);

  const unsolved = await savePlan({
    solved: false,
    assignments: [
      { id: a.id, frequency: 500 },
      { id: b.id, frequency: 510 },
    ],
  });
  const r1 = await request('POST', `/api/plans/${unsolved}/switch-guide`);
  assert.equal(r1.status, 422);
  assert.ok(r1.data.reasons.some((r) => /已求解/.test(r)));
  assert.ok(r1.data.targetChecks.some((c) => c.name === '方案已求解' && !c.ok));

  const lockedDev = await createDevice('C', 520, 0.25, true);
  const lockedPlan = await savePlan({
    assignments: [
      { id: a.id, frequency: 500 },
      { id: b.id, frequency: 510 },
      { id: lockedDev.id, name: 'C', locked: true, frequency: 521 },
    ],
  });
  const r2 = await request('POST', `/api/plans/${lockedPlan}/switch-guide`);
  assert.equal(r2.status, 422);
  assert.ok(r2.data.reasons.some((r) => /锁定设备/.test(r) && /不得改频/.test(r)));
});

test('频率完全相同 → noop 无需改频', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);
  const id = await savePlan({
    assignments: [
      { id: a.id, name: 'A', frequency: 500 },
      { id: b.id, name: 'B', frequency: 510 },
    ],
  });
  const res = await request('POST', `/api/plans/${id}/switch-guide`);
  assert.equal(res.status, 200);
  assert.equal(res.data.noop, true);
  assert.equal(res.data.solvable, true);
  assert.match(res.data.message, /无需改频/);
  assert.deepEqual(res.data.steps, []);
  assert.equal(res.data.table.length, 2);
  assert.ok(res.data.table.every((r) => r.atTarget));
});

test('顺序敏感场景：仅有一种可行顺序，逐步给出名称/改前改后与完整频率表', async () => {
  // A: 500.0 → 500.4，B: 500.4 → 500.8（guard 0.25）
  // 先改 A 会得到 {500.4, 500.4} 同频冲突；唯一可行顺序是先 B 后 A
  const a = await createDevice('A', 500.0);
  const b = await createDevice('B', 500.4);
  const id = await savePlan({
    assignments: [
      { id: a.id, name: 'A', frequency: 500.4 },
      { id: b.id, name: 'B', frequency: 500.8 },
    ],
  });
  const res = await request('POST', `/api/plans/${id}/switch-guide`);
  assert.equal(res.status, 200);
  assert.equal(res.data.noop, false);
  assert.equal(res.data.solvable, true);
  assert.equal(res.data.steps.length, 2);

  const [s1, s2] = res.data.steps;
  assert.equal(s1.step, 1);
  assert.equal(s1.device.id, b.id);
  assert.equal(s1.device.name, 'B');
  assert.equal(s1.from, 500.4);
  assert.equal(s1.to, 500.8);
  assert.equal(s2.device.id, a.id);
  assert.equal(s2.from, 500.0);
  assert.equal(s2.to, 500.4);

  // 每台至多一次
  assert.deepEqual(
    [...new Set(res.data.steps.map((s) => s.device.id))].length,
    res.data.steps.length,
  );

  // 每步完整频率表，且每个中间配置按当前保护间隔复算均无互调冲突
  const devs = [a, b];
  for (const s of res.data.steps) {
    assert.equal(s.table.length, 2);
    const trial = s.table.map((r, i) => ({
      id: r.id,
      name: r.name,
      freqHz: mhzToHz(r.frequency),
      guardHz: mhzToHz(devs.find((d) => d.id === r.id).guard),
    }));
    assert.equal(computeConflicts(trial).length, 0);
  }
  // 第一步后：A 仍 500.0（未达目标），B 已 500.8（达目标）
  assert.equal(s1.table.find((r) => r.id === a.id).frequency, 500.0);
  assert.equal(s1.table.find((r) => r.id === a.id).atTarget, false);
  assert.equal(s1.table.find((r) => r.id === b.id).frequency, 500.8);
  assert.equal(s1.table.find((r) => r.id === b.id).atTarget, true);
  // 最后一步后全部达目标
  assert.ok(s2.table.every((r) => r.atTarget));
});

test('多个可行顺序 → 取设备 ID 序列字典序最小者', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);
  const id = await savePlan({
    assignments: [
      { id: a.id, name: 'A', frequency: 502 },
      { id: b.id, name: 'B', frequency: 512 },
    ],
  });
  const res = await request('POST', `/api/plans/${id}/switch-guide`);
  assert.equal(res.status, 200);
  assert.equal(res.data.solvable, true);
  assert.deepEqual(res.data.steps.map((s) => s.device.id), [a.id, b.id]);
});

test('交换频率且无临时频率可用 → 无可行顺序并明确提示', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 502);
  const id = await savePlan({
    assignments: [
      { id: a.id, name: 'A', frequency: 502 },
      { id: b.id, name: 'B', frequency: 500 },
    ],
  });
  const res = await request('POST', `/api/plans/${id}/switch-guide`);
  assert.equal(res.status, 200);
  assert.equal(res.data.solvable, false);
  assert.equal(res.data.noop, false);
  assert.match(res.data.message, /无可行改频顺序/);
  assert.deepEqual(res.data.steps, []);
});

test('生成指引为只读：设备与方案均不被写回', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);
  const id = await savePlan({
    assignments: [
      { id: a.id, name: 'A', frequency: 502 },
      { id: b.id, name: 'B', frequency: 512 },
    ],
  });
  const before = await request('GET', '/api/plans');
  const res = await request('POST', `/api/plans/${id}/switch-guide`);
  assert.equal(res.status, 200);
  assert.equal(res.data.solvable, true);

  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.find((d) => d.id === a.id).frequency, 500);
  assert.equal(devs.data.devices.find((d) => d.id === b.id).frequency, 510);

  const after = await request('GET', '/api/plans');
  assert.deepEqual(after.data, before.data);
});
