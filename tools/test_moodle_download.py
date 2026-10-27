"""実際の認証情報・外部通信を使わず、取得と保全を検証する。"""

import argparse
from contextlib import redirect_stdout
from email.message import Message
import io
import json
import os
import subprocess
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import urllib.parse

import moodle_download as moodle


class Response(io.BytesIO):
    def __init__(self, data, media_type="application/pdf"):
        super().__init__(data)
        self.headers = Message()
        self.headers["Content-Type"] = media_type


class FakeClient:
    content = b"%PDF-1.4\nlecture material\n"
    modified = 100
    reads = 0

    def public_config(self):
        return {"sitename": "テスト授業", "enablewebservices": 1, "enablemobilewebservice": 1}

    def login(self, username, password):
        assert username == "test-user" and password == "test-password"

    def call(self, function, **params):
        if function == "core_webservice_get_site_info":
            return {"userid": 10}
        if function == "core_enrol_get_users_courses":
            assert params == {"userid": 10}
            return [{"id": 123, "fullname": "授業テスト", "startdate": 1}]
        assert function == "core_course_get_contents" and params == {"courseid": 123}
        return [{"id": 2, "name": "第1回", "modules": [{
            "id": 3, "name": "配布資料", "contents": [{
                "type": "file", "filename": "資料.pdf", "filepath": "/",
                "fileurl": moodle.SITE + "/webservice/pluginfile.php/1/mod_resource/content/1/file.pdf",
                "filesize": len(type(self).content), "timemodified": type(self).modified,
                "mimetype": "application/pdf",
            }],
        }]}]

    def file_response(self, url):
        type(self).reads += 1
        return Response(type(self).content)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        FakeClient.content = b"%PDF-1.4\nlecture material\n"
        FakeClient.modified = 100
        FakeClient.reads = 0

    def run_tool(self, output, **kwargs):
        args = argparse.Namespace(check=False, list=False, course=[123], dry_run=False, output=output,
                                  no_save=True, login=False, forget_login=False)
        for key, value in kwargs.items():
            setattr(args, key, value)
        with (patch.object(moodle, "Client", FakeClient),
              patch("builtins.input", side_effect=AssertionError("credentials must not use visible input")),
              patch.object(moodle.getpass, "getpass", side_effect=["test-user", "test-password"]),
              patch.object(moodle.sys.stdin, "isatty", return_value=True),
              redirect_stdout(io.StringIO()) as log):
            result = moodle.run(args)
        self.assertNotIn("test-password", log.getvalue())
        self.assertNotIn("test-user", log.getvalue())
        return result

    def test_download_skip_update_and_preserve_local_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            self.assertEqual(self.run_tool(root), 0)
            original = next(root.rglob("*.pdf"))
            original_bytes = original.read_bytes()
            self.assertEqual(self.run_tool(root), 0)
            self.assertEqual(FakeClient.reads, 1)
            FakeClient.content = b"%PDF-1.4\nupdated lecture\n"
            FakeClient.modified = 200
            self.assertEqual(self.run_tool(root), 0)
            self.assertEqual(original.read_bytes(), original_bytes)
            self.assertEqual(len(list(root.rglob("*.pdf"))), 2)
            self.assertEqual(self.run_tool(root), 0)
            self.assertEqual(FakeClient.reads, 2)
            manifest = json.loads((root / ".manifest.json").read_text(encoding="utf-8"))
            latest = Path(next(iter(manifest.values()))["path"])
            latest.write_bytes(b"my local edits")
            self.assertEqual(self.run_tool(root), 0)
            self.assertEqual(latest.read_bytes(), b"my local edits")
            self.assertEqual(len(list(root.rglob("*.pdf"))), 3)
            self.assertNotIn("test-password", (root / ".manifest.json").read_text(encoding="utf-8"))

    def test_preview_does_not_write_files(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder).resolve() / "new"
            self.assertEqual(self.run_tool(output, dry_run=True), 0)
            self.assertFalse(output.exists())
            self.assertEqual(FakeClient.reads, 0)

    def test_html_or_api_error_or_truncation_is_not_saved(self):
        for body, media_type in [(b"<html>Login</html>", "text/html"),
                                 (b'{"exception":"error","errorcode":"invalidtoken"}', "application/json"),
                                 (b"truncated", "application/pdf")]:
            with self.subTest(media_type=media_type), tempfile.TemporaryDirectory() as folder:
                client = FakeClient()
                client.file_response = lambda url: Response(body, media_type)
                destination = Path(folder).resolve() / "file.pdf"
                with self.assertRaises(moodle.MoodleError):
                    moodle.download(client, {"fileurl": "unused", "filesize": 500}, destination, None)
                self.assertEqual(list(Path(folder).resolve().iterdir()), [])

    def test_credentials_only_in_post_and_no_external_destinations(self):
        client = moodle.Client()
        client.token = "test-secret-token"
        with patch.object(client.opener, "open", return_value=Response(b"file")) as opening:
            client.file_response(moodle.SITE + "/pluginfile.php/1/mod_resource/file.pdf?forcedownload=1")
            req = opening.call_args.args[0]
            self.assertEqual(req.get_method(), "POST")
            self.assertNotIn("test-secret-token", req.full_url)
            self.assertEqual(urllib.parse.parse_qs(req.data.decode())["token"], ["test-secret-token"])
        for url in ("http://moodle52.u-toyama.ac.jp/file", "https://example.com/file",
                    "https://moodle52.u-toyama.ac.jp.example.com/file"):
            with self.assertRaises(moodle.MoodleError):
                client.file_response(url)
        with self.assertRaises(moodle.MoodleError):
            client.call("core_enrol_unenrol_user_enrolment")
        with self.assertRaises(moodle.MoodleError):
            moodle.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com")

    def test_login_uses_post_body_and_reports_invalid_login(self):
        client = moodle.Client()
        with patch.object(client.opener, "open", return_value=Response(b'{"token":"test-token"}')) as opening:
            client.login("test-user", "test-password")
            req = opening.call_args.args[0]
            self.assertEqual(req.get_method(), "POST")
            self.assertEqual(req.full_url, moodle.SITE + "/login/token.php")
            params = urllib.parse.parse_qs(req.data.decode())
            self.assertEqual(params["password"], ["test-password"])
            self.assertEqual(params["service"], ["moodle_mobile_app"])
            self.assertEqual(client.token, "test-token")
        with patch.object(client.opener, "open", return_value=Response(b'{"errorcode":"invalidlogin","error":"invalid"}')):
            with self.assertRaisesRegex(moodle.MoodleError, "invalidlogin"):
                client.login("test-user", "wrong")

    def test_manifest_cannot_direct_download_outside_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve() / "downloads"
            self.run_tool(root)
            manifest_path = root / ".manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            next(iter(manifest.values()))["path"] = str(Path(folder).resolve() / "outside.pdf")
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(moodle.MoodleError):
                self.run_tool(root)
            self.assertFalse((Path(folder).resolve() / "outside.pdf").exists())


class SecurityTests(unittest.TestCase):
    def item(self, **extra):
        return {"fileurl": "mock-only", **extra}

    def client(self, data):
        return Mock(file_response=Mock(return_value=Response(data)))

    def symlink(self, path, target, directory=False):
        try:
            path.symlink_to(target, target_is_directory=directory)
        except OSError:
            self.skipTest("Symlinks unavailable for this account")

    def test_reserved_api_keys_cannot_override_read_function_or_token(self):
        client = moodle.Client()
        client.token = "dummy"
        for key in ("wsfunction", "wstoken", "moodlewsrestformat"):
            with patch.object(client, "json") as request:
                with self.assertRaises(moodle.MoodleError):
                    client.call("core_course_get_contents", **{key: "override"})
                request.assert_not_called()

    def test_malformed_ids_cannot_create_traversal_paths(self):
        for value in ("../../outside", "1", -1, 0, 1.5, True, 2**53):
            for field in ("course", "section", "module"):
                course = {"id": value if field == "course" else 1, "fullname": "course"}
                module = {"id": value if field == "module" else 3, "contents": []}
                sections = [{"id": value if field == "section" else 2, "modules": [module]}]
                with self.assertRaises(moodle.MoodleError):
                    list(moodle.material_files(course, sections))

    def test_oversized_declared_files_are_rejected_without_request(self):
        with tempfile.TemporaryDirectory() as folder:
            client = self.client(b"unused")
            with self.assertRaises(moodle.MoodleError):
                moodle.download(client, self.item(filesize=moodle.MAX_FILE_BYTES + 1), Path(folder).resolve() / "file", None)
            client.file_response.assert_not_called()
            self.assertEqual(list(Path(folder).resolve().iterdir()), [])

    def test_streams_stop_at_declared_or_hard_limit_and_cleanup(self):
        for declared in (None, 1):
            with self.subTest(declared=declared), tempfile.TemporaryDirectory() as folder:
                response = Response(b"x" * 4096)
                client = Mock(file_response=Mock(return_value=response))
                budget = moodle.TransferBudget()
                with patch.object(moodle, "MAX_FILE_BYTES", 32):
                    with self.assertRaises(moodle.MoodleError):
                        moodle.download(client, self.item(filesize=declared), Path(folder).resolve() / "file", None, budget=budget)
                self.assertEqual(budget.received, (declared if declared is not None else 32) + 1)
                self.assertTrue(response.closed)
                self.assertEqual(list(Path(folder).resolve().iterdir()), [])

    def test_exact_capacity_and_empty_files_can_be_saved(self):
        for body in (b"", b"x" * 32):
            with tempfile.TemporaryDirectory() as folder, patch.object(moodle, "MAX_FILE_BYTES", 32):
                target = Path(folder).resolve() / "file"
                entry, status = moodle.download(self.client(body), self.item(filesize=len(body)), target, None)
                self.assertEqual(status, "saved")
                self.assertEqual(target.read_bytes(), body)
                self.assertEqual(entry["sha256"], moodle.sha256(target))

    def test_fragmented_api_error_is_never_saved(self):
        class Fragmented(Response):
            def read1(self, size):
                return super().read1(min(size, 1))
        body = b'{"errorcode":"invalidtoken","message":"dummy"}'
        with tempfile.TemporaryDirectory() as folder:
            client = Mock(file_response=Mock(return_value=Fragmented(body)))
            with self.assertRaises(moodle.MoodleError):
                moodle.download(client, self.item(filesize=len(body)), Path(folder).resolve() / "file", None)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_oversized_content_length_is_rejected_before_read(self):
        with tempfile.TemporaryDirectory() as folder:
            response = Response(b"unused")
            response.headers["Content-Length"] = "10000"
            with patch.object(response, "read1", side_effect=AssertionError("must not read")):
                with self.assertRaises(moodle.MoodleError):
                    moodle.download(Mock(file_response=Mock(return_value=response)), self.item(filesize=1), Path(folder).resolve() / "file", None)
            self.assertEqual(list(Path(folder).resolve().iterdir()), [])

    def test_total_budget_includes_failed_files_and_stops_next_request(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(moodle, "MAX_TOTAL_BYTES", 10):
            root = Path(folder).resolve()
            budget = moodle.TransferBudget()
            with self.assertRaises(moodle.MoodleError):
                moodle.download(self.client(b"123456"), self.item(filesize=8), root / "bad", None, budget=budget)
            self.assertEqual(budget.received, 6)
            client = self.client(b"12345")
            with self.assertRaises(moodle.MoodleError):
                moodle.download(client, self.item(filesize=5), root / "next", None, budget=budget)
            client.file_response.assert_not_called()
            self.assertEqual(list(root.iterdir()), [])

    def test_trickling_response_cannot_reset_file_deadline(self):
        clock = [0]
        class Trickling(Response):
            def read1(self, size):
                clock[0] += 50
                return super().read1(min(size, 1))
        with tempfile.TemporaryDirectory() as folder, patch.object(moodle.time, "monotonic", side_effect=lambda: clock[0]):
            response = Trickling(b"123456789")
            with self.assertRaisesRegex(moodle.MoodleError, "制限時間"):
                moodle.download(Mock(file_response=Mock(return_value=response)), self.item(), Path(folder).resolve() / "file", None)
            self.assertEqual(clock[0], 150)
            self.assertEqual(list(Path(folder).resolve().iterdir()), [])

    def test_expired_total_budget_sends_nothing(self):
        budget = moodle.TransferBudget()
        budget.deadline = 0
        client = self.client(b"unused")
        with self.assertRaises(moodle.MoodleError):
            moodle.download(client, self.item(), Path("unused"), None, budget=budget)
        client.file_response.assert_not_called()

    def test_api_trickling_is_bounded_too(self):
        clock = [0]
        class Trickling(Response):
            def read1(self, size):
                clock[0] += 25
                return b" "
        client = moodle.Client()
        with (patch.object(client, "open", return_value=Trickling(b"")),
              patch.object(moodle.time, "monotonic", side_effect=lambda: clock[0])):
            with self.assertRaisesRegex(moodle.MoodleError, "制限時間"):
                client.json(moodle.SITE, {})
        self.assertEqual(clock[0], 50)

    def test_parent_swap_during_response_never_writes_outside(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            parent, outside = root / "downloads", root / "outside"
            parent.mkdir()
            outside.mkdir()
            if os.name != "nt":
                self.symlink(root / "probe", outside, True)
                (root / "probe").unlink()
            swapped = []
            def response(url):
                try:
                    parent.rename(root / "original")
                except PermissionError:
                    # Windows must pin the path by denying directory renames.
                    swapped.append(False)
                    return Response(b"123")
                swapped.append(True)
                parent.symlink_to(outside, target_is_directory=True)
                return Response(b"123")
            client = Mock(file_response=Mock(side_effect=response))
            if os.name == "nt":
                moodle.download(client, self.item(filesize=3), parent / "file", None)
                self.assertEqual(swapped, [False])
                self.assertEqual((parent / "file").read_bytes(), b"123")
            else:
                with self.assertRaises(moodle.MoodleError):
                    moodle.download(client, self.item(filesize=3), parent / "file", None)
                self.assertEqual(swapped, [True])
                self.assertEqual(list((root / "original").iterdir()), [])
            self.assertEqual(list(outside.iterdir()), [])

    def test_static_symlink_parent_and_history_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            outside = root / "outside"
            outside.mkdir()
            linked = root / "linked"
            self.symlink(linked, outside, True)
            with self.assertRaises(OSError):
                moodle.download(self.client(b"123"), self.item(filesize=3), linked / "file", None)
            secret = outside / "secret"
            secret.write_bytes(b"unchanged")
            history = root / ".manifest.json"
            self.symlink(history, secret)
            with moodle.Directory(root) as directory:
                with self.assertRaises(OSError):
                    directory.open_read(history.name)
            moodle.write_json(history, {"safe": True})
            self.assertEqual(secret.read_bytes(), b"unchanged")
            self.assertFalse(history.is_symlink())
            self.assertEqual(json.loads(history.read_text(encoding="utf-8")), {"safe": True})

    @unittest.skipUnless(os.name == "nt", "Windows junctions only")
    def test_windows_junction_parent_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            outside, linked = root / "outside", root / "junction"
            outside.mkdir()
            subprocess.run(["cmd", "/c", "mklink", "/J", str(linked), str(outside)], check=True, capture_output=True)
            with self.assertRaises(OSError):
                moodle.download(self.client(b"123"), self.item(filesize=3), linked / "file", None)
            self.assertEqual(list(outside.iterdir()), [])

    def test_long_names_preserve_unicode_with_bounded_work(self):
        name = moodle.clean_name("あ😀" * 100000)
        self.assertLessEqual(len(name.encode("utf-8")), 160)
        self.assertEqual(name, "あ😀" * 22 + "あ")


class MemoryBackend:
    """テスト専用。OSの実際の保管庫を読み書きしない。"""

    def __init__(self):
        self.raw = None

    def get_password(self, service, account):
        assert service == moodle.KEYRING_SERVICE and account == moodle.KEYRING_ACCOUNT
        return self.raw

    def set_password(self, service, account, value):
        assert service == moodle.KEYRING_SERVICE and account == moodle.KEYRING_ACCOUNT
        self.raw = value

    def delete_password(self, service, account):
        assert service == moodle.KEYRING_SERVICE and account == moodle.KEYRING_ACCOUNT
        self.raw = None


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.store = moodle.CredentialStore.__new__(moodle.CredentialStore)
        self.store.backend = MemoryBackend()
        self.args = argparse.Namespace(no_save=False, login=False, forget_login=False)
        self.client = Mock()
        self.client.call.return_value = {"userid": 10}

    def authenticate(self, username="test-user", password="test-password", interactive=True):
        with (patch.object(moodle, "CredentialStore", return_value=self.store),
              patch("builtins.input", side_effect=AssertionError("credentials must not use visible input")) as user_prompt,
              patch.object(moodle.getpass, "getpass", side_effect=[username, password]) as password_prompt,
              patch.object(moodle.sys.stdin, "isatty", return_value=interactive),
              redirect_stdout(io.StringIO()) as log):
            info = moodle.authenticate(self.client, self.args)
        self.assertNotIn(password, log.getvalue())
        self.assertNotIn(username, log.getvalue())
        return info, user_prompt, password_prompt

    def test_first_success_is_saved_and_next_run_needs_no_input(self):
        info, user_prompt, password_prompt = self.authenticate()
        self.assertEqual(info, {"userid": 10})
        self.assertEqual(self.store.load(), ("test-user", "test-password"))
        user_prompt.assert_not_called()
        self.assertEqual(password_prompt.call_count, 2)
        self.client.login.assert_called_once_with("test-user", "test-password")
        self.client.reset_mock()
        _, user_prompt, password_prompt = self.authenticate(interactive=False)
        user_prompt.assert_not_called()
        password_prompt.assert_not_called()
        self.client.login.assert_called_once_with("test-user", "test-password")

    def test_failed_first_login_is_not_saved(self):
        self.client.login.side_effect = moodle.MoodleAPIError("invalid credentials", "invalidlogin")
        with self.assertRaises(moodle.MoodleAPIError):
            self.authenticate()
        self.assertIsNone(self.store.load())

    def test_saved_password_change_prompts_once_and_replaces_after_success(self):
        self.store.save("old-user", "old-password")
        self.client.login.side_effect = [moodle.MoodleAPIError("invalid", "invalidlogin"), None]
        _, user_prompt, password_prompt = self.authenticate("new-user", "new-password")
        self.assertEqual(self.client.login.call_count, 2)
        user_prompt.assert_not_called()
        self.assertEqual(password_prompt.call_count, 2)
        self.assertEqual(self.store.load(), ("new-user", "new-password"))

    def test_network_failure_does_not_retry_or_replace_saved_login(self):
        self.store.save("test-user", "test-password")
        self.client.login.side_effect = moodle.MoodleError("network unavailable")
        with self.assertRaises(moodle.MoodleError):
            self.authenticate()
        self.client.login.assert_called_once()
        self.assertEqual(self.store.load(), ("test-user", "test-password"))

    def test_no_save_never_reads_or_writes_store(self):
        self.args.no_save = True
        self.store.save("old-user", "old-password")
        with patch.object(moodle, "CredentialStore", side_effect=AssertionError("must not touch keychain")):
            with (patch("builtins.input", side_effect=AssertionError("credentials must not use visible input")),
                  patch.object(moodle.getpass, "getpass", side_effect=["test-user", "test-password"]),
                  patch.object(moodle.sys.stdin, "isatty", return_value=True),
                  redirect_stdout(io.StringIO())):
                moodle.authenticate(self.client, self.args)
        self.assertEqual(self.store.load(), ("old-user", "old-password"))

    def test_explicit_login_bypasses_corrupt_saved_credentials(self):
        self.store.backend.raw = "broken record"
        self.args.login = True
        self.authenticate()
        self.assertEqual(self.store.load(), ("test-user", "test-password"))

    def test_forget_login_does_not_contact_moodle(self):
        self.store.save("test-user", "test-password")
        self.args.forget_login = True
        with (patch.object(moodle, "CredentialStore", return_value=self.store),
              patch.object(moodle, "Client", side_effect=AssertionError("network must not be used")),
              redirect_stdout(io.StringIO())):
            self.assertEqual(moodle.run(self.args), 0)
        self.assertIsNone(self.store.load())
        self.assertFalse(self.store.forget())

    def test_plaintext_backend_is_rejected(self):
        module = types.SimpleNamespace(get_keyring=lambda: MemoryBackend())
        with patch.dict(moodle.sys.modules, {"keyring": module}):
            with self.assertRaisesRegex(moodle.MoodleError, "平文ファイルには保存しません"):
                moodle.CredentialStore()

    def test_store_failure_does_not_leak_password_or_block_this_login(self):
        with (patch.object(self.store.backend, "set_password", side_effect=RuntimeError("test-password")),
              patch.object(moodle.sys, "stderr", new_callable=io.StringIO) as log):
            self.authenticate()
        self.assertNotIn("test-password", log.getvalue())
        self.assertIn("次回は再入力", log.getvalue())
        self.assertIsNone(self.store.load())

    def test_public_check_does_not_touch_credentials(self):
        self.args.check = True
        with (patch.object(moodle, "Client", FakeClient),
              patch.object(moodle, "CredentialStore", side_effect=AssertionError("must not read credentials")),
              redirect_stdout(io.StringIO())):
            self.assertEqual(moodle.run(self.args), 0)


class CredentialPromptTests(unittest.TestCase):
    def test_both_fields_are_hidden_and_only_username_is_trimmed(self):
        with (patch.object(moodle.sys.stdin, "isatty", return_value=True),
              patch("builtins.input", side_effect=AssertionError("visible input is forbidden")),
              patch.object(moodle.getpass, "getpass", side_effect=[" user ", " pass "]) as hidden):
            self.assertEqual(moodle.prompt_credentials(), ("user", " pass "))
        self.assertEqual(hidden.call_count, 2)

    def test_echo_warning_in_either_field_stops_login(self):
        for replies in ([moodle.getpass.GetPassWarning()], ["user", moodle.getpass.GetPassWarning()]):
            with self.subTest(field=len(replies)), \
                    patch.object(moodle.sys.stdin, "isatty", return_value=True), \
                    patch.object(moodle.getpass, "getpass", side_effect=replies):
                with self.assertRaisesRegex(moodle.MoodleError, "非表示にできるターミナル"):
                    moodle.prompt_credentials()

    def test_noninteractive_input_is_rejected_before_prompting(self):
        with (patch.object(moodle.sys.stdin, "isatty", return_value=False),
              patch.object(moodle.getpass, "getpass") as hidden):
            with self.assertRaises(moodle.MoodleError):
                moodle.prompt_credentials()
        hidden.assert_not_called()

    def test_empty_username_does_not_prompt_for_password(self):
        with (patch.object(moodle.sys.stdin, "isatty", return_value=True),
              patch.object(moodle.getpass, "getpass", return_value="  ") as hidden):
            with self.assertRaisesRegex(moodle.MoodleError, "ユーザー名が未入力"):
                moodle.prompt_credentials()
        hidden.assert_called_once()


if __name__ == "__main__":
    unittest.main()
