# Toyama Moodle Downloader

富山大学の「Moodle 専門科目/その他」から、選択した授業の資料を取得するツールです。ブラウザを起動せず、Moodle公式のモバイルAPIを使います。

対象サイト: https://moodle52.u-toyama.ac.jp/

大学が提供する公式ツールではありません。利用者自身のMoodleアカウントでアクセスでき、授業内容APIに掲載される資料が対象です。

## 必要なもの

- Python 3.11以降（追加パッケージは不要です）
- 富山大学Moodleのユーザー名・パスワード
- インターネット接続

有料のAI APIやクラウドサービスは使いません。毎回ログインする対話式のツールで、認証情報の保存・定期実行は行いません。

## ダウンロードと実行

このリポジトリをGitでcloneするか、GitHubの「Code → Download ZIP」で取得し、ZIPの場合は展開します。

### macOS

`Moodle資料取得.command` をダブルクリックします。実行権限がない場合やPythonが見つからない場合は、下記のターミナル用コマンドを使ってください。

### Windows / Linux / macOSのターミナル

ターミナルでこのフォルダに移動して実行します。

```sh
python3 tools/moodle_download.py
```

Windowsでは、環境に応じて `python3` の代わりに `py -3` または `python` を使います。

1. Moodleのユーザー名とパスワードを手元のターミナルに入力します。パスワードは入力中も表示されません。
2. 登録している授業のID・授業名が表示されます。
3. 取得する授業のIDを入力します。複数なら `123,456` のように指定します。
4. 資料を `moodle_downloads/` に保存します。IDを入力せずEnterを押すと、取得せずに終了します。

保存例:

```text
moodle_downloads/
  授業ID_授業名/
    セクションID_第1回/
      教材ID_配布資料/
        識別子_資料.pdf
```

同名資料を区別するため、ファイル名の先頭に識別子を付けます。変更のない取得済み資料は省略し、更新された資料は別名で保存します。手元のファイルは上書き・削除しません。

## 最初に接続・授業一覧だけ試す

```sh
# ログインせず、Moodleへの接続とAPI設定だけ確認
python3 tools/moodle_download.py --check

# ログインと登録授業一覧だけ確認
python3 tools/moodle_download.py --list

# 取得予定の資料一覧だけ確認（ファイルを保存しません）
python3 tools/moodle_download.py --dry-run

# 指定した授業の資料を取得（IDは自分の授業一覧で確認）
python3 tools/moodle_download.py --course 123

# 複数授業を指定
python3 tools/moodle_download.py --course 123 --course 456
```

保存先を変える場合は `--output /path/to/folder` を指定できます。独自の保存先はこのリポジトリの `.gitignore` では保護されない場合があるため、共有するコードとは別の場所を指定してください。

## 情報の扱い

- ユーザー名・パスワードは `https://moodle52.u-toyama.ac.jp/login/token.php` にHTTPSのPOSTで送信します。
- パスワードと取得したAPIトークンはファイルに保存しません。トークンをURLにも入れません。
- 通信先は上記のMoodleに限定し、別URLへの転送は行いません。資料をAIや他の外部サービスに送る処理はありません。
- このプログラムが呼び出すAPIは、サイト情報・本人の登録授業・授業内容の取得に限定しています。課題提出や履修登録、成績変更の操作はありません。
- ただし、発行されるモバイルAPIトークン自体が読み取り専用とは限りません。終了時に大学側のトークンを失効させる処理はありません。
- Moodle側には認証トークンやアクセスログが残る可能性があります。
- 取得資料と履歴は暗号化せず手元に保存します。iCloudなどの同期対象フォルダに置くと、そのサービスにもコピーされる可能性があります。
- 標準の保存先 `moodle_downloads/`、`.env`、一般的な認証情報ファイルはGitから除外しています。除外設定は暗号化やアクセス制御ではなく、強制的なGit追加や別サービスへの共有は防げません。
- プログラムを共有する際はコードだけを渡し、利用者はそれぞれ自分のアカウントで実行してください。パスワード・トークン・取得した授業資料をGitHubのIssueなどに貼らないでください。

## 対応範囲と制限

- 授業内容APIに掲載された、Moodle内のファイルを取得します。
- 外部サイト、ストリーミング動画、APIに掲載されない添付ファイルなどは対象外です。授業ページ全体を保存するものではありません。
- 他の富山大学Moodleサイトや、他大学のサイトは現在の対象外です。
- アカウントの権限や追加認証によってAPIを利用できない場合は、エラーを表示して終了します。認証失敗の自動再試行はしません。
- このMacで公開設定への実接続と模擬テストを確認しています。実アカウントのログイン・資料取得、Windows/Linuxでの実行は共有版作成時点で未検証です。

## テスト

外部通信・実際の認証情報を使わずに実行できます。

```sh
python3 -m unittest discover -s tools -p 'test_moodle_download.py' -v
```

## 仕様の確認元

- [Moodle公式の認証API説明](https://docs.moodle.org/dev/Creating_a_web_service_client)
- [Moodle公式のファイル取得処理](https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/webservice/pluginfile.php)
