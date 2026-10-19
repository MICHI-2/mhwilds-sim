// 探索を UI スレッドから切り離す
import { prepare, search } from "./engine.js";

let data = null;
const FILES = ["skills", "decorations", "bonuses", "armor", "charms", "weapons", "meta"];

async function load() {
  const base = new URL("../data/", import.meta.url);
  const parts = await Promise.all(FILES.map((f) => fetch(new URL(f + ".json", base)).then((r) => r.json())));
  data = prepare(Object.fromEntries(FILES.map((f, i) => [f, parts[i]])));
}

self.onmessage = async (ev) => {
  const { id, type, q } = ev.data;
  try {
    if (!data) await load();
    if (type === "search") {
      const r = search(data, q);
      self.postMessage({ id, ok: true, r });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.stack || e) });
  }
};
