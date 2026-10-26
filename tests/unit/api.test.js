import test from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, fileURL, login, MoodleClient, MoodleError, SITE, validateURL } from '../../src/api.js';

const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('login uses POST bodies, omits cookies and does not expose the token', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    const params = options.body;
    if (String(url).endsWith('/login/token.php')) return response({ token: 'test-token' });
    if (params.get('wsfunction') === 'core_webservice_get_site_info') return response({ userid: 10 });
    return response([{ id: 1, fullname: '古い授業', startdate: 1 }, { id: 2, fullname: '新しい授業', startdate: 2 }]);
  });
  const session = await login(' student ', 'test-password');
  assert.deepEqual(session.courses.map(c => c.id), [2, 1]);
  assert.equal(calls[0].options.body.get('username'), 'student');
  assert.equal(calls[0].options.body.get('password'), 'test-password');
  assert.equal(calls[0].options.body.get('service'), 'moodle_mobile_app');
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, SITE);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.ok(!url.includes('test-token') && !url.includes('test-password'));
  }
  assert.equal(JSON.stringify(session.client), '{}');
  session.client.clear();
  await assert.rejects(session.client.call('core_webservice_get_site_info'), /ログイン/);
});

test('external and malformed URLs are rejected', () => {
  for (const url of ['https://example.com/file', 'http://moodle52.u-toyama.ac.jp/file',
    'https://moodle52.u-toyama.ac.jp.example.com/file', 'https://user:secret@moodle52.u-toyama.ac.jp/',
    'https://moodle52.u-toyama.ac.jp:444/file', 'javascript:alert(1)']) {
    assert.throws(() => validateURL(url), MoodleError);
  }
  assert.throws(() => fileURL(SITE + '/login/index.php'), /対応していない/);
});

test('file token is in POST only, and stale URL tokens are removed', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(String(url).startsWith(SITE + '/webservice/pluginfile.php/'));
    assert.ok(!String(url).includes('token'));
    assert.equal(options.body.get('token'), 'test-token');
    return new Response('pdf', { headers: { 'Content-Type': 'application/pdf' } });
  });
  const client = new MoodleClient('test-token');
  const bytes = await client.file({ fileurl: SITE + '/pluginfile.php/1/file.pdf?token=old&wstoken=old#fragment', filesize: 3 });
  assert.equal(new TextDecoder().decode(bytes), 'pdf');
});

test('only permitted read APIs can be called', async t => {
  const fetching = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected'); });
  await assert.rejects(new MoodleClient('test-token').call('core_enrol_unenrol_user_enrolment'), /読み取り/);
  assert.equal(fetching.mock.callCount(), 0);
});

test('API errors and transport errors do not disclose server messages or secrets', async t => {
  const fetching = t.mock.method(globalThis, 'fetch', async () => response({ errorcode: 'invalidlogin', error: 'test-password' }));
  await assert.rejects(login('student', 'test-password'), error => error.message.includes('invalidlogin') && !error.message.includes('test-password'));
  fetching.mock.mockImplementation(async () => { throw new TypeError('secret-token'); });
  await assert.rejects(login('student', 'test-password'), error => error instanceof MoodleError && !error.message.includes('secret-token'));
});

test('HTML, API error files and truncated files are rejected', async t => {
  const fetching = t.mock.method(globalThis, 'fetch', async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }));
  const client = new MoodleClient('test-token');
  const item = { fileurl: SITE + '/webservice/pluginfile.php/1/file.pdf', filesize: 3 };
  await assert.rejects(client.file(item), /ログインページ/);
  fetching.mock.mockImplementation(async () => response({ exception: 'error', errorcode: 'invalidtoken', message: 'secret-token' }));
  await assert.rejects(client.file(item), /invalidtoken/);
  fetching.mock.mockImplementation(async () => new Response('short'));
  await assert.rejects(client.file(item), /サイズが一致/);
});

test('size limits reject a large streamed response', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('too much data'));
  await assert.rejects(new MoodleClient('test-token').file({ fileurl: SITE + '/pluginfile.php/1/file.pdf' }, { maxBytes: 3 }), /上限/);
});

test('cancelling before a request sends nothing', async t => {
  const fetching = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(login('student', 'test-password', { signal: controller.signal }), CancelledError);
  assert.equal(fetching.mock.callCount(), 0);
});
