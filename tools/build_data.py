"""mhdb (wilds.mhdb.io) の日本語データを取り込み、シミュレータ用の軽量 JSON を data/ に書く。

    python tools/build_data.py            # API から取得（tools/_raw/ にキャッシュ）
    python tools/build_data.py --offline  # tools/_raw/ のキャッシュだけで生成

進行度（チャプター・HR）は tools/progress.json の手入力テーブルから、防具の作製素材を
モンスター報酬にたどって付ける。解決できなかった素材は data/report.md に列挙する。
"""
import argparse
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "tools" / "_raw"
OUT = ROOT / "data"
API = "https://wilds.mhdb.io"
ENDPOINTS = ["armor", "armor/sets", "decorations", "charms", "skills", "weapons", "monsters"]
PARTS = ["head", "chest", "arms", "waist", "legs"]


def fetch(ep, offline):
    f = RAW / (ep.replace("/", "_") + ".json")
    if offline or f.exists() and offline is None:
        return json.loads(f.read_text(encoding="utf-8"))
    RAW.mkdir(parents=True, exist_ok=True)
    url = f"{API}/ja/{ep}" if ep != "version" else f"{API}/version"
    print("GET", url, flush=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "mhwilds-sim/1.0"}), timeout=300) as r:
        b = r.read()
    f.write_bytes(b)
    return json.loads(b)


def dump(name, obj):
    """配列は 1 レコード 1 行（人が読めて diff も取れる）。辞書は indent 付き"""
    OUT.mkdir(exist_ok=True)
    p = OUT / name
    if isinstance(obj, list):
        body = ",\n".join(" " + json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in obj)
        text = "[\n" + body + "\n]\n"
    else:
        text = json.dumps(obj, ensure_ascii=False, indent=1) + "\n"
    p.write_text(text, encoding="utf-8", newline="\n")
    print(f"  {name}: {p.stat().st_size/1024:.0f} KB", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--refresh", action="store_true", help="キャッシュを無視して取り直す")
    a = ap.parse_args()
    offline = True if a.offline else (False if a.refresh else None)

    prog = json.loads((ROOT / "tools" / "progress.json").read_text(encoding="utf-8"))
    chapters = prog["chapters"]
    chidx = {c: i for i, c in enumerate(chapters)}

    version = fetch("version", offline)
    raw = {ep: fetch(ep, offline) for ep in ENDPOINTS}

    # ---- skills
    skills = []
    for s in raw["skills"]:
        skills.append({
            "id": s["id"], "name": s["name"], "kind": s["kind"],
            "desc": s["description"] or "",
            "max": max(r["level"] for r in s["ranks"]),
            "levels": [{"lv": r["level"], "desc": r["description"] or "", "name": r["name"],
                        "pieces": r["setPiecesRequired"]} for r in sorted(s["ranks"], key=lambda r: r["level"])],
        })
    skill_kind = {s["id"]: s["kind"] for s in skills}

    # ---- decorations
    decos = []
    for d in raw["decorations"]:
        decos.append({"id": d["id"], "name": d["name"], "kind": d["kind"], "slot": d["slot"], "rarity": d["rarity"],
                      "skills": [[x["skill"]["id"], x["level"]] for x in d["skills"]]})
    for d in decos:  # 前提の確認：武器珠は武器スキルだけ、防具珠は防具スキルだけ（Lv1）
        for sid, lv in d["skills"]:
            assert skill_kind[sid] == d["kind"], (d["name"], sid)
            if d["kind"] == "armor":
                assert lv == 1, d["name"]

    # ---- set / group bonuses: スキル id で数える（ゴグマジオス防具は 1 部位で複数のシリーズに数えられる）
    bonuses = []
    for s in skills:
        if s["kind"] in ("set", "group"):
            assert all(l["pieces"] for l in s["levels"]), s["name"]
            bonuses.append({"skillId": s["id"], "kind": s["kind"], "name": s["name"],
                            "ranks": [{"pieces": l["pieces"], "level": l["lv"], "name": l["name"]} for l in s["levels"]]})

    # ---- item -> monster requirement（素材 1 つにつき「落とすモンスターのどれか」の選択肢）
    mon_table = prog["monsters"]
    missing_mon = [m["name"] for m in raw["monsters"] if m["name"] not in mon_table]
    item_alts = {}  # item id -> {"low": [alt...], "high": [alt...]}  alt = {"ch","hr","tags","src"}
    for m in raw["monsters"]:
        t = mon_table.get(m["name"])
        if not t:
            continue
        for r in m["rewards"]:
            ranks = {c["rank"] for c in r["conditions"]}
            e = item_alts.setdefault(r["item"]["id"], {"low": [], "high": []})
            for rk in ranks:
                req = t.get(rk)
                if req is None:
                    continue
                alt = {"ch": chidx[req["ch"]], "hr": req.get("hr", 0), "tags": sorted(req.get("tags", [])), "src": m["name"],
                       "gates": sorted({g for g in (req.get("gate"), req.get("gate2")) if g})}
                if alt not in e[rk]:
                    e[rk].append(alt)
    item_fixed = {k: v for k, v in prog["items"].items() if not k.startswith("_")}
    patterns = [(re.compile(p["pattern"]), p.get("tags", [])) for p in prog["item_patterns"]]
    unresolved = Counter()

    def item_alternatives(item, rank):
        """素材 1 つの要求：満たせばよい選択肢の一覧 [{ch,hr,tags,src}]"""
        name = item["name"]
        base = {"ch": chidx["1-1"] if rank == "low" else chidx["4-1"], "hr": 0 if rank == "low" else 9, "tags": [], "src": None, "gates": []}
        if name in item_fixed:
            f = item_fixed[name]
            if "low" in f or "high" in f:
                f = f.get(rank) or f.get("high" if rank == "low" else "low")
            return [{"ch": max(base["ch"], chidx[f["ch"]]), "hr": max(base["hr"], f.get("hr", 0)), "tags": sorted(f.get("tags", [])), "src": name,
                     "gates": sorted({g for g in (f.get("gate"), f.get("gate2")) if g})}]
        e = item_alts.get(item["id"])
        if e and item["icon"]["kind"] not in ("ore", "bone"):  # 鉱石・骨は採取でも取れるのでランクの既定値
            alts = e[rank] or e["high" if rank == "low" else "low"]
            if alts:
                return [{**a, "ch": max(base["ch"], a["ch"]), "hr": max(base["hr"], a["hr"])} for a in alts]
        tags = sorted({t for pat, ts in patterns if pat.search(name) for t in ts})
        if not tags and item["icon"]["kind"] not in ("ore", "bone"):
            unresolved[(name, rank)] += 1
        return [{**base, "tags": tags, "src": name if tags else None}]

    def summarize(mats):
        """表示用の要約：各素材の一番早い選択肢の最大（(ch,hr) の辞書順）"""
        ch, hr, tags = 0, 0, set()
        for alts in mats:
            best = min(alts, key=lambda a: (a["ch"], a["hr"]))
            ch, hr = max(ch, best["ch"]), max(hr, best["hr"])
            for a in alts:
                tags.update(a["tags"])
        return ch, hr, sorted(tags)

    # ---- armor
    set_over = {k: v for k, v in prog.get("sets", {}).items() if not k.startswith("_")}
    armors = []
    for x in raw["armor"]:
        rank = x["rank"]
        mats, srcs = [], set()
        base = [{"ch": chidx["1-1"] if rank == "low" else chidx["4-1"], "hr": 0 if rank == "low" else 9, "tags": [], "src": None, "gates": []}]
        mats.append(base)
        for mm in x["crafting"]["materials"]:
            alts = item_alternatives(mm["item"], rank)
            if alts not in mats:
                mats.append(alts)
            srcs.update(a["src"] for a in alts if a["src"])
        so = set_over.get(x["armorSet"]["name"])
        if so:
            mats.append([{"ch": chidx[so["ch"]], "hr": so.get("hr", 0), "tags": sorted(so.get("tags", [])), "src": so.get("note", "セット"),
                          "gates": sorted({g for g in (so.get("gate"), so.get("gate2")) if g})}])
            srcs.add(so.get("note", "セット上書き"))
        ch, hr, tags = summarize(mats)
        res = x["resistances"]
        for s in x["skills"]:  # 部位に付くシリーズ/グループスキルは必ず Lv1 相当の「1 部位ぶん」
            assert s["skill"]["kind"] in ("armor", "set", "group"), (x["name"], s)
        armors.append({
            "id": x["id"], "name": x["name"], "part": x["kind"], "rank": rank, "rarity": x["rarity"],
            "def": x["defense"]["base"], "defMax": x["defense"]["max"],
            "res": [res["fire"], res["water"], res["thunder"], res["ice"], res["dragon"]],
            "slots": sorted(x["slots"], reverse=True),
            "skills": [[s["skill"]["id"], s["level"]] for s in x["skills"] if s["skill"]["kind"] == "armor"],
            "bonusSkills": sorted({s["skill"]["id"] for s in x["skills"] if s["skill"]["kind"] in ("set", "group")}),
            "set": {"id": x["armorSet"]["id"], "name": x["armorSet"]["name"]},
            "req": {"ch": ch, "hr": hr, "tags": tags,
                    "gates": sorted({g for alts in mats for a in alts for g in a["gates"]}),
                    "mats": [[[a["ch"], a["hr"], a["tags"], a["gates"]] for a in alts] for alts in mats]},
            "src": ", ".join(sorted(srcs)),
        })

    # ---- charms
    charms = []
    for c in raw["charms"]:
        ranks = sorted(c["ranks"], key=lambda r: r["level"])
        for r in ranks:
            charms.append({"id": r["id"], "charmId": c["id"], "name": r["name"], "level": r["level"],
                           "top": r is ranks[-1], "rarity": r["rarity"], "random": c["random"],
                           "skills": [[s["skill"]["id"], s["level"]] for s in r["skills"]]})

    # ---- weapons
    weapons = []
    for w in raw["weapons"]:
        sp = w["specials"] or []
        elem = [[e.get("element") or e.get("status") or "?", (e.get("damage") or {}).get("display"), bool(e.get("hidden"))] for e in sp]
        weapons.append({
            "id": w["id"], "name": w["name"], "kind": w["kind"], "rarity": w["rarity"],
            "atk": (w["damage"] or {}).get("display"), "aff": w["affinity"], "elem": elem, "defBonus": w.get("defenseBonus") or 0,
            "slots": sorted(w["slots"], reverse=True),
            "skills": [[s["skill"]["id"], s["level"]] for s in w["skills"]],
            "series": (w["series"] or {}).get("name"),
            "final": not (w["crafting"] or {}).get("branches"),
        })

    meta = {
        "dataVersion": version["version"], "source": "wilds.mhdb.io (LartTyler/mhdb-wilds-data)",
        "chapters": chapters, "chapterLabels": prog["chapter_labels"], "hrToChapter": prog["hr_to_chapter"],
        "hrMilestones": prog["hr_milestones"],
        "gates": [{"id": k, **v} for k, v in prog.get("gates", {}).items() if not k.startswith("_")],
        "weaponKinds": sorted({w["kind"] for w in weapons}),
        "counts": {"armor": len(armors), "decorations": len(decos), "charms": len(charms), "weapons": len(weapons), "skills": len(skills)},
    }

    print("writing data/", flush=True)
    dump("skills.json", skills)
    dump("decorations.json", decos)
    dump("bonuses.json", bonuses)
    dump("armor.json", armors)
    dump("charms.json", charms)
    dump("weapons.json", weapons)
    dump("meta.json", meta)

    # ---- report
    lines = [f"# データ生成レポート\n\nデータ版: {version['version']}\n"]
    if missing_mon:
        lines.append("## progress.json に無いモンスター\n" + "\n".join(f"- {m}" for m in missing_mon) + "\n")
    lines.append("## 進行度を決められなかった素材（ランクの既定値を使用）\n")
    lines += [f"- {n}（{r}）×{k}" for (n, r), k in unresolved.most_common()]
    lines.append("\n## 防具セットごとの要求（最大値）\n")
    by_set = defaultdict(list)
    for x in armors:
        by_set[(x["rank"], x["set"]["name"])].append(x)
    for (rank, name), xs in sorted(by_set.items(), key=lambda kv: (kv[0][0] != "low", max(chapters.index(chapters[x["req"]["ch"]]) for x in kv[1]), max(x["req"]["hr"] for x in kv[1]))):
        ch = chapters[max(x["req"]["ch"] for x in xs)]
        hr = max(x["req"]["hr"] for x in xs)
        tags = sorted({t for x in xs for t in x["req"]["tags"]})
        src = sorted({x["src"] for x in xs if x["src"]})
        lines.append(f"- {name}（{rank}）: Ch{ch} HR{hr} {' '.join(tags)} ← {', '.join(src)[:80]}")
    (OUT / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print("done; unresolved materials:", len(unresolved), "; missing monsters:", missing_mon, flush=True)


if __name__ == "__main__":
    sys.exit(main())
