import test from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, MoodleClient, MoodleError, SITE } from '../../src/api.js';
import { collectAssignments, formatDeadline, normalizeAssignment } from '../../src/assignments.js';

const course = { id: 123, fullname: '情報処理演習' };
const deadline = Date.parse('2026-11-17T09:00:00Z') / 1000;
const assignment = { id: 7, cmid: 70, name: '課題2', intro: '<p>PDFとモデルを提出</p>', duedate: deadline };
const status = (value = 'submitted', extra = {}) => ({
  lastattempt: {
    submission: { status: value, plugins: [{ type: 'file', fileareas: [{ files: [{ filename: 'report.pdf' }] }] }] },
    extensionduedate: 0, ...extra,
  },
  warnings: [],
});

test('assignment reads send tokens in POST bodies and cannot invoke submission APIs', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ courses: [], warnings: [] }));
  });
  const client = new MoodleClient('assignment-test-token');
  await client.call('mod_assign_get_assignments', { 'courseids[0]': 123 });
  await client.call('mod_assign_get_submission_status', { assignid: 7 });
  for (const { url, options } of requests) {
    assert.equal(url, SITE + '/webservice/rest/server.php');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body.get('wstoken'), 'assignment-test-token');
  }
  await assert.rejects(client.call('mod_assign_submit_for_grading', { assignmentid: 7 }), /読み取り/);
  assert.equal(requests.length, 2);
});

test('assignment deadline uses the personal extension and Japan time', () => {
  const extended = deadline + 86400;
  const row = normalizeAssignment(course, assignment, status('submitted', { extensionduedate: extended }));
  assert.equal(row.dueDate, extended);
  assert.equal(row.extended, true);
  assert.equal(row.status, 'submitted');
  assert.deepEqual(row.files, ['report.pdf']);
  assert.equal(row.url, SITE + '/mod/assign/view.php?id=70');
  assert.match(formatDeadline(extended), /2026/);
  assert.match(formatDeadline(extended), /11[/-]18/);
  assert.match(formatDeadline(extended), /18:00/);
});

test('text-based deadlines and paper-submission notes remain available when no due date is configured', () => {
  const intro = '<p>各回の翌週火曜13時まで。紙で提出済みの人は不要。</p>';
  const row = normalizeAssignment(course, { ...assignment, duedate: 0, intro }, status('new'));
  assert.equal(row.dueDate, 0);
  assert.equal(row.description, intro);
  assert.notEqual(formatDeadline(0), formatDeadline(deadline));
  assert.equal(row.status, 'new');
});

test('additional activity instructions returned with the status are retained for the assignment details', () => {
  const response = { ...status('new'), assignmentdata: { activity: '<p>実験後の翌週火曜13時に提出。</p>' } };
  const row = normalizeAssignment(course, { ...assignment, activity: '<p>古い案内</p>' }, response);
  assert.equal(row.instructions, response.assignmentdata.activity);
  assert.equal(normalizeAssignment(course, { ...assignment, activity: '<p>補足指示</p>' }, status()).instructions,
    '<p>補足指示</p>');
});

test('drafts, reopened attempts and missing submission records are not marked submitted', () => {
  assert.equal(normalizeAssignment(course, assignment, status('draft')).status, 'draft');
  assert.equal(normalizeAssignment(course, assignment, status('reopened')).status, 'reopened');
  assert.equal(normalizeAssignment(course, assignment, { lastattempt: {} }).status, 'unknown');
  assert.equal(normalizeAssignment(course, assignment, status('unexpected-status')).status, 'unknown');
});

test('team submissions use group status rather than the empty individual submission', () => {
  const row = normalizeAssignment(course, { ...assignment, teamsubmission: 1 }, status('new', {
    teamsubmission: { status: 'submitted', plugins: [{ type: 'file', fileareas: [{ files: [{ filename: 'group.pdf' }] }] }] },
  }));
  assert.equal(row.status, 'submitted');
  assert.deepEqual(row.files, ['group.pdf']);
});

test('group work without a group record is unknown even if the individual record says submitted', () => {
  const row = normalizeAssignment(course, { ...assignment, teamsubmission: 1 }, status('submitted'));
  assert.equal(row.status, 'unknown');
});

test('group work awaiting another member confirmation is not presented as fully submitted', () => {
  const row = normalizeAssignment(course, { ...assignment, teamsubmission: 1 }, status('new', {
    teamsubmission: { status: 'submitted', plugins: [] },
    submissiongroupmemberswhoneedtosubmit: [{ id: 20, fullname: 'Other student' }],
  }));
  assert.equal(row.status, 'draft');
  assert.ok(row.warning);
  assert.ok(!JSON.stringify(row).includes('Other student'));
});

test('a status response with warnings is not treated as a confirmed submission', () => {
  const row = normalizeAssignment(course, assignment, {
    ...status(), warnings: [{ warningcode: '1', message: 'private server details' }],
  });
  assert.equal(row.status, 'unknown');
  assert.ok(row.warning);
  assert.ok(!JSON.stringify(row).includes('private server details'));
});

test('selected-course fetch retains partial failures as unknown and reports inaccessible items', async () => {
  const calls = [];
  const client = { async call(fn, params) {
    calls.push({ fn, params });
    if (fn === 'mod_assign_get_assignments') return {
      courses: [{ id: 123, fullname: course.fullname, assignments: [assignment, { ...assignment, id: 8, cmid: 80 }] }],
      warnings: [{ item: 'module', itemid: 99, warningcode: '1', message: 'private server details' }],
    };
    if (params.assignid === 8) throw new MoodleError('状態を取得できませんでした。');
    return status();
  } };
  const result = await collectAssignments(client, [course]);
  assert.equal(calls[0].fn, 'mod_assign_get_assignments');
  assert.equal(Number(calls[0].params['courseids[0]']), 123);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find(item => item.id === 7).status, 'submitted');
  assert.equal(result.items.find(item => item.id === 8).status, 'unknown');
  assert.ok(result.warnings.length);
  assert.ok(!JSON.stringify(result).includes('private server details'));
  assert.ok(result.checkedAt);
});

test('cancellation stops assignment checks without converting cancellation into an unknown result', async () => {
  const controller = new AbortController();
  let statusCalls = 0;
  const client = { async call(fn) {
    if (fn === 'mod_assign_get_assignments') return {
      courses: [{ id: 123, assignments: [assignment, { ...assignment, id: 8, cmid: 80 }] }], warnings: [],
    };
    statusCalls++;
    controller.abort();
    throw new CancelledError();
  } };
  await assert.rejects(collectAssignments(client, [course], { signal: controller.signal }), CancelledError);
  assert.equal(statusCalls, 1);
});

test('a malformed assignment listing does not produce a misleading empty success', async () => {
  const client = { async call() { return {}; } };
  await assert.rejects(collectAssignments(client, [course]), MoodleError);
});
