import { prepare, search, addableSkills, armorAvailable, PARTS, PART_LABEL } from "./engine.js";
import { store } from "./store.js";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const WEAPON_KIND = {
  "great-sword": "大剣", "long-sword": "太刀", "sword-shield": "片手剣", "dual-blades": "双剣", hammer: "ハンマー",
  "hunting-horn": "狩猟笛", lance: "ランス", gunlance: "ガンランス", "switch-axe": "スラッシュアックス",
  "charge-blade": "チャージアックス", "insect-glaive": "操虫棍", "light-bowgun": "ライトボウガン", "heavy-bowgun": "ヘビィボウガン", bow: "弓",
};
const KIND_LABEL = { armor: "防具", weapon: "武器", set: "シリーズ", group: "グループ" };
const ELEM = { fire: "火", water: "水", thunder: "雷", ice: "氷", dragon: "龍", poison: "毒", paralysis: "麻痺", sleep: "睡眠", blastblight: "爆破" };
const SLOT_CH = ["", "①", "②", "③"];
const slotStr = (slots) => (slots && slots.length ? slots.map((s) => SLOT_CH[s]).join("") : "－");

let data = null;
let worker = null;
let seq = 0;
const pending = new Map();

const defaultState = () => ({
  hr: 100, chapter: "auto", incLow: false, incEvent: true, incArena: true, incTrade: true, incSeason: true, lockedGates: [], tab: "search",
  weapon: { kind: "great-sword", id: null, final: true, manualSlots: [0, 0, 0], cols: ["atk", "elem", "slots", "skills"], sortKey: "rarity", sortDir: -1 },
  targets: {},
  charms: { craftable: true, topOnly: true, customs: [] },
  decoMode: "all", decoCounts: {},
  excludeNames: [], fixed: {},
  sort: "def", maxResults: 50, allowEmpty: false,
  theme: "auto",
});
const savedState = store.loadState();
const firstVisit = !savedState;
let state = { ...defaultState(), ...(savedState || {}) };
state.weapon = { ...defaultState().weapon, ...(state.weapon || {}) };
state.charms = { ...defaultState().charms, ...(state.charms || {}) };
let lastResult = null;

// 入力は「現状を保存」を押したときだけ localStorage に書く。それまでは未保存の印を付ける
let dirty = false;
function persist() { dirty = true; updateSaveBtn(); }
function saveNow() {
  const ok = store.saveState(state);
  dirty = !ok;
  updateSaveBtn();
  $("#status").textContent = ok ? "保存した" : "保存できない（ブラウザの保存領域が使えない）";
}
function updateSaveBtn() {
  const b = $("#btn-save");
  if (!b) return;
  b.classList.toggle("dirty", dirty);
  b.textContent = dirty ? "現状を保存（未保存）" : "現状を保存";
}

// ---------- データ読み込み ----------
async function loadData() {
  const files = ["skills", "decorations", "bonuses", "armor", "charms", "weapons", "meta"];
  const parts = await Promise.all(files.map((f) => fetch(`data/${f}.json`).then((r) => { if (!r.ok) throw new Error(f); return r.json(); })));
  data = prepare(Object.fromEntries(files.map((f, i) => [f, parts[i]])));
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      ev.data.ok ? p.resolve(ev.data.r) : p.reject(new Error(ev.data.error));
    };
    worker.onerror = () => { worker = null; for (const p of pending.values()) p.reject(new Error("worker")); pending.clear(); };
  } catch { worker = null; }
}
function runSearch(q) {
  if (!worker) return Promise.resolve(search(data, q)); // Worker が使えない環境ではメインスレッドで
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, type: "search", q }); })
    .catch(() => search(data, q));
}

// ---------- 進行度 ----------
function chapterIndexAuto(hr) {
  let ch = data.meta.chapters[0];
  for (const [h, c] of data.meta.hrToChapter) if (hr >= h) ch = c;
  return data.meta.chapters.indexOf(ch);
}
function progressQuery() {
  const chapters = data.meta.chapters;
  const hr = Math.max(1, +state.hr || 1);
  const ch = state.chapter === "auto" ? chapterIndexAuto(hr) : chapters.indexOf(state.chapter);
  const highStartCh = chapters.indexOf("4-1");
  return { ch, hr, includeLow: ch < highStartCh ? true : !!state.incLow, includeEvent: !!state.incEvent, includeArena: !!state.incArena, includeTrade: state.incTrade !== false, includeSeason: state.incSeason !== false, lockedGates: state.lockedGates || [], highStartCh };
}
function renderProgress() {
  const sel = $("#chapter");
  sel.innerHTML = "";
  sel.append(el("option", { value: "auto" }, "HR から推定"));
  for (const c of data.meta.chapters) sel.append(el("option", { value: c }, data.meta.chapterLabels[c] || c));
  sel.value = state.chapter;
  $("#hr").value = state.hr;
  $("#inc-low").checked = state.incLow;
  $("#inc-event").checked = state.incEvent;
  $("#inc-arena").checked = state.incArena;
  $("#inc-trade").checked = state.incTrade !== false;
  $("#inc-season").checked = state.incSeason !== false;
  updateProgressSub();
}
function updateProgressSub() {
  const p = progressQuery();
  const chName = data.meta.chapters[p.ch];
  const ms = data.meta.hrMilestones.filter(([h]) => h <= p.hr).slice(-1)[0];
  const next = data.meta.hrMilestones.find(([h]) => h > p.hr);
  const n = data.armor.filter((a) => armorOk(a, p)).length;
  $("#progress-sub").textContent = `HR${p.hr}・Ch${chName}・候補 ${n} 部位`;
  $("#tab-status-sub").textContent = `HR${p.hr}`;
  $("#gates-sub").textContent = (state.lockedGates || []).length ? `${state.lockedGates.length} 件 未` : "全部 済";
  $("#hr-hint").textContent = (ms ? `HR${ms[0]}〜: ${ms[1]}` : "") + (next ? `　／　次: HR${next[0]} ${next[1]}` : "");
}
const armorOk = armorAvailable;

// ---------- 解放ゲート ----------
function renderGates() {
  const box = $("#gate-list");
  box.innerHTML = "";
  const locked = new Set(state.lockedGates || []);
  let lastGroup = null;
  for (const g of data.meta.gates || []) {
    if (g.group !== lastGroup) { lastGroup = g.group; box.append(el("div", { class: "gate-grp" }, g.group)); }
    const cb = el("input", { type: "checkbox", onchange: (e) => {
      const set = new Set(state.lockedGates || []);
      e.target.checked ? set.delete(g.id) : set.add(g.id);
      state.lockedGates = [...set];
      persist(); updateProgressSub(); renderGates();
    } });
    cb.checked = !locked.has(g.id);
    box.append(el("label", { class: "gate" + (locked.has(g.id) ? " locked" : "") }, cb, " ", g.label, locked.has(g.id) ? el("span", { class: "badge" }, "未") : null));
  }
}

// ---------- タブ ----------
function showTab(name) {
  state.tab = name;
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const b of document.querySelectorAll(".tab-btn")) b.classList.toggle("active", b.dataset.tab === name);
  try { localStorage.setItem("mhws-sim.v1.tab", name); } catch {}
}

// ---------- 武器 ----------
function renderWeaponKinds() {
  const sel = $("#weapon-kind");
  sel.innerHTML = "";
  for (const k of data.meta.weaponKinds) sel.append(el("option", { value: k }, WEAPON_KIND[k] || k));
  sel.value = state.weapon.kind;
  $("#weapon-final").checked = state.weapon.final;
  for (const i of [1, 2, 3]) {
    const s = $("#wslot" + i);
    s.innerHTML = "";
    for (const v of [0, 1, 2, 3]) s.append(el("option", { value: v }, v ? SLOT_CH[v] : "－"));
    s.value = state.weapon.manualSlots[i - 1] || 0;
  }
}
// 武器一覧の列。value: 表示用、sort: 並べ替え用の数値/文字列
const elemStr = (w) => w.elem.map(([k, v, hidden]) => `${ELEM[k] || k}${v ?? ""}${hidden ? "(隠)" : ""}`).join(" ");
const WEAPON_COLS = {
  rarity: { label: "レア", value: (w) => "R" + w.rarity, sort: (w) => w.rarity, num: true },
  atk: { label: "攻撃力", value: (w) => w.atk ?? "", sort: (w) => w.atk ?? -1, num: true },
  aff: { label: "会心", value: (w) => `${w.aff}%`, sort: (w) => w.aff, num: true },
  elem: { label: "属性", value: elemStr, sort: (w) => (w.elem[0] ? (ELEM[w.elem[0][0]] || "") + String(w.elem[0][1] ?? 0).padStart(4, "0") : "") },
  slots: { label: "スロット", value: (w) => slotStr(w.slots), sort: (w) => w.slots.reduce((s, x) => s + x * x, 0), num: true },
  skills: { label: "スキル", value: (w) => w.skills.map(([s, l]) => data.skills.get(s).name + l).join(" "), sort: (w) => w.skills.map(([s, l]) => data.skills.get(s).name + l).join(" ") },
  series: { label: "派生", value: (w) => w.series || "", sort: (w) => w.series || "" },
  def: { label: "防御", value: (w) => w.defBonus || "", sort: (w) => w.defBonus || 0, num: true },
};
function renderWeaponCols() {
  const box = $("#weapon-cols");
  for (const n of [...box.querySelectorAll("label.col")]) n.remove();
  for (const [key, c] of Object.entries(WEAPON_COLS)) {
    const cb = el("input", { type: "checkbox", onchange: (e) => {
      const set = new Set(state.weapon.cols);
      e.target.checked ? set.add(key) : set.delete(key);
      state.weapon.cols = Object.keys(WEAPON_COLS).filter((k) => set.has(k));
      persist(); renderWeaponList();
    } });
    cb.checked = state.weapon.cols.includes(key);
    box.append(el("label", { class: "col" }, cb, " " + c.label));
  }
}
function renderWeaponList() {
  const t = $("#weapon-list");
  t.innerHTML = "";
  const q = ($("#weapon-search").value || "").trim();
  let ws = data.weapons.filter((w) => w.kind === state.weapon.kind && (!state.weapon.final || w.final));
  if (q) ws = ws.filter((w) => w.name.includes(q) || (w.series || "").includes(q) || elemStr(w).includes(q) || WEAPON_COLS.skills.value(w).includes(q));
  const cols = state.weapon.cols.filter((k) => WEAPON_COLS[k]);
  const sk = WEAPON_COLS[state.weapon.sortKey] ? state.weapon.sortKey : "rarity";
  const dir = state.weapon.sortDir || -1;
  const sortOf = (w) => (sk === "name" ? w.name : WEAPON_COLS[sk].sort(w));
  ws.sort((a, b) => {
    const x = sortOf(a), y = sortOf(b);
    const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ja");
    return d ? d * dir : b.rarity - a.rarity || a.name.localeCompare(b.name, "ja");
  });
  const th = (key, label, num) => el("th", { class: (sk === key ? "on" : "") + (num ? " num" : ""), onclick: () => {
    if (state.weapon.sortKey === key) state.weapon.sortDir = -(state.weapon.sortDir || -1);
    else { state.weapon.sortKey = key; state.weapon.sortDir = key === "name" || key === "series" || key === "skills" ? 1 : -1; }
    persist(); renderWeaponList();
  } }, label + (sk === key ? (dir > 0 ? " ▲" : " ▼") : ""));
  t.append(el("tr", {}, th("name", "武器", false), ...cols.map((k) => th(k, WEAPON_COLS[k].label, WEAPON_COLS[k].num))));
  const pick = (w) => { state.weapon.id = w.id; persist(); renderWeaponList(); renderWeaponInfo(); };
  for (const w of ws.slice(0, 300)) {
    t.append(el("tr", { class: w.id === state.weapon.id ? "sel" : "", onclick: () => pick(w) },
      el("td", { class: "nm" }, w.name), ...cols.map((k) => el("td", { class: WEAPON_COLS[k].num ? "num" : "" }, String(WEAPON_COLS[k].value(w))))));
  }
  if (ws.length > 300) t.append(el("tr", {}, el("td", { class: "hint", colspan: cols.length + 1 }, `…ほか ${ws.length - 300} 件（絞り込んでください）`)));
}
function currentWeapon() {
  const w = state.weapon.id != null ? data.weaponById.get(state.weapon.id) : null;
  if (w) return { name: w.name, slots: [...w.slots], skills: w.skills.map((x) => [...x]) };
  const slots = state.weapon.manualSlots.map(Number).filter((x) => x > 0).sort((a, b) => b - a);
  return { name: null, slots, skills: [] };
}
function renderWeaponInfo() {
  const w = state.weapon.id != null ? data.weaponById.get(state.weapon.id) : null;
  const info = $("#weapon-info");
  if (!w) {
    info.textContent = "武器未選択（手入力のスロットで計算）";
    $("#weapon-sub").textContent = `手入力 ${slotStr(currentWeapon().slots)}`;
    return;
  }
  const elem = elemStr(w);
  info.innerHTML = "";
  info.append(el("b", {}, w.name), ` ${WEAPON_KIND[w.kind]} R${w.rarity}　攻撃 ${w.atk ?? "?"}　会心 ${w.aff}%　${elem}`, el("br"),
    `スロット ${slotStr(w.slots)}　スキル: ${w.skills.map(([s, l]) => data.skills.get(s).name + " Lv" + l).join("、") || "なし"}`);
  $("#weapon-sub").textContent = `${w.name} ${slotStr(w.slots)}`;
}

// ---------- スキル ----------
function skillKindFilter() { return document.querySelector("input[name=skind]:checked").value; }
// スキルの大まかな分類（名前のキーワードで振り分け。上から順に最初に当たった組）
const SKILL_GROUPS = [
  ["耐性", /耐性|やられ|耳栓|風圧|耐震|緩衝|ひるみ軽減|適応/],
  ["属性・状態異常", /属性|ビン追加|毒ダメージ|会心撃/],
  ["切れ味・ガード", /匠|業物|剛刃研磨|達人芸|砥石|心眼|ガード|攻めの守勢|刃鱗|シールド/],
  ["射撃・武器種", /弾|矢|射|装填|砲|チャージマスター|溜打|高速変形|強化持続|笛吹き|ショット|ＫＯ術|KO術|スタミナ奪取|飛燕|集中/],
  ["攻撃・会心", /攻撃|見切り|超会心|弱点特効|渾身|力の解放|挑戦者|攻勢|巧撃|連撃|逆恨み|火事場力|フルチャージ|無我の境地|鈍器|抜刀術|逆襲|急襲|災禍転福|破壊王|鎖刃刺撃|研鑽/],
  ["スタミナ・回避・移動", /体術|ランナー|スタミナ|回避|納刀|飛び込み|クライマー|ジャンプ/],
  ["防御・回復", /防御|精霊の加護|回復|広域化|整備|満足感|早食い|腹減り|にぎりめし|ハンター生活/],
  ["アイテム・採集・その他", /.*/],
];
function skillGroupOf(s) {
  if (s.kind === "set") return "シリーズスキル";
  if (s.kind === "group") return "グループスキル";
  if (s.kind === "weapon" && !data.weaponDecos.some((d) => d.skills.some(([sid]) => sid === s.id))) return "武器固有（珠がなく武器に付いているものだけ）";
  for (const [name, re] of SKILL_GROUPS) if (re.test(s.name)) return name;
  return "その他";
}
const GROUP_ORDER = [...SKILL_GROUPS.map(([n]) => n).filter((n) => n !== "アイテム・採集・その他"), "アイテム・採集・その他", "武器固有（珠がなく武器に付いているものだけ）", "シリーズスキル", "グループスキル"];
// 分類の中は「攻撃・会心」→「属性…」の順で見やすいように並べ替え
GROUP_ORDER.splice(0, 0, ...GROUP_ORDER.splice(GROUP_ORDER.indexOf("攻撃・会心"), 1));
GROUP_ORDER.splice(GROUP_ORDER.indexOf("防御・回復"), 0, ...GROUP_ORDER.splice(GROUP_ORDER.indexOf("スタミナ・回避・移動"), 1));
function renderSkillList() {
  const box = $("#skill-list");
  box.innerHTML = "";
  const q = ($("#skill-search").value || "").trim();
  const kind = skillKindFilter();
  const list = [...data.skills.values()].filter((s) => (kind === "all" || s.kind === kind) && (!q || s.name.includes(q) || s.desc.includes(q)));
  const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const s of list) (groups.get(skillGroupOf(s)) || groups.get("アイテム・採集・その他")).push(s);
  const frag = document.createDocumentFragment();
  for (const [g, ss] of groups) {
    if (!ss.length) continue;
    ss.sort((a, b) => (a.kind === "weapon") - (b.kind === "weapon") || a.name.localeCompare(b.name, "ja"));
    frag.append(el("div", { class: "grp" }, g));
    for (const s of ss) frag.append(skillCell(s));
  }
  box.append(frag);
  renderTargetChips();
}
function skillCell(s) {
  const cur = state.targets[s.id] || 0;
  const sel = el("select", { title: s.desc, onchange: (e) => setTarget(s.id, +e.target.value) });
  sel.append(el("option", { value: 0 }, "－"));
  for (let i = 1; i <= s.max; i++) {
    const pieces = (s.kind === "set" || s.kind === "group") && s.levels[i - 1]?.pieces;
    sel.append(el("option", { value: i, title: s.levels[i - 1]?.desc || "" }, pieces ? `${i}(${pieces}部位)` : String(i)));
  }
  sel.value = cur;
  const hasDeco = s.kind === "armor" && data.decoBySkill.has(s.id);
  const sub = s.kind === "armor" ? (hasDeco ? `【${data.decoBySkill.get(s.id).slot}】` : "珠なし") : "";
  return el("div", { class: "skill-cell" + (cur ? " on" : ""), "data-sid": s.id },
    el("span", { class: "nm", title: s.desc + (s.kind === "weapon" ? "（武器側：武器本体と武器珠でしか付かない）" : "") }, s.name,
      s.kind === "weapon" ? el("span", { class: "w", title: "武器側のスキル" }, "武") : null, sub ? el("span", { class: "d" }, sub) : null), sel);
}
function setTarget(sid, lv) {
  if (lv > 0) state.targets[sid] = lv; else delete state.targets[sid];
  persist();
  const cell = document.querySelector(`.skill-cell[data-sid="${sid}"]`);
  if (cell) cell.replaceWith(skillCell(data.skills.get(sid)));
  renderTargetChips();
}
function renderTargetChips() {
  const box = $("#target-chips");
  box.innerHTML = "";
  const ids = Object.keys(state.targets).map(Number);
  for (const sid of ids) {
    const s = data.skills.get(sid);
    if (!s) continue;
    box.append(el("span", { class: "chip" }, `${s.name} Lv${state.targets[sid]}`, el("button", { onclick: () => setTarget(sid, 0), title: "外す" }, "×")));
  }
  $("#skills-sub").textContent = ids.length ? `${ids.length} 件` : "未選択";
  const ts = $("#tab-search-sub"); if (ts) ts.textContent = ids.length ? String(ids.length) : "";
}

// ---------- 護石 ----------
function armorSkillOptions(sel, withNone = true) {
  sel.innerHTML = "";
  if (withNone) sel.append(el("option", { value: "" }, "（スキル）"));
  const list = [...data.skills.values()].filter((s) => s.kind === "armor").sort((a, b) => a.name.localeCompare(b.name, "ja"));
  for (const s of list) sel.append(el("option", { value: s.id }, s.name));
}
// 護石の登録フォーム：スキル一覧（防具スキルだけ）からプルダウンで選ぶ。選択は保存しない
const ccSel = {};
function renderCharms() {
  $("#charm-craftable").checked = state.charms.craftable;
  $("#charm-top").checked = state.charms.topOnly;
  for (const i of [1, 2, 3]) {
    const sl = $("#cc-slot" + i);
    sl.innerHTML = "";
    for (const v of [0, 1, 2, 3]) sl.append(el("option", { value: v }, v ? SLOT_CH[v] : "－"));
  }
  renderCharmGrid();
  renderCustomCharms();
}
function renderCharmGrid() {
  const box = $("#cc-grid");
  box.innerHTML = "";
  const q = ($("#cc-search").value || "").trim();
  const list = [...data.skills.values()].filter((s) => (s.kind === "armor" || s.kind === "weapon") && (!q || s.name.includes(q) || s.desc.includes(q)));
  const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const s of list) (groups.get(skillGroupOf(s)) || groups.get("アイテム・採集・その他")).push(s);
  const frag = document.createDocumentFragment();
  for (const [g, ss] of groups) {
    if (!ss.length) continue;
    ss.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    frag.append(el("div", { class: "grp" }, g));
    for (const s of ss) frag.append(charmCell(s));
  }
  box.append(frag);
  renderCharmChips();
}
function charmCell(s) {
  const cur = ccSel[s.id] || 0;
  const sel = el("select", { title: s.desc, onchange: (e) => setCharmSel(s.id, +e.target.value) });
  sel.append(el("option", { value: 0 }, "－"));
  for (let i = 1; i <= s.max; i++) sel.append(el("option", { value: i }, String(i)));
  sel.value = cur;
  return el("div", { class: "skill-cell" + (cur ? " on" : ""), "data-ccsid": s.id },
    el("span", { class: "nm", title: s.desc }, s.name, s.kind === "weapon" ? el("span", { class: "w", title: "武器側のスキル" }, "武") : null), sel);
}
function setCharmSel(sid, lv) {
  if (lv > 0) {
    if (!ccSel[sid] && Object.keys(ccSel).length >= 3) {
      $("#cc-msg").textContent = "護石のスキルは 3 つまで";
      const cell = document.querySelector(`.skill-cell[data-ccsid="${sid}"]`);
      if (cell) cell.replaceWith(charmCell(data.skills.get(sid)));
      return;
    }
    ccSel[sid] = lv;
  } else delete ccSel[sid];
  $("#cc-msg").textContent = "";
  const cell = document.querySelector(`.skill-cell[data-ccsid="${sid}"]`);
  if (cell) cell.replaceWith(charmCell(data.skills.get(sid)));
  renderCharmChips();
}
function renderCharmChips() {
  const box = $("#cc-chips");
  box.innerHTML = "";
  const ids = Object.keys(ccSel).map(Number);
  if (!ids.length) { box.append(el("span", { class: "hint" }, "下の一覧でレベルを選ぶ（最大 3 つ）")); return; }
  for (const sid of ids) box.append(el("span", { class: "chip" }, `${data.skills.get(sid).name} Lv${ccSel[sid]}`, el("button", { onclick: () => setCharmSel(sid, 0) }, "×")));
}
function renderCustomCharms() {
  const box = $("#custom-charms");
  box.innerHTML = "";
  if (!state.charms.customs.length) box.append(el("tr", {}, el("td", { class: "hint", colspan: 4 }, "まだ登録がない。下のフォームで追加する。")));
  else box.append(el("tr", {}, el("th", {}, "名前"), el("th", {}, "スキル"), el("th", {}, "スロット"), el("th", {}, "")));
  state.charms.customs.forEach((c, i) => {
    box.append(el("tr", {},
      el("td", {}, c.name),
      el("td", {}, c.skills.map(([s, l]) => `${data.skills.get(s)?.name} Lv${l}`).join("、")),
      el("td", {}, slotStr(c.slots)),
      el("td", {}, el("button", { class: "small", onclick: () => { state.charms.customs.splice(i, 1); persist(); renderCustomCharms(); } }, "削除"))));
  });
  $("#charms-sub").textContent = `${state.charms.craftable ? "作製品" : ""}${state.charms.customs.length ? ` 手入力 ${state.charms.customs.length}` : ""}`;
}
function addCustomCharm() {
  const skills = Object.entries(ccSel).map(([sid, lv]) => [+sid, lv]);
  if (!skills.length) { $("#cc-msg").textContent = "スキルを 1 つ以上選んでください"; return; }
  $("#cc-msg").textContent = "";
  const slots = [1, 2, 3].map((i) => +$("#cc-slot" + i).value).filter((v) => v > 0).sort((a, b) => b - a);
  const name = $("#cc-name").value.trim() || skills.map(([s, l]) => data.skills.get(s).name + l).join("・");
  state.charms.customs.push({ name, skills, slots });
  $("#cc-name").value = "";
  for (const i of [1, 2, 3]) $("#cc-slot" + i).value = 0;
  for (const k of Object.keys(ccSel)) delete ccSel[k];
  renderCharmGrid();
  $("#cc-msg").textContent = `「${name}」を追加した`;
  persist();
  renderCustomCharms();
}

// ---------- 装飾品 ----------
function renderDecoMode() {
  if (!["all", "none", "count"].includes(state.decoMode)) state.decoMode = "all";
  document.querySelector(`input[name=decomode][value=${state.decoMode}]`).checked = true;
  $("#deco-editor").hidden = state.decoMode !== "count";
  $("#decos-sub").textContent = { all: "無制限", none: "使わない", count: "所持数で制限" }[state.decoMode];
  if (state.decoMode === "count") renderDecoTable();
}
function renderDecoTable() {
  const t = $("#deco-table");
  t.innerHTML = "";
  const q = ($("#deco-search").value || "").trim();
  const kind = document.querySelector("input[name=decokind]:checked").value;
  let list = data.decorations.filter((d) => d.kind === kind);
  if (q) list = list.filter((d) => d.name.includes(q) || d.skills.some(([s]) => data.skills.get(s).name.includes(q)));
  list.sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name, "ja"));
  t.append(el("tr", {}, el("th", {}, "装飾品"), el("th", {}, "スキル"), el("th", { class: "num" }, "所持")));
  for (const d of list) {
    const inp = el("input", { type: "number", min: 0, max: 99, value: state.decoCounts[d.id] || 0, "data-deco": d.id,
      onchange: (ev) => { state.decoCounts[d.id] = Math.max(0, +ev.target.value || 0); persist(); } });
    t.append(el("tr", {}, el("td", {}, d.name), el("td", { class: "hint" }, d.skills.map(([s, l]) => data.skills.get(s).name + l).join("・")), el("td", { class: "num" }, inp)));
  }
}
function decoInvQuery() {
  if (state.decoMode === "count") return { mode: "count", counts: state.decoCounts };
  if (state.decoMode === "none") return { mode: "count", counts: {} };
  return { mode: "all" };
}

// ---------- 除外・固定 ----------
function renderArmorFilters() {
  const chips = $("#exclude-chips");
  chips.innerHTML = "";
  for (const n of state.excludeNames) chips.append(el("span", { class: "chip" }, n, el("button", { onclick: () => { state.excludeNames = state.excludeNames.filter((x) => x !== n); persist(); renderArmorFilters(); } }, "×")));
  const rows = $("#fixed-rows");
  rows.innerHTML = "";
  for (const p of PARTS) {
    const a = state.fixed[p] != null ? data.armorById.get(state.fixed[p]) : null;
    rows.append(el("div", { class: "saved-item" }, el("span", { class: "part" }, PART_LABEL[p]), el("span", { class: "nm" }, a ? `${a.name} ${slotStr(a.slots)}` : el("span", { class: "hint" }, "（自由）")),
      a ? el("button", { class: "small", onclick: () => { delete state.fixed[p]; persist(); renderArmorFilters(); } }, "解除") : null));
  }
  const n = state.excludeNames.length + Object.keys(state.fixed).length;
  $("#armor-sub").textContent = n ? `${state.excludeNames.length} 除外・${Object.keys(state.fixed).length} 固定` : "";
}
function armorSearchList(boxSel, q, onPick) {
  const box = $(boxSel);
  box.innerHTML = "";
  q = (q || "").trim();
  if (!q) return;
  const p = progressQuery();
  const list = data.armor.filter((a) => a.name.includes(q) || a.set.name.includes(q)).slice(0, 60);
  for (const a of list) {
    box.append(el("div", { onclick: () => onPick(a) }, `${a.name}`, el("span", { class: "hint" }, `　${PART_LABEL[a.part]} ${a.rank === "low" ? "下位" : "上位"} ${slotStr(a.slots)} ${a.skills.map(([s, l]) => data.skills.get(s).name + l).join(" ")}${armorOk(a, p) ? "" : "（進行度で除外中）"}`)));
  }
}

// ---------- 検索 ----------
function buildQuery() {
  const w = currentWeapon();
  return {
    targets: state.targets,
    weapon: { slots: w.slots, skills: w.skills },
    progress: progressQuery(),
    excludeNames: state.excludeNames,
    fixed: state.fixed,
    charms: state.charms,
    decoInv: decoInvQuery(),
    options: { allowEmpty: !!state.allowEmpty, maxResults: Math.max(1, +state.maxResults || 50), sort: state.sort },
  };
}
async function doSearch(auto = false) {
  const btn = $("#btn-search");
  const status = $("#status");
  if (!Object.keys(state.targets).length) { status.textContent = "スキルを選んでください"; return; }
  btn.disabled = true;
  status.textContent = "検索中…";
  const q = buildQuery();
  try {
    const r = await runSearch(q);
    lastResult = r;
    renderResults(r, q);
    if (auto !== true) { pushHistory(q); $("#results").scrollIntoView({ behavior: "smooth", block: "start" }); }
    status.textContent = r.ok ? `${r.total} 件${r.truncated ? "（打ち切り）" : ""} ${r.elapsed} ms` : "条件を満たせません";
  } catch (e) {
    status.textContent = "エラー: " + e.message;
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}
function renderResults(r, q) {
  const head = $("#results-head");
  const list = $("#results-list");
  list.innerHTML = "";
  head.innerHTML = "";
  const w = currentWeapon();
  if (!r.ok) {
    if (r.error === "weapon") {
      head.append(el("div", { class: "err" }, "武器側のスキルが足りません。"),
        el("div", {}, `武器「${w.name || "手入力"}」のスロット ${slotStr(w.slots)} と武器のスキルでは次が不足: `,
          r.lacking.map((l) => `${l.name} あと ${l.deficit}`).join("、")),
        el("div", { class: "hint" }, "武器スキル（攻撃・見切り・匠など）は武器本体と武器スロットの装飾品からしか付かない。武器を変えるかスロットを増やす。"));
    } else head.append(el("div", { class: "err" }, "検索できませんでした"));
    return;
  }
  const wd = r.weapon.decos.map((id) => data.decoById.get(id).name);
  head.append(el("div", {},
    el("b", {}, `${r.total} 件`), r.truncated ? el("span", { class: "warn" }, "（多すぎるので途中で打ち切り。条件を増やすと網羅的に出ます）") : "",
    el("span", { class: "hint" }, `　${r.elapsed} ms・候補 ${PARTS.map((p) => r.candidateCounts[p]).join("/")} 護石${r.candidateCounts.charm}`)),
    el("div", { class: "hint" }, `武器: ${w.name || "手入力"} ${slotStr(w.slots)}　武器珠: ${wd.length ? wd.join("・") : "なし"}　武器側の空き: ${slotStr(r.weapon.free)}`));
  if (!r.results.length) {
    head.append(el("div", { class: "err" }, "条件を満たす組み合わせがありません。"), el("div", { class: "hint" }, "進行度を上げる、スキルのレベルを下げる、除外・固定を見直す、装飾品の所持数を増やす、のどれかで解けることが多い。"));
    return;
  }
  const targetIds = new Set(Object.keys(q.targets).map(Number));
  const inv = q.decoInv.mode === "count" ? (id) => q.decoInv.counts[id] || 0 : () => Infinity;
  r.results.forEach((res, i) => list.append(resultCard(res, i, targetIds, q, inv, res.weapon || r.weapon)));
}
function resultCard(res, i, targetIds, q, inv, weaponPlan) {
  const card = el("div", { class: "result" });
  card.append(el("h3", {}, el("span", { class: "n" }, `#${i + 1}`), `防御 ${res.defMax}`, el("span", { class: "hint" }, `（初期 ${res.def}）`),
    el("span", { class: "stats" }, `火${res.res[0]} 水${res.res[1]} 雷${res.res[2]} 氷${res.res[3]} 龍${res.res[4]}`)));
  const pieces = el("div", { class: "pieces" });
  for (const p of [...PARTS, "charm"]) {
    const pc = res.pieces[p];
    pieces.append(el("span", { class: "part" }, PART_LABEL[p]),
      el("span", {}, pc ? pc.name : el("span", { class: "hint" }, "なし"),
        pc && pc.id != null && typeof pc.id === "number" && (data.armorById.get(pc.id)?.req.gates || []).length ? el("span", { class: "alts" }, `　要: ${data.armorById.get(pc.id).req.gates.map((g) => (data.meta.gates.find((x) => x.id === g) || {}).label || g).join("／")}`) : null,
        pc && pc.alts.length ? el("span", { class: "alts" }, `　同等: ${pc.alts.map((a) => a.name).join("、")}`) : null),
      el("span", { class: "slots" }, pc ? slotStr(pc.slots) : ""));
  }
  card.append(pieces);
  // 装飾品
  const dc = new Map();
  for (const id of res.decos) dc.set(id, (dc.get(id) || 0) + 1);
  const decoText = [...dc].map(([id, n]) => `${data.decoById.get(id).name}×${n}`).join("、");
  const wdc = new Map();
  for (const id of weaponPlan.decos) wdc.set(id, (wdc.get(id) || 0) + 1);
  card.append(el("div", { class: "decos" }, "防具珠: ", decoText || "なし", "　空き: ", el("span", { class: "free" }, slotStr(res.free)),
    "　武器珠: ", [...wdc].map(([id, n]) => `${data.decoById.get(id).name}×${n}`).join("、") || "なし", "　武器側の空き: ", el("span", { class: "free" }, slotStr(weaponPlan.free))));
  // スキル
  const sk = el("div", { class: "skills-out" });
  const all = new Map(res.skills);
  for (const [sid, lv] of weaponPlan.skills) all.set(sid, (all.get(sid) || 0) + lv);
  const sorted = [...all].sort((a, b) => (targetIds.has(b[0]) - targetIds.has(a[0])) || b[1] - a[1]);
  for (const [sid, lv] of sorted) {
    const s = data.skills.get(sid);
    const tgt = q.targets[sid] || 0;
    sk.append(el("span", { class: targetIds.has(sid) ? "t" : "" }, `${s.name} Lv${Math.min(lv, s.max)}`, lv > tgt && targetIds.has(sid) ? el("span", { class: "over" }, `(+${lv - tgt})`) : null, lv > s.max ? el("span", { class: "hint" }, `(${lv})`) : null));
  }
  for (const b of res.bonuses) sk.append(el("span", { class: targetIds.has(b.sid) ? "t" : "" }, `${b.name}: ${b.levelName || "Lv" + b.level}`, el("span", { class: "hint" }, `(${b.pieces}部位)`)));
  card.append(sk);
  // 追加できるスキル
  const add = addableSkills(data, res.free, inv).filter((a) => !targetIds.has(a.sid));
  if (add.length) {
    card.append(el("details", { class: "sub" }, el("summary", {}, `空きスロットに入れられるスキル（${add.length}）`),
      el("div", { class: "hint" }, add.map((a) => `${a.name}【${a.deco.slot}】`).join("、"))));
  }
  const nameInp = el("input", { type: "text", value: Object.keys(q.targets).map((s) => data.skills.get(+s).name + q.targets[s]).join(" ").slice(0, 60), style: "width:180px" });
  card.append(el("div", { class: "row" },
    nameInp, el("button", { class: "small", onclick: () => saveResult(res, q, nameInp.value.trim() || "装備") }, "この装備を保存"),
    el("button", { class: "small", onclick: () => { for (const p of PARTS) if (res.pieces[p]) state.fixed[p] = res.pieces[p].id; persist(); renderArmorFilters(); } }, "この 5 部位を固定にする")));
  return card;
}

// ---------- 保存・履歴 ----------
function saveResult(res, q, name) {
  const saved = store.loadSaved();
  saved.unshift({ name, at: new Date().toISOString(), pieces: res.pieces, decos: res.decos, free: res.free, defMax: res.defMax, weapon: currentWeapon(), targets: { ...q.targets } });
  store.saveSaved(saved);
  renderSaved();
}
function pushHistory(q) {
  const h = store.loadHistory();
  const names = Object.entries(q.targets).map(([s, l]) => data.skills.get(+s).name + l).join(" ");
  const key = JSON.stringify([q.targets, state.weapon.id, state.weapon.manualSlots, state.hr, state.chapter]);
  const rest = h.filter((x) => x.key !== key);
  rest.unshift({ key, at: new Date().toISOString(), label: `${names}｜${currentWeapon().name || "武器手入力"}｜HR${state.hr}`, targets: { ...q.targets }, weapon: { ...state.weapon }, hr: state.hr, chapter: state.chapter });
  store.saveHistory(rest);
  renderSaved();
}
function renderSaved() {
  const saved = store.loadSaved();
  const box = $("#saved-list");
  box.innerHTML = "";
  if (!saved.length) box.append(el("div", { class: "hint" }, "保存した装備はまだない"));
  saved.forEach((s, i) => {
    box.append(el("div", { class: "saved-item" },
      el("span", { class: "nm" }, el("b", {}, s.name), el("br"), el("span", { class: "hint" }, [...PARTS, "charm"].map((p) => s.pieces[p]?.name || "－").join(" / ") + `　防御 ${s.defMax}`)),
      el("button", { class: "small", onclick: () => { for (const p of PARTS) if (s.pieces[p]) state.fixed[p] = s.pieces[p].id; state.targets = { ...s.targets }; persist(); renderAll(); } }, "復元"),
      el("button", { class: "small", onclick: () => { saved.splice(i, 1); store.saveSaved(saved); renderSaved(); } }, "削除")));
  });
  const h = store.loadHistory();
  const hb = $("#history-list");
  hb.innerHTML = "";
  h.slice(0, 15).forEach((x) => hb.append(el("div", { class: "saved-item" },
    el("span", { class: "nm" }, x.label),
    el("button", { class: "small", onclick: () => { state.targets = { ...x.targets }; state.weapon = { ...state.weapon, ...x.weapon }; state.hr = x.hr; state.chapter = x.chapter; persist(); renderAll(); } }, "復元"))));
  $("#saved-sub").textContent = `${saved.length} 件保存・履歴 ${h.length}`;
  $("#tab-saved-sub").textContent = saved.length ? String(saved.length) : "";
}

// ---------- 配色 ----------
function applyTheme() {
  const t = state.theme || "auto";
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  $("#btn-theme").textContent = { auto: "配色: 自動", light: "配色: 明", dark: "配色: 暗" }[t];
}

// ---------- 配線 ----------
function bind() {
  $("#hr").addEventListener("input", (e) => { state.hr = +e.target.value || 1; persist(); updateProgressSub(); });
  $("#chapter").addEventListener("change", (e) => { state.chapter = e.target.value; persist(); updateProgressSub(); });
  for (const [id, k] of [["#inc-low", "incLow"], ["#inc-event", "incEvent"], ["#inc-arena", "incArena"], ["#inc-trade", "incTrade"], ["#inc-season", "incSeason"]])
    $(id).addEventListener("change", (e) => { state[k] = e.target.checked; persist(); updateProgressSub(); });
  $("#weapon-kind").addEventListener("change", (e) => { state.weapon.kind = e.target.value; state.weapon.id = null; persist(); renderWeaponList(); renderWeaponInfo(); });
  $("#weapon-final").addEventListener("change", (e) => { state.weapon.final = e.target.checked; persist(); renderWeaponList(); });
  $("#weapon-search").addEventListener("input", renderWeaponList);
  $("#weapon-clear").addEventListener("click", () => { state.weapon.id = null; persist(); renderWeaponList(); renderWeaponInfo(); });
  for (const i of [1, 2, 3]) $("#wslot" + i).addEventListener("change", (e) => { state.weapon.manualSlots[i - 1] = +e.target.value; persist(); renderWeaponInfo(); });
  $("#skill-search").addEventListener("input", renderSkillList);
  for (const r of document.querySelectorAll("input[name=skind]")) r.addEventListener("change", renderSkillList);
  $("#skills-clear").addEventListener("click", () => { state.targets = {}; persist(); renderSkillList(); });
  $("#charm-craftable").addEventListener("change", (e) => { state.charms.craftable = e.target.checked; persist(); renderCustomCharms(); });
  $("#charm-top").addEventListener("change", (e) => { state.charms.topOnly = e.target.checked; persist(); });
  $("#cc-add").addEventListener("click", addCustomCharm);
  $("#cc-search").addEventListener("input", renderCharmGrid);
  $("#cc-clear").addEventListener("click", () => { for (const k of Object.keys(ccSel)) delete ccSel[k]; renderCharmGrid(); });
  for (const r of document.querySelectorAll("input[name=decomode]")) r.addEventListener("change", (e) => { state.decoMode = e.target.value; persist(); renderDecoMode(); });
  for (const r of document.querySelectorAll("input[name=decokind]")) r.addEventListener("change", renderDecoTable);
  $("#deco-search").addEventListener("input", renderDecoTable);
  $("#deco-fill").addEventListener("click", () => { for (const inp of document.querySelectorAll("#deco-table input")) { inp.value = 9; state.decoCounts[+inp.dataset.deco] = 9; } persist(); });
  $("#deco-zero").addEventListener("click", () => { for (const inp of document.querySelectorAll("#deco-table input")) { inp.value = 0; state.decoCounts[+inp.dataset.deco] = 0; } persist(); });
  $("#exclude-search").addEventListener("input", (e) => armorSearchList("#exclude-list", e.target.value, (a) => { if (!state.excludeNames.includes(a.name)) state.excludeNames.push(a.name); persist(); renderArmorFilters(); }));
  $("#fixed-search").addEventListener("input", (e) => armorSearchList("#fixed-list", e.target.value, (a) => { state.fixed[a.part] = a.id; persist(); renderArmorFilters(); }));
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; persist(); });
  $("#max-results").addEventListener("change", (e) => { state.maxResults = +e.target.value || 50; persist(); });
  $("#allow-empty").addEventListener("change", (e) => { state.allowEmpty = e.target.checked; persist(); });
  $("#btn-search").addEventListener("click", () => { showTab("search"); doSearch(); });
  for (const b of document.querySelectorAll(".tab-btn")) b.addEventListener("click", () => showTab(b.dataset.tab));
  $("#gates-all").addEventListener("click", () => { state.lockedGates = []; persist(); updateProgressSub(); renderGates(); });
  $("#gates-none").addEventListener("click", () => { state.lockedGates = (data.meta.gates || []).map((g) => g.id); persist(); updateProgressSub(); renderGates(); });
  $("#btn-save").addEventListener("click", saveNow);
  document.addEventListener("keydown", (e) => { if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNow(); } });
  let clearArmed = 0;
  $("#btn-clear-all").addEventListener("click", (e) => {
    if (clearArmed) { store.clearAll(); state = defaultState(); clearArmed = 0; e.target.textContent = "このブラウザの保存データを全部消す"; renderAll(); dirty = false; updateSaveBtn(); return; }
    clearArmed = setTimeout(() => { clearArmed = 0; e.target.textContent = "このブラウザの保存データを全部消す"; }, 5000);
    e.target.textContent = "本当に消す（もう一度押す）";
  });
  $("#btn-theme").addEventListener("click", () => { state.theme = { auto: "light", light: "dark", dark: "auto" }[state.theme || "auto"]; persist(); applyTheme(); });
  $("#btn-export").addEventListener("click", () => { $("#io-text").value = store.exportAll(); $("#io-msg").textContent = "書き出した。コピーして別端末に貼る"; });
  $("#btn-copy").addEventListener("click", async () => {
    const ta = $("#io-text");
    if (!ta.value) ta.value = store.exportAll();
    try { await navigator.clipboard.writeText(ta.value); $("#io-msg").textContent = "コピーした"; }
    catch { ta.focus(); ta.select(); $("#io-msg").textContent = "選択したので Ctrl+C でコピー"; }
  });
  $("#btn-import").addEventListener("click", () => {
    try { store.importAll($("#io-text").value); state = { ...defaultState(), ...(store.loadState() || {}) }; renderAll(); dirty = false; updateSaveBtn(); $("#io-msg").textContent = "読み込んだ"; }
    catch (err) { $("#io-msg").textContent = "読み込めない: " + err.message; }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doSearch(); });
}
function renderAll() {
  renderProgress();
  renderGates();
  let tab = state.tab || "search";
  try { tab = localStorage.getItem("mhws-sim.v1.tab") || tab; } catch {}
  if (location.hash.startsWith("#tab-")) tab = location.hash.slice(5);
  showTab(["status", "search", "saved"].includes(tab) ? tab : "search");
  renderWeaponKinds();
  renderWeaponCols();
  renderWeaponList();
  renderWeaponInfo();
  renderSkillList();
  renderCharms();
  renderDecoMode();
  renderArmorFilters();
  $("#sort").value = state.sort;
  $("#max-results").value = state.maxResults;
  $("#allow-empty").checked = !!state.allowEmpty;
  renderSaved();
  applyTheme();
}

(async function main() {
  try {
    await loadData();
  } catch (e) {
    $("#meta").textContent = "データを読み込めませんでした: " + e.message;
    return;
  }
  const m = data.meta;
  $("#meta").textContent = `データ ${m.dataVersion.slice(0, 10)}・防具 ${m.counts.armor}・武器 ${m.counts.weapons}・装飾品 ${m.counts.decorations}`;
  bind();
  if (location.hash) { const d = document.querySelector(location.hash); if (d && d.tagName === 'DETAILS') d.open = true; }
  if (firstVisit && !Object.keys(state.targets).length) {
    for (const [name, lv] of [["弱点特効", 5], ["連撃", 3], ["巧撃", 2]]) {
      const s = [...data.skills.values()].find((s) => s.name === name);
      if (s) state.targets[s.id] = lv;
    }
  }
  renderAll();
  if (Object.keys(state.targets).length) doSearch(true);
})();
