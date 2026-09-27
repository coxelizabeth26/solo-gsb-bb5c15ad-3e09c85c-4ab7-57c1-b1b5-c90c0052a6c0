'use strict';

/**
 * 互调冲突分析与自动频率协调核心逻辑（纯函数，无外部依赖）。
 *
 * 单位约定：所有频率在内部一律使用整数 Hz（由 MHz × 1e6 四舍五入得到），
 * 避免浮点误差；仅在 API 边界与界面显示时转换为 MHz。
 *
 * 互调积：对任意两个不同频道 (f1, f2) 枚举
 *   |f1 - f2|、f1 + f2、|2f1 - f2|（含两种有序组合，即 |2f1-f2| 与 |2f2-f1|）
 * 保护区：频道载频 fc、保护间隔 g 时，区间 [fc - g, fc + g] 为保护区；
 * 互调积 p 满足 |p - fc| <= g（含边界）即判定为落入保护区，构成冲突。
 */

const HZ_PER_MHZ = 1e6;

function mhzToHz(mhz) {
  const n = Number(mhz);
  if (!Number.isFinite(n)) {
    throw new Error(`无效频率值: ${mhz}`);
  }
  return Math.round(n * HZ_PER_MHZ);
}

function hzToMhz(hz) {
  // 保留 6 位小数（1 Hz 精度），并去掉多余的尾随零
  return parseFloat((hz / HZ_PER_MHZ).toFixed(6));
}

/**
 * 校验并合并现场占用频段（单位 MHz）。
 *
 * 入参为 [{ lo, hi }, ...]：要求 lo、hi 均为有限数值且 lo <= hi；
 * 重叠或端点相接的区间自动合并，返回按下限升序的合并结果（MHz，Hz 精度）。
 * 纯函数，供 API 层做参数校验与界面回看共用。
 *
 * @param {Array<{lo:number, hi:number}>} raw
 * @returns {Array<{lo:number, hi:number}>} 合并后的区间（MHz）
 * @throws {Error} 格式非法、数值非有限或下限大于上限
 */
function normalizeOccupiedBands(raw) {
  if (!Array.isArray(raw)) throw new Error('现场占用频段必须是区间数组');
  const pairs = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('每个占用区间必须包含下限 lo 与上限 hi（MHz）');
    }
    const lo = Number(item.lo);
    const hi = Number(item.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('占用频段必须填写有限数值（MHz）');
    }
    if (lo > hi) {
      throw new Error(`占用区间无效：下限 ${lo} 不能大于上限 ${hi}`);
    }
    pairs.push({ loHz: mhzToHz(lo), hiHz: mhzToHz(hi) });
  }
  pairs.sort((a, b) => a.loHz - b.loHz || a.hiHz - b.hiHz);

  const merged = [];
  for (const p of pairs) {
    const last = merged[merged.length - 1];
    // 闭区间语义：端点相接（p.loHz === last.hiHz）也合并，与避让判定保持一致
    if (last && p.loHz <= last.hiHz) {
      if (p.hiHz > last.hiHz) last.hiHz = p.hiHz;
    } else {
      merged.push({ loHz: p.loHz, hiHz: p.hiHz });
    }
  }
  return merged.map(({ loHz, hiHz }) => ({ lo: hzToMhz(loHz), hi: hzToMhz(hiHz) }));
}

/**
 * 计算一组频道的全部互调冲突。
 * @param {Array<{id:*, name:string, freqHz:number, guardHz:number}>} channels 按录入顺序排列
 * @returns {Array<object>} 冲突列表，每项含互调积类型/频率、来源频道、受影响频道
 */
function computeConflicts(channels) {
  const conflicts = [];
  const n = channels.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = channels[i];
      const b = channels[j];
      // 每个无序频道对产生 4 个互调积（三阶项含两种有序组合）
      const products = [
        { type: '|f1-f2|', f1: a, f2: b, value: Math.abs(a.freqHz - b.freqHz) },
        { type: 'f1+f2', f1: a, f2: b, value: a.freqHz + b.freqHz },
        { type: '|2f1-f2|', f1: a, f2: b, value: Math.abs(2 * a.freqHz - b.freqHz) },
        { type: '|2f1-f2|', f1: b, f2: a, value: Math.abs(2 * b.freqHz - a.freqHz) },
      ];
      for (const p of products) {
        for (let k = 0; k < n; k++) {
          const victim = channels[k];
          const deviation = Math.abs(p.value - victim.freqHz);
          if (deviation <= victim.guardHz) {
            conflicts.push({
              productType: p.type,
              productHz: p.value,
              source: [
                { id: p.f1.id, name: p.f1.name, freqHz: p.f1.freqHz },
                { id: p.f2.id, name: p.f2.name, freqHz: p.f2.freqHz },
              ],
              victim: {
                id: victim.id,
                name: victim.name,
                freqHz: victim.freqHz,
                guardHz: victim.guardHz,
              },
              deviationHz: deviation,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

/** 回溯搜索的节点上限，防止极端参数下搜索空间爆炸 */
const SEARCH_NODE_CAP = 2_000_000;

/**
 * 自动频率协调。
 *
 * 在 [bandMinHz, bandMaxHz] 频段内，以 stepHz 为步进、maxOffsetHz 为最大偏移，
 * 为每个未锁定频道生成候选频率（原频 + k × 步进）。锁定频道保持不动。
 * 若提供 occupiedHz（已合并的占用区间列表），候选载频的保护区
 * [f - guard, f + guard] 与任一占用区间相交（端点相接也算）时，该候选不可用。
 * 通过带回溯的分支限界搜索，找出总偏移（各频道 |新频-原频| 之和）最小的无冲突方案；
 * 总偏移相同时，按录入顺序逐频道比较，优先选择更低频率。
 *
 * @param {Array<{id:*, name:string, freqHz:number, guardHz:number, locked:boolean}>} channels 按录入顺序
 * @param {{bandMinHz:number, bandMaxHz:number, stepHz:number, maxOffsetHz:number,
 *          occupiedHz?:Array<{loHz:number, hiHz:number}>}} params
 * @returns {{solved:boolean, reason:string|null, capped:boolean, nodes:number,
 *            assignments:Array, totalOffsetHz:number}}
 */
function coordinate(channels, params) {
  const { bandMinHz, bandMaxHz, stepHz, maxOffsetHz, occupiedHz = [] } = params;
  const n = channels.length;

  /** 保护区 [f - guard, f + guard] 是否与任一占用区间相交（闭区间，端点相接也算） */
  const hitsOccupied = (f, guardHz) =>
    occupiedHz.some((o) => f - guardHz <= o.hiHz && o.loHz <= f + guardHz);

  /** 找出第一个与保护区相交的占用区间，用于提示 */
  const firstOccupiedHit = (f, guardHz) =>
    occupiedHz.find((o) => f - guardHz <= o.hiHz && o.loHz <= f + guardHz);

  // ---- 生成候选频率（按偏移升序、同偏移按频率升序排列；剔除占用频段） ----
  const candInfos = channels.map((ch) => {
    if (ch.locked) {
      // 锁定频道只有原频一个候选；若其保护区侵入占用频段则候选为空（锁定无法避让）
      const blocked = hitsOccupied(ch.freqHz, ch.guardHz);
      return {
        list: blocked ? [] : [{ freqHz: ch.freqHz, offsetHz: 0 }],
        blockedByOccupied: blocked,
      };
    }
    let rawExists = false;
    const list = [];
    const kMax = Math.floor(maxOffsetHz / stepHz);
    for (let k = -kMax; k <= kMax; k++) {
      const f = ch.freqHz + k * stepHz;
      if (f < bandMinHz || f > bandMaxHz) continue;
      rawExists = true;
      if (hitsOccupied(f, ch.guardHz)) continue; // 保护区与占用频段相交 → 候选不可用
      list.push({ freqHz: f, offsetHz: Math.abs(k) * stepHz });
    }
    list.sort((x, y) => x.offsetHz - y.offsetHz || x.freqHz - y.freqHz);
    // 频段/步进/偏移约束内存在原始候选、却被占用频段全部剔除 → 完全由占用频段堵死
    return { list, blockedByOccupied: list.length === 0 && rawExists };
  });
  const candLists = candInfos.map((c) => c.list);

  // 某频道在约束下没有任何候选频率 → 直接无解
  for (let i = 0; i < n; i++) {
    const ch = channels[i];
    if (candLists[i].length === 0) {
      let reason;
      if (ch.locked) {
        const hit = firstOccupiedHit(ch.freqHz, ch.guardHz);
        if (hit) {
          reason = `锁定频道「${ch.name}」的保护区（${hzToMhz(ch.freqHz - ch.guardHz)}–` +
            `${hzToMhz(ch.freqHz + ch.guardHz)} MHz）与现场占用频段（${hzToMhz(hit.loHz)}–` +
            `${hzToMhz(hit.hiHz)} MHz）相交，锁定频道无法避让，已保持原有频率。`;
        } else {
          reason = '所有频道均已锁定且当前配置存在互调冲突，没有可调整的频道，已保持原有频率。';
        }
      } else if (candInfos[i].blockedByOccupied) {
        reason = `频道「${ch.name}」在指定频段、步进与最大偏移约束内的所有候选频率，其保护区均与现场占用频段相交，没有可用频率，已保持原有频率。`;
      } else {
        reason = `频道「${ch.name}」在指定频段、步进与最大偏移约束下没有可用频率，已保持原有频率。`;
      }
      return {
        solved: false,
        reason,
        capped: false,
        nodes: 0,
        assignments: channels.map((c) => ({
          id: c.id, name: c.name, locked: !!c.locked,
          originalHz: c.freqHz, freqHz: c.freqHz, offsetHz: 0,
        })),
        totalOffsetHz: 0,
      };
    }
  }

  // ---- 回溯 + 分支限界 ----
  const assigned = new Array(n); // 已确定的频率（Hz）
  const products = [];           // 已确定频道之间产生的互调积（Hz）
  let best = null;               // { totalHz, freqs: number[] }
  let nodes = 0;
  let capped = false;

  const hitsGuard = (productHz, idx) =>
    Math.abs(productHz - assigned[idx]) <= channels[idx].guardHz;

  /** 解 A 是否优于解 B：总偏移更小；或相同则按录入顺序逐频道取更低频率 */
  const isBetter = (a, b) => {
    if (b === null) return true;
    if (a.totalHz !== b.totalHz) return a.totalHz < b.totalHz;
    for (let i = 0; i < n; i++) {
      if (a.freqs[i] !== b.freqs[i]) return a.freqs[i] < b.freqs[i];
    }
    return false;
  };

  function dfs(k, offsetSoFar) {
    if (capped) return;
    if (++nodes > SEARCH_NODE_CAP) { capped = true; return; }
    if (best && offsetSoFar > best.totalHz) return; // 限界：部分偏移已超过最优解
    if (k === n) {
      const sol = { totalHz: offsetSoFar, freqs: assigned.slice() };
      if (isBetter(sol, best)) best = sol;
      return;
    }
    const baseCount = products.length;
    for (const cand of candLists[k]) {
      if (best && offsetSoFar + cand.offsetHz > best.totalHz) break; // 候选按偏移升序，可提前终止
      assigned[k] = cand.freqHz;

      // 新增互调积：频道 k 与已确定的 0..k-1 配对
      let ok = true;
      for (let j = 0; j < k && ok; j++) {
        const fj = assigned[j];
        const fk = cand.freqHz;
        const newProducts = [
          Math.abs(fj - fk),
          fj + fk,
          Math.abs(2 * fj - fk),
          Math.abs(2 * fk - fj),
        ];
        for (const p of newProducts) {
          // 新互调积不得落入任何已确定频道（含频道 k 自身）的保护区
          for (let m = 0; m <= k; m++) {
            if (hitsGuard(p, m)) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) break;
        products.push(...newProducts);
      }
      // 既有互调积不得落入频道 k 的保护区
      if (ok) {
        for (let t = 0; t < baseCount; t++) {
          if (hitsGuard(products[t], k)) { ok = false; break; }
        }
      }

      if (ok) dfs(k + 1, offsetSoFar + cand.offsetHz);
      products.length = baseCount; // 回溯
      if (capped) return;
    }
  }

  dfs(0, 0);

  if (best) {
    const assignments = channels.map((ch, i) => ({
      id: ch.id,
      name: ch.name,
      locked: !!ch.locked,
      originalHz: ch.freqHz,
      freqHz: best.freqs[i],
      offsetHz: Math.abs(best.freqs[i] - ch.freqHz),
    }));
    return {
      solved: true,
      reason: capped ? '搜索达到节点上限，返回当前已找到的最优方案（可能非全局最优）。' : null,
      capped,
      nodes,
      assignments,
      totalOffsetHz: best.totalHz,
    };
  }

  // 无解：保持原值并说明原因
  let reason;
  if (channels.every((ch) => ch.locked)) {
    reason = '所有频道均已锁定且当前配置存在互调冲突，没有可调整的频道，已保持原有频率。';
  } else {
    reason = '在指定频段、步进、最大偏移' +
      (occupiedHz.length > 0 ? '与现场占用频段' : '') +
      '约束内未找到无冲突组合，已保持原有频率。' +
      (occupiedHz.length > 0 ? '可尝试避开或缩小占用频段、' : '') +
      '可尝试放宽最大偏移、减小步进或扩大频段。';
  }
  if (capped) reason += '（搜索达到节点上限，结论基于已截断的搜索空间。）';
  return {
    solved: false,
    reason,
    capped,
    nodes,
    assignments: channels.map((ch) => ({
      id: ch.id, name: ch.name, locked: !!ch.locked,
      originalHz: ch.freqHz, freqHz: ch.freqHz, offsetHz: 0,
    })),
    totalOffsetHz: 0,
  };
}

/**
 * 安全改频顺序搜索（纯函数，只读，不写回任何数据）。
 *
 * 给定当前配置与各频道目标频率（Hz），寻找一种逐台改频顺序：
 * 每步仅把一台需要改频的频道由当前频率直接改到目标值（不使用临时频率、每台至多一次），
 * 且每个中间配置都无互调冲突、各频道保护区（当前保护间隔）均不与占用区间相交（闭区间）。
 * 搜索全部可能顺序；存在多个可行顺序时，返回设备 ID 序列字典序最小者。
 *
 * @param {Array<{id:*, name:string, freqHz:number, guardHz:number, locked?:boolean}>} channels 当前配置
 * @param {Array<number>} targetFreqsHz 与 channels 等长、一一对应的目标频率（Hz）
 * @param {Array<{loHz:number, hiHz:number}>} occupiedHz 已合并的占用区间（可空）
 * @returns {{solvable:boolean, noop:boolean,
 *            steps:Array<{id:*, name:string, fromHz:number, toHz:number, freqsHz:Array<number>}>}}
 *          noop 为 true 表示所有频率已与目标一致（无需改频）；
 *          steps[k].freqsHz 为第 k 步完成后的完整频率表（Hz，与 channels 同序）
 */
function findSwitchOrder(channels, targetFreqsHz, occupiedHz = []) {
  const n = channels.length;
  const moveIdx = [];
  for (let i = 0; i < n; i++) {
    if (channels[i].freqHz !== targetFreqsHz[i]) moveIdx.push(i);
  }
  if (moveIdx.length === 0) return { solvable: true, noop: true, steps: [] };

  // 锁定频道不得改频：调用方应保证锁定频道目标与当前一致，否则直接判无可行顺序
  if (moveIdx.some((i) => channels[i].locked)) {
    return { solvable: false, noop: false, steps: [] };
  }

  // 按设备 ID 升序逐个尝试 → 深度优先找到的第一条完整顺序即设备 ID 序列字典序最小者
  moveIdx.sort((a, b) => (channels[a].id < channels[b].id ? -1 : channels[a].id > channels[b].id ? 1 : 0));

  const m = moveIdx.length;
  const fullMask = (1 << m) - 1;

  // 中间配置只取决于「已改频频道集合」，与到达顺序无关 → 按集合记忆化（至多 2^m 种配置）
  const validMemo = new Map();
  const isValid = (mask) => {
    let ok = validMemo.get(mask);
    if (ok !== undefined) return ok;
    const freqs = new Array(n);
    for (let i = 0; i < n; i++) freqs[i] = channels[i].freqHz;
    for (let b = 0; b < m; b++) {
      if (mask & (1 << b)) freqs[moveIdx[b]] = targetFreqsHz[moveIdx[b]];
    }
    const trial = channels.map((c, i) => ({
      id: c.id, name: c.name, freqHz: freqs[i], guardHz: c.guardHz,
    }));
    ok = computeConflicts(trial).length === 0;
    if (ok) {
      // 各频道保护区与占用区间闭区间相交检查（端点相接也算）
      ok = freqs.every((f, i) => {
        const g = channels[i].guardHz;
        return !occupiedHz.some((o) => f - g <= o.hiHz && o.loHz <= f + g);
      });
    }
    validMemo.set(mask, ok);
    return ok;
  };

  const picked = [];
  const dfs = (mask) => {
    if (mask === fullMask) return true;
    for (let b = 0; b < m; b++) {
      if (mask & (1 << b)) continue;
      const next = mask | (1 << b);
      if (!isValid(next)) continue; // 该中间配置不安全，剪掉其全部后续排列
      picked.push(moveIdx[b]);
      if (dfs(next)) return true;
      picked.pop();
    }
    return false;
  };

  // 起点（当前配置）与终点（目标配置）不安全时无需搜索；调用方一般已先行校验
  if (!isValid(0) || !isValid(fullMask) || !dfs(0)) {
    return { solvable: false, noop: false, steps: [] };
  }

  const freqs = channels.map((c) => c.freqHz);
  const steps = picked.map((idx) => {
    const fromHz = freqs[idx]; // 每台至多改一次，此处必为当前频率
    const toHz = targetFreqsHz[idx];
    freqs[idx] = toHz;
    return { id: channels[idx].id, name: channels[idx].name, fromHz, toHz, freqsHz: freqs.slice() };
  });
  return { solvable: true, noop: false, steps };
}

module.exports = {
  HZ_PER_MHZ,
  mhzToHz,
  hzToMhz,
  normalizeOccupiedBands,
  computeConflicts,
  coordinate,
  findSwitchOrder,
  SEARCH_NODE_CAP,
};
