// エンジンの回帰テスト。ブラウザで tests/test.html を開く（headless でも可）。
// 結果は <pre id="out"> に "PASS n / FAIL m" で出る。
import { prepare, search, solveWeapon, armorAvailable } from "../js/engine.js";

const out = [];
let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; out.push("ok   " + name); } else { fail++; out.push("FAIL " + name + (extra ? "  " + extra : "")); }
}
const show = () => { document.getElementById("out").textContent = out.join("\n") + `\n\nPASS ${pass} / FAIL ${fail}` + (fail ? "\nRESULT: FAIL" : "\nRESULT: PASS"); };

const files = ["skills", "decorations", "bonuses", "armor", "charms", "weapons", "meta"];
const parts = await Promise.all(files.map((f) => fetch(`../data/${f}.json`).then((r) => r.json())));
const data = prepare(Object.fromEntries(files.map((f, i) => [f, parts[i]])));
const S = (name) => { const s = [...data.skills.values()].find((s) => s.name === name); if (!s) throw new Error("no skill " + name); return s; };
const D = (name) => { const d = data.decorations.find((d) => d.name === name); if (!d) throw new Error("no deco " + name); return d; };
const W = (name) => { const w = data.weapons.find((w) => w.name === name); if (!w) throw new Error("no weapon " + name); return w; };
const chIdx = (c) => data.meta.chapters.indexOf(c);
const PROG_ALL = { ch: chIdx("6-2"), hr: 999, includeLow: false, includeEvent: true, includeArena: true, highStartCh: chIdx("4-1") };
const skillsOf = (r) => Object.fromEntries(r.skills.map(([sid, lv]) => [data.skills.get(sid).name, lv]));

try {
  // --- データの前提
  check("防具珠は全部 Lv1 の 1 スキル", data.decorations.filter((d) => d.kind === "armor").every((d) => d.skills.length === 1 && d.skills[0][1] === 1));
  check("武器珠は武器スキルだけ", data.weaponDecos.every((d) => d.skills.every(([s]) => data.skills.get(s).kind === "weapon")));
  check("防具は防具スキルだけ", data.armor.every((a) => a.skills.every(([s]) => data.skills.get(s).kind === "armor")));
  check("防具 714 件", data.armor.length === 714, String(data.armor.length));

  // --- 進行度フィルタ
  const mitsune = data.armor.find((a) => a.name.startsWith("ミツネヘルム"));
  check("ミツネ防具は HR21 要求", mitsune.req.hr === 21, JSON.stringify(mitsune.req));
  check("HR20 ではミツネ不可", !armorAvailable(mitsune, { ...PROG_ALL, hr: 20 }));
  check("HR21 でミツネ可", armorAvailable(mitsune, { ...PROG_ALL, hr: 21 }));
  const gog = data.armor.find((a) => a.name === "ゴグヘルムα");
  check("ゴグ防具は HR100", gog.req.hr === 100);
  check("ゴグ防具は複数シリーズに数えられる", gog.bonusSkills.length >= 2, String(gog.bonusSkills.length));
  const low = data.armor.find((a) => a.rank === "low");
  check("下位防具は includeLow=false で不可", !armorAvailable(low, PROG_ALL));
  check("下位進行中（Ch2-1）は上位防具不可", !armorAvailable(mitsune, { ...PROG_ALL, ch: chIdx("2-1"), hr: 5, includeLow: true }));
  const arena = data.armor.find((a) => a.req.tags.includes("arena"));
  check("闘技防具は includeArena=false で不可", arena && !armorAvailable(arena, { ...PROG_ALL, includeArena: false }));

  // --- 武器側
  const inf = () => Infinity;
  const kougeki = S("攻撃"), takumi = S("匠"), chokaishin = S("超会心");
  let wp = solveWeapon(data, { [kougeki.id]: 3 }, { slots: [3, 2, 1], skills: [] }, inf);
  check("攻撃3 を武器スロ 321 で", wp.ok && (wp.skills.get(kougeki.id) || 0) >= 3, JSON.stringify(wp));
  wp = solveWeapon(data, { [kougeki.id]: 5 }, { slots: [1], skills: [] }, inf);
  check("攻撃5 を武器スロ 1 では不可", !wp.ok && wp.lacking[0].sid === kougeki.id);
  wp = solveWeapon(data, { [kougeki.id]: 2 }, { slots: [], skills: [[kougeki.id, 2]] }, inf);
  check("武器に付いている攻撃2 で足りる", wp.ok && wp.decos.length === 0);
  // 複合珠（2 スキル持ちの武器珠）1 個で両方の目標を満たす
  const multi = data.weaponDecos.find((d) => d.skills.length === 2 && d.slot === 3);
  wp = solveWeapon(data, Object.fromEntries(multi.skills), { slots: [3], skills: [] }, inf);
  check(`複合珠 ${multi.name} で 1 スロットに 2 スキル`, wp.ok && wp.decos.length === 1, JSON.stringify(wp));
  const kgd = data.weaponDecos.filter((d) => d.skills.some(([s]) => s === kougeki.id));
  const invNoAtk = (id) => (kgd.some((d) => d.id === id) ? 0 : Infinity);
  wp = solveWeapon(data, { [kougeki.id]: 1 }, { slots: [3, 3, 3], skills: [] }, invNoAtk);
  check("攻撃珠の所持 0 なら不可", !wp.ok);

  // --- 防具側：基本
  const jakuten = S("弱点特効"), kaihi = S("回避性能"), mimisen = S("耳栓");
  let r = search(data, { targets: { [jakuten.id]: 5 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, options: { maxResults: 10 } });
  check("弱点特効5 が解ける", r.ok && r.results.length > 0, JSON.stringify(r).slice(0, 200));
  if (r.ok && r.results.length) {
    const top = r.results[0];
    check("結果は弱点特効 ≥5", skillsOf(top)["弱点特効"] >= 5, JSON.stringify(skillsOf(top)));
    check("5 部位すべて埋まる（空き部位なし）", ["head", "chest", "arms", "waist", "legs"].every((p) => top.pieces[p]), JSON.stringify(top.pieces));
    check("防御力順（1位 ≥ 2位）", r.results.length < 2 || r.results[0].defMax >= r.results[1].defMax);
    check("珠は所持内で付く", top.decos.every((id) => data.decoById.get(id).kind === "armor"));
  }
  // 空き部位許可
  r = search(data, { targets: { [jakuten.id]: 1 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, options: { maxResults: 5, allowEmpty: true, sort: "slots" } });
  check("allowEmpty でも解ける", r.ok && r.results.length > 0);

  // --- 珠の割り当てが正しい（スロットサイズ）
  r = search(data, { targets: { [jakuten.id]: 5, [kaihi.id]: 5, [mimisen.id]: 5 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, options: { maxResults: 20 } });
  check("弱特5 回避5 耳栓5 が解ける（または正しく不可）", r.ok, JSON.stringify(r).slice(0, 200));
  if (r.ok) for (const res of r.results) {
    const sk = skillsOf(res);
    check("各結果が全目標を満たす", sk["弱点特効"] >= 5 && sk["回避性能"] >= 5 && sk["耳栓"] >= 5, JSON.stringify(sk));
    // 珠の総数 ≤ スロット総数、サイズ別の累積条件
    const slots = ["head", "chest", "arms", "waist", "legs", "charm"].flatMap((p) => res.pieces[p]?.slots || []);
    const used = res.decos.map((id) => data.decoById.get(id).slot).sort((a, b) => b - a);
    const sorted = [...slots].sort((a, b) => b - a);
    const fits = used.every((s, i) => s <= sorted[i]);
    check("珠がスロットに収まる", fits, JSON.stringify({ slots: sorted, used }));
    check("空きスロット数 = スロット数 − 珠数", res.free.length === slots.length - used.length);
    break;
  }

  // --- 不可能な条件
  r = search(data, { targets: { [jakuten.id]: 5, [kaihi.id]: 5, [mimisen.id]: 5, [S("体術").id]: 5, [S("回復速度").id]: 3, [S("ランナー").id]: 3, [S("気絶耐性").id]: 3, [S("逆恨み").id]: 3, [S("渾身").id]: 3, [S("挑戦者").id]: 5 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, options: { maxResults: 5 } });
  check("明らかに無理な条件は 0 件で返る", r.ok && r.results.length === 0, JSON.stringify(r).slice(0, 200));

  // --- 珠のない防具スキル
  const noDeco = [...data.skills.values()].find((s) => s.kind === "armor" && !data.decoBySkill.has(s.id) && s.max >= 2);
  if (noDeco) {
    r = search(data, { targets: { [noDeco.id]: noDeco.max }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, options: { maxResults: 5 } });
    check(`珠のないスキル ${noDeco.name} Lv${noDeco.max} は防具だけで解く`, r.ok, JSON.stringify(r).slice(0, 200));
    if (r.ok && r.results.length) check("珠なしスキルの結果に珠が混ざらない", r.results[0].decos.every((id) => data.decoById.get(id).skills[0][0] !== noDeco.id));
  }

  // --- 装飾品の所持数制限
  const jkDeco = data.decoBySkill.get(jakuten.id);
  r = search(data, { targets: { [jakuten.id]: 5 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, decoInv: { mode: "count", counts: { [jkDeco.id]: 1 } }, options: { maxResults: 10 } });
  check("痛撃珠 1 個制限でも解ける", r.ok && r.results.length > 0);
  if (r.ok) check("珠の使用が 1 個以下", r.results.every((res) => res.decos.filter((id) => id === jkDeco.id).length <= 1));
  r = search(data, { targets: { [jakuten.id]: 5 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, decoInv: { mode: "count", counts: {} }, options: { maxResults: 10 } });
  check("珠 0 個でも防具だけで解けるか判定が返る", r.ok);
  if (r.ok) check("珠 0 個の結果に珠が無い", r.results.every((res) => res.decos.length === 0));

  // --- シリーズスキル
  const gore = data.bonuses.get(S("黒蝕竜の力").id);
  r = search(data, { targets: { [gore.skillId]: 2 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, options: { maxResults: 5 } });
  check("黒蝕竜の力 Ⅱ（4 部位）が解ける", r.ok && r.results.length > 0);
  if (r.ok && r.results.length) {
    const b = r.results[0].bonuses.find((b) => b.sid === gore.skillId);
    check("発動レベル 2・4 部位以上", b && b.level === 2 && b.pieces >= 4, JSON.stringify(r.results[0].bonuses));
  }
  // グループスキル
  const grp = [...data.bonuses.values()].find((b) => b.kind === "group");
  r = search(data, { targets: { [grp.skillId]: 1 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, options: { maxResults: 5 } });
  check(`グループ ${grp.name} が解ける`, r.ok && r.results.length > 0 && r.results[0].bonuses.some((b) => b.sid === grp.skillId));

  // --- 武器選択＋混在目標
  const w = data.weapons.find((x) => x.kind === "great-sword" && x.final && x.slots.length === 3);
  r = search(data, { targets: { [kougeki.id]: 3, [jakuten.id]: 3 }, weapon: { slots: w.slots, skills: w.skills }, progress: PROG_ALL, options: { maxResults: 5 } });
  check("武器スキル＋防具スキルの混在が解ける", r.ok && r.results.length > 0, JSON.stringify(r).slice(0, 300));
  if (r.ok) check("武器側の計画に攻撃珠が入る", r.weapon.decos.length > 0 || w.skills.some(([s]) => s === kougeki.id));
  r = search(data, { targets: { [kougeki.id]: 5 }, weapon: { slots: [1], skills: [] }, progress: PROG_ALL, options: { maxResults: 5 } });
  check("武器側が不足なら error=weapon", !r.ok && r.error === "weapon");

  // --- 除外・固定
  const fixedHead = data.armor.find((a) => a.part === "head" && armorAvailable(a, PROG_ALL));
  r = search(data, { targets: { [jakuten.id]: 1 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, fixed: { head: fixedHead.id }, options: { maxResults: 5 } });
  check("固定した頭が使われる", r.ok && r.results.every((res) => res.pieces.head.id === fixedHead.id));
  r = search(data, { targets: { [jakuten.id]: 1 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, excludeNames: [fixedHead.name], options: { maxResults: 20 } });
  check("除外した頭は出ない", r.ok && r.results.every((res) => res.pieces.head.name !== fixedHead.name && !res.pieces.head.alts.some((a) => a.name === fixedHead.name)));

  // --- 護石（手入力）
  r = search(data, { targets: { [jakuten.id]: 5 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, charms: { craftable: false, topOnly: true, customs: [{ name: "テスト", skills: [[jakuten.id, 3]], slots: [3] }] }, options: { maxResults: 5 } });
  check("手入力護石が使える", r.ok && r.results.length > 0 && r.results.some((res) => res.pieces.charm && res.pieces.charm.name === "テスト"));

  // --- 解放ゲート（HR は足りていてもミッション未クリアなら候補に入らない）
  const queen = data.armor.find((a) => a.name === "クイーンピアスα");
  check("クイーンα は queen ゲート付き", queen.req.gates.includes("queen"), JSON.stringify(queen.req.gates));
  check("ゲート全部済なら HR100 でクイーン可", armorAvailable(queen, { ...PROG_ALL, hr: 100, lockedGates: [] }));
  check("queen を未にするとクイーン不可", !armorAvailable(queen, { ...PROG_ALL, hr: 100, lockedGates: ["queen"] }));
  const lagi = data.armor.find((a) => a.name.startsWith("ラギアヘルム"));
  check("ラギア防具は狂界ゲートで消える", !armorAvailable(lagi, { ...PROG_ALL, lockedGates: ["kyokai"] }) && armorAvailable(lagi, { ...PROG_ALL, lockedGates: [] }));

  // --- 護石の武器スキル（鑑定護石）
  r = search(data, { targets: { [kougeki.id]: 2 }, weapon: { slots: [1], skills: [] }, progress: PROG_ALL, charms: { craftable: false, topOnly: true, customs: [{ name: "攻撃護石", skills: [[kougeki.id, 2]], slots: [] }] }, options: { maxResults: 5 } });
  check("護石の武器スキルで武器側が足りる", r.ok && r.results.length > 0 && r.results[0].pieces.charm?.name === "攻撃護石", JSON.stringify(r).slice(0, 300));
  if (r.ok && r.results.length) check("結果の武器側スキルに護石ぶんが入る", r.results[0].weapon.skills.some(([s, l]) => s === kougeki.id && l >= 2));
  r = search(data, { targets: { [kougeki.id]: 2 }, weapon: { slots: [1], skills: [] }, progress: PROG_ALL, charms: { craftable: false, topOnly: true, customs: [] }, options: { maxResults: 5 } });
  check("護石なしなら武器側不足で error", !r.ok && r.error === "weapon");

  // --- 進行度を下げると候補が減る／下位だけでも解ける
  const lowProg = { ch: chIdx("2-1"), hr: 5, includeLow: true, includeEvent: true, includeArena: true, highStartCh: chIdx("4-1") };
  r = search(data, { targets: { [S("体術").id]: 2 }, weapon: { slots: [], skills: [] }, progress: lowProg, options: { maxResults: 5 } });
  check("下位 Ch2-1 で体術2", r.ok, JSON.stringify(r).slice(0, 200));
  if (r.ok && r.results.length) check("下位結果は下位防具だけ", ["head", "chest", "arms", "waist", "legs"].every((p) => data.armorById.get(r.results[0].pieces[p].id).rank === "low"));

  // --- 最良が取りこぼされない（上位 K 件の分枝限定）
  {
    const q0 = { targets: { [jakuten.id]: 1 }, weapon: { slots: [], skills: [] }, progress: PROG_ALL, charms: { craftable: false, topOnly: true, customs: [] } };
    const r1 = search(data, { ...q0, options: { maxResults: 1 } });
    const r200 = search(data, { ...q0, options: { maxResults: 200 } });
    check("軽い条件：K=1 と K=200 の 1 位の防御が同じ", r1.ok && r200.ok && r1.results[0].defMax === r200.results[0].defMax, `${r1.results[0]?.defMax} vs ${r200.results[0]?.defMax}`);
    check("軽い条件でも打ち切られない", !r1.truncated && !r200.truncated, `${r1.nodes} ${r200.nodes}`);
    // 全候補の最大防御（部位ごとの最大の和）は上界。1 位はそれ以下で、2 位以下は単調
    check("結果が主指標で単調", r200.results.every((r, i) => i === 0 || r200.results[i - 1].defMax >= r.defMax));
    const rs = search(data, { ...q0, options: { maxResults: 20, sort: "slots" } });
    check("スロット順：1 位の slotValue ≥ 防御順の 1 位の slotValue", rs.ok && rs.results[0].slotValue >= r200.results[0].slotValue, `${rs.results[0]?.slotValue} vs ${r200.results[0]?.slotValue}`);
    check("スロット順で単調", rs.results.every((r, i) => i === 0 || rs.results[i - 1].slotValue >= r.slotValue));
    // 総当たりとの照合：候補を絞った小さい問題で、最大防御を素朴に求める
    const prog = { ...PROG_ALL, hr: 15 }; // 候補を減らす
    const rb = search(data, { ...q0, progress: prog, options: { maxResults: 1 } });
    let brute = 0;
    const byPart = {};
    for (const p of ["head", "chest", "arms", "waist", "legs"]) byPart[p] = data.armor.filter((a) => a.part === p && armorAvailable(a, prog));
    // 弱点特効1 は珠【３】で付くので、「どれか 1 部位が弱特を持つ」か「≥3 スロットが 1 つある」構成の最大防御
    const bestDef = (p, pred) => Math.max(0, ...byPart[p].filter(pred).map((a) => a.defMax));
    const anyDef = Object.fromEntries(Object.keys(byPart).map((p) => [p, bestDef(p, () => true)]));
    const total = Object.values(anyDef).reduce((s, x) => s + x, 0);
    for (const p of Object.keys(byPart)) {
      const withJk = bestDef(p, (a) => a.skills.some(([s]) => s === jakuten.id) || a.slots.some((s) => s >= 3));
      if (withJk) brute = Math.max(brute, total - anyDef[p] + withJk);
    }
    check(`総当たり照合（HR15, 弱特1）: ${rb.results[0]?.defMax} = ${brute}`, rb.ok && rb.results[0].defMax === brute);
  }

  // --- 性能
  const t0 = performance.now();
  r = search(data, { targets: { [jakuten.id]: 5, [S("連撃").id]: 3, [S("巧撃").id]: 2, [kougeki.id]: 3 }, weapon: { slots: [3, 2, 1], skills: [] }, progress: PROG_ALL, options: { maxResults: 50 } });
  const dt = performance.now() - t0;
  check(`典型条件が 3 秒以内（${dt.toFixed(0)} ms, ${r.nodes} nodes, ${r.total} 件）`, dt < 3000);
} catch (e) {
  fail++;
  out.push("EXCEPTION " + (e.stack || e));
}
show();
