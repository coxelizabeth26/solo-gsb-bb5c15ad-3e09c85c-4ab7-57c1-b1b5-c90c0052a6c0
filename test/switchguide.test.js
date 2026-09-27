'use strict';

// 安全改频指引接口测试：POST /api/plans/:id/switch-guide
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

async function savePlan(assignments, params = BASE_PARAMS) {
  const res = await request('POST', '/api/plans', {
    name: '测试方案',
    params,
    assignments,
    totalOffset: 0,
    solved: true,
  });
  assert.equal(res.status, 201, res.data.error);
  return res.data.id;
}

const asg = (d, frequency) => ({
  id: d.id, name: d.name, locked: d.locked, original: d.frequency, frequency, offset: Math.abs(frequency - d.frequency),
});

async function guide(id) {
  return request('POST', `/api/plans/${id}/switch-guide`);
}

test('频率完全相同：noChange=true，空步骤并提示无需改频', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 510);
  const id = await savePlan([asg(a, 500), asg(b, 510)]);

  const res = await guide(id);
  assert.equal(res.status, 200);
  assert.equal(res.data.feasible, true);
  assert.equal(res.data.noChange, true);
  assert.match(res.data.message, /无需改频/);
  assert.deepEqual(res.data.steps, []);
  assert.equal(res.data.initialTable.length, 2);
  assert.equal(res.data.initialTable.find((d) => d.id === a.id).frequency, 500);
});

test('单台改频：一步成功，含设备名/改前改后 MHz/每步完整频率表，且不写回设备', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 520);
  const id = await savePlan([asg(a, 502), asg(b, 520)]);

  const res = await guide(id);
  assert.equal(res.status, 200);
  assert.equal(res.data.feasible, true);
  assert.deepEqual(res.data.order, [a.id]);
  assert.equal(res.data.steps.length, 1);

  const s = res.data.steps[0];
  assert.equal(s.step, 1);
  assert.equal(s.deviceId, a.id);
  assert.equal(s.deviceName, 'A');
  assert.equal(s.from, 500);
  assert.equal(s.to, 502);

  // 改前/改后均为包含全部设备的完整频率表
  assert.equal(s.tableBefore.length, 2);
  assert.equal(s.tableAfter.length, 2);
  assert.equal(s.tableBefore.find((d) => d.id === a.id).frequency, 500);
  assert.equal(s.tableAfter.find((d) => d.id === a.id).frequency, 502);
  assert.equal(s.tableAfter.find((d) => d.id === b.id).frequency, 520);

  // 只读：设备频率未被写回，方案与设备均不变化
  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.find((d) => d.id === a.id).frequency, 500);
  const plans = await request('GET', '/api/plans');
  assert.equal(plans.data[0].assignments.find((x) => x.id === a.id).frequency, 502);
});

test('交换频率互不可先改：明确提示无可行顺序并逐设备列出冲突原因', async () => {
  // 500/520 无冲突；目标 520/500 也无冲突；但任一方先改都会撞成同频（互调冲突）
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 520);
  const id = await savePlan([asg(a, 520), asg(b, 500)]);

  const res = await guide(id);
  assert.equal(res.status, 200);
  assert.equal(res.data.feasible, false);
  assert.equal(res.data.stage, 'order');
  assert.deepEqual(res.data.steps, []);
  assert.ok(Array.isArray(res.data.reasons) && res.data.reasons.length >= 2);
  const joined = res.data.reasons.join('\n');
  assert.match(joined, /A/);
  assert.match(joined, /B/);
  assert.match(joined, /互调|冲突|保护区/);
  assert.match(joined, /不存在任何安全改频顺序/);
});

test('首台先改被阻、另一台可先改：唯一可行顺序 [B, A]（非 ID 升序）', async () => {
  // A 500→519.8（先改则与 520 的 B 相差 0.2 ≤ 0.25，冲突）
  // B 520→522（先改：500/522 干净），随后 A→519.8（519.8/522 干净）
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 520);
  const id = await savePlan([asg(a, 519.8), asg(b, 522)]);

  const res = await guide(id);
  assert.equal(res.status, 200);
  assert.equal(res.data.feasible, true);
  assert.deepEqual(res.data.order, [b.id, a.id]);
  assert.equal(res.data.steps.length, 2);

  const s1 = res.data.steps[0];
  assert.equal(s1.deviceId, b.id);
  assert.equal(s1.from, 520);
  assert.equal(s1.to, 522);
  assert.equal(s1.tableAfter.find((d) => d.id === a.id).frequency, 500);
  assert.equal(s1.tableAfter.find((d) => d.id === b.id).frequency, 522);

  const s2 = res.data.steps[1];
  assert.equal(s2.deviceId, a.id);
  assert.equal(s2.from, 500);
  assert.equal(s2.to, 519.8);
  assert.equal(s2.tableAfter.find((d) => d.id === a.id).frequency, 519.8);
  assert.equal(s2.tableAfter.find((d) => d.id === b.id).frequency, 522);
});

test('多可行顺序取设备 ID 序列字典序最小者：[2,3,1] 优先于 [3,2,1]', async () => {
  // 穷举验证过：当前 [500,500.4,501.2]、目标 [500.2,500.8,502] 均无冲突，
  // 可行顺序为 (B,C,A) 与 (C,B,A)，字典序最小为 (B,C,A)。
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 500.4);
  const c = await createDevice('C', 501.2);
  const id = await savePlan([asg(a, 500.2), asg(b, 500.8), asg(c, 502)]);

  const res = await guide(id);
  assert.equal(res.status, 200);
  assert.equal(res.data.feasible, true);
  assert.deepEqual(res.data.order, [b.id, c.id, a.id]);
  assert.equal(res.data.steps.length, 3);

  // 每一步的中间表都必须无冲突：逐步核对关键频率
  const freqsOf = (table) => Object.fromEntries(table.map((d) => [d.id, d.frequency]));
  assert.deepEqual(freqsOf(res.data.steps[0].tableAfter), {
    [a.id]: 500, [b.id]: 500.8, [c.id]: 501.2,
  });
  assert.deepEqual(freqsOf(res.data.steps[1].tableAfter), {
    [a.id]: 500, [b.id]: 500.8, [c.id]: 502,
  });
  assert.deepEqual(freqsOf(res.data.steps[2].tableAfter), {
    [a.id]: 500.2, [b.id]: 500.8, [c.id]: 502,
  });
});

test('锁定设备不改频：步骤中只出现未锁定设备，锁定设备全程保持原频', async () => {
  const a = await createDevice('A', 500, 0.25, true);
  const b = await createDevice('B', 520);
  const id = await savePlan([asg(a, 500), asg(b, 522)]);

  const res = await guide(id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.order, [b.id]);
  const rowA = res.data.steps[0].tableAfter.find((d) => d.id === a.id);
  assert.equal(rowA.frequency, 500);
  assert.equal(rowA.locked, true);
});

test('当前配置存在互调冲突：422 且 stage=start，列出起始检查原因', async () => {
  // 500 与 500.1（guard 0.25）当前即冲突；目标 500/510 是干净的
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 500.1);
  const id = await savePlan([asg(a, 500), asg(b, 510)]);

  const res = await guide(id);
  assert.equal(res.status, 422);
  assert.equal(res.data.stage, 'start');
  assert.equal(res.data.feasible, false);
  assert.ok(res.data.startReasons.some((r) => /互调冲突/.test(r)));
});

test('目标未通过应用检查：422 且 stage=target，列出目标检查原因', async () => {
  const a = await createDevice('A', 500);
  const b = await createDevice('B', 520);
  // 目标 500/500.1 按当前保护间隔复算有互调冲突
  const id = await savePlan([asg(a, 500), asg(b, 500.1)]);

  const res = await guide(id);
  assert.equal(res.status, 422);
  assert.equal(res.data.stage, 'target');
  assert.equal(res.data.feasible, false);
  assert.ok(res.data.targetReasons.some((r) => /互调冲突/.test(r)));
  assert.ok(res.data.conflicts.length > 0);
});

test('当前配置侵入方案所存占用区间：422 且 stage=start', async () => {
  // A=500 保护区 [499.75,500.25]；占用区间 [499.8,499.9] 与当前相交但与目标 510 不相交
  const a = await createDevice('A', 500);
  const id = await savePlan(
    [{ ...asg(a, 510) }],
    { ...BASE_PARAMS, occupiedBands: [{ lo: 499.8, hi: 499.9 }] },
  );

  const res = await guide(id);
  assert.equal(res.status, 422);
  assert.equal(res.data.stage, 'start');
  assert.ok(res.data.startReasons.some((r) => /占用区间/.test(r)));
});

test('不存在的方案：404', async () => {
  const res = await guide(424242);
  assert.equal(res.status, 404);
});
