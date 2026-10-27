import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { unzipSync } from 'fflate';

const SITE = 'https://moodle52.u-toyama.ac.jp';
const pdf = Buffer.from('%PDF-1.4\nlecture material\n');
const courses = [
  { id: 123, fullname: '情報処理演習', startdate: 2 },
  { id: 456, fullname: '基礎数学', startdate: 1 },
  { id: 789, fullname: '<img src="https://example.com/steal" onerror="alert(1)">安全な表示', startdate: 0 },
];

async function mockMoodle(page, { invalidLogin = false } = {}) {
  const requests = [];
  await page.route(`${SITE}/**`, async route => {
    const request = route.request();
    const params = new URLSearchParams(request.postData());
    requests.push({ url: request.url(), params, method: request.method() });
    let data;
    if (request.url().includes('/login/token.php')) {
      data = invalidLogin ? { errorcode: 'invalidlogin', error: 'test-password' } : { token: 'browser-test-token' };
    } else if (request.url().includes('/webservice/pluginfile.php/')) {
      await route.fulfill({ body: pdf, contentType: 'application/pdf', headers: { 'Access-Control-Allow-Origin': '*' } });
      return;
    } else if (params.get('wsfunction') === 'core_webservice_get_site_info') {
      data = { userid: 10, fullname: 'テスト利用者' };
    } else if (params.get('wsfunction') === 'core_enrol_get_users_courses') {
      data = courses;
    } else if (params.get('wsfunction') === 'core_course_get_contents') {
      data = [{ id: 2, name: '第1回', modules: [{ id: 3, name: '配布資料', contents: [{
        type: 'file', filename: '資料.pdf', filepath: '/',
        fileurl: `${SITE}/pluginfile.php/1/file.pdf?token=old-url-token`,
        filesize: pdf.length, mimetype: 'application/pdf',
      }] }] }];
    } else {
      throw new Error('Unexpected API function');
    }
    await route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  return requests;
}

async function signIn(page) {
  await page.getByLabel('ユーザー名', { exact: true }).fill('test-user');
  await page.getByLabel('パスワード', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: /^ログイン/ }).click();
  await expect(page.getByText('テスト利用者', { exact: true })).toBeVisible();
}

test('login, select, download a valid ZIP, then log out without retaining secrets', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = await mockMoodle(page);
  await page.goto('./');
  await expect(page.locator('h1')).toContainText('授業の資料を、');
  await expect(page.locator('.brand-icon')).toHaveCSS('background-color', 'rgb(23, 100, 90)');
  await signIn(page);
  await expect(page.locator('.course-row')).toHaveCount(3);
  await expect(page.locator('#password')).toHaveValue('');
  await expect(page.locator('#course-list img')).toHaveCount(0);
  await page.locator('.course-row').filter({ hasText: '情報処理演習' }).getByRole('checkbox').check();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '選択した授業の資料を取得' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^moodle-materials-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = unzipSync(new Uint8Array(await readFile(await download.path())));
  const [name] = Object.keys(zip);
  expect(name).toMatch(/^123_情報処理演習\/2_第1回\/3_配布資料\/[a-f0-9]{16}_資料.pdf$/);
  expect(Buffer.from(zip[name])).toEqual(pdf);
  await expect(page.getByRole('status')).toContainText('取得 1件 / 失敗 0件');
  for (const request of requests) {
    expect(request.method).toBe('POST');
    expect(request.url).not.toContain('test-password');
    expect(request.url).not.toContain('browser-test-token');
    expect(request.url).not.toContain('old-url-token');
  }
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  expect(stored).toEqual({ local: {}, session: {}, cookie: '' });
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#download-button')).toBeDisabled();
  await expect(page.locator('#archive-link')).toBeHidden();
  expect(errors).toEqual([]);
});

test('search selects only visible courses, and preview does not request files', async ({ page }) => {
  const requests = await mockMoodle(page);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.goto('./');
  await signIn(page);
  await page.getByRole('searchbox').fill('数学');
  await expect(page.locator('.course-row')).toHaveCount(1);
  await page.getByRole('button', { name: '表示中をすべて選択' }).click();
  await expect(page.locator('#selected-count')).toHaveText('1');
  await page.getByLabel('まず取得予定の資料だけ確認する').check();
  await page.getByRole('button', { name: '選択した授業の資料を取得' }).click();
  await expect(page.getByRole('status')).toContainText('取得予定: 1件');
  expect(requests.filter(r => r.url.includes('/pluginfile.php/'))).toHaveLength(0);
  expect(requests.find(r => r.params.get('wsfunction') === 'core_course_get_contents').params.get('courseid')).toBe('456');
  expect(downloads).toBe(0);
});

test('password manager is requested only after successful login and explicit choice', async ({ page }) => {
  await page.addInitScript(() => {
    window.PasswordCredential = class { constructor(value) { this.id = value.id; } };
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
      store: async credential => { window.savedAccountForTest = credential.id; },
    } });
  });
  await mockMoodle(page);
  await page.goto('./');
  await page.getByLabel('このブラウザにパスワードを保存').check();
  await signIn(page);
  await expect.poll(() => page.evaluate(() => window.savedAccountForTest)).toBe('test-user');
});

test('failed authentication does not save credentials or disclose the password', async ({ page }) => {
  await page.addInitScript(() => {
    window.PasswordCredential = class {};
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
      store: async () => { window.savedAccountForTest = true; },
    } });
  });
  await mockMoodle(page, { invalidLogin: true });
  await page.goto('./');
  await page.getByLabel('ユーザー名', { exact: true }).fill('test-user');
  await page.getByLabel('パスワード', { exact: true }).fill('test-password');
  await page.getByLabel('このブラウザにパスワードを保存').check();
  await page.getByRole('button', { name: /^ログイン/ }).click();
  await expect(page.getByRole('status')).toContainText('invalidlogin');
  await expect(page.getByRole('status')).not.toContainText('test-password');
  expect(await page.evaluate(() => window.savedAccountForTest)).toBeUndefined();
  await expect(page.locator('#session-box')).toBeHidden();
});

test('cancelling an active download produces no archive and controls recover', async ({ page }) => {
  await mockMoodle(page);
  let started;
  const fileStarted = new Promise(resolve => { started = resolve; });
  let release;
  const released = new Promise(resolve => { release = resolve; });
  await page.route(`${SITE}/webservice/pluginfile.php/**`, async route => {
    started();
    await released;
    await route.fulfill({ body: pdf, contentType: 'application/pdf', headers: { 'Access-Control-Allow-Origin': '*' } }).catch(() => {});
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.goto('./');
  await signIn(page);
  await page.locator('.course-row').first().getByRole('checkbox').check();
  await page.getByRole('button', { name: '選択した授業の資料を取得' }).click();
  try {
    await fileStarted;
    await page.getByRole('button', { name: '中止する' }).click();
    await expect(page.getByRole('status')).toContainText('取得を中止');
    await expect(page.locator('#download-button')).toBeEnabled();
    await expect(page.locator('#archive-link')).toBeHidden();
    expect(downloads).toBe(0);
  } finally { release(); }
});

test('mobile layout has no horizontal overflow and password can be shown and hidden', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'パスワードを表示' })).toBeVisible();
  await page.getByRole('button', { name: 'パスワードを表示' }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'パスワードを隠す' }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'password');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const sandbox of [null, 'allow-scripts', 'allow-scripts allow-same-origin', '']) {
  test(`embedded pages never expose credential fields (sandbox=${sandbox})`, async ({ page }) => {
    const requests = await mockMoodle(page);
    const attribute = sandbox === null ? '' : `sandbox="${sandbox}"`;
    const parent = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<iframe ${attribute} src="http://127.0.0.1:4173/toyama-moodle-downloader/"></iframe>`);
    });
    await new Promise(resolve => parent.listen(0, '127.0.0.1', resolve));
    // Match GitHub Pages' public CORS headers for opaque sandbox origins.
    await page.route('http://127.0.0.1:4173/**', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    try {
      await page.goto(`http://127.0.0.1:${parent.address().port}/frame-test`);
      const frame = page.frameLocator('iframe');
      await expect(frame.locator('#login-template')).toHaveCount(1);
      if (sandbox !== '') await expect(frame.locator('#launch-message')).toContainText('埋め込み画面ではログインできません');
      await expect(frame.locator('input[name="username"], input[name="password"]')).toHaveCount(0);
      await expect(frame.locator('#login-form')).toHaveCount(0);
      expect(requests).toHaveLength(0);
    } finally { await new Promise(resolve => parent.close(resolve)); }
  });
}

test('credential inputs remain inert when JavaScript is unavailable', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(baseURL);
    await expect(page.locator('#login-template')).toHaveCount(1);
    await expect(page.locator('input[name="username"], input[name="password"]')).toHaveCount(0);
  } finally { await context.close(); }
});
