'use strict';

// 应用前预览 / 确认应用接口测试。
// 使用独立临时 DATA_DIR，通过 HTTP 调用导出的 app（监听随机端口）。
process.env.DATA_DIR = require('node:path').join(
  require('node:os').tmpdir(),
  `mic-preview-test-${process.pid}-${Date.now()}`,
);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../db');
const app = require('../server');

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

/** 两个互不冲突的设备：500 与 510（guard 0.25） */
async function setupTwoClean() {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);
  const id = await savePlan({
    assignments: [
      { id: a.id, name: 'A', locked: false, original: 500, frequency: 500, offset: 0 },
      { id: b.id, name: 'B', locked: false, original: 510, frequency: 510, offset: 0 },
    ],
  });
  return { a, b, id };
}

test('预览成功：返回按设备 ID 的当前/目标频率、全部检查项与确认凭据', async () => {
  const { a, b, id } = await setupTwoClean();
  const res = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(res.status, 200);
  assert.match(res.data.token || '', /^[0-9a-f]{64}$/);
  assert.ok(res.data.expiresAt);
  assert.equal(res.data.plan.id, id);
  assert.equal(res.data.checks.every((c) => c.ok), true);
  assert.deepEqual(res.data.devices.map((d) => d.id), [a.id, b.id]);
  const rowA = res.data.devices.find((d) => d.id === a.id);
  assert.equal(rowA.current, 500);
  assert.equal(rowA.target, 500);
  assert.equal(rowA.changed, false);
});

test('确认应用：同一事务核对凭据并写入，返回写入与变化数；凭据一次性', async () => {
  const { a, b, id } = await setupTwoClean();
  const prev = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(prev.status, 200);

  // 方案把 A 调到 502、B 保持 510
  const movedId = await savePlan({
    assignments: [
      { id: a.id, name: 'A', locked: false, original: 500, frequency: 502, offset: 2 },
      { id: b.id, name: 'B', locked: false, original: 510, frequency: 510, offset: 0 },
    ],
  });
  const prev2 = await request('POST', `/api/plans/${movedId}/preview`);
  assert.equal(prev2.status, 200);
  assert.equal(prev2.data.devices.find((d) => d.id === a.id).changed, true);

  const applied = await request('POST', `/api/plans/${movedId}/apply`, { token: prev2.data.token });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, 2);
  assert.equal(applied.data.changed, 1);

  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.find((d) => d.id === a.id).frequency, 502);
  assert.equal(devs.data.devices.find((d) => d.id === b.id).frequency, 510);

  // 同一凭据再次使用 → 409，且设备不再变化
  const again = await request('POST', `/api/plans/${movedId}/apply`, { token: prev2.data.token });
  assert.equal(again.status, 409);
  assert.equal(again.data.repreview, true);
  const devs2 = await request('GET', '/api/devices');
  assert.equal(devs2.data.devices.find((d) => d.id === a.id).frequency, 502);
});

test('缺少凭据直接应用 → 409 且不写入任何设备', async () => {
  const { a, id } = await setupTwoClean();
  const noToken = await request('POST', `/api/plans/${id}/apply`, {});
  assert.equal(noToken.status, 409);
  assert.equal(noToken.data.repreview, true);
  const bogus = await request('POST', `/api/plans/${id}/apply`, { token: 'nope' });
  assert.equal(bogus.status, 409);
  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.find((d) => d.id === a.id).frequency, 500);
});

test('未标记为已求解的方案：预览 422 并禁止应用', async () => {
  const a = await createDevice('A', 500);
  const id = await savePlan({
    solved: false,
    assignments: [{ id: a.id, frequency: 500 }],
  });
  const res = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(res.status, 422);
  assert.ok(res.data.reasons.some((r) => /已求解/.test(r)));
  // 未签发任何凭据
  const applied = await request('POST', `/api/plans/${id}/apply`, { token: 'whatever' });
  assert.equal(applied.status, 409);
});

test('分配与设备不一一对应：指向缺失设备 / 遗漏当前设备 / 重复 ID 均列明原因', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);

  const missingId = await savePlan({
    assignments: [
      { id: a.id, frequency: 500 },
      { id: 999999, frequency: 520 },
    ],
  });
  const r1 = await request('POST', `/api/plans/${missingId}/preview`);
  assert.equal(r1.status, 422);
  assert.ok(r1.data.reasons.some((r) => /不存在/.test(r)));
  assert.ok(r1.data.reasons.some((r) => /没有对应分配/.test(r)));

  const dupId = await savePlan({
    assignments: [
      { id: a.id, frequency: 500 },
      { id: a.id, frequency: 501 },
      { id: b.id, frequency: 510 },
    ],
  });
  const r2 = await request('POST', `/api/plans/${dupId}/preview`);
  assert.equal(r2.status, 422);
  assert.ok(r2.data.reasons.some((r) => /重复/.test(r)));
});

test('非法目标频率（0、负数、超过 10000、非数值）：422', async () => {
  const a = await createDevice('A', 500);
  for (const bad of [0, -1, 10000.0001, NaN]) {
    const id = await savePlan({ assignments: [{ id: a.id, frequency: bad }] });
    const res = await request('POST', `/api/plans/${id}/preview`);
    assert.equal(res.status, 422, `bad=${bad}`);
    assert.ok(res.data.reasons.some((r) => /目标频率/.test(r)), `bad=${bad}`);
  }
  // 边界 10000 合法（单设备 10000 无互调、无占用）
  const idOk = await savePlan({ assignments: [{ id: a.id, frequency: 10000 }] });
  const okRes = await request('POST', `/api/plans/${idOk}/preview`);
  assert.equal(okRes.status, 200);
});

test('锁定设备目标频率与当前不一致：422 且原因点名锁定设备', async () => {
  const a = await createDevice('A', 500, 0.25, true);
  const id = await savePlan({
    assignments: [{ id: a.id, name: 'A', locked: true, frequency: 501, original: 500 }],
  });
  const res = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(res.status, 422);
  assert.ok(res.data.reasons.some((r) => /锁定设备/.test(r) && /不得改频/.test(r)));

  // 锁定且保持原频 → 通过
  const idSame = await savePlan({
    assignments: [{ id: a.id, name: 'A', locked: true, frequency: 500, original: 500 }],
  });
  const same = await request('POST', `/api/plans/${idSame}/preview`);
  assert.equal(same.status, 200);
});

test('按当前保护间隔复算互调冲突：目标配置有冲突时 422 并禁止应用', async () => {
  // 500 与 500.1（guard 0.25）：三阶积 499.9 距 500 仅 0.1 ≤ 0.25 → 冲突
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 505);
  const id = await savePlan({
    assignments: [
      { id: a.id, frequency: 500 },
      { id: b.id, frequency: 500.1 },
    ],
  });
  const res = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(res.status, 422);
  assert.ok(res.data.reasons.some((r) => /互调冲突/.test(r)));
  assert.ok(res.data.conflicts.length > 0);
});

test('保护区与方案所存占用区间闭区间相交（含端点相接）：422', async () => {
  const a = await createDevice('A', 500, 0.25);
  // 保护区 [499.75, 500.25] 与占用 [500.2, 500.4] 相交（500.2 为内部点）
  const id = await savePlan({
    params: { ...BASE_PARAMS, occupiedBands: [{ lo: 500.2, hi: 500.4 }] },
    assignments: [{ id: a.id, frequency: 500 }],
  });
  const res = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(res.status, 422);
  assert.ok(res.data.reasons.some((r) => /占用区间/.test(r)));

  // 端点相接：占用 [500.25, 501]，保护区右端点 500.25 恰好相接
  const idTouch = await savePlan({
    params: { ...BASE_PARAMS, occupiedBands: [{ lo: 500.25, hi: 501 }] },
    assignments: [{ id: a.id, frequency: 500 }],
  });
  const touch = await request('POST', `/api/plans/${idTouch}/preview`);
  assert.equal(touch.status, 422);
  assert.ok(touch.data.reasons.some((r) => /闭区间/.test(r)));

  // 不相交 → 通过
  const idClear = await savePlan({
    params: { ...BASE_PARAMS, occupiedBands: [{ lo: 500.3, hi: 501 }] },
    assignments: [{ id: a.id, frequency: 500 }],
  });
  const clear = await request('POST', `/api/plans/${idClear}/preview`);
  assert.equal(clear.status, 200);
});

test('旧方案缺省占用区间按空数组处理，可正常预览', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);
  // 直接写库模拟旧方案：params 不含 occupiedBands
  db.prepare('INSERT INTO plans (name, params, assignments, total_offset, solved) VALUES (?, ?, ?, ?, ?)')
    .run(
      '旧方案',
      JSON.stringify({ bandMin: 470, bandMax: 608, step: 0.025, maxOffset: 5 }),
      JSON.stringify([
        { id: a.id, frequency: 500 },
        { id: b.id, frequency: 510 },
      ]),
      0,
      1,
    );
  const row = db.prepare('SELECT id FROM plans ORDER BY id DESC LIMIT 1').get();
  const res = await request('POST', `/api/plans/${row.id}/preview`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.occupiedBands, []);
  const listed = await request('GET', '/api/plans');
  assert.deepEqual(listed.data[0].params.occupiedBands, []);
});

test('预览后设备状态变化：确认返回 409、整批回滚不写入，重新预览后可应用', async () => {
  const { a, b, id } = await setupTwoClean();
  const prev = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(prev.status, 200);

  // 预览后把 A 改为 503（通过设备接口，模拟现场状态变化）
  const updated = await request('PUT', `/api/devices/${a.id}`, {
    name: 'A', frequency: 503, guard: 0.25, locked: false,
  });
  assert.equal(updated.status, 200);

  const applied = await request('POST', `/api/plans/${id}/apply`, { token: prev.data.token });
  assert.equal(applied.status, 409);
  assert.match(applied.data.error, /重新预览/);

  // 事务回滚：方案频率未写入，A 仍是 503
  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.find((d) => d.id === a.id).frequency, 503);
  assert.equal(devs.data.devices.find((d) => d.id === b.id).frequency, 510);

  // 旧凭据彻底失效
  const again = await request('POST', `/api/plans/${id}/apply`, { token: prev.data.token });
  assert.equal(again.status, 409);

  // 重新预览（此时 503/510 仍无冲突）→ 凭据刷新，确认成功
  const re = await request('POST', `/api/plans/${id}/preview`);
  assert.equal(re.status, 200);
  assert.equal(re.data.devices.find((d) => d.id === a.id).current, 503);
  assert.equal(re.data.devices.find((d) => d.id === a.id).target, 500);
  const ok = await request('POST', `/api/plans/${id}/apply`, { token: re.data.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.changed, 1);
  const devs2 = await request('GET', '/api/devices');
  assert.equal(devs2.data.devices.find((d) => d.id === a.id).frequency, 500);
});

test('不存在的方案：预览 404', async () => {
  const res = await request('POST', '/api/plans/424242/preview');
  assert.equal(res.status, 404);
});
