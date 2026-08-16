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

## セットアップ（初回だけ）

**Googleアカウントの認証だけはご自身のPCで行う必要があります**
（認証ブラウザが開くため、クラウド側からは代行できません）。

### 1. claspを入れる

```bash
npm install -g @google/clasp
```

### 2. Googleにログイン（ブラウザが開きます）

```bash
clasp login
```

`You are logged in as ...` と出れば成功です。

### 3. Apps Script APIを有効にする

ブラウザで https://script.google.com/home/usersettings を開き、
「Google Apps Script API」を **オン** にしてください。
ここがオフだと次の `clasp push` が失敗します。

### 4. このフォルダに移動する

`Project settings not found.` というエラーは、`.clasp.json` があるフォルダに
いないことが原因です。展開した `reuse-os` フォルダの中に入ってください。

```bash
cd reuse-os
ls
```

`.clasp.json` と `src` が見えていればOKです。

### 5. スクリプトIDを `.clasp.json` に書く

Apps Scriptエディタを開いたときのURLがこの形式になっています。

```
https://script.google.com/home/projects/1AbCdEf.../edit
```

`projects/` と `/edit` の間の文字列がスクリプトIDです。
これを `.clasp.json` の `scriptId` の値と差し替えてください。

コマンドで書き換える場合（`1AbC...` の部分を自分のIDに置き換えて実行）:

```bash
sed -i '' 's|ここにApps ScriptのスクリプトIDを貼る|1AbCdEf...|' .clasp.json
```

---

## 毎回の使い方

ローカル → Apps Script へ反映（コピペ不要）:

```bash
clasp push
```

Apps Script側で直接編集した分をローカルへ取り込む:

```bash
clasp pull
```

エディタを開く:

```bash
clasp open
```

`clasp push` の後、Apps Scriptエディタをリロードすれば最新コードになっています。

初回の `clasp push` では「上書きしていいか」を聞かれます。
Apps Script側に残したい編集が無ければ `y` で進めて構いません。

---

## 秘密情報の設定（clasp push の後に1回だけ）

APIキーはソースコードに一切書きません。Apps Scriptの
「スクリプトプロパティ」に入れて、実行時に読み出します。

### 方法A（推奨・コードに一瞬も載らない）

1. Apps Scriptエディタ左の「⚙ プロジェクトの設定」を開く
2. 一番下の「スクリプト プロパティ」→「スクリプト プロパティを追加」
3. 下記のキーと値を入れて保存

必須:

| キー | 中身 |
|---|---|
| `VISION_API_KEY` | Google Cloud の APIキー |
| `GOOGLE_API_KEY` | 同上（Google Books用。同じキーで可） |
| `DISCOGS_TOKEN` | Discogs 開発者トークン |
| `SHEET_ID` | 作業用スプレッドシートのID |
| `DRIVE_FOLDER_ID` | 撮影画像を置くDriveフォルダのID |

販路連携（使う分だけでOK）: `EBAY_OAUTH_TOKEN` / `ETSY_API_KEY` /
`ETSY_OAUTH_TOKEN` / `ETSY_SHOP_ID` / `MERCARI_SHOPS_ACCESS_TOKEN` /
`MERCARI_SHOPS_CLIENT_NAME` / `YAHOO_SHOPPING_ACCESS_TOKEN` / `YAHOO_SHOPPING_SELLER_ID`

### 方法B（まとめて入れたい場合）

`src/setup-secrets.example.gs` を `src/setup-secrets.gs` にコピーし、
値を書いて `saveSecrets()` を1回実行してください。
このファイルは `.gitignore` 済みなのでコミットされません。実行後は削除して構いません。

### 確認

Apps Scriptエディタで `checkConfig()` を実行すると、どのキーが設定済みかが
一覧表示されます。**秘密情報は末尾4文字だけ表示される**ので、
この実行ログはそのまま共有しても漏洩しません。

---

## gitの使い方

このリポジトリは既にコミット済みです。GitHubに上げる場合:

GitHubで空のリポジトリを作ってから、

```bash
git remote add origin https://github.com/<あなたのユーザー名>/reuse-os.git
git branch -M main
git push -u origin main
```

APIキーはソースに含まれないため、publicリポジトリでも秘密情報は漏れません。
ただし `SHEET_ID` / `DRIVE_FOLDER_ID` もプロパティ側に移してあるので、
`src/setup-secrets.gs` を作った場合はそれだけは絶対にコミットしないでください
（`.gitignore` 済みですが念のため）。

---

## ファイル構成と依存順

`filePushOrder`（.clasp.json）で読み込み順を固定しています。

| ファイル | 役割 |
|---|---|
| `config.gs` | **秘密情報の分離**。スクリプトプロパティからCONFIGを読む。`checkConfig()` |
| `phase0-implementation.gs` | Canonical Product Record / OCR / カテゴリ判定 / 各DB Resolver |
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

## 開発時のチェック（PCで実行・外部APIを叩きません）

```bash
npm run verify
```

構文チェック + グローバル名の重複チェック + 全テストを実行します。
`clasp push` する前にこれを通す習慣にすると、GASに壊れたコードを送らずに済みます。

GASは全ファイルを1つの名前空間に展開するため、別々のファイルに同じ名前の関数が
あると後から読まれた方で上書きされ、静かに壊れます。エディタでは気づけないので
`npm run check` で機械的に検出しています。

GitHubに上げると、pushのたびに同じチェックが自動で走ります
（`.github/workflows/verify.yml`）。

---

## 動作確認用の関数（外部APIを叩きません）

Apps Scriptエディタで実行してください。

| 関数 | 確認内容 |
|---|---|
| `testChannelAdapters()` | 全Adapterのインターフェース充足・設定状態・停止ステップ数 |
| `testChannelRouter()` | Etsyヴィンテージ判定（20年境界・年式不明） |
| `testListingGenerator()` | タイトル・説明文の生成 |
| `testInventoryStateMachine()` | 在庫登録 → 出品記録 → 売却 → 冪等性 → 要対応リスト |
| `checkConfig()` | どのキーが設定済みか一覧（秘密情報は末尾4文字のみ表示） |

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
秘密情報のPropertiesService隔離          完成

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
