# 音楽エンジンの設計

## 作曲

`generateSong(settings)`はブラウザAPIに依存しない純粋な処理で、曲の設定、セクション、1小節ごとのコード、各パートのイベントを返す。同じ設定とシードなら同じイベント列になる。
独立した乱数系列を和声・鍵盤・ベース・ドラム・リードに用いる。発音タイミングのゆらぎはシードとイベントの識別子から作るため、別パートに音を追加しても既存の音のタイミングが変わらない。

32／64／96小節の曲は、イントロ、テーマA、テーマB、ソロ、テーマ回帰、エンディングを持つ。リードのテーマは短いリズムセルと段階的な音程輪郭から作り、反復・移調・区間による変化・休符を使う。
強拍やフレーズの端ではコードトーンを優先し、極端な跳躍を抑える。エンディングは主音を含む和音に戻り、ベースが主音を保持してリズムを落ち着かせる。

和声にはDorian、Lydian dominant、Aeolian、Mixolydianを起点とするスタイル別の進行を使う。9th／11th／13th、sus、alteredなどのコードカラーを含む。
エレピはベースにルートを任せ、上声の間隔と前の配置からの移動量を考慮して配置する。スタイルごとの伴奏パターンに小さな変化を加え、ベースは主音・5度・オクターブと次の和音へのアプローチ、ドラムは固定した骨格と少数のフィルを使う。

| 設定 | 範囲 | 効果 |
| --- | --- | --- |
| `seed` | 最大80文字 | 曲の乱数系列と再現性 |
| `style` | contemporary / fusion / nocturne / bossa | モード、進行、リズム、初期テンポ |
| `key` | 0〜11 | Cを0とする主音 |
| `tempo` | 60〜150 | BPM、4/4 |
| `bars` | 32 / 64 / 96 | 曲の構成と長さ |
| `complexity` | 0〜1 | 伴奏の追加、フィル、フレーズの変化 |
| `swing` | 0〜0.45 | 8分裏拍を最大0.225拍遅らせる |
| `humanize` | 0〜1 | 発音時刻を最大±0.022拍ずらす |

イベントは`{track, beat, duration, velocity, note}`、打楽器は`note`の代わりに`drum`を持つ。時刻と長さの単位は拍。
出力は時刻順で、タイミングの補正、再生、WAV、MIDIが共通のイベント列を使う。

## 音源と再生

Web Audio APIの標準ノードを使用する。エレピは正弦波、短いFMのアタックと倍音、ベースは三角波・低域フィルター・プラック、リードは柔らかい正弦波／三角波と小さなビブラート。
ドラムはピッチが下降するキック、フィルターを通したノイズと胴鳴り、短いハイハット、金属倍音のライドなどで合成する。ノイズと部屋のインパルスは決定的に生成する。外部サンプルは使わない。

パートのGainNodeからドライ音とルームへ送り、マスター、コンプレッサー、アナライザー、出力へ接続する。
各発音のエンベロープはソース停止前にゼロに達する。声は発音終了後に切断し、停止・位置移動時は短いフェードでキャンセルする。
再生は`AudioContext.currentTime`を基準に、25ms間隔で150ms先までノードを予約する。画面描画の時刻は発音を決めない。
中断時は位置を保持し、タイマーが遅れた場合は古いイベントを飛ばして一度に大量発音しない。

WAVは同じ音源グラフを`OfflineAudioContext`でレンダリングし、2秒のリバーブ尾部を付けてPCMに変換する。
MIDIは5トラックのType 1ファイルで、同音の重なりを調整し、古いnote-offが次のnote-onを切らないようにする。

## 調査した一次資料

これらの資料の音楽的考え方と標準APIを参考にした独自のルールベース実装。教材の曲やコードは複製していない。

- [Berklee Online — Jazz Composition](https://online.berklee.edu/courses/jazz-composition): 曲の形式、和声進行、モチーフの反復・変化・展開。
- [Berklee Online — Jazz Arranging](https://online.berklee.edu/courses/jazz-arranging): リズムセクション、伴奏、Funk and Fusionの編曲。
- [Berklee Online — Modal Harmony in Jazz Composition](https://online.berklee.edu/takenote/harmonic-considerations-modal-harmony/): モードの特徴音、モーダルな和声の扱い。
- [Berklee Online — Four Critical Listening Tips for Songwriters](https://online.berklee.edu/takenote/four-critical-listening-tips-for-songwriters/): モチーフ、反復、音程・リズムの変化、休符とシンコペーション。
- [Berklee — Improvisation lesson](https://college.berklee.edu/bt/193/lesson.html): 拍や小節線に固定されないフレーズ、アクセントと休符。
- [W3C — Web Audio API](https://www.w3.org/TR/webaudio/): オーディオグラフ、ソースの時刻指定、AudioParam、OfflineAudioContext。
- [MDN — Advanced techniques: Creating and sequencing audio](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Advanced_techniques): 先読みスケジューラ、合成、エンベロープ。
