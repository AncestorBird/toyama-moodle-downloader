import { test, expect } from '@playwright/test';

const SITE = 'https://moodle52.u-toyama.ac.jp';
const deadline = Date.parse('2026-11-17T09:00:00Z') / 1000;
const courses = [
  { id: 123, fullname: '2026_Q3_火2_情報処理演習_担当A', startdate: 2 },
  { id: 124, fullname: '2026_Q3_火3_実験演習_担当B', startdate: 2 },
  { id: 125, fullname: '2026_Q3_水1_課題のない授業_担当C', startdate: 2 },
  { id: 456, fullname: '2026_Q4_木1_冬学期の授業_担当D', startdate: 2 },
  { id: 223, fullname: '2025_Q3_火2_前年度の授業_担当A', startdate: 1 },
  { id: 999, fullname: '2026_案内_学期未分類の授業', startdate: 2 },
];
const byCourse = {
  123: [
    { id: 7, cmid: 70, name: '提出済み課題', duedate: deadline, intro: '<p>PDFを提出してください。</p>' },
    { id: 8, cmid: 80, name: 'ミニットペーパー', duedate: 0,
      intro: '<p>紙で提出済みの人は不要。各回の翌週火曜13時まで。</p><img src="https://example.com/private" onerror="window.assignmentXSS=true"><script>window.assignmentXSS=true</script>' },
    { id: 9, cmid: 90, name: '状態を取得できない課題', duedate: deadline, intro: '' },
  ],
  124: [{ id: 10, cmid: 100, name: '実験レポート', duedate: deadline, intro: '実験結果をまとめてください。' }],
  125: [],
  456: [{ id: 20, cmid: 200, name: '冬学期レポート', duedate: deadline + 30 * 86400, intro: '' }],
  223: [{ id: 30, cmid: 300, name: '前年度レポート', duedate: deadline - 365 * 86400, intro: '' }],
  999: [{ id: 40, cmid: 400, name: '未分類レポート', duedate: 0, intro: '' }],
};

function courseIDs(request) {
  return [...request.params.entries()].filter(([name]) => /^courseids\[\d+\]$/.test(name))
    .map(([, value]) => Number(value)).sort((a, b) => a - b);
}

const listingRequests = requests => requests.filter(r => r.params.get('wsfunction') === 'mod_assign_get_assignments');

async function setup(page, { delayStatus = false, materials = false } = {}) {
  await page.clock.setFixedTime(new Date('2026-11-09T09:00:00Z'));
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  const requests = [];
  let release, began, fulfilled;
  const released = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const delayedFulfilled = new Promise(resolve => { fulfilled = resolve; });
  await page.route(`${SITE}/**`, async route => {
    const request = route.request();
    const params = new URLSearchParams(request.postData());
    requests.push({ url: request.url(), method: request.method(), params });
    const fn = params.get('wsfunction');
    const id = Number(params.get('assignid'));
    let data;
    if (request.url().endsWith('/login/token.php')) data = { token: 'assignment-browser-token' };
    else if (fn === 'core_webservice_get_site_info') data = { userid: 10, fullname: '課題テスト利用者' };
    else if (fn === 'core_enrol_get_users_courses') data = courses;
    else if (fn === 'mod_assign_get_assignments') {
      const selected = courseIDs({ params });
      data = {
        courses: courses.filter(course => selected.includes(course.id))
          .map(course => ({ ...course, assignments: byCourse[course.id] })),
        warnings: selected.includes(123)
          ? [{ item: 'module', itemid: 111, warningcode: '1', message: 'private server details' }] : [],
      };
    } else if (fn === 'mod_assign_get_submission_status') {
      if (delayStatus && id === 7) { began(); await released; }
      data = id === 9 ? { exception: 'moodle_exception', errorcode: 'nopermissions', message: 'private server details' } : {
        lastattempt: {
          submission: { status: [7, 20].includes(id) ? 'submitted' : 'new', plugins: id === 7 ? [
            { type: 'file', fileareas: [{ files: [{ filename: 'report.pdf' }] }] },
          ] : [] },
          extensionduedate: id === 7 ? deadline + 86400 : null,
        }, warnings: [],
      };
    } else if (fn === 'core_course_get_contents') {
      data = [{ id: 2, name: '配布資料', modules: [{ id: 3, name: '講義資料', contents: [{
        type: 'file', filename: '資料.pdf', filepath: '/', filesize: 20,
        fileurl: `${SITE}/pluginfile.php/1/file.pdf`, mimetype: 'application/pdf',
      }] }] }];
    } else throw new Error(`Unexpected API function: ${fn}`);
    await route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': '*' } }).catch(() => {});
    if (delayStatus && id === 7) fulfilled();
  });
  await page.goto('./');
  if (materials) await page.locator('#mode-materials').click();
  await page.getByLabel('ユーザー名', { exact: true }).fill('test-user');
  await page.getByLabel('パスワード', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: /^ログイン/ }).click();
  await expect(page.getByText('課題テスト利用者', { exact: true })).toBeVisible();
  return { requests, release, started, delayedFulfilled };
}

test('login automatically checks current-quarter courses, grouped by class with safe details and partial failures', async ({ page }) => {
  const errors = [];
  const external = [];
  let downloads = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', () => downloads++);
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) external.push(request.url()); });
  const { requests } = await setup(page);
  await expect(page.locator('#year-filter')).toHaveValue('2026');
  await expect(page.locator('#quarter-filter')).toHaveValue('3');
  await expect(page.locator('#assignment-filter')).toHaveValue('pending');
  await expect(page.locator('#materials-panel')).toBeHidden();
  await expect(page.locator('.assignment-course-group')).toHaveCount(3);
  await expect(page.locator('.assignment-row')).toHaveCount(3);
  const info = page.locator('.assignment-course-group').filter({ has: page.locator('.course-group-title', { hasText: '情報処理演習' }) });
  await expect(info.locator('.course-group-counts')).toContainText('未提出等 1 · 要確認 1 · 提出済み 1');
  await expect(info.locator('.assignment-row')).toHaveCount(2);
  const experiment = page.locator('.assignment-course-group').filter({ has: page.locator('.course-group-title', { hasText: '実験演習' }) });
  await expect(experiment).toContainText('実験レポート');
  await expect(experiment.locator('.course-group-next')).toContainText('2026/11/17 18:00');
  expect(courseIDs(listingRequests(requests)[0])).toEqual([123, 124, 125]);
  expect(requests.some(r => r.params.get('wsfunction') === 'core_course_get_contents')).toBe(false);
  expect(downloads).toBe(0);
  await page.locator('#assignment-filter').selectOption('all');
  await expect(page.locator('.assignment-row')).toHaveCount(4);
  const submitted = page.locator('.assignment-row').filter({ hasText: '提出済み課題' });
  await expect(submitted).toContainText('2026/11/18 18:00');
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
  await page.locator('#assignment-filter').selectOption('unknown');
  await expect(page.locator('.assignment-row')).toHaveCount(1);
  await expect(page.locator('.assignment-row')).toContainText('状態を取得できない課題');
  for (const r of requests) {
    expect(r.method).toBe('POST');
    expect(r.url).not.toContain('assignment-browser-token');
    expect(r.url).not.toContain('test-password');
  }
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.locator('.assignment-course-group')).toHaveCount(0);
  await expect(page.locator('.assignment-row')).toHaveCount(0);
  await expect(page.locator('#assignment-button')).toBeDisabled();
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  expect(stored).toEqual({ local: {}, session: {}, cookie: '' });
  expect(errors).toEqual([]);
});

test('quarter, year and search changes automatically narrow the request and replace course groups', async ({ page }) => {
  const { requests } = await setup(page);
  await expect(page.locator('.assignment-course-group')).toHaveCount(3);
  await page.locator('#quarter-filter').selectOption('4');
  await expect(page.locator('.assignment-course-group')).toHaveCount(1);
  await expect(page.locator('.course-group-title')).toContainText('冬学期の授業');
  await expect(page.locator('#assignment-summary')).toContainText('更新');
  expect(courseIDs(listingRequests(requests).at(-1))).toEqual([456]);
  await page.locator('#quarter-filter').selectOption('3');
  await page.locator('#year-filter').selectOption('2025');
  await expect(page.locator('.assignment-course-group')).toHaveCount(1);
  await expect(page.locator('.course-group-title')).toContainText('前年度の授業');
  await expect(page.locator('#assignment-summary')).toContainText('更新');
  expect(courseIDs(listingRequests(requests).at(-1))).toEqual([223]);
  await page.locator('#year-filter').selectOption('2026');
  await expect(page.locator('.assignment-course-group')).toHaveCount(3);
  await page.locator('#course-search').fill('実験演習');
  await expect(page.locator('.assignment-course-group')).toHaveCount(1);
  await expect(page.locator('.course-group-title')).toContainText('実験演習');
  await expect(page.locator('#assignment-summary')).toContainText('更新');
  expect(courseIDs(listingRequests(requests).at(-1))).toEqual([124]);
  await page.locator('#course-search').fill('');
  await page.locator('#quarter-filter').selectOption('other');
  await expect(page.locator('.assignment-course-group')).toHaveCount(1);
  await expect(page.locator('.course-group-title')).toContainText('学期未分類の授業');
  await expect(page.locator('#assignment-summary')).toContainText('更新');
  expect(courseIDs(listingRequests(requests).at(-1))).toEqual([999]);
});

test('materials mode does not auto-check or download, and scope changes clear hidden selections', async ({ page }) => {
  let downloads = 0;
  page.on('download', () => downloads++);
  const { requests } = await setup(page, { materials: true });
  await expect(page.locator('#materials-panel')).toBeVisible();
  await expect(page.locator('#assignment-panel')).toBeHidden();
  await expect(page.locator('.course-row')).toHaveCount(3);
  await page.locator('.course-row').filter({ hasText: '情報処理演習' }).getByRole('checkbox').check();
  await expect(page.locator('#selected-count')).toHaveText('1');
  await page.locator('#quarter-filter').selectOption('4');
  await expect(page.locator('.course-row')).toHaveCount(1);
  await expect(page.locator('#selected-count')).toHaveText('0');
  await expect(page.locator('#download-button')).toBeDisabled();
  await page.locator('.course-row').getByRole('checkbox').check();
  await page.locator('#preview').check();
  await page.locator('#download-button').click();
  await expect(page.getByRole('status')).toContainText('取得予定: 1件');
  expect(listingRequests(requests)).toHaveLength(0);
  expect(requests.filter(r => r.params.get('wsfunction') === 'core_course_get_contents')
    .map(r => r.params.get('courseid'))).toEqual(['456']);
  expect(downloads).toBe(0);
  await page.locator('#mode-assignments').click();
  await expect(page.locator('#materials-panel')).toBeHidden();
  await expect(page.locator('.assignment-course-group')).toHaveCount(1);
  await expect(page.locator('#assignment-summary')).toContainText('更新');
  expect(courseIDs(listingRequests(requests).at(-1))).toEqual([456]);
});

test('changing the quarter during an automatic check discards the old response', async ({ page }) => {
  const { started, release, delayedFulfilled } = await setup(page, { delayStatus: true });
  await started;
  try {
    await page.locator('#quarter-filter').selectOption('4');
    await expect(page.locator('.assignment-course-group')).toHaveCount(1);
    await expect(page.locator('.course-group-title')).toContainText('冬学期の授業');
    release();
    await delayedFulfilled;
    await expect(page.locator('.assignment-course-group')).toHaveCount(1);
    await expect(page.locator('#assignment-list')).not.toContainText('ミニットペーパー');
    await expect(page.locator('#quarter-filter')).toHaveValue('4');
  } finally { release(); }
});

test('cancelling an automatic check discards late results and permits logout', async ({ page }) => {
  const { started, release, delayedFulfilled } = await setup(page, { delayStatus: true });
  await started;
  try {
    await page.getByRole('button', { name: '中止する', exact: true }).click();
    await expect(page.locator('#assignment-button')).toBeEnabled();
    await expect(page.locator('.assignment-row')).toHaveCount(0);
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    release();
    await delayedFulfilled;
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('.assignment-course-group')).toHaveCount(0);
    await expect(page.locator('.assignment-row')).toHaveCount(0);
  } finally { release(); }
});

test('automatic course groups fit a narrow mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.locator('.assignment-course-group')).toHaveCount(3);
  await expect(page.locator('#mode-assignments')).toBeVisible();
  await expect(page.locator('#mode-materials')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
