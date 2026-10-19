"""Claude Artifact（クローズドなβ配布）用のページを作る。

index.html から html/head/body の骨組みを外し、css/style.css をインラインにして
_tmp_/artifact/index.html に書く。js/ と data/ はそのまま files として一緒に公開する。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / "index.html").read_text(encoding="utf-8")
css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")

title = re.search(r"<title>(.*?)</title>", src).group(1)
body = re.search(r"<body>(.*)</body>", src, re.S).group(1).strip()
# 骨組みの外側にあった要素はページ先頭に置く（title と style。meta は公開時の骨組みが持つ）
page = f"<title>{title}</title>\n<style>\n{css}\n</style>\n{body}\n"
out = ROOT / "_tmp_" / "artifact" / "index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page, encoding="utf-8", newline="\n")
print("wrote", out, f"{out.stat().st_size/1024:.0f} KB")
