'use strict';

// 安全改频顺序搜索核心（lib/switchguide.js）的纯函数单元测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const { mhzToHz } = require('../lib/intermod');
const { searchSwitchOrder } = require('../lib/switchguide');

const G = mhzToHz(0.25);

/** mover：{id,name,from,to}；fixed：{id,name,f}，频率单位 MHz */
function solve(moverSpecs, fixedSpecs = [], occupied = []) {
  const movers = moverSpecs.map(({ id, from, to }) => ({
    id, name: `D${id}`, freqHz: mhzToHz(from), targetHz: mhzToHz(to), guardHz: G, locked: false,
  }));
  const fixed = fixedSpecs.map(({ id, f, locked = false }) => ({
    id, name: `D${id}`, freqHz: mhzToHz(f), guardHz: G, locked,
  }));
  const occupiedHz = occupied.map(([lo, hi]) => ({ loHz: mhzToHz(lo), hiHz: mhzToHz(hi) }));
  return searchSwitchOrder(movers, fixed, occupiedHz);
}

test('单 mover：一步到达目标，状态表记录初始与目标', () => {
  const r = solve([{ id: 1, from: 500, to: 502 }], [{ id: 2, f: 520 }]);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.order, [1]);
  assert.equal(r.states.get(0).get(1), mhzToHz(500));
  assert.equal(r.states.get(1).get(1), mhzToHz(502));
  assert.equal(r.states.get(1).get(2), mhzToHz(520)); // 固定设备全程不变
});

test('同频交换无可行顺序，两台设备都在 blocked 中', () => {
  const r = solve([
    { id: 1, from: 500, to: 520 },
    { id: 2, from: 520, to: 500 },
  ]);
  assert.equal(r.feasible, false);
  assert.deepEqual(r.blocked.map((b) => b.id).sort(), [1, 2]);
  for (const b of r.blocked) assert.ok(b.conflicts.length > 0);
});

test('多个可行顺序取设备 ID 序列字典序最小者', () => {
  // 可行顺序 [2,3,1] 与 [3,2,1]，最小为 [2,3,1]
  const r = solve([
    { id: 1, from: 500, to: 500.2 },
    { id: 2, from: 500.4, to: 500.8 },
    { id: 3, from: 501.2, to: 502 },
  ]);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.order, [2, 3, 1]);
  // 终态全部到达目标
  const finalState = r.states.get(3);
  assert.equal(finalState.get(1), mhzToHz(500.2));
  assert.equal(finalState.get(2), mhzToHz(500.8));
  assert.equal(finalState.get(3), mhzToHz(502));
});

test('占用区间：改到目标后的保护区与占用区间闭区间相交 → 不可行并给出占用命中', () => {
  // 设备1 500→510（设备2 固定 540，互调上无冲突）；
  // 占用 [509.9, 511] 与起点 500 的保护区不相交（起始干净），
  // 但与目标 510 的保护区 [509.75, 510.25] 相交 → 唯一步被阻塞。
  const r = solve([{ id: 1, from: 500, to: 510 }], [{ id: 2, f: 540 }], [[509.9, 511]]);
  assert.equal(r.feasible, false);
  const b1 = r.blocked.find((b) => b.id === 1);
  assert.ok(b1, '设备 1 的目标步应被占用区间阻塞');
  assert.ok(b1.occupiedHits.length > 0);
});

test('占用区间不影响安全路径时仍可找到顺序', () => {
  // 占用远离工作频率（600 附近），[2,3,1] 顺序依然可行
  const r = solve([
    { id: 1, from: 500, to: 500.2 },
    { id: 2, from: 500.4, to: 500.8 },
    { id: 3, from: 501.2, to: 502 },
  ], [], [[600, 601]]);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.order, [2, 3, 1]);
});

test('锁定设备作为固定设备全程不变', () => {
  const r = solve([{ id: 2, from: 520, to: 522 }], [{ id: 1, f: 500, locked: true }]);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.order, [2]);
  assert.equal(r.states.get(1).get(1), mhzToHz(500));
});
