import { test, expect } from '@playwright/test';

const SITE = 'https://moodle52.u-toyama.ac.jp';
const deadline = Date.parse('2026-11-17T09:00:00Z') / 1000;
const assignments = [
  { id: 7, cmid: 70, name: '提出済み課題', duedate: deadline, intro: '<p>PDFを提出してください。</p>' },
  { id: 8, cmid: 80, name: 'ミニットペーパー', duedate: 0,
    intro: '<p>紙で提出済みの人は不要。各回の翌週火曜13時まで。</p><img src="https://example.com/private" onerror="window.assignmentXSS=true"><script>window.assignmentXSS=true</script>' },
  { id: 9, cmid: 90, name: '状態を取得できない課題', duedate: deadline, intro: '' },
];

async function setup(page, { delayStatus = false } = {}) {
  const requests = [];
  let release, began;
  const released = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  await page.route(`${SITE}/**`, async route => {
    const request = route.request();
    const params = new URLSearchParams(request.postData());
    requests.push({ url: request.url(), method: request.method(), params });
    const fn = params.get('wsfunction');
    let data;
    if (request.url().endsWith('/login/token.php')) data = { token: 'assignment-browser-token' };
    else if (fn === 'core_webservice_get_site_info') data = { userid: 10, fullname: '課題テスト利用者' };
    else if (fn === 'core_enrol_get_users_courses') data = [
      { id: 123, fullname: '情報処理演習', startdate: 2 }, { id: 456, fullname: '別の授業', startdate: 1 },
    ];
    else if (fn === 'mod_assign_get_assignments') data = {
      courses: [{ id: 123, fullname: '情報処理演習', assignments }],
      warnings: [{ item: 'module', itemid: 100, warningcode: '1', message: 'private server details' }],
    };
    else if (fn === 'mod_assign_get_submission_status') {
      if (delayStatus) { began(); await released; }
      const id = Number(params.get('assignid'));
      data = id === 9 ? { exception: 'moodle_exception', errorcode: 'nopermissions', message: 'private server details' } : {
        lastattempt: {
          submission: { status: id === 7 ? 'submitted' : 'new', plugins: id === 7 ? [
            { type: 'file', fileareas: [{ files: [{ filename: 'report.pdf' }] }] },
          ] : [] },
          extensionduedate: id === 7 ? deadline + 86400 : null,
        }, warnings: [],
      };
    } else throw new Error(`Unexpected API function: ${fn}`);
    await route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': '*' } }).catch(() => {});
  });
  await page.goto('./');
  await page.getByLabel('ユーザー名', { exact: true }).fill('test-user');
  await page.getByLabel('パスワード', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: /^ログイン/ }).click();
  await expect(page.getByText('課題テスト利用者', { exact: true })).toBeVisible();
  await page.locator('.course-row').filter({ hasText: '情報処理演習' }).getByRole('checkbox').check();
  return { requests, release, started };
}

test('assignment results show deadlines, partial failures and safe descriptions; filters and logout work', async ({ page }) => {
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) external.push(request.url()); });
  const { requests } = await setup(page);
  await page.getByRole('button', { name: '選択した授業の課題を確認' }).click();
  await expect(page.locator('#assignment-panel')).toBeVisible();
  await expect(page.locator('.assignment-row')).toHaveCount(3);
  const submitted = page.locator('.assignment-row').filter({ hasText: '提出済み課題' });
  await expect(submitted).toContainText('2026/11/18 18:00');
  await expect(submitted).toContainText('提出済み');
  await expect(submitted.getByRole('link')).toHaveAttribute('href', `${SITE}/mod/assign/view.php?id=70`);
  const paper = page.locator('.assignment-row').filter({ hasText: 'ミニットペーパー' });
  await paper.locator('summary').click();
  await expect(paper).toContainText('紙で提出済みの人は不要');
  await expect(paper).toContainText('翌週火曜13時');
  await expect(page.locator('#assignment-list img, #assignment-list script')).toHaveCount(0);
  expect(await page.evaluate(() => window.assignmentXSS)).toBeUndefined();
  expect(external).toEqual([]);
  await expect(page.locator('#assignment-warnings')).not.toBeEmpty();
  await expect(page.locator('#assignment-panel')).not.toContainText('private server details');
  await page.locator('#assignment-filter').selectOption('pending');
  await expect(page.locator('.assignment-row')).toHaveCount(1);
  await expect(page.locator('.assignment-row')).toContainText('ミニットペーパー');
  await page.locator('#assignment-filter').selectOption('unknown');
  await expect(page.locator('.assignment-row')).toHaveCount(1);
  await expect(page.locator('.assignment-row')).toContainText('状態を取得できない課題');
  for (const r of requests) {
    expect(r.method).toBe('POST');
    expect(r.url).not.toContain('assignment-browser-token');
    expect(r.url).not.toContain('test-password');
  }
  const listing = requests.find(r => r.params.get('wsfunction') === 'mod_assign_get_assignments');
  expect(listing.params.get('courseids[0]')).toBe('123');
  expect(listing.params.get('courseids[1]')).toBeNull();
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.locator('#assignment-panel')).toBeHidden();
  await expect(page.locator('#assignment-list')).toBeEmpty();
  await expect(page.locator('#assignment-button')).toBeDisabled();
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  expect(stored).toEqual({ local: {}, session: {}, cookie: '' });
  expect(errors).toEqual([]);
});

test('cancelling an assignment check discards late results and permits logout', async ({ page }) => {
  const { started, release } = await setup(page, { delayStatus: true });
  await page.getByRole('button', { name: '選択した授業の課題を確認' }).click();
  await started;
  try {
    await page.getByRole('button', { name: '中止する', exact: true }).click();
    await expect(page.locator('#assignment-button')).toBeEnabled();
    await expect(page.locator('.assignment-row')).toHaveCount(0);
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    release();
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#assignment-panel')).toBeHidden();
    await expect(page.locator('.assignment-row')).toHaveCount(0);
  } finally { release(); }
});

test('assignment results fit a narrow mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole('button', { name: '選択した授業の課題を確認' }).click();
  await expect(page.locator('.assignment-row')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
