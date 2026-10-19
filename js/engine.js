// スキルシミュレータの探索エンジン（DOM に依存しない。Worker からも main からも使う）
//
// 前提（data/ の生成時に検証済み）
//  - 武器用装飾品は武器スキルだけ、防具用装飾品は防具スキルだけ（すべて Lv1・1 スキル）
//  - 護石は防具スキルだけ
//  - シリーズ／グループスキルは「そのスキルを持つ部位の数」で発動（1 部位が複数に数えられることがある）
// なので、武器スキルは「武器＋武器スロット」だけで閉じ、防具スキルは「防具 5 部位＋護石＋防具スロット」で閉じる。

export const PARTS = ["head", "chest", "arms", "waist", "legs"];
export const PART_LABEL = { head: "頭", chest: "胴", arms: "腕", waist: "腰", legs: "脚", charm: "護石" };

export function prepare(raw) {
  const skills = new Map(raw.skills.map((s) => [s.id, s]));
  const bonuses = new Map(raw.bonuses.map((b) => [b.skillId, b]));
  const decoBySkill = new Map(); // armor skill id -> deco
  const weaponDecos = [];
  for (const d of raw.decorations) {
    if (d.kind === "armor") decoBySkill.set(d.skills[0][0], d);
    else weaponDecos.push(d);
  }
  return {
    ...raw,
    skills,
    bonuses,
    decoBySkill,
    weaponDecos,
    decoById: new Map(raw.decorations.map((d) => [d.id, d])),
    armorById: new Map(raw.armor.map((a) => [a.id, a])),
    charmById: new Map(raw.charms.map((c) => [c.id, c])),
    weaponById: new Map(raw.weapons.map((w) => [w.id, w])),
  };
}

// ---------- 進行度フィルタ ----------
// 素材ごとに「落とすモンスターのどれか 1 体が出ていればよい」。全素材が満たせたら作れる
function tagOk(t, p) {
  if (t === "event") return !!p.includeEvent;
  if (t === "arena") return !!p.includeArena;
  if (t === "trade") return p.includeTrade !== false;
  if (t === "season") return p.includeSeason !== false;
  return true;
}
export function armorAvailable(a, progress) {
  if (!progress) return true;
  if (a.rank === "low" && !progress.includeLow) return false;
  if (a.rank === "high" && progress.ch < progress.highStartCh) return false;
  const p = progress;
  const locked = p.lockedGates ? new Set(p.lockedGates) : null;
  if (a.req.mats) return a.req.mats.every((alts) => alts.some(([ch, hr, tags, gates]) => ch <= p.ch && hr <= p.hr && tags.every((t) => tagOk(t, p)) && (!locked || !(gates || []).some((g) => locked.has(g)))));
  if (a.req.ch > p.ch || a.req.hr > p.hr) return false;
  return a.req.tags.every((t) => tagOk(t, p));
}

// ---------- 武器側 ----------
// targets: {sid: lv}（武器スキルだけ）。weapon: {slots:[3,2,1], skills:[[sid,lv]]}
// inv: 装飾品の残数を返す関数 inv(decoId) -> number（Infinity 可）
export function solveWeapon(data, targets, weapon, inv) {
  const have = new Map();
  for (const [sid, lv] of weapon.skills || []) have.set(sid, (have.get(sid) || 0) + lv);
  const need = new Map();
  for (const [sid, lv] of Object.entries(targets)) {
    const d = lv - (have.get(+sid) || 0);
    if (d > 0) need.set(+sid, d);
  }
  const slots = [...(weapon.slots || [])].sort((a, b) => b - a);
  if (need.size === 0) return { ok: true, decos: [], free: slots, skills: have };
  // 候補：不足スキルに寄与する武器珠
  const cands = data.weaponDecos.filter((d) => d.skills.some(([sid]) => need.has(sid)) && inv(d.id) > 0);
  // 深さ優先：スロット順に珠を置く／置かない。使用数が少ない順に最良を採る
  const maxPer = Math.max(0, ...cands.map((d) => d.skills.reduce((s, [, lv]) => s + lv, 0))); // 珠 1 個の最大寄与
  let best = null;
  const used = new Map();
  const chosen = [];
  const rec = (i, need) => {
    if (need.size === 0) {
      const score = chosen.length * 100 - chosen.reduce((s, [slotSize, d]) => s + (slotSize - d.slot), 0);
      if (!best || score < best.score) best = { score, decos: chosen.map(([, d]) => d) , placed: chosen.map(([s, d]) => [s, d.id]) };
      return;
    }
    if (i >= slots.length) return;
    // 上界：残りスロット数で残り不足点を賄えるか
    let deficit = 0;
    for (const v of need.values()) deficit += v;
    if (deficit > (slots.length - i) * maxPer) return;
    for (const d of cands) {
      if (d.slot > slots[i]) continue;
      if ((used.get(d.id) || 0) >= inv(d.id)) continue;
      if (!d.skills.some(([sid]) => need.has(sid))) continue;
      const n2 = new Map(need);
      for (const [sid, lv] of d.skills) {
        if (!n2.has(sid)) continue;
        const r = n2.get(sid) - lv;
        if (r <= 0) n2.delete(sid);
        else n2.set(sid, r);
      }
      used.set(d.id, (used.get(d.id) || 0) + 1);
      chosen.push([slots[i], d]);
      rec(i + 1, n2);
      chosen.pop();
      used.set(d.id, used.get(d.id) - 1);
    }
    rec(i + 1, need); // このスロットは空けておく
  };
  rec(0, need);
  if (!best) {
    const lacking = [...need].map(([sid, d]) => ({ sid, name: data.skills.get(sid)?.name, deficit: d }));
    return { ok: false, lacking };
  }
  const skills = new Map(have);
  for (const d of best.decos) for (const [sid, lv] of d.skills) skills.set(sid, (skills.get(sid) || 0) + lv);
  const free = [...slots];
  for (const [s] of best.placed) free.splice(free.indexOf(s), 1);
  return { ok: true, decos: best.decos, free, skills };
}

// ---------- 防具側 ----------
function cumSlots(slots) {
  // [≥1 の数, ≥2 の数, ≥3 の数]
  const c = [0, 0, 0];
  for (const s of slots) for (let k = 0; k < s; k++) c[k]++;
  return c;
}

// 候補 1 件のベクトル（目標スキルへの寄与＋スロット＋シリーズ寄与）
function vectorOf(item, tgtSkills, tgtBonus, slotsOf) {
  const v = [];
  const sk = new Map(item.skills);
  for (const sid of tgtSkills) v.push(sk.get(sid) || 0);
  for (const bid of tgtBonus) v.push((item.bonusSkills || []).includes(bid) ? 1 : 0);
  return v.concat(cumSlots(slotsOf(item)));
}

function dominates(a, b) {
  // a が b 以上（全成分）
  for (let i = 0; i < a.length; i++) if (a[i] < b[i]) return false;
  return true;
}

// 同じ部位の候補を支配関係で絞る。同値の物は alts にまとめる
function pruneCandidates(items, vecOf, defOf) {
  const list = items.map((it) => ({ it, v: vecOf(it), def: defOf(it), alts: [] }));
  list.sort((a, b) => b.def - a.def || b.v.reduce((s, x) => s + x, 0) - a.v.reduce((s, x) => s + x, 0));
  const keep = [];
  outer: for (const c of list) {
    for (const k of keep) {
      if (dominates(k.v, c.v) && k.def >= c.def) {
        if (k.v.every((x, i) => x === c.v[i]) && k.def === c.def) k.alts.push(c.it);
        continue outer;
      }
    }
    keep.push(c);
  }
  return keep;
}

// 防具珠の割り当て：needs = Map(sid -> 個数)。slots = [3,2,1,...]。inv(decoId)
// 返り値: {ok, decos:[deco...], free:[...]} 。防具珠は全部 1 スキル Lv1 なので、サイズ別の累積条件だけで判定できる
function assignArmorDecos(data, needs, slots, inv) {
  const bySize = [[], [], [], []]; // size -> [deco, count]
  for (const [sid, n] of needs) {
    const d = data.decoBySkill.get(sid);
    if (!d) return { ok: false, reason: { sid, why: "nodeco" } };
    if (inv(d.id) < n) return { ok: false, reason: { sid, why: "inv", have: inv(d.id), need: n } };
    bySize[d.slot].push([d, n]);
  }
  const c = cumSlots(slots);
  const n3 = bySize[3].reduce((s, [, n]) => s + n, 0);
  const n2 = bySize[2].reduce((s, [, n]) => s + n, 0);
  const n1 = bySize[1].reduce((s, [, n]) => s + n, 0);
  if (n3 > c[2] || n3 + n2 > c[1] || n3 + n2 + n1 > c[0]) return { ok: false, reason: { why: "slots" } };
  // 実際の割り当て（大きい珠から、ちょうど入る最小のスロットへ）
  const free = [...slots].sort((a, b) => a - b);
  const decos = [];
  for (const size of [3, 2, 1]) {
    for (const [d, n] of bySize[size]) {
      for (let k = 0; k < n; k++) {
        const idx = free.findIndex((s) => s >= size);
        free.splice(idx, 1);
        decos.push(d);
      }
    }
  }
  return { ok: true, decos, free: free.sort((a, b) => b - a) };
}

/**
 * 探索の本体
 * q = {
 *   targets: {sid: lv},                       // 目標スキル（防具・武器・シリーズ・グループ混在可）
 *   weapon: {slots:[], skills:[[sid,lv]]},    // 武器（なしなら slots:[] skills:[]）
 *   progress: {ch, hr, includeLow, includeEvent, includeArena, highStartCh} | null,
 *   excludeNames: [armorName...], fixed: {head: armorId|null, ...},
 *   charms: {craftable: true, topOnly: true, customs: [{name, skills:[[sid,lv]], slots:[]}]},
 *   decoInv: {mode: "all"|"count", counts: {decoId: n}},
 *   options: {allowEmpty: false, maxResults: 50, maxNodes: 400000, sort: "def"|"slots"}
 * }
 */
export function search(data, q) {
  const t0 = Date.now();
  const opt = { allowEmpty: false, maxResults: 50, maxNodes: 1500000, sort: "def", ...(q.options || {}) };
  const inv = q.decoInv && q.decoInv.mode === "count"
    ? (id) => q.decoInv.counts[id] || 0
    : () => Infinity;

  // 目標を種類で分ける
  const tArmor = {}, tWeapon = {}, tBonus = {};
  for (const [k, lv] of Object.entries(q.targets || {})) {
    const sid = +k;
    if (!lv) continue;
    const s = data.skills.get(sid);
    if (!s) continue;
    if (s.kind === "weapon") tWeapon[sid] = lv;
    else if (s.kind === "armor") tArmor[sid] = lv;
    else tBonus[sid] = lv;
  }

  // --- 武器側（護石が武器スキルを持つことがあるので、護石ごとに「護石ぶんを引いた目標」で解く）
  const wTargets = Object.keys(tWeapon).map(Number);
  const wplanCache = new Map();
  const weaponPlanFor = (charm) => {
    const have = new Map((charm && charm.skills) || []);
    const key = wTargets.map((sid) => have.get(sid) || 0).join(",");
    if (wplanCache.has(key)) return wplanCache.get(key);
    const t = {};
    for (const sid of wTargets) { const d = tWeapon[sid] - (have.get(sid) || 0); if (d > 0) t[sid] = d; }
    const plan = solveWeapon(data, t, q.weapon || { slots: [], skills: [] }, inv);
    wplanCache.set(key, plan);
    return plan;
  };
  const wp = weaponPlanFor(null);

  // --- シリーズ／グループ：必要部位数
  const bonusNeed = new Map(); // sid -> pieces
  for (const [k, lv] of Object.entries(tBonus)) {
    const b = data.bonuses.get(+k);
    if (!b) continue;
    const r = b.ranks.find((r) => r.level >= lv) || b.ranks[b.ranks.length - 1];
    bonusNeed.set(+k, r.pieces);
  }
  const tgtSkills = Object.keys(tArmor).map(Number);
  const tgtBonus = [...bonusNeed.keys()];
  const nS = tgtSkills.length, nB = tgtBonus.length;

  // --- 候補
  const excl = new Set(q.excludeNames || []);
  const fixed = q.fixed || {};
  const candidates = {};
  for (const part of PARTS) {
    let items;
    if (fixed[part] != null && data.armorById.has(fixed[part])) items = [data.armorById.get(fixed[part])];
    else items = data.armor.filter((a) => a.part === part && !excl.has(a.name) && armorAvailable(a, q.progress));
    const vecOf = (a) => vectorOf(a, tgtSkills, tgtBonus, (x) => x.slots);
    let list = pruneCandidates(items, vecOf, (a) => a.defMax);
    if (opt.allowEmpty || items.length === 0) list.push({ it: null, v: new Array(nS + nB + 3).fill(0), def: 0, alts: [] });
    // 目標への寄与が大きい順 → 防御順（既に支配で絞ってある）
    list.sort((a, b) => b.v.reduce((s, x) => s + x, 0) - a.v.reduce((s, x) => s + x, 0) || b.def - a.def);
    candidates[part] = list;
  }
  // 護石
  {
    const items = [{ id: null, name: "なし", skills: [], slots: [], rarity: 0, custom: false }];
    const cq = q.charms || { craftable: true, topOnly: true, customs: [] };
    for (const c of cq.customs || []) items.push({ ...c, id: "custom:" + c.name, custom: true });
    if (cq.craftable !== false) for (const c of data.charms) if (!c.random && (!cq.topOnly || c.top)) items.push(c);
    const vecOf = (c) => vectorOf(c, tgtSkills, tgtBonus, (x) => x.slots || []).concat(wTargets.map((sid) => Math.min(tWeapon[sid], (new Map(c.skills || [])).get(sid) || 0)));
    const usable = items.filter((c) => weaponPlanFor(c).ok);
    if (!usable.length) return { ok: false, error: "weapon", lacking: wp.lacking, elapsed: Date.now() - t0 };
    candidates.charm = pruneCandidates(usable, vecOf, () => 0);
    for (const c of candidates.charm) c.wplan = weaponPlanFor(c.it);
    candidates.charm.sort((a, b) => b.v.reduce((s, x) => s + x, 0) - a.v.reduce((s, x) => s + x, 0));
  }
  // 防具のベクトルにも武器目標ぶんの 0 を足して長さを揃える
  for (const part of PARTS) for (const c of candidates[part]) c.v = c.v.concat(wTargets.map(() => 0));

  // --- 上界用：部位ごとの最大寄与
  const order = [...PARTS, "charm"];
  const nW = wTargets.length;
  const maxVec = order.map((p) => {
    const m = new Array(nS + nB + 3 + nW).fill(0);
    for (const c of candidates[p]) for (let i = 0; i < m.length; i++) m[i] = Math.max(m[i], c.v[i]);
    return m;
  });
  // 後ろからの累積
  const sufMax = new Array(order.length + 1).fill(null).map(() => new Array(nS + nB + 3 + nW).fill(0));
  for (let i = order.length - 1; i >= 0; i--) for (let k = 0; k < nS + nB + 3 + nW; k++) sufMax[i][k] = sufMax[i + 1][k] + maxVec[i][k];

  const decoSize = tgtSkills.map((sid) => data.decoBySkill.get(sid)?.slot || 0); // 0 = 珠なし
  const decoCap = tgtSkills.map((sid) => (data.decoBySkill.get(sid) ? inv(data.decoBySkill.get(sid).id) : 0));

  // --- 並べ替えの主指標と、その上界（分枝限定に使う）
  const metric = {
    def: { of: (r) => r.defMax, cand: (c) => (c.it && c.it.defMax) || 0 },
    slots: { of: (r) => r.slotValue, cand: (c) => (c.it ? (c.it.slots || []).reduce((s, x) => s + x * x, 0) : 0) },
    extra: { of: (r) => r.extraSkillPoints, cand: (c) => (c.it ? (c.it.skills || []).reduce((s, [, lv]) => s + lv, 0) : 0) },
  }[opt.sort] || { of: (r) => r.defMax, cand: (c) => (c.it && c.it.defMax) || 0 };
  const secondary = {
    def: (r) => [r.slotValue, r.extraSkillPoints],
    slots: (r) => [r.defMax, r.extraSkillPoints],
    extra: (r) => [r.defMax, r.slotValue],
  }[opt.sort] || ((r) => [r.slotValue]);
  for (const p of order) candidates[p].sort((a, b) => metric.cand(b) - metric.cand(a) || b.v.reduce((s, x) => s + x, 0) - a.v.reduce((s, x) => s + x, 0));
  const sufMetric = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) sufMetric[i] = sufMetric[i + 1] + Math.max(0, ...candidates[order[i]].map(metric.cand));

  // --- 深さ優先（上位 K 件の分枝限定）
  const K = opt.maxResults;
  let results = [];
  let threshold = -Infinity; // K 件たまったら、K 位の主指標より下の枝は見ない
  let nodes = 0, truncated = false;
  const cur = new Array(nS + nB + 3 + nW).fill(0);
  const pick = new Array(order.length).fill(null);
  let curMetric = 0;

  const feasibleBound = (depth) => {
    if (curMetric + sufMetric[depth] < threshold) return false;
    let deficitDecos = 0;
    for (let i = 0; i < nS; i++) {
      const d = tArmor[tgtSkills[i]] - cur[i] - sufMax[depth][i];
      if (d > 0) {
        if (!decoSize[i] || d > decoCap[i]) return false;
        deficitDecos += d;
      }
    }
    if (deficitDecos > cur[nS + nB] + sufMax[depth][nS + nB]) return false; // ≥1 のスロット総数
    for (let i = 0; i < nB; i++) if (cur[nS + i] + sufMax[depth][nS + i] < bonusNeed.get(tgtBonus[i])) return false;
    return true;
  };
  const cmp = (a, b) => {
    const d = metric.of(b) - metric.of(a);
    if (d) return d;
    const ka = secondary(a), kb = secondary(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  };
  const trim = () => {
    results.sort(cmp);
    if (results.length > K) results.length = K;
    if (results.length >= K) threshold = metric.of(results[K - 1]);
  };

  const complete = () => {
    const needs = new Map();
    for (let i = 0; i < nS; i++) {
      const d = tArmor[tgtSkills[i]] - cur[i];
      if (d > 0) needs.set(tgtSkills[i], d);
    }
    const slots = [];
    for (let i = 0; i < order.length; i++) {
      const c = pick[i];
      if (c && c.it) for (const s of (c.it.slots || [])) slots.push(s);
    }
    const asg = assignArmorDecos(data, needs, slots, inv);
    if (!asg.ok) return;
    const r = buildResult(data, order, pick, asg, (pick[order.length - 1] && pick[order.length - 1].wplan) || wp, tArmor, bonusNeed);
    if (metric.of(r) < threshold) return;
    results.push(r);
    if (results.length >= 4 * K) trim();
  };

  const rec = (depth) => {
    if (truncated) return;
    if (++nodes > opt.maxNodes) { truncated = true; return; }
    if (depth === order.length) { complete(); return; }
    if (!feasibleBound(depth)) return;
    for (const c of candidates[order[depth]]) {
      for (let k = 0; k < cur.length; k++) cur[k] += c.v[k];
      curMetric += metric.cand(c);
      pick[depth] = c;
      rec(depth + 1);
      for (let k = 0; k < cur.length; k++) cur[k] -= c.v[k];
      curMetric -= metric.cand(c);
    }
    pick[depth] = null;
  };
  rec(0);
  trim();

  return {
    ok: true,
    results,
    total: results.length,
    truncated,
    nodes,
    elapsed: Date.now() - t0,
    weapon: results[0]?.weapon || (wp.ok ? { decos: wp.decos.map((d) => d.id), free: wp.free, skills: [...wp.skills] } : { decos: [], free: [], skills: [] }),
    candidateCounts: Object.fromEntries(order.map((p) => [p, candidates[p].length])),
  };
}

function buildResult(data, order, pick, asg, wp, tArmor, bonusNeed) {
  const pieces = {};
  const skills = new Map();
  const bonusCount = new Map();
  let def = 0, defMax = 0;
  const res = [0, 0, 0, 0, 0];
  for (let i = 0; i < order.length; i++) {
    const c = pick[i];
    const it = c && c.it;
    pieces[order[i]] = it ? { id: it.id, name: it.name, alts: c.alts.map((a) => ({ id: a.id, name: a.name })), slots: it.slots || [], custom: !!it.custom } : null;
    if (!it) continue;
    for (const [sid, lv] of it.skills) if (data.skills.get(sid)?.kind !== "weapon") skills.set(sid, (skills.get(sid) || 0) + lv);
    for (const b of it.bonusSkills || []) bonusCount.set(b, (bonusCount.get(b) || 0) + 1);
    if (it.defMax != null) { def += it.def; defMax += it.defMax; }
    if (it.res) for (let k = 0; k < 5; k++) res[k] += it.res[k];
  }
  for (const d of asg.decos) for (const [sid, lv] of d.skills) skills.set(sid, (skills.get(sid) || 0) + lv);
  // シリーズ／グループの発動レベル
  const bonusLevels = [];
  for (const [sid, n] of bonusCount) {
    const b = data.bonuses.get(sid);
    if (!b) continue;
    let lv = 0, name = null;
    for (const r of b.ranks) if (n >= r.pieces) { lv = r.level; name = r.name; }
    if (lv > 0) bonusLevels.push({ sid, name: b.name, level: lv, levelName: name, pieces: n });
  }
  // 余剰：目標を超えた防具スキルのレベル合計（珠で付いた分も含む）
  let extra = 0;
  for (const [sid, lv] of skills) extra += Math.max(0, lv - (tArmor[sid] || 0));
  const slotValue = asg.free.reduce((s, x) => s + x * x, 0); // 空きスロットの価値（大きい枠ほど高く）
  // 護石の武器スキルは武器側の合計に足す
  const wskills = new Map(wp.skills);
  const charm = pick[order.length - 1] && pick[order.length - 1].it;
  if (charm) for (const [sid, lv] of charm.skills || []) if (data.skills.get(sid)?.kind === "weapon") wskills.set(sid, (wskills.get(sid) || 0) + lv);
  return {
    weapon: { decos: wp.decos.map((d) => d.id), free: wp.free, skills: [...wskills] },
    pieces,
    skills: [...skills].sort((a, b) => b[1] - a[1]),
    bonuses: bonusLevels,
    decos: asg.decos.map((d) => d.id),
    free: asg.free,
    def, defMax, res,
    slotValue,
    extraSkillPoints: extra,
  };
}

// 空きスロットで追加できる防具スキルの候補（UI 用）
export function addableSkills(data, free, inv) {
  const out = [];
  if (!free.length) return out;
  const maxFree = Math.max(...free);
  for (const [sid, d] of data.decoBySkill) {
    if (d.slot <= maxFree && inv(d.id) > 0) out.push({ sid, name: data.skills.get(sid).name, deco: d });
  }
  return out.sort((a, b) => a.deco.slot - b.deco.slot || a.name.localeCompare(b.name, "ja"));
}
