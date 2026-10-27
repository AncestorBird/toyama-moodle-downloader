#!/usr/bin/env python3
"""富山大学Moodleの公式APIで授業資料を取得する。認証情報はOSの保管庫に保存。"""

import argparse
import getpass
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings

from safe_output import Directory


SITE = "https://moodle52.u-toyama.ac.jp"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "moodle_downloads"
KEYRING_SERVICE = "toyama-moodle-downloader:https://moodle52.u-toyama.ac.jp"
KEYRING_ACCOUNT = "default"
MAX_FILE_BYTES = 250 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILE_SECONDS = 120
MAX_TOTAL_SECONDS = 30 * 60


class TransferBudget:
    def __init__(self):
        self.received = 0
        self.deadline = time.monotonic() + MAX_TOTAL_SECONDS

    def check(self):
        if time.monotonic() >= self.deadline:
            raise MoodleError("取得全体の制限時間（30分）を超えました。授業を分けて取得してください。")

    def consume(self, size):
        self.received += size
        self.check()
        if self.received > MAX_TOTAL_BYTES:
            raise MoodleError("受信合計が2 GiBの上限を超えました。授業を分けて取得してください。")


def bounded_chunks(response, limit, deadline, on_chunk=lambda size: None):
    """read1 returns after one socket read, so trickling cannot reset the deadline."""
    received = 0
    read = getattr(response, "read1", response.read)
    while True:
        if time.monotonic() >= deadline:
            raise MoodleError("応答の制限時間を超えたため取得を中止しました。")
        chunk = read(min(65536, limit - received + 1))
        if chunk:
            on_chunk(len(chunk))
        if time.monotonic() >= deadline:
            raise MoodleError("応答の制限時間を超えたため取得を中止しました。")
        if not chunk:
            return
        received += len(chunk)
        if received > limit:
            raise MoodleError("応答サイズが上限または宣言サイズを超えたため中止しました。")
        yield chunk


READ_FUNCTIONS = {
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_course_get_contents",
}


class MoodleError(Exception):
    pass


class MoodleAPIError(MoodleError):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


class CredentialStore:
    """ツール専用の1項目にアカウント名とパスワードをまとめて保管する。"""

    def __init__(self):
        try:
            import keyring
        except ImportError:
            raise MoodleError(
                "認証情報の保存にはkeyringが必要です。READMEのセットアップ手順を実行するか、"
                "保存しない場合は --no-save を指定してください。"
            ) from None
        try:
            self.backend = keyring.get_keyring()
            # keyrings.altなどの平文ファイルへの保存先は受け付けない。
            allowed = {
                "darwin": {("keyring.backends.macOS", "Keyring")},
                "win32": {("keyring.backends.Windows", "WinVaultKeyring")},
            }.get(sys.platform, {("keyring.backends.SecretService", "Keyring")})
            kind = (type(self.backend).__module__, type(self.backend).__name__)
            if kind not in allowed:
                raise ValueError("unsupported backend")
        except Exception:
            raise MoodleError(
                "OSの認証情報保管庫を利用できません。平文ファイルには保存しません。"
                "保管庫の設定を確認するか --no-save を指定してください。"
            ) from None

    def load(self):
        try:
            raw = self.backend.get_password(KEYRING_SERVICE, KEYRING_ACCOUNT)
            if raw is None:
                return None
            data = json.loads(raw)
            if (not isinstance(data, dict) or data.get("version") != 1
                    or not isinstance(data.get("username"), str) or not data["username"].strip()
                    or not isinstance(data.get("password"), str) or not data["password"]):
                raise ValueError("invalid credential record")
            return data["username"], data["password"]
        except Exception:
            raise MoodleError(
                "保存済みの認証情報を読み出せません。--login で再登録するか --no-save を指定してください。"
            ) from None

    def save(self, username, password):
        try:
            self.backend.set_password(KEYRING_SERVICE, KEYRING_ACCOUNT, json.dumps({
                "version": 1, "username": username, "password": password,
            }, ensure_ascii=False))
        except Exception:
            raise MoodleError("OSの保管庫への保存に失敗しました。認証情報をファイルには保存していません。") from None

    def forget(self):
        try:
            if self.backend.get_password(KEYRING_SERVICE, KEYRING_ACCOUNT) is None:
                return False
            self.backend.delete_password(KEYRING_SERVICE, KEYRING_ACCOUNT)
            return True
        except Exception:
            raise MoodleError("保存済みの認証情報を削除できませんでした。OSの保管庫を確認してください。") from None


def prompt_credentials():
    if not sys.stdin.isatty():
        raise MoodleError("初回ログイン・再入力は手元のターミナルで実行してください。")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            username = getpass.getpass("Moodleのユーザー名（入力は非表示）: ").strip()
            if not username:
                raise MoodleError("ユーザー名が未入力です。")
            password = getpass.getpass("Moodleのパスワード（入力は非表示）: ")
        except getpass.GetPassWarning:
            raise MoodleError("ユーザー名・パスワードを非表示にできるターミナルで実行してください。") from None
    if not password:
        raise MoodleError("パスワードが未入力です。")
    return username, password


def authenticate(client, args):
    store = None if args.no_save else CredentialStore()
    saved = None if store is None or args.login else store.load()
    if saved:
        print("保存済みのアカウントでログインします。")
        username, password = saved
    else:
        print("ユーザー名・パスワードの入力は非表示です。" + (
            "認証情報は保存しません。" if store is None
            else "ログイン成功後、アカウント名とパスワードをOSの保管庫に保存します。"
        ))
        username, password = prompt_credentials()
    try:
        try:
            client.login(username, password)
            info = client.call("core_webservice_get_site_info")
        except MoodleAPIError as exc:
            # 保存したパスワードが変わった場合のみ、対話環境で1回だけ再入力する。
            # 通信エラー・API権限エラーでは認証情報を消したり再送したりしない。
            if not saved or exc.code != "invalidlogin" or not sys.stdin.isatty():
                raise
            saved = None
            print("保存済みの認証情報ではログインできませんでした。新しい情報を入力してください。")
            username, password = prompt_credentials()
            client.login(username, password)
            info = client.call("core_webservice_get_site_info")
        if store is not None and not saved:
            try:
                store.save(username, password)
                print("アカウント名とパスワードをOSの保管庫に保存しました。次回から入力を省略します。")
            except MoodleError as exc:
                print("注意:", exc, "今回はログインできましたが、次回は再入力が必要です。", file=sys.stderr)
        return info
    finally:
        # Pythonのメモリを完全消去する保証はない。プロセス終了時まで平文を必要以上に保持しない。
        del username, password, saved


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
            raw = b"".join(bounded_chunks(response, 8 * 1024 * 1024, time.monotonic() + 45))
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
            raise MoodleAPIError(f"Moodle APIエラー: {code}。" + hints.get(code, "アカウントのAPI権限や追加認証を確認してください。"), code)
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
        if {"wstoken", "wsfunction", "moodlewsrestformat"}.intersection(params):
            raise MoodleError("APIの予約パラメーターは指定できません。")
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
    text = html.unescape(re.sub(r"<[^<>]*>", "", str(value)))
    text = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", text).strip(" .")
    # 日本語のファイル名でもファイルシステムの1要素の制限内にする。
    return text.encode("utf-8")[:160].decode("utf-8", errors="ignore").rstrip(" .") or "名称なし"


def require_id(value):
    if type(value) is not int or not 0 < value <= 2**53 - 1:
        raise MoodleError("資料のIDが正しくありません。")


def material_files(course, sections):
    require_id(course["id"])
    for section in sections:
        require_id(section["id"])
        for module in section.get("modules", []):
            require_id(module["id"])
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


def stream_digest(stream):
    digest = hashlib.sha256()
    for chunk in bounded_chunks(stream, MAX_FILE_BYTES, time.monotonic() + MAX_FILE_SECONDS):
        digest.update(chunk)
    return digest.hexdigest()


def sha256(path):
    with Directory(path.parent) as directory, directory.open_read(path.name) as stream:
        return stream_digest(stream)


def write_json(path, value):
    with Directory(path.parent) as directory, directory.temporary() as (name, stream):
        stream.write((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        stream.close()
        if not directory.is_current():
            raise MoodleError("保存先が変更されたため中止しました。")
        directory.replace(name, path.name)


def declared_size(item):
    value = item.get("filesize")
    if value is None:
        return None
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,16}", value):
        return int(value)
    raise MoodleError("資料のファイルサイズが正しくありません。")


def download(client, item, destination, old, *, budget=None):
    budget = budget or TransferBudget()
    budget.check()
    stamp = {"timemodified": item.get("timemodified"), "filesize": item.get("filesize")}
    previous = Path(old["path"]) if old and old.get("path") else destination
    if old and stamp == {k: old.get(k) for k in stamp}:
        try:
            if sha256(previous) == old.get("sha256"):
                return old, "skip"
        except FileNotFoundError:
            pass
    size = declared_size(item)
    limit = min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - budget.received)
    if size is not None:
        if size > limit:
            raise MoodleError("資料が容量上限（1ファイル250 MiB・受信合計2 GiB）を超えます。")
        limit = min(limit, size)
    deadline = min(time.monotonic() + MAX_FILE_SECONDS, budget.deadline)
    # Pin directories before the request: a concurrent symlink replacement must
    # never redirect temporary files or final links into another directory.
    with Directory(destination.parent, create=True) as directory:
        with directory.temporary() as (temporary, stream), client.file_response(item["fileurl"]) as response:
            header_size = response.headers.get("Content-Length")
            if header_size and (not re.fullmatch(r"[0-9]{1,16}", header_size) or int(header_size) > limit):
                raise MoodleError("応答サイズが容量上限または宣言サイズを超えています。")
            media_type = response.headers.get_content_type()
            if media_type == "text/html" and not str(item.get("mimetype", "")).startswith("text/html"):
                raise MoodleError("資料の代わりにHTMLページが返りました。")
            digest = hashlib.sha256()
            received = 0
            prefix = bytearray()
            for chunk in bounded_chunks(response, limit, deadline, budget.consume):
                if len(prefix) < 65536:
                    prefix.extend(chunk[:65536 - len(prefix)])
                received += len(chunk)
                digest.update(chunk)
                stream.write(chunk)
            stream.close()
            try:
                error = json.loads(prefix)
            except (ValueError, UnicodeError):
                error = None
            if isinstance(error, dict) and error.get("errorcode") and (error.get("exception") or error.get("message")):
                raise MoodleError("資料の取得時にMoodleからAPIエラーが返りました。")
            if size is not None and received != size:
                raise MoodleError("ファイルサイズが一致しないため保存を中止しました。")
            if not directory.is_current():
                raise MoodleError("保存先が変更されたため中止しました。")
            digest = digest.hexdigest()
            target = destination
            counter = 1
            while True:
                try:
                    directory.link(temporary, target.name)
                    break
                except FileExistsError:
                    try:
                        with directory.open_read(target.name) as existing:
                            if stream_digest(existing) == digest:
                                break
                    except (OSError, MoodleError):
                        pass
                    suffix = "" if counter == 1 else f"_{counter}"
                    target = destination.with_name(destination.stem + f"_{digest[:12]}{suffix}" + destination.suffix)
                    counter += 1
                    if counter > 1000:
                        raise MoodleError("同名ファイルが多すぎるため保存を中止しました。")
            return {**stamp, "sha256": digest, "path": str(target)}, "saved"


def run(args):
    if args.forget_login:
        removed = CredentialStore().forget()
        print("保存済みのアカウント名とパスワードを削除しました。" if removed else "保存済みの認証情報はありません。")
        print("大学側のAPIトークンは失効させません。")
        return 0
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
    info = authenticate(client, args)
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
            with Directory(root) as directory, directory.open_read(manifest_path.name) as stream:
                raw = stream.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError
            manifest = json.loads(raw)
            if not isinstance(manifest, dict):
                raise ValueError
        except (ValueError, UnicodeError):
            raise MoodleError("取得履歴が壊れています。.manifest.jsonを別名に退避して再実行してください。") from None
    counts = {"saved": 0, "skip": 0, "failed": 0, "preview": 0}
    budget = TransferBudget()
    for course in selected:
        budget.check()
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
            if previous is not None and not isinstance(previous, dict):
                raise MoodleError("取得履歴の項目が正しくありません。")
            destination = root / relative
            # 手動改変された履歴やシンボリックリンクで保存先の外に出ない。
            paths = [destination]
            if previous and previous.get("path"):
                paths.append(Path(previous["path"]))
            if any(not p.resolve().is_relative_to(root) for p in paths):
                raise MoodleError("保存先の外を指すパスがあるため中止しました。")
            try:
                entry, status = download(client, item, destination, previous, budget=budget)
                manifest[key] = entry
                write_json(manifest_path, manifest)
                counts[status] += 1
                print("  [保存]" if status == "saved" else "  [取得済み]", clean_name(item["filename"]))
            except (MoodleError, OSError) as exc:
                counts["failed"] += 1
                message = str(exc) if isinstance(exc, MoodleError) else "ファイルの保存・通信に失敗しました。"
                print("  [失敗]", clean_name(item["filename"]), message)
                budget.check()
                if budget.received >= MAX_TOTAL_BYTES:
                    raise MoodleError("受信合計が2 GiBの上限に達したため中止しました。")
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
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--login", action="store_true", help="認証情報を再入力し、ログイン成功後に保存し直す")
    auth.add_argument("--no-save", action="store_true", help="保存情報を読み書きせず、今回だけ手入力する")
    auth.add_argument("--forget-login", action="store_true", help="保存済みの認証情報を削除して終了（通信なし）")
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
