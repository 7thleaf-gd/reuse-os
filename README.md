# REUSE / 7THLEAF USED GOODS OS

中古品の「撮影 → 商品特定 → 相場 → 在庫化 → 複数販路出品 → 売却時の他販路自動停止」を回すシステム。

---

## なぜこのリポジトリがあるか

Apps Scriptエディタへのコピペ運用には実害がありました。
以前、ファイルプレビュー画面からコピペした際にファイル名の見出し行が混入し、
`SyntaxError: Unexpected identifier 'implementation'` で動かなくなっています。

clasp（Google公式のApps Script CLI）を使えば、ローカルのファイルをそのまま
Apps Scriptへ同期できるので、この事故は構造的に起きなくなります。
あわせてgitで履歴が残るため、「動いていた時点」に戻せるようになります。

---

## セットアップ（初回だけ・5分）

**このリポジトリはクラウド上で作られているため、Googleアカウントの認証だけは
ご自身のPCで行う必要があります**（認証ブラウザが開くため、こちらからは実行できません）。

### 1. claspを入れる

```bash
npm install -g @google/clasp
```

### 2. Googleにログイン（ブラウザが開きます）

```bash
clasp login
```

### 3. Apps Script APIを有効にする

https://script.google.com/home/usersettings を開いて
「Google Apps Script API」を **オン** にしてください。ここがオフだと push が失敗します。

### 4. スクリプトIDを `.clasp.json` に書く

Apps Scriptエディタを開いたときのURLがこの形式になっています。

```
https://script.google.com/home/projects/【この部分がスクリプトID】/edit
```

これを `.clasp.json` の `scriptId` に貼ってください。

---

## 毎回の使い方

```bash
# ローカル → Apps Script へ反映（コピペ不要）
clasp push

# Apps Script側で直接編集してしまった分をローカルへ取り込む
clasp pull

# エディタを開く
clasp open
```

`clasp push` の後、Apps Scriptエディタをリロードすれば最新コードになっています。

---

## gitの使い方

このリポジトリは既にコミット済みです。GitHubに上げる場合:

```bash
# GitHubで空のリポジトリを作ってから
git remote add origin https://github.com/<あなたのユーザー名>/reuse-os.git
git branch -M main
git push -u origin main
```

**注意**: `src/phase0-implementation.gs` のCONFIGにAPIキーを直接書く運用のままだと、
GitHubのpublicリポジトリに上げた瞬間にキーが公開されます。
publicにする場合は、先に「APIキーをPropertiesServiceへ移す」対応が必要です（未実装）。
当面はprivateリポジトリにしてください。

---

## ファイル構成と依存順

`filePushOrder`（.clasp.json）で読み込み順を固定しています。

| ファイル | 役割 |
|---|---|
| `phase0-implementation.gs` | CONFIG / Canonical Product Record / OCR / カテゴリ判定 / 各DB Resolver |
| `price-engine.gs` | Discogs相場取得（price_suggestions → lowest_priceフォールバック） |
| `listing-generator.gs` | 出品タイトル・説明文の生成（テンプレート方式） |
| `channel-router.gs` | どの販路に出せるか判定（Etsyの20年ヴィンテージ判定など） |
| `channel-adapters.gs` | **各販路のAPI作法を隔離**。停止・verifyの手順はここだけに書く |
| `inventory-manager.gs` | **商品マスター + SOLDステートマシン**。王様。各社APIを知らない |
| `phase0-batch-runner.gs` | Driveの写真を順に処理するバッチ実行 |
| `measurement-gas.gs` | 計測・ROI記録 |

### 設計の中心

```
inventory-manager.gs  ← 「何を止めるか」だけ決める
        ↓
channel-adapters.gs   ← 「どう止めるか」を各社ごとに隔離
        ├ EbayAdapter
        ├ EtsyAdapter
        ├ MercariShopsAdapter
        ├ YahooShoppingAdapter
        └ ManualAdapter（メルカリ個人 / ラクマ / ヤフオク個人）
```

新しい販路を足すときは `channel-adapters.gs` にAdapterを1つ書いて
`CHANNEL_ADAPTERS` に登録するだけです。`inventory-manager.gs` は一切変更不要。

---

## 動作確認用の関数（外部APIを叩きません）

Apps Scriptエディタで実行してください。

| 関数 | 確認内容 |
|---|---|
| `testChannelAdapters()` | 全Adapterのインターフェース充足・設定状態・停止ステップ数 |
| `testChannelRouter()` | Etsyヴィンテージ判定（20年境界・年式不明） |
| `testListingGenerator()` | タイトル・説明文の生成 |
| `testInventoryStateMachine()` | 在庫登録 → 出品記録 → 売却 → 冪等性 → 要対応リスト |

外部APIを実際に叩くのは以下（キー設定後に実行）:

| 関数 | 内容 |
|---|---|
| `testVisionApiKey()` | Vision APIキーの疎通 |
| `testDiscogsToken()` | Discogsトークンの疎通 |
| `testPriceEngine()` | 相場取得（①price_suggestions → ②lowest_priceフォールバック） |
| `testWithFewImages()` | Driveの写真3-5枚でE2E（本番バッチ前の必須ゲート） |

---

## 現在の到達点

```
HUNTER（撮影→特定→相場→粗利）        基礎成立
MASTER INVENTORY（商品マスター）        基礎成立
SOLD WORKFLOW（ステートマシン）         完成
CHANNEL ROUTER（販路判定）              基礎成立
CHANNEL ADAPTER（販路隔離）             完成

残り:
  → eBay実接続（OAuthトークン取得）
  → 実商品1件でE2E（出品 → SOLD検知 → stop → verify）
  → Etsy / Mercari Shops / Yahoo Shopping を1社ずつ追加
```

**外部API実通信はまだ0回**です。全てモックによる単体テストのみで検証しています。

---

## ステートマシン

```
在庫ステータス:  AVAILABLE ──→ RESERVED ──→ SOLD
                                  └──→ AVAILABLE（注文キャンセル時）

同期ステータス:  SALE_DETECTED → STOPPING_CHANNELS → VERIFYING → ┬ SYNCED
                                                                 ├ PARTIAL_FAILURE
                                                                 └ MANUAL_ACTION_REQUIRED
```

- **RESERVED が最重要**: 売却検知した瞬間に確保する。他販路の停止完了を待たない
- **冪等性**: イベントID =「チャネル:注文ID」。同じWebhookが2回来ても1回しか実行しない
- **リトライ**: 失敗したチャネルだけ `retryFailedStops(sku)` で再実行。成功済みには触らない
- **verify=null を成功に丸めない**: 判定不能は `MANUAL_ACTION_REQUIRED` に倒す

---

## 正直に書いておく制約

- 二重販売リスクはゼロにできません。4社とも「即時・確実に購入不可になる」保証文言が
  公式ドキュメントに無く、特にYahoo!ショッピングは「フロント反映は別処理」と明記されています
- メルカリ個人 / ラクマ / ヤフオク個人は自動停止できません（規約・API不在）。
  手動削除の作業リストを自動生成することで対応しています
- 手数料計算は未実装。Gross Profitは「実売価格 − 仕入価格」で、販売手数料を引いていません
- eBayのgetOfferレスポンスのフィールド名、Etsyのstate literal、
  Mercari Shopsの削除後の照会挙動は、公式ドキュメントで確認しきれていない箇所があります。
  該当箇所は各Adapterのコメントに「⚠️未確認」として明記してあります
- Discogsは現状「商品DB・相場参照」専用です。販売チャネルとしては未実装
  （本人確認が通ったら `discogs-adapter` を足して `CHANNEL_ADAPTERS` に登録するだけ）
