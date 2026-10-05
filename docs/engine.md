# 音楽エンジンの設計

## 作曲

`generateSong(settings)`はブラウザAPIに依存しない純粋な処理で、曲の設定、セクション、1小節ごとのコード、各パートのイベントを返す。同じ設定とシードなら同じイベント列になる。
独立した乱数系列を和声・鍵盤・ベース・ドラム・リードに用いる。発音タイミングのゆらぎはシードとイベントの識別子から作るため、別パートに音を追加しても既存の音のタイミングが変わらない。

32／64／96小節の曲は、イントロ、テーマA、テーマB、ソロ、テーマ回帰、エンディングを持つ。リードのテーマは短いリズムセルと段階的な音程輪郭から作り、反復・移調・区間による変化・休符を使う。
強拍やフレーズの端ではコードトーンを優先し、極端な跳躍を抑える。エンディングは主音を含む和音に戻り、ベースが主音を保持してリズムを落ち着かせる。

和声にはDorian、Lydian dominant、Aeolian、Mixolydianを起点とするスタイル別の進行を使う。9th／11th／13th、sus、alteredなどのコードカラーを含む。
エレピはベースにルートを任せ、上声の間隔と前の配置からの移動量を考慮して配置する。スタイルごとの伴奏パターンに小さな変化を加え、ベースは主音・5度・オクターブと次の和音へのアプローチ、ドラムは固定した骨格と少数のフィルを使う。

### ピアノ・バンドの生成モード

| モード | 参照 | 編成 | 作曲上の特徴 |
| --- | --- | --- | --- |
| `bloom` / Gardenia系 | PRIMITIVE ART ORCHESTRA「Gardenia」 | ピアノ伴奏・ピアノ旋律・コントラバス・ドラム | 繊細な導入、1小節ごとの和声、4小節の旋律、ライドとシンコペーション、テーマ回帰での盛り上がり |
| `carousel` / Ferris Wheel系 | bohemianvoodoo「Ferris Wheel」 | ギター・ピアノ・ベース・ドラム | 2小節単位の和声、メジャーとマイナーの対比、旋律の反復と変化、ギターの伴奏と応答、バックビート |

両モードは複数の独自の和声パレットからシードで選択し、明るい主調にマイナーの色彩、sus、セカンダリードミナントなどを加える。対照的なテーマでは進行と音程輪郭を変え、ソロでは密度設定に応じて装飾を加える。4小節のフレーズ全体に旋律を配置し、導入から回帰に向かって各パートの強弱を増す。
Ferris Wheel系ではフレーズ末のピアノを短く区切り、空いた箇所にギターが応答する。ベースは両モードで次のコードに向かう半音アプローチを持つ。

参考にしたのは公式資料で確認できる編成とバンドの音楽的方向性。原曲の音源聴取・採譜は行っていないため、BPM・キー・拍子・進行の再現を示すモードではない。126／116 BPMと4/4はこの生成器の設計値。旋律と和声は独自に生成する。

| 設定 | 範囲 | 効果 |
| --- | --- | --- |
| `seed` | 最大80文字 | 曲の乱数系列と再現性 |
| `style` | bloom / carousel / contemporary / fusion / nocturne / bossa | 編成、モード、進行、リズム、初期テンポ |
| `key` | 0〜11 | Cを0とする主音 |
| `tempo` | 60〜150 | BPM、4/4 |
| `bars` | 32 / 64 / 96 | 曲の構成と長さ |
| `complexity` | 0〜1 | 伴奏の追加、フィル、フレーズの変化 |
| `swing` | 0〜0.45 | 8分裏拍を最大0.225拍遅らせる |
| `humanize` | 0〜1 | 発音時刻を最大±0.022拍ずらす |

イベントは`{track, beat, duration, velocity, note}`、打楽器は`note`の代わりに`drum`を持つ。新音色のイベントは`piano`／`guitar`／`upright`の`timbre`を持ち、曲の`instruments`にもパートと音色の対応を保存する。時刻と長さの単位は拍。
出力は時刻順で、タイミングの補正、再生、WAV、MIDIが共通のイベント列を使う。

## 音源と再生

Web Audio APIの標準ノードを使用する。エレピは正弦波、短いFMのアタックと倍音、ベースは三角波・低域フィルター・プラック、リードは柔らかい正弦波／三角波と小さなビブラート。
ピアノは3つの倍音の個別減衰と短いハンマー音、クリーン・ギターは減衰する三角波の倍音、コントラバスは低域のプラックと短い木質のアタックを合成する。パートの役割に関わらずイベントの音色指定を優先し、ライブ再生とWAVに同じ合成処理を使う。
ドラムはピッチが下降するキック、フィルターを通したノイズと胴鳴り、短いハイハット、金属倍音のライドなどで合成する。ノイズと部屋のインパルスは決定的に生成する。外部サンプルは使わない。

パートのGainNodeからドライ音とルームへ送り、マスター、コンプレッサー、アナライザー、出力へ接続する。
各発音のエンベロープはソース停止前にゼロに達する。声は発音終了後に切断し、停止・位置移動時は短いフェードでキャンセルする。
再生は`AudioContext.currentTime`を基準に、25ms間隔で150ms先までノードを予約する。画面描画の時刻は発音を決めない。
中断時は位置を保持し、タイマーが遅れた場合は古いイベントを飛ばして一度に大量発音しない。

WAVは同じ音源グラフを`OfflineAudioContext`でレンダリングし、2秒のリバーブ尾部を付けてPCMに変換する。
MIDIは5トラックのType 1ファイルで、同音の重なりを調整し、古いnote-offが次のnote-onを切らないようにする。
`instruments`からGeneral MIDIのAcoustic Grand Piano（program 0）、Electric Guitar Clean（27）、Acoustic Bass（32）を選び、新しい編成をDAWへ渡す。数字は0始まりで、従来スタイルの音色とドラムのチャンネル10はそのまま。

## 調査した一次資料

これらの資料の音楽的考え方と標準APIを参考にした独自のルールベース実装。教材の曲やコードは複製していない。

- [Berklee Online — Jazz Composition](https://online.berklee.edu/courses/jazz-composition): 曲の形式、和声進行、モチーフの反復・変化・展開。
- [PRIMITIVE ART ORCHESTRA — Artifact](https://primitiveartorchestra.bandcamp.com/album/artifact): Gardeniaの収録を確認。
- [Playwright — PRIMITIVE ART ORCHESTRA](https://www.playwright.jp/artists/pao/): ピアノ・ベース・ドラム編成とバンドの方向性。
- [bohemianvoodoo — Ferris Wheel](https://bohemianvoodoo.bandcamp.com/track/ferris-wheel): 『Aromatic』収録曲と、バンドの旋律性・ドラマチックな展開・ドライブ感の説明を確認。説明はバンド全体の特徴で、曲固有の採譜情報ではない。
- [Playwright — bohemianvoodoo](https://www.playwright.jp/artists/bohemianvoodoo/): ギター・ピアノ・ベース・ドラムのメンバー表とメロディアスなインストの方向性。
- [Berklee Online — Jazz Arranging](https://online.berklee.edu/courses/jazz-arranging): リズムセクション、伴奏、Funk and Fusionの編曲。
- [Berklee Online — Modal Harmony in Jazz Composition](https://online.berklee.edu/takenote/harmonic-considerations-modal-harmony/): モードの特徴音、モーダルな和声の扱い。
- [Berklee Online — Four Critical Listening Tips for Songwriters](https://online.berklee.edu/takenote/four-critical-listening-tips-for-songwriters/): モチーフ、反復、音程・リズムの変化、休符とシンコペーション。
- [Berklee — Improvisation lesson](https://college.berklee.edu/bt/193/lesson.html): 拍や小節線に固定されないフレーズ、アクセントと休符。
- [W3C — Web Audio API](https://www.w3.org/TR/webaudio/): オーディオグラフ、ソースの時刻指定、AudioParam、OfflineAudioContext。
- [MDN — Advanced techniques: Creating and sequencing audio](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Advanced_techniques): 先読みスケジューラ、合成、エンベロープ。
