#!/usr/bin/env python3
"""富山大学Moodleの公式APIで授業資料を取得する。Python標準ライブラリのみ。"""

import argparse
import getpass
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import warnings


SITE = "https://moodle52.u-toyama.ac.jp"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "moodle_downloads"
READ_FUNCTIONS = {
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_course_get_contents",
}


class MoodleError(Exception):
    pass


def validate_url(url):
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != "https" or parts.hostname != "moodle52.u-toyama.ac.jp"
            or parts.port not in (None, 443) or parts.username or parts.password):
        raise MoodleError("取得先が対象のMoodle以外のため中止しました。")
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 認証情報を別URLに送らず、SSOなどは明示的なエラーとして扱う。
        raise MoodleError("別URLへの転送が要求されました。この取得方法では対応していません。")


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect())
        self.token = None

    def open(self, url, params, *, json_body=False):
        validate_url(url)
        data = (json.dumps(params).encode() if json_body
                else urllib.parse.urlencode(params).encode())
        req = urllib.request.Request(url, data=data, headers={
            "Content-Type": "application/json" if json_body else "application/x-www-form-urlencoded",
            "User-Agent": "ToyamaMoodleMaterials/1.0",
        })
        try:
            return self.opener.open(req, timeout=45)
        except urllib.error.HTTPError as exc:
            raise MoodleError(f"MoodleからHTTP {exc.code}が返りました。") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            # 例外にURLや認証情報が含まれる可能性があるため、そのまま表示しない。
            raise MoodleError("Moodleとの通信に失敗しました。ネット接続・証明書を確認してください。") from None

    def json(self, url, params, *, json_body=False):
        with self.open(url, params, json_body=json_body) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise MoodleError("API応答が上限サイズを超えました。")
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            raise MoodleError("APIからJSON以外の応答が返りました。") from None
        if isinstance(data, dict) and (data.get("exception") or data.get("errorcode") or data.get("error")):
            code = str(data.get("errorcode", "apierror"))
            code = re.sub(r"[^a-zA-Z0-9_-]", "", code)[:80]
            hints = {
                "invalidlogin": "ユーザー名またはパスワードを確認してください。",
                "invalidtoken": "認証が無効です。再起動してログインし直してください。",
                "requirecorrectaccess": "このアカウントではAPIを利用できません。",
                "servicenotavailable": "このアカウントではモバイルAPIを利用できません。",
                "forcepasswordchangenotice": "大学のサイトでパスワード変更が必要です。",
            }
            raise MoodleError(f"Moodle APIエラー: {code}。" + hints.get(code, "アカウントのAPI権限や追加認証を確認してください。"))
        return data

    def public_config(self):
        result = self.json(SITE + "/lib/ajax/service.php?info=tool_mobile_get_public_config", [
            {"index": 0, "methodname": "tool_mobile_get_public_config", "args": {}}
        ], json_body=True)
        if not isinstance(result, list) or not result or result[0].get("error"):
            raise MoodleError("公開設定を取得できませんでした。")
        return result[0]["data"]

    def login(self, username, password):
        result = self.json(SITE + "/login/token.php", {
            "username": username, "password": password, "service": "moodle_mobile_app",
        })
        if not isinstance(result, dict) or not result.get("token"):
            raise MoodleError("認証トークンを取得できませんでした。追加認証が必要な可能性があります。")
        self.token = result["token"]

    def call(self, function, **params):
        if function not in READ_FUNCTIONS:
            raise MoodleError("このツールは指定された読み取り用APIのみ実行できます。")
        if not self.token:
            raise MoodleError("ログインが必要です。")
        return self.json(SITE + "/webservice/rest/server.php", {
            "wstoken": self.token, "wsfunction": function,
            "moodlewsrestformat": "json", **params,
        })

    def file_response(self, url):
        validate_url(url)
        parts = urllib.parse.urlsplit(url)
        path = parts.path
        if path.startswith("/pluginfile.php"):
            path = "/webservice" + path
        if not (path == "/webservice/pluginfile.php" or path.startswith("/webservice/pluginfile.php/")):
            raise MoodleError("対応していないファイル取得URLです。")
        query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query) if k not in ("token", "wstoken")]
        url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, urllib.parse.urlencode(query), ""))
        # Moodleのrequired_paramはPOSTにも対応。トークンをURLや履歴に入れない。
        return self.open(url, {"token": self.token, "forcedownload": 1})


def clean_name(value):
    text = html.unescape(re.sub(r"<[^>]*>", "", str(value)))
    text = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", text).strip(" .")
    # 日本語のファイル名でもファイルシステムの1要素の制限内にする。
    while len(text.encode("utf-8")) > 160:
        text = text[:-1]
    return text or "名称なし"


def material_files(course, sections):
    for section in sections:
        for module in section.get("modules", []):
            if module.get("uservisible") is False:
                continue
            for item in module.get("contents", []):
                if item.get("type") != "file" or not item.get("fileurl"):
                    continue
                # Moodle内のファイルのみ。外部リンク先へ認証情報を送らない。
                try:
                    validate_url(item["fileurl"])
                except MoodleError:
                    continue
                remote_path = item.get("filepath", "/")
                identity = json.dumps([course["id"], module["id"], remote_path, item["filename"]], ensure_ascii=False)
                key = hashlib.sha256(identity.encode()).hexdigest()[:16]
                relative = (Path(f'{course["id"]}_{clean_name(course["fullname"])}')
                            / f'{section["id"]}_{clean_name(section.get("name", "資料"))}'
                            / f'{module["id"]}_{clean_name(module["name"])}'
                            / f'{key}_{clean_name(item["filename"])}')
                yield item, relative


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    # 途中終了で履歴を壊さないよう、同じディレクトリの一時ファイルから置き換える。
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as f:
        temporary = Path(f.name)
        try:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write("\n")
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def download(client, item, destination, old):
    stamp = {"timemodified": item.get("timemodified"), "filesize": item.get("filesize")}
    previous = Path(old["path"]) if old and old.get("path") else destination
    if (old and stamp == {k: old.get(k) for k in stamp} and previous.is_file()
            and not previous.is_symlink() and sha256(previous) == old.get("sha256")):
        return old, "skip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with client.file_response(item["fileurl"]) as response:
            first = response.read(65536)
            # ログインページやAPIエラーを資料ファイルとして保存しない。
            media_type = response.headers.get_content_type()
            if media_type == "text/html" and not str(item.get("mimetype", "")).startswith("text/html"):
                raise MoodleError("資料の代わりにHTMLページが返りました。")
            try:
                error = json.loads(first)
            except (ValueError, UnicodeError):
                error = None
            if isinstance(error, dict) and error.get("errorcode") and (error.get("exception") or error.get("message")):
                raise MoodleError("資料の取得時にMoodleからAPIエラーが返りました。")
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as f:
                temporary = Path(f.name)
                f.write(first)
                shutil.copyfileobj(response, f)
        if item.get("filesize") is not None and temporary.stat().st_size != int(item["filesize"]):
            raise MoodleError("ファイルサイズが一致しないため保存を中止しました。")
        digest = sha256(temporary)
        # 既存のファイル（手元で編集したファイルを含む）を上書きしない。
        target = destination
        if target.exists() or target.is_symlink():
            target = destination.with_name(destination.stem + "_" + digest[:12] + destination.suffix)
        counter = 2
        while True:
            try:
                os.link(temporary, target)
                break
            except FileExistsError:
                if target.is_file() and not target.is_symlink() and sha256(target) == digest:
                    break
                target = destination.with_name(destination.stem + f"_{digest[:12]}_{counter}" + destination.suffix)
                counter += 1
        return {**stamp, "sha256": digest, "path": str(target)}, "saved"
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run(args):
    client = Client()
    config = client.public_config()
    print("接続先:", config["sitename"])
    print("Web API:", "有効" if config.get("enablewebservices") else "無効")
    print("モバイルAPI:", "有効" if config.get("enablemobilewebservice") else "無効")
    if args.check:
        return 0
    if not config.get("enablemobilewebservice"):
        raise MoodleError("このサイトではモバイルAPIが無効です。")
    print("認証情報の送信先: " + SITE + " （HTTPS）")
    print("パスワードは画面に表示せず、パスワード・トークンをファイルに保存しません。")
    if not sys.stdin.isatty():
        raise MoodleError("ログインは手元のターミナルで実行してください。")
    username = input("Moodleのユーザー名: ").strip()
    if not username:
        raise MoodleError("ユーザー名が未入力です。")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            password = getpass.getpass("Moodleのパスワード（入力は非表示）: ")
        except getpass.GetPassWarning:
            raise MoodleError("パスワードを非表示にできるターミナルで実行してください。") from None
    if not password:
        raise MoodleError("パスワードが未入力です。")
    try:
        client.login(username, password)
    finally:
        del password
    info = client.call("core_webservice_get_site_info")
    courses = client.call("core_enrol_get_users_courses", userid=info["userid"])
    courses.sort(key=lambda c: (c.get("startdate", 0), c["id"]), reverse=True)
    print(f"\nログイン成功。登録授業: {len(courses)}件")
    for course in courses:
        print(f'  ID {course["id"]}: {clean_name(course["fullname"])}')
    if args.list or not courses:
        return 0
    ids = args.course
    if not ids:
        raw = input("\n取得する授業のID（複数はカンマ区切り、Enterで終了）: ").strip()
        if not raw:
            print("資料を取得せず終了しました。")
            return 0
        try:
            ids = [int(v) for v in re.split(r"[,、\s]+", raw) if v]
        except ValueError:
            raise MoodleError("授業のIDを数字で指定してください。") from None
    selected = [c for c in courses if c["id"] in ids]
    if set(ids) - {c["id"] for c in selected}:
        raise MoodleError("登録授業一覧にないIDが含まれています。")
    root = args.output.expanduser().resolve()
    if not args.dry_run:
        root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / ".manifest.json"
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(manifest, dict):
                raise ValueError
        except (ValueError, UnicodeError):
            raise MoodleError("取得履歴が壊れています。.manifest.jsonを別名に退避して再実行してください。") from None
    counts = {"saved": 0, "skip": 0, "failed": 0, "preview": 0}
    for course in selected:
        sections = client.call("core_course_get_contents", courseid=course["id"])
        files = list(material_files(course, sections))
        print(f'\n{clean_name(course["fullname"])}: 取得可能な資料 {len(files)}件')
        for item, relative in files:
            if args.dry_run:
                print("  [取得予定]", relative)
                counts["preview"] += 1
                continue
            key = str(relative)
            previous = manifest.get(key)
            destination = root / relative
            # 手動改変された履歴やシンボリックリンクで保存先の外に出ない。
            paths = [destination]
            if previous and previous.get("path"):
                paths.append(Path(previous["path"]))
            if any(not p.resolve().is_relative_to(root) for p in paths):
                raise MoodleError("保存先の外を指すパスがあるため中止しました。")
            try:
                entry, status = download(client, item, destination, previous)
                manifest[key] = entry
                write_json(manifest_path, manifest)
                counts[status] += 1
                print("  [保存]" if status == "saved" else "  [取得済み]", clean_name(item["filename"]))
            except (MoodleError, OSError) as exc:
                counts["failed"] += 1
                message = str(exc) if isinstance(exc, MoodleError) else "ファイルの保存・通信に失敗しました。"
                print("  [失敗]", clean_name(item["filename"]), message)
    print(f'\n完了: 保存 {counts["saved"]}件 / 取得済み {counts["skip"]}件 / 失敗 {counts["failed"]}件 / 取得予定 {counts["preview"]}件')
    if not args.dry_run:
        print("保存先:", root)
    return 1 if counts["failed"] else 0


def main():
    if sys.version_info < (3, 11):
        print("Python 3.11以降で実行してください。", file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="公開設定だけ確認（ログイン不要）")
    parser.add_argument("--list", action="store_true", help="ログインと授業一覧取得のみ")
    parser.add_argument("--course", type=int, action="append", help="取得する授業ID（繰り返し指定可）")
    parser.add_argument("--dry-run", action="store_true", help="資料一覧のみ確認し、保存しない")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="保存先")
    args = parser.parse_args()
    # ダウンロードした資料は本人だけが読める権限で作成。
    os.umask(0o077)
    try:
        return run(args)
    except (KeyboardInterrupt, EOFError):
        print("\n終了しました。")
        return 130
    except MoodleError as exc:
        print("エラー:", exc, file=sys.stderr)
        return 1
    except OSError:
        print("エラー: ファイル操作または通信に失敗しました。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
