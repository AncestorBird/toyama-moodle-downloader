# Toyama Moodle Downloader

富山大学の「Moodle 専門科目/その他」から、選んだ授業の資料をまとめてダウンロードするツールです。

**[アプリを開く →](https://ancestorbird.github.io/toyama-moodle-downloader/)**

ブラウザで使う場合、インストールは不要です。自分のMoodleアカウントでログインして使います。富山大学の公式ツールではありません。

対象のMoodle： https://moodle52.u-toyama.ac.jp/

## どちらを使う？

| やりたいこと | おすすめ |
| --- | --- |
| インストールせず、画面から授業を選んで取得したい | [Web版](#web版の使い方) |
| 取得済みの資料を省略したい／Web版の容量上限を超える資料を取得したい | [CLI版](#cli版の使い方pc向け)（ターミナルで実行） |

## Web版の使い方

1. **[アプリを開く](https://ancestorbird.github.io/toyama-moodle-downloader/)** → Moodleのユーザー名とパスワードでログインします。
2. 登録授業から、資料が必要な授業にチェックします。授業名・IDで検索できます。
3. **「選択した授業の資料を取得」**を押します。資料が授業ごとのフォルダに整理されたZIPで保存されます。

Chrome・Edgeなどの対応ブラウザでは、先にZIPの保存先を選び、取得しながらそのファイルへ書き込みます。同名の既存ファイルを選ぶと、完了時に置き換えます。それ以外のブラウザでは、ブラウザのダウンロード設定に従って保存します。

保存前に一覧だけ見たい場合は「まず取得予定の資料だけ確認する」を選んでください。取得中は「中止する」で止められます。

### パスワードを保存したい

ブラウザ標準のパスワードマネージャーを使います。

- 「このブラウザにパスワードを保存」が表示される場合は、チェックしてログインしてください。ログインと授業一覧の取得に成功した後で、ブラウザに保存を依頼します。
- チェック欄がない場合も、ブラウザの標準の保存案内・自動入力を利用できます。保存案内の有無は、ブラウザや設定によります。
- 変更・削除・同期は、ブラウザのパスワードマネージャーで管理してください。保存先のサイト名は、このアプリの公開ドメインです。Moodle本体に保存した項目とは別に扱われます。

### Web版の容量と対応範囲

1ファイル **50 MiB**、1回の資料合計 **1 GiB** までです。画面では「MB」「GB」と表示しています。成功した資料だけをZIPにまとめ、失敗した資料は画面に表示します。対応ブラウザではZIPを保存先へ順次書き込み、ブラウザ内にZIP全体をため込む負荷を避けています。通常ダウンロードを使うブラウザではZIPデータを保持するため、端末・ブラウザ設定によっては1 GiB未満でも保存領域の制約に当たる場合があります。その場合は授業を分けて取得してください。

対象は授業内容APIに掲載されたMoodle内のファイルです。外部サイト・ストリーミング動画・追加認証には対応していません。Web版は毎回新しいZIPを作成し、取得済みの資料も再度ダウンロードします。

## CLI版の使い方（PC向け）

CLI版は、PCのターミナルから実行するPythonプログラムです。変更のない取得済み資料を省略し、更新された資料は別名で保存します。手元の資料は上書き・削除しません。

### 1. 必要なものを用意する

- Python **3.11以降**
- 自分の富山大学Moodleアカウントとインターネット接続
- パスワードを保存する場合は、OSの保管庫（macOSのキーチェーン／Windowsの資格情報マネージャー／LinuxのSecret Service）

このリポジトリの **Code → Download ZIP** からダウンロードして展開するか、Gitでcloneします。以下のコマンドは、展開したフォルダをターミナルで開いて実行してください。

### 2. セットアップして実行する

**macOS / Linux**

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python tools/moodle_download.py
```

次回からは、同じフォルダで次の2行を実行します。

```sh
source .venv/bin/activate
python tools/moodle_download.py
```

macOSでは、セットアップ後に `Moodle資料取得.command` をダブルクリックする方法もあります。実行権限がない場合は、上のコマンドを使ってください。

**Windows（PowerShell）**

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe tools/moodle_download.py
```

次回からは、同じフォルダで最後の1行を実行します。この方法では仮想環境の有効化操作は不要です。

### 3. ログインして授業を選ぶ

1. 初回はユーザー名とパスワードを入力します。**入力中は文字も「●」も表示されません。** そのまま入力してEnterを押してください。
2. ログイン成功後、認証情報をOSの保管庫へ保存します。次回からは保存した情報を使います。
3. 表示された授業一覧からIDを入力します。複数なら `123,456` のように指定します。何も入力せずEnterを押すと終了します。
4. 資料は、このツールのフォルダ内の **`moodle_downloads/`** に保存されます。

```text
moodle_downloads/
  授業ID_授業名/
    セクションID_第1回/
      教材ID_配布資料/
        識別子_資料.pdf
```

同名の資料を区別するため、ファイル名の先頭に識別子が付きます。

### CLIでよく使う操作

以下は仮想環境を有効にした場合のコマンドです。Windowsでは、先頭の `python` を `.\.venv\Scripts\python.exe` に置き換えてください。

```sh
# ログインせず、Moodleへの接続と公開API設定だけ確認
python tools/moodle_download.py --check

# ログインと登録授業の一覧表示だけ行う
python tools/moodle_download.py --list

# 取得予定の資料を確認（保存しない）
python tools/moodle_download.py --dry-run

# 指定した授業の資料を取得（IDは自分の授業一覧で確認）
python tools/moodle_download.py --course 123 --course 456

# 保存先を変更
python tools/moodle_download.py --output /path/to/folder

# アカウント・パスワードを再入力し、成功後に保存し直す
python tools/moodle_download.py --login

# OSの保管庫に保存した認証情報を削除して終了（通信なし）
python tools/moodle_download.py --forget-login

# 保存情報を読み書きせず、今回だけ手入力で使う
python tools/moodle_download.py --no-save
```

保存先はOSの保管庫にある `toyama-moodle-downloader:https://moodle52.u-toyama.ac.jp` という専用項目です。保管庫が使えない場合は、平文保存へ切り替えずエラーにします。`--no-save` は既存の保存情報を削除しません。`--no-save` と `--check` は、`keyring` パッケージを導入せずに実行できます。

CLIの上限は **1ファイル250 MiB・1回の受信合計2 GiB** です。失敗したファイルの受信量も合計に含みます。ファイル取得120秒・取得処理全体30分を過ぎると中止を判定します。通信待ちの間は、ソケットのタイムアウト分だけ判定が遅れる場合があります。

保存先には本人専用のフォルダを使ってください。保存先配下のシンボリックリンク・Windowsのジャンクションは受け付けません。`--output` で指定した場所は、このリポジトリの `.gitignore` では保護されない場合があります。

## 困ったとき

| 状況 | 対処 |
| --- | --- |
| Web版でログインできない | ユーザー名・パスワードを確認し、大学のMoodleに直接ログインできるか確認してください。追加認証やAPIの利用制限が原因の場合もあります。 |
| 「埋め込み画面ではログインできません」と表示される | [公開ページ](https://ancestorbird.github.io/toyama-moodle-downloader/)をブラウザのタブで直接開いてください。 |
| 資料が出てこない | このツールは、授業内容APIに掲載されたファイルだけを取得します。外部リンクや一部の添付ファイルは対象外です。 |
| 容量上限に達する | 選ぶ授業を減らしてください。1ファイルがWeb版の上限を超える場合は、CLI版の上限も確認してください。 |
| CLIの入力中に何も表示されない | 正常です。ユーザー名・パスワードは非表示で入力されます。そのまま入力してEnterを押してください。 |
| CLIでOSの保管庫を使えない | 保管庫の設定を確認するか、`--no-save` を付けて今回だけ手入力してください。 |
| CLIで保存済みのパスワードを変更したい | `--login` を付けて再入力してください。保存済み情報が認証エラーになった場合も、対話環境では1回だけ再入力を求めます。 |

## 情報の扱いと安全性

- 認証情報・APIリクエストは、アプリから対象MoodleへHTTPSで直接送ります。認証情報や取得資料を、アプリ独自のサーバーやAIへ送信する処理はありません。
- Webの保存はブラウザのパスワードマネージャー、CLIの保存はOSの保管庫を使います。ソースコード・設定ファイルへ認証情報を書き込みません。
- APIトークンは実行中のメモリに保持します。Webではログアウト・再読み込みで破棄しますが、大学側のトークンは失効させません。発行されるトークン自体が読み取り専用とは限りません。
- 取得資料・履歴は暗号化せずPCに保存されます。同期フォルダに置くと、そのサービスにもコピーされる場合があります。
- パスワード・トークン・取得した授業資料をGitHubへ追加したり、Issueへ貼ったりしないでください。共有するのはコードだけにしてください。

配信ヘッダーの制約、同じ公開ドメインでの保存パスワードの扱い、実装した対策と検証範囲は **[SECURITY.md](SECURITY.md)** にまとめています。Web版はGitHub Pagesから配信されるため、通常のページアクセス情報はGitHubにも送られます。外部のアクセス解析は使用しません。

## 開発・自分のリポジトリで公開する

利用するだけなら、この節の作業は不要です。

### ローカル開発とテスト

Web版にはNode.js **22.12以降** が必要です。CLI版のテストにはPython **3.11以降**を使います。

```sh
npm ci
npm run dev
```

起動時に表示されるURLをブラウザで開きます。テストは別のターミナルから実行してください。

```sh
# Web単体テスト
npm test

# ブラウザテスト
npx playwright install chromium
npm run test:e2e

# CLIテスト
python -m unittest discover -s tools -p 'test_moodle_download.py' -v

# 公開用ファイルをdist/に生成
npm run build
```

自動テストは模擬API・ダミー認証情報を使い、実アカウントや実際のOS保管庫にはアクセスしません。GitHub ActionsではWeb・ブラウザのテストと、Linux・macOS・WindowsのCLIテストを実行します。ブラウザの実際のパスワード保存・自動入力は、利用するブラウザで別途確認してください。

Web版は、利用者本人の実アカウントでログイン・資料取得を動作確認済みです。Moodle側のブラウザ接続許可（CORS）に依存するため、大学側の設定変更や追加認証によって利用できなくなる場合があります。

### GitHub Pagesへ公開する

1. 自分のリポジトリで **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。
2. `main` に変更を反映すると、`.github/workflows/pages.yml` がテスト・ビルドを実行します。Actionsの **Test and publish GitHub Pages → Run workflow** からも実行できます。
3. すべてのテストと `deploy` ジョブの成功後、GitHub Pagesの設定に表示されるURLを開きます。フォークや独自ドメインでは、このREADMEの公開URLも自分のURLへ変更してください。

利用者は各自のアカウントでログインするため、Moodleの認証情報をGitHub Secretsへ登録する必要はありません。閲覧時に依存パッケージを外部CDNから読み込む構成にはしていません。

## 仕様の確認元

- [Moodle公式の認証API説明](https://docs.moodle.org/dev/Creating_a_web_service_client)
- [Moodle公式のファイル取得処理](https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/webservice/pluginfile.php)
- [keyring公式の保管方式・セキュリティ上の注意](https://keyring.readthedocs.io/en/latest/#security-considerations)
