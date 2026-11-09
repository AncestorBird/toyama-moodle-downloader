import { CancelledError, MoodleError, SITE } from './api.js';

const STATUS_LABELS = {
  submitted: '提出済み', new: 'Moodle上は未提出', draft: '下書き（提出未確定）',
  reopened: '再提出待ち', unknown: '確認できませんでした',
};
const isID = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000 ? value : 0;

export function formatDeadline(value) {
  if (!timestamp(value)) return '日時の設定なし（説明を確認）';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value * 1000)) + ' JST';
}

// Convert source HTML to inert text without creating DOM nodes or loading resources.
// Descriptions are never inserted with innerHTML; unknown entities remain readable source text.
export function assignmentText(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
      if (code[0] !== '#') return named[code.toLowerCase()] || entity;
      const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : '';
    }).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();
}

export function normalizeAssignment(course, assignment, response, error = '') {
  const last = response?.lastattempt;
  const team = assignment.teamsubmission === true || assignment.teamsubmission === 1;
  const submission = team ? (last?.teamsubmission || last?.groupsubmission) : last?.submission;
  const warning = response?.warnings != null && (!Array.isArray(response.warnings) || response.warnings.length)
    ? 'Moodleから警告が返ったため、提出状況を確認できませんでした。' : '';
  let state = !error && !warning && submission && Object.hasOwn(STATUS_LABELS, submission.status)
    ? submission.status : 'unknown';
  let statusLabel = STATUS_LABELS[state];
  let groupWarning = '';
  if (team && state === 'submitted' && last?.submissiongroupmemberswhoneedtosubmit?.length) {
    state = 'draft';
    statusLabel = 'グループ提出の確定待ち';
    groupWarning = 'まだ提出を確定していないグループメンバーがいます。';
  }
  const extension = timestamp(last?.extensionduedate);
  const files = [];
  for (const plugin of Array.isArray(submission?.plugins) ? submission.plugins : []) {
    for (const area of Array.isArray(plugin?.fileareas) ? plugin.fileareas : []) {
      for (const file of Array.isArray(area?.files) ? area.files : []) {
        if (typeof file?.filename === 'string') files.push(file.filename);
      }
    }
  }
  return {
    id: assignment.id, courseId: course.id, course: course.fullname, name: assignment.name,
    description: typeof assignment.intro === 'string' ? assignment.intro : '',
    instructions: typeof response?.assignmentdata?.activity === 'string' ? response.assignmentdata.activity
      : typeof assignment.activity === 'string' ? assignment.activity : '',
    url: `${SITE}/mod/assign/view.php?id=${assignment.cmid}`,
    status: state, statusLabel, dueDate: extension || timestamp(assignment.duedate),
    extended: !!extension, files, warning: warning || groupWarning, error,
  };
}

export async function collectAssignments(client, courses, { signal, onProgress = () => {} } = {}) {
  const checkCancelled = () => { if (signal?.aborted) throw new CancelledError(); };
  checkCancelled();
  const selected = new Map();
  for (const course of courses) {
    if (!isID(course?.id) || typeof course.fullname !== 'string') throw new MoodleError('授業の情報が正しくありません。');
    selected.set(course.id, course);
  }
  if (!selected.size) throw new MoodleError('課題を確認する授業を選んでください。');
  const params = Object.fromEntries([...selected.keys()].map((id, index) => [`courseids[${index}]`, id]));
  const listing = await client.call('mod_assign_get_assignments', params, { signal });
  checkCancelled();
  if (!Array.isArray(listing?.courses) || (listing.warnings != null && !Array.isArray(listing.warnings))) {
    throw new MoodleError('課題一覧を取得できませんでした。');
  }
  const warnings = [];
  if (listing.warnings?.length) warnings.push(`閲覧権限などの理由で取得できない項目が ${listing.warnings.length} 件あります。確認できた課題のみ表示します。`);
  const tasks = [];
  const seen = new Set();
  for (const entry of listing.courses) {
    const course = selected.get(entry?.id);
    if (!course || !Array.isArray(entry.assignments)) {
      warnings.push('授業情報の一部を確認できませんでした。');
      continue;
    }
    for (const assignment of entry.assignments) {
      if (assignment?.uservisible === false) continue;
      if (!isID(assignment?.id) || !isID(assignment?.cmid) || typeof assignment.name !== 'string') {
        warnings.push('情報が不完全な課題を表示できませんでした。');
        continue;
      }
      if (seen.has(assignment.id)) continue;
      seen.add(assignment.id);
      tasks.push({ course, assignment });
    }
  }
  const items = [];
  for (const [index, { course, assignment }] of tasks.entries()) {
    checkCancelled();
    onProgress({ index, total: tasks.length, course: course.fullname, name: assignment.name });
    let response, error = '';
    try {
      response = await client.call('mod_assign_get_submission_status', { assignid: assignment.id }, { signal });
    } catch (cause) {
      if (cause instanceof CancelledError || signal?.aborted) throw new CancelledError();
      error = cause instanceof MoodleError ? cause.message : '提出状況の取得に失敗しました。';
    }
    checkCancelled();
    items.push(normalizeAssignment(course, assignment, response, error));
  }
  items.sort((a, b) => (a.dueDate || Infinity) - (b.dueDate || Infinity)
    || a.course.localeCompare(b.course, 'ja') || a.id - b.id);
  return { items, warnings, checkedAt: Date.now() };
}
