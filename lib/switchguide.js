'use strict';

/**
 * 安全改频顺序搜索（纯函数，内部一律使用整数 Hz，与互调核心口径一致）。
 *
 * 给定当前配置与目标配置（仅未锁定设备的频率可能不同），寻找一条改频顺序，使得：
 *   - 每一步只把一台未锁定设备从其【当前频率】直接改到【目标频率】；
 *     不使用任何临时频率，每台设备至多改一次；
 *   - 每一步完成后的中间配置都满足：
 *       1) 全部设备之间无互调冲突（复用 computeConflicts，按各自当前保护间隔）；
 *       2) 每台设备的保护区 [f - guard, f + guard] 不与任一占用区间闭区间相交
 *          （端点相接也算）。
 *
 * 穷举全部排列（设备上限 8，最多 8! = 40320 条路径）；多个可行顺序时，
 * 取设备 ID 序列字典序最小者（DFS 按 ID 升序枚举，第一个完成的排列即最小）。
 */

const { computeConflicts } = require('./intermod');

/**
 * 完整配置的安全校验。
 * @returns {null} 配置安全；否则 { conflicts:Array, occupiedHits:Array<{id, bandHz}> }
 */
function configViolations(channels, occupiedHz) {
  const conflicts = computeConflicts(channels);
  const occupiedHits = [];
  for (const ch of channels) {
    const hit = occupiedHz.find((o) => ch.freqHz - ch.guardHz <= o.hiHz && o.loHz <= ch.freqHz + ch.guardHz);
    if (hit) occupiedHits.push({ id: ch.id, bandHz: hit });
  }
  if (conflicts.length === 0 && occupiedHits.length === 0) return null;
  return { conflicts, occupiedHits };
}

/**
 * 搜索安全改频顺序。
 *
 * @param {Array<{id:number,name:string,freqHz:number,guardHz:number,targetHz:number}>} movers
 *        需要改频的未锁定设备（freqHz 为当前频率，targetHz 为目标频率，二者不同）
 * @param {Array<{id:number,name:string,freqHz:number,guardHz:number,locked:boolean}>} fixed
 *        不改频的设备（锁定设备及频率与目标一致的设备），全程保持 freqHz
 * @param {Array<{loHz:number,hiHz:number}>} occupiedHz 方案所存占用区间（已合并）
 * @returns {{
 *   feasible:boolean,
 *   order:number[],                 // 可行时的设备 ID 顺序（字典序最小）
 *   states:Map<number, number>,     // 可行时：完成各步骤后的频率表 id -> freqHz
 *                                   //（键为步骤序号，0 为初始状态）
 *   blocked:Array<{id:number, conflicts:Array, occupiedHits:Array}>  // 不可行时的首步阻塞明细
 * }}
 */
function searchSwitchOrder(movers, fixed, occupiedHz) {
  // 设备展示顺序：固定设备在前、待改设备在后（仅影响冲突明细，不影响判定）
  const allDevices = [
    ...fixed.map((d) => ({ id: d.id, name: d.name, guardHz: d.guardHz, locked: !!d.locked })),
    ...movers.map((d) => ({ id: d.id, name: d.name, guardHz: d.guardHz, locked: false })),
  ];

  // 当前频率表：初始为各设备当前频率，DFS 中随步骤更新/回溯
  const currentHz = new Map();
  for (const d of fixed) currentHz.set(d.id, d.freqHz);
  for (const d of movers) currentHz.set(d.id, d.freqHz);

  function channelsNow() {
    return allDevices.map((d) => ({
      id: d.id,
      name: d.name,
      freqHz: currentHz.get(d.id),
      guardHz: d.guardHz,
      locked: d.locked,
    }));
  }

  // 调用方（服务端）已保证初始配置安全；此处保留防御性校验
  if (configViolations(channelsNow(), occupiedHz) !== null) {
    throw new Error('安全改频搜索要求初始配置无互调冲突且避开占用区间');
  }

  // 按 ID 数值升序枚举：首个走通的排列即为设备 ID 序列字典序最小者
  // （字典序逐位比较，第一位取最小可行 ID，再在其前缀下递归取后续最小值）
  const pending = [...movers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Array(pending.length).fill(false);
  const chosen = [];
  const states = new Map();

  function dfs(done) {
    if (done === pending.length) return true;
    for (let i = 0; i < pending.length; i++) {
      if (used[i]) continue;
      const m = pending[i];
      currentHz.set(m.id, m.targetHz); // 直接改到目标频率（无临时频率）
      if (configViolations(channelsNow(), occupiedHz) === null) {
        used[i] = true;
        chosen.push(m.id);
        states.set(chosen.length, new Map(currentHz));
        if (dfs(done + 1)) return true;
        states.delete(chosen.length);
        chosen.pop();
        used[i] = false;
      }
      currentHz.set(m.id, m.freqHz); // 回溯
    }
    return false;
  }

  states.set(0, new Map(currentHz));
  if (dfs(0)) {
    return { feasible: true, order: chosen, states, blocked: [] };
  }

  // 不可行：枚举每台设备作为【第一步】时的阻塞冲突（其余设备保持当前频率）
  const blocked = [];
  for (const m of pending) {
    currentHz.set(m.id, m.targetHz);
    const v = configViolations(channelsNow(), occupiedHz);
    currentHz.set(m.id, m.freqHz);
    if (!v) continue; // 该设备可以作为第一步，但其后继排列均失败
    const conflicts = v.conflicts
      .filter((c) => c.victim.id === m.id || c.source.some((s) => s.id === m.id))
      .map((c) => ({ ...c, source: c.source.map((s) => ({ ...s })), victim: { ...c.victim } }));
    const occupiedHits = v.occupiedHits.filter((h) => h.id === m.id).map((h) => ({ ...h }));
    blocked.push({ id: m.id, conflicts, occupiedHits });
  }
  blocked.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { feasible: false, order: [], states: new Map(), blocked };
}

module.exports = { searchSwitchOrder, configViolations };
