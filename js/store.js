// localStorage への保存（入力状態・保存した装備・検索履歴）。読めない環境でも落ちない
const KEY = "mhws-sim.v1";

function read(name, fallback) {
  try {
    const t = localStorage.getItem(KEY + "." + name);
    return t ? JSON.parse(t) : fallback;
  } catch {
    return fallback;
  }
}
function write(name, obj) {
  try {
    localStorage.setItem(KEY + "." + name, JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

export const store = {
  loadState: () => read("state", null),
  saveState: (s) => write("state", s),
  loadSaved: () => read("saved", []),
  saveSaved: (list) => write("saved", list),
  loadHistory: () => read("history", []),
  saveHistory: (list) => write("history", list.slice(0, 30)),
  exportAll: () => JSON.stringify({ state: read("state", null), saved: read("saved", []), history: read("history", []) }, null, 1),
  importAll: (text) => {
    const o = JSON.parse(text);
    if (o.state) write("state", o.state);
    if (o.saved) write("saved", o.saved);
    if (o.history) write("history", o.history);
  },
  clearAll: () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(KEY)) localStorage.removeItem(k);
    } catch {}
  },
};
