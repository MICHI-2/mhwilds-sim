# mhwilds-sim

モンスターハンターワイルズのスキルシミュレータ（β）。ビルド不要の静的サイト。

**公開ページ**: https://michi-2.github.io/mhwilds-sim/

## できること

- 進行度（HR・チャプター）で、作れる防具だけを候補にする
- 武器を選ぶとスロットと付属スキルを自動で使う
- 武器スキルは武器＋武器珠、防具スキルは防具＋護石＋防具珠で解く（Wilds の仕様どおり）
- 5 部位を必ず埋め、防御力／空きスロット／余剰スキルの順で最良を厳密に出す
- 装飾品の所持数、鑑定護石（武器スキル可）、除外・固定、保存と履歴

## 使い方（ローカル）

`file://` では動かないので http サーバ越しに開く。

```
python -m http.server 8765 --bind 127.0.0.1
# → http://127.0.0.1:8765/
```

テスト: `tests/test.html` を開く（`PASS n / FAIL m` が出る）。

## データ

- 装備・スキル・装飾品・護石・武器: [wilds.mhdb.io](https://wilds.mhdb.io/)（[LartTyler/mhdb-wilds-data](https://github.com/LartTyler/mhdb-wilds-data)）。`data/meta.json` の `dataVersion` が取り込み日
- 進行度: `tools/progress.json`（手入力。出典は攻略サイト各防具ページ）
- 取り直し: `python tools/build_data.py --refresh`（`data/` を再生成。`data/report.md` に割り当ての一覧）

## ファイル

```
index.html / css/ / js/   ページ本体（app: UI, engine: 探索, store: 保存, worker: 探索スレッド）
data/                     生成データ
tools/                    データ生成と進行度テーブル
tests/                    エンジンの回帰テスト
```

## 版

タグ `vX.Y.Z`。X: 判定や探索の仕組みが変わる、Y: データ・進行度表の更新や機能追加、Z: 修正。

ゲーム内容の権利は CAPCOM に帰属します。
