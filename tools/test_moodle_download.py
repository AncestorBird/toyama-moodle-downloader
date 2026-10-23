"""実際の認証情報・外部通信を使わず、取得と保全を検証する。"""

import argparse
from contextlib import redirect_stdout
from email.message import Message
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
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
        args = argparse.Namespace(check=False, list=False, course=[123], dry_run=False, output=output)
        for key, value in kwargs.items():
            setattr(args, key, value)
        with (patch.object(moodle, "Client", FakeClient),
              patch("builtins.input", return_value="test-user"),
              patch.object(moodle.getpass, "getpass", return_value="test-password"),
              patch.object(moodle.sys.stdin, "isatty", return_value=True),
              redirect_stdout(io.StringIO()) as log):
            result = moodle.run(args)
        self.assertNotIn("test-password", log.getvalue())
        return result

    def test_download_skip_update_and_preserve_local_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
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
            manifest = json.loads((root / ".manifest.json").read_text())
            latest = Path(next(iter(manifest.values()))["path"])
            latest.write_bytes(b"my local edits")
            self.assertEqual(self.run_tool(root), 0)
            self.assertEqual(latest.read_bytes(), b"my local edits")
            self.assertEqual(len(list(root.rglob("*.pdf"))), 3)
            self.assertNotIn("test-password", (root / ".manifest.json").read_text())

    def test_preview_does_not_write_files(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "new"
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
                destination = Path(folder) / "file.pdf"
                with self.assertRaises(moodle.MoodleError):
                    moodle.download(client, {"fileurl": "unused", "filesize": 500}, destination, None)
                self.assertEqual(list(Path(folder).iterdir()), [])

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
            root = Path(folder) / "downloads"
            self.run_tool(root)
            manifest_path = root / ".manifest.json"
            manifest = json.loads(manifest_path.read_text())
            next(iter(manifest.values()))["path"] = str(Path(folder) / "outside.pdf")
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(moodle.MoodleError):
                self.run_tool(root)
            self.assertFalse((Path(folder) / "outside.pdf").exists())


if __name__ == "__main__":
    unittest.main()
