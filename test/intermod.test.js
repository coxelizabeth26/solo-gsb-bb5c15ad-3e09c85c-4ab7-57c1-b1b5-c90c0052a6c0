'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mhzToHz, hzToMhz, computeConflicts, coordinate, normalizeOccupiedBands } = require('../lib/intermod');

/** 构造频道对象 */
function ch(id, freqMhz, guardMhz = 0.25, locked = false) {
  return {
    id,
    name: `CH${id}`,
    freqHz: mhzToHz(freqMhz),
    guardHz: mhzToHz(guardMhz),
    locked,
  };
}

test('MHz 与 Hz 转换', () => {
  assert.equal(mhzToHz(512.025), 512025000);
  assert.equal(hzToMhz(512025000), 512.025);
  assert.equal(hzToMhz(mhzToHz(470.123456)), 470.123456);
});

test('无冲突：间隔充分的两个频道', () => {
  const conflicts = computeConflicts([ch(1, 500), ch(2, 510)]);
  assert.equal(conflicts.length, 0);
});

test('互调积枚举：|f1-f2|、f1+f2、|2f1-f2| 两种有序组合', () => {
  // f1=100, f2=200（guard=0 便于精确命中）
  // |f1-f2|=100 命中 f1；f1+f2=300 不命中；|2f1-f2|=0 不命中；|2f2-f1|=300 不命中
  const channels = [ch(1, 100, 0), ch(2, 200, 0)];
  const conflicts = computeConflicts(channels);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].productType, '|f1-f2|');
  assert.equal(conflicts[0].productHz, mhzToHz(100));
  assert.equal(conflicts[0].victim.id, 1);
});

test('三阶互调 |2f1-f2| 命中第三方频道并报告来源', () => {
  // f1=500, f2=501 → 2*500-501=499；f3=499 受害
  const conflicts = computeConflicts([ch(1, 500), ch(2, 501), ch(3, 499)]);
  const hit = conflicts.find((c) => c.victim.id === 3 && c.productType === '|2f1-f2|');
  assert.ok(hit, '应检测到 |2f1-f2| 冲突');
  assert.deepEqual(hit.source.map((s) => s.id), [1, 2]);
  assert.equal(hit.productHz, mhzToHz(499));
});

test('保护间隔边界（含边界）判定', () => {
  // f1=500, f2=500.2 → |f1-f2|=0.2 MHz 远离；改用和频测试边界：
  // f1=100, f2=200, guard=0.1 → |f1-f2|=100 距 f1 载频 0，必中；把 guard 调 0 再验证边界外
  const exact = computeConflicts([ch(1, 100, 0), ch(2, 200, 0)]);
  assert.equal(exact.length, 1);
  // guard 为 0.05 时，|f1-f2|=100 距 f1 载频偏差 0 ≤ 0.05 仍命中
  const within = computeConflicts([ch(1, 100, 0.05), ch(2, 200, 0)]);
  assert.ok(within.some((c) => c.victim.id === 1));
});

test('自动协调：锁定频道保持不动', () => {
  // 500 与 500.1 的三阶互调 2*500-500.1=499.9 距 500 为 0.1 ≤ 0.25 → 冲突
  // 锁定 500，期望 500.1 被移走
  const result = coordinate(
    [ch(1, 500, 0.25, true), ch(2, 500.1, 0.25, false)],
    { bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510), stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2) },
  );
  assert.equal(result.solved, true);
  assert.equal(result.assignments[0].freqHz, mhzToHz(500)); // 锁定不动
  assert.notEqual(result.assignments[1].freqHz, mhzToHz(500.1)); // 未锁定被调整
  // 结果必须真的无冲突
  const solved = result.assignments.map((a, i) => ({
    id: a.id, name: a.name, freqHz: a.freqHz, guardHz: mhzToHz(0.25), locked: i === 0,
  }));
  assert.equal(computeConflicts(solved).length, 0);
});

test('自动协调：选择总偏移最小的方案', () => {
  // 单频道无冲突 → 总偏移 0，保持原值
  const r0 = coordinate(
    [ch(1, 500), ch(2, 510)],
    { bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(520), stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2) },
  );
  assert.equal(r0.solved, true);
  assert.equal(r0.totalOffsetHz, 0);

  // 双频道冲突场景：验证总偏移确实最小
  const channels = [ch(1, 500, 0.25, true), ch(2, 500.1, 0.25, false)];
  const params = { bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510), stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2) };
  const result = coordinate(channels, params);
  // 暴力枚举验证最优性
  const kMax = Math.floor(params.maxOffsetHz / params.stepHz);
  let bestBrute = Infinity;
  for (let k = -kMax; k <= kMax; k++) {
    const f2 = mhzToHz(500.1) + k * params.stepHz;
    if (f2 < params.bandMinHz || f2 > params.bandMaxHz) continue;
    const trial = [
      { id: 1, name: 'a', freqHz: mhzToHz(500), guardHz: mhzToHz(0.25) },
      { id: 2, name: 'b', freqHz: f2, guardHz: mhzToHz(0.25) },
    ];
    if (computeConflicts(trial).length === 0) {
      bestBrute = Math.min(bestBrute, Math.abs(k) * params.stepHz);
    }
  }
  assert.equal(result.totalOffsetHz, bestBrute);
});

test('自动协调：同分时按录入顺序选择更低频率', () => {
  // 对称场景：f1=500（锁定），f2=500（未锁定，与 f1 同频），guard=0.25
  // 三阶互调 |2f1-f2'|、|2f2'-f1| 距载频均为 |f2'-500|，需 > 0.25
  // 步进 0.025 → k=±11（偏移同为 0.275）为最小总偏移，两个方向同分
  // 按录入顺序应选更低频率：500 - 0.275 = 499.725
  const result = coordinate(
    [ch(1, 500, 0.25, true), ch(2, 500, 0.25, false)],
    { bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510), stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(1) },
  );
  assert.equal(result.solved, true);
  assert.equal(result.totalOffsetHz, 11 * mhzToHz(0.025));
  const newF2 = result.assignments[1].freqHz;
  assert.equal(newF2, mhzToHz(500) - 11 * mhzToHz(0.025));
});

test('自动协调：无解时保持原值并给出原因', () => {
  // 最大偏移为 0 → 无法移动，冲突依旧
  const result = coordinate(
    [ch(1, 500, 0.25, true), ch(2, 500.1, 0.25, false)],
    { bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510), stepHz: mhzToHz(0.025), maxOffsetHz: 0 },
  );
  assert.equal(result.solved, false);
  assert.ok(result.reason && result.reason.length > 0);
  assert.equal(result.assignments[1].freqHz, mhzToHz(500.1)); // 保持原值
});

test('自动协调：候选为空时报告对应频道', () => {
  // 频段不含原频且 maxOffset 够不到 → 候选为空
  const result = coordinate(
    [ch(1, 500), ch(2, 600)],
    { bandMinHz: mhzToHz(510), bandMaxHz: mhzToHz(520), stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(1) },
  );
  assert.equal(result.solved, false);
  assert.match(result.reason, /没有可用频率/);
});

test('自动协调：全部锁定且冲突 → 明确提示', () => {
  const result = coordinate(
    [ch(1, 500, 0.25, true), ch(2, 500.1, 0.25, true)],
    { bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510), stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2) },
  );
  assert.equal(result.solved, false);
  assert.match(result.reason, /锁定/);
});

test('8 频道综合场景：协调后无冲突且总偏移最小', () => {
  const freqs = [512.0, 512.2, 520.0, 536.5, 548.0, 560.25, 574.0, 590.5];
  const channels = freqs.map((f, i) => ch(i + 1, f, 0.25, i === 6)); // 第 7 个锁定
  const params = { bandMinHz: mhzToHz(470), bandMaxHz: mhzToHz(608), stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(5) };
  const before = computeConflicts(channels);
  assert.ok(before.length > 0, '示例数据应存在冲突');

  const result = coordinate(channels, params);
  assert.equal(result.solved, true);
  const solved = result.assignments.map((a, i) => ({
    id: a.id, name: a.name, freqHz: a.freqHz, guardHz: mhzToHz(0.25), locked: i === 6,
  }));
  assert.equal(computeConflicts(solved).length, 0);
  assert.equal(solved[6].freqHz, mhzToHz(574.0)); // 锁定频道不动
});

/* ---------- 现场占用频段 ---------- */

test('占用区间校验：非有限数值与下限大于上限均被拒绝', () => {
  assert.throws(() => normalizeOccupiedBands([{ lo: 'abc', hi: 500 }]), /有限数值/);
  assert.throws(() => normalizeOccupiedBands([{ lo: NaN, hi: 500 }]), /有限数值/);
  assert.throws(() => normalizeOccupiedBands([{ lo: 501, hi: 500 }]), /下限/);
  assert.throws(() => normalizeOccupiedBands('x'), /数组/);
  assert.throws(() => normalizeOccupiedBands([{ lo: 500 }]), /有限数值/);
  assert.throws(() => normalizeOccupiedBands([null]), /上限/);
});

test('占用区间：合并重叠与端点相接的区间并按下限排序', () => {
  const merged = normalizeOccupiedBands([
    { lo: 505, hi: 510 },
    { lo: 499, hi: 501 },
    { lo: 500.5, hi: 505 },     // 与 [499,501] 重叠，并与 [505,510] 在 505 相接
    { lo: 520, hi: 521 },
  ]);
  assert.deepEqual(merged, [
    { lo: 499, hi: 510 },
    { lo: 520, hi: 521 },
  ]);
  // 单点区间合法（下限 = 上限）
  assert.deepEqual(normalizeOccupiedBands([{ lo: 500, hi: 500 }]), [{ lo: 500, hi: 500 }]);
  // 空输入 → 空数组（不启用避让）
  assert.deepEqual(normalizeOccupiedBands([]), []);
});

test('占用避让：保护区与占用区间相交的候选被剔除，其余仍按总偏移最小求解', () => {
  // 单频道无互调问题；占用 [499.8, 500.2]，guard 0.25
  // 候选 f 的保护区 [f-0.25, f+0.25] 与占用区间相交即不可用
  // 两侧最近的可用候选：499.525（保护区右端 499.775 < 499.8）、500.475（左端 500.225 > 500.2）
  const params = {
    bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510),
    stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2),
    occupiedHz: [{ loHz: mhzToHz(499.8), hiHz: mhzToHz(500.2) }],
  };
  const result = coordinate([ch(1, 500, 0.25)], params);
  assert.equal(result.solved, true);
  assert.equal(result.assignments[0].freqHz, mhzToHz(499.525)); // 偏移 0.475
  // 对照：无占用时保持原频
  const { occupiedHz, ...freeParams } = params;
  const free = coordinate([ch(1, 500, 0.25)], freeParams);
  assert.equal(free.assignments[0].freqHz, mhzToHz(500));
});

test('占用避让：端点相接也算相交（闭区间）', () => {
  // 占用 [500.2, 510]：f = 499.95 时保护区右端 = 500.2，恰好相接 → 不可用
  // 最近可用为 499.925（右端 500.175 < 500.2）
  const result = coordinate(
    [ch(1, 500, 0.25)],
    {
      bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510),
      stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2),
      occupiedHz: [{ loHz: mhzToHz(500.2), hiHz: mhzToHz(510) }],
    },
  );
  assert.equal(result.solved, true);
  assert.equal(result.assignments[0].freqHz, mhzToHz(499.925));
});

test('占用避让：重叠区间合并后等价生效', () => {
  const channels = [ch(1, 500, 0.25)];
  const base = {
    bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510),
    stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2),
  };
  const split = coordinate(channels, {
    ...base,
    occupiedHz: [
      { loHz: mhzToHz(499.9), hiHz: mhzToHz(500.05) },
      { loHz: mhzToHz(500.05), hiHz: mhzToHz(500.3) }, // 端点相接，合并为 [499.9,500.3]
    ],
  });
  const merged = coordinate(channels, {
    ...base,
    occupiedHz: [{ loHz: mhzToHz(499.9), hiHz: mhzToHz(500.3) }],
  });
  assert.equal(split.solved, true);
  assert.equal(split.assignments[0].freqHz, merged.assignments[0].freqHz);
});

test('占用避让：所有候选均被占用频段堵死 → 无解、保持原值并说明占用原因', () => {
  const result = coordinate(
    [ch(1, 500, 0.25)],
    {
      bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510),
      stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2),
      occupiedHz: [{ loHz: mhzToHz(0), hiHz: mhzToHz(100000) }],
    },
  );
  assert.equal(result.solved, false);
  assert.match(result.reason, /占用频段/);
  assert.equal(result.assignments[0].freqHz, mhzToHz(500)); // 保持原值
});

test('占用避让：锁定频道保护区与占用区间相交 → 明确提示且保持原频', () => {
  const result = coordinate(
    [ch(1, 500, 0.25, true)],
    {
      bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510),
      stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2),
      occupiedHz: [{ loHz: mhzToHz(500.1), hiHz: mhzToHz(500.4) }],
    },
  );
  assert.equal(result.solved, false);
  assert.match(result.reason, /锁定频道/);
  assert.match(result.reason, /占用频段/);
  assert.equal(result.assignments[0].freqHz, mhzToHz(500));
});

test('占用避让：互调规则与占用约束同时生效，结果既无互调冲突也不侵入占用区', () => {
  // 500（锁定）+ 500.1（未锁定）存在互调冲突；占用区间再排除 500.275–500.5
  const occupiedHz = [{ loHz: mhzToHz(500.275), hiHz: mhzToHz(500.5) }];
  const result = coordinate(
    [ch(1, 500, 0.25, true), ch(2, 500.1, 0.25, false)],
    {
      bandMinHz: mhzToHz(490), bandMaxHz: mhzToHz(510),
      stepHz: mhzToHz(0.025), maxOffsetHz: mhzToHz(2),
      occupiedHz,
    },
  );
  assert.equal(result.solved, true);
  const f2 = result.assignments[1].freqHz;
  // 无互调冲突
  const solved = [
    { id: 1, name: 'a', freqHz: mhzToHz(500), guardHz: mhzToHz(0.25) },
    { id: 2, name: 'b', freqHz: f2, guardHz: mhzToHz(0.25) },
  ];
  assert.equal(computeConflicts(solved).length, 0);
  // 新载频保护区不侵入占用区间
  assert.ok(f2 + mhzToHz(0.25) < mhzToHz(500.275) || f2 - mhzToHz(0.25) > mhzToHz(500.5));
});
