import { CancelledError, login, MoodleError } from './api.js';
import { cleanName, collectMaterials, createArchive, formatBytes } from './download.js';
import { assignmentText, collectAssignments, formatDeadline } from './assignments.js';
import { courseMetadata, courseYears, defaultCourseScope, filterCourses } from './courses.js';

const $ = id => document.getElementById(id);
let session = null;
let operation = null;
let operationKind = null;
let mode = 'assignments';
let archiveURL = null;
let assignmentResults = null;
let assignmentCourses = [];
let assignmentState = 'idle';
let autoTimer = null;
const selected = new Set();
const pending = item => ['new', 'draft', 'reopened'].includes(item.status);

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function scope() {
  return { year: $('year-filter').value, quarter: $('quarter-filter').value, query: $('course-search').value };
}
function visibleCourses() { return filterCourses(session?.courses || [], scope()); }

function busy(active = !!operation) {
  const blocking = !!operation && operationKind !== 'assignments';
  $('login-button').disabled = active;
  for (const id of ['username', 'password', 'show-password', 'remember']) $(id).disabled = active;
  $('logout-button').disabled = !session || blocking;
  for (const id of ['mode-assignments', 'mode-materials']) $(id).disabled = blocking;
  for (const id of ['year-filter', 'quarter-filter', 'course-search']) $(id).disabled = !session || blocking;
  for (const id of ['select-all', 'preview']) $(id).disabled = active || !session;
  $('download-button').disabled = active || !session || mode !== 'materials' || !selected.size;
  $('assignment-button').disabled = active || !session || !visibleCourses().length;
  $('assignment-filter').disabled = !session;
  for (const input of $('course-list').querySelectorAll('input')) input.disabled = active;
  $('cancel-button').hidden = !active;
  $('cancel-button').disabled = !active;
  $('progress').hidden = !active;
  if (active) $('progress').removeAttribute('value');
  else $('progress').value = 0;
  $('login-button').textContent = active && !session ? '接続しています…' : 'ログイン →';
}

function clearArchive() {
  if (archiveURL) URL.revokeObjectURL(archiveURL);
  archiveURL = null;
  $('archive-link').hidden = true;
  $('archive-link').removeAttribute('href');
}

function stopAssignmentCheck() {
  clearTimeout(autoTimer);
  autoTimer = null;
  if (operationKind === 'assignments') {
    operation.abort();
    operation = null;
    operationKind = null;
  }
}

function resetAssignments(state = 'idle') {
  assignmentResults = null;
  assignmentCourses = session ? visibleCourses() : [];
  assignmentState = state;
  $('assignment-warnings').replaceChildren();
  renderAssignments();
}

function node(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

function assignmentRow(item) {
  const row = document.createElement('article');
  row.className = 'assignment-row';
  const title = document.createElement('h3');
  const link = node('a', assignmentText(item.name) || '名称なし');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  title.append(link);
  const meta = document.createElement('div');
  meta.className = 'assignment-meta';
  meta.append(node('span', item.statusLabel, `assignment-state ${item.status}`),
    node('span', `締切: ${formatDeadline(item.dueDate)}${item.extended ? '（個別延長）' : ''}`));
  row.append(title, meta);
  for (const message of [item.warning, item.error].filter(Boolean)) row.append(node('p', message, 'assignment-warning'));
  const details = document.createElement('details');
  details.append(node('summary', '課題の説明・提出ファイル'));
  details.append(node('p', assignmentText(item.description) || '説明文はありません。課題名のリンクからMoodleを確認してください。', 'assignment-description'));
  if (item.instructions && item.instructions !== item.description) {
    details.append(node('p', `課題の指示\n${assignmentText(item.instructions)}`, 'assignment-description'));
  }
  details.append(node('p', item.files.length ? `登録ファイル: ${item.files.join('、')}`
    : '登録ファイルは取得されませんでした。オンラインテキストや紙での提出は授業の指示を確認してください。', 'assignment-description'));
  row.append(details);
  return row;
}

function renderAssignments() {
  const items = assignmentResults?.items || [];
  const unknown = items.filter(item => item.status === 'unknown').length;
  const open = items.filter(pending).length;
  const done = items.filter(item => item.status === 'submitted').length;
  $('assignment-summary').textContent = assignmentResults
    ? `${assignmentCourses.length}授業 · 未提出等 ${open}件 / 要確認 ${unknown}件 / 提出済み ${done}件 · ${formatDeadline(Math.floor(assignmentResults.checkedAt / 1000))} 更新`
    : assignmentState === 'loading' ? `${assignmentCourses.length}授業の提出状況を確認しています…`
      : session ? 'この範囲の提出状況はまだ確認できていません。' : 'ログインすると、対象の授業を自動で確認します。';
  $('assignment-warnings').replaceChildren(...(assignmentResults?.warnings || []).map(message => node('p', message)));
  const fragment = document.createDocumentFragment();
  const filter = $('assignment-filter').value;
  for (const course of assignmentCourses) {
    const metadata = courseMetadata(course);
    const courseItems = items.filter(item => item.courseId === course.id);
    const coursePending = courseItems.filter(pending);
    const courseUnknown = courseItems.filter(item => item.status === 'unknown');
    const shown = courseItems.filter(item => filter === 'all' || (filter === 'pending'
      ? pending(item) || item.status === 'unknown' : item.status === filter));
    const group = document.createElement('details');
    group.className = 'assignment-course-group';
    group.dataset.courseId = course.id;
    group.open = !!assignmentResults && (coursePending.length > 0 || courseUnknown.length > 0 || filter !== 'pending');
    const summary = document.createElement('summary');
    const heading = document.createElement('span');
    heading.append(node('strong', metadata.title, 'course-group-title'), node('span', metadata.termLabel, 'course-group-term'));
    const counts = !assignmentResults ? (assignmentState === 'loading' ? '確認中' : '未確認')
      : courseItems.length ? `未提出等 ${coursePending.length} · 要確認 ${courseUnknown.length} · 提出済み ${courseItems.filter(item => item.status === 'submitted').length}`
        : '取得できる課題なし';
    summary.append(heading, node('span', counts, 'course-group-counts'));
    const deadlines = coursePending.filter(item => item.dueDate).map(item => item.dueDate).sort((a, b) => a - b);
    const next = deadlines.find(value => value >= Date.now() / 1000) || deadlines[0];
    if (next) summary.append(node('span', `締切 ${formatDeadline(next)}`, 'course-group-next'));
    group.append(summary);
    if (!assignmentResults) {
      group.append(node('p', assignmentState === 'loading' ? '課題と提出状況を確認しています。'
        : '確認が完了していません。「再確認」で取得できます。', 'no-results'));
    } else if (!shown.length) {
      group.append(node('p', courseItems.length ? 'この表示条件に合う課題はありません。表示を「すべて」にすると提出済みの課題も見られます。'
        : '取得できる課題はありませんでした。非公開・閲覧制限のある課題や小テストは含みません。', 'no-results'));
    } else for (const item of shown) group.append(assignmentRow(item));
    const materials = node('button', 'この授業の資料を保存', 'text-button course-materials-button');
    materials.type = 'button';
    materials.addEventListener('click', () => {
      changeMode('materials');
      selected.clear();
      selected.add(course.id);
      renderCourses();
      $('materials-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    group.append(materials);
    fragment.append(group);
  }
  if (!assignmentCourses.length) {
    fragment.append(node('p', session ? 'この範囲に授業はありません。年度・クォーター・検索条件を変更してください。'
      : 'ログイン後、年度とクォーターで対象を絞れます。未提出・要確認の課題から授業ごとに表示します。', 'no-results'));
  }
  $('assignment-list').replaceChildren(fragment);
}

function selection() {
  $('selected-count').textContent = selected.size;
  const shown = visibleCourses();
  $('select-all').textContent = shown.length && shown.every(course => selected.has(course.id))
    ? '表示中の選択を解除' : '表示中をすべて選択';
  busy();
}

function renderCourses() {
  const fragment = document.createDocumentFragment();
  const courses = visibleCourses();
  for (const course of courses) {
    const metadata = courseMetadata(course);
    const row = document.createElement('label');
    row.className = 'course-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = course.id;
    checkbox.checked = selected.has(course.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(course.id); else selected.delete(course.id);
      selection();
    });
    const text = document.createElement('span');
    text.className = 'course-name';
    text.append(node('strong', metadata.title), node('span', `${metadata.termLabel} · 授業ID ${course.id}`));
    row.append(checkbox, text);
    fragment.append(row);
  }
  if (!courses.length) fragment.append(node('p', session ? 'この範囲に授業はありません。絞り込みを変更してください。'
    : 'ログインすると、資料を保存する授業を選べます。', 'no-results'));
  $('course-list').replaceChildren(fragment);
  $('course-count').textContent = session ? `${courses.length}件の授業` : '未接続';
  const year = $('year-filter').selectedOptions[0]?.textContent || 'すべての年度';
  const quarter = $('quarter-filter').selectedOptions[0]?.textContent || 'すべて';
  $('scope-summary').textContent = session ? `${year} / ${quarter} · 対象 ${courses.length}授業`
    : 'ログインすると、現在の時期に合わせた範囲が選ばれます。';
  selection();
}

function initializeScope() {
  $('year-filter').replaceChildren(new Option('すべての年度', 'all'),
    ...courseYears(session.courses).map(year => new Option(`${year}年度`, year)));
  const initial = defaultCourseScope(session.courses);
  $('year-filter').value = initial.year;
  $('quarter-filter').value = initial.quarter;
  $('course-search').value = '';
  $('assignment-filter').value = 'pending';
}

function scheduleAssignmentCheck(delay = 0) {
  stopAssignmentCheck();
  resetAssignments('loading');
  busy();
  if (!session || mode !== 'assignments') return;
  if (!visibleCourses().length) {
    assignmentState = 'idle';
    renderAssignments();
    status('対象の授業がありません。絞り込みを変更してください。');
    return;
  }
  autoTimer = setTimeout(() => { autoTimer = null; checkAssignments(); }, delay);
}

async function checkAssignments() {
  if (!session || mode !== 'assignments' || (operation && operationKind !== 'assignments')) return;
  stopAssignmentCheck();
  const currentSession = session;
  const courses = visibleCourses();
  if (!courses.length) return;
  const controller = new AbortController();
  operation = controller;
  operationKind = 'assignments';
  resetAssignments('loading');
  busy(true);
  status(`${courses.length}授業の未提出・提出状況を自動で確認しています…`);
  try {
    const result = await collectAssignments(currentSession.client, courses, {
      signal: controller.signal,
      onProgress: ({ index, total, course, name }) => {
        if (operation !== controller) return;
        $('progress').max = total;
        $('progress').value = index;
        status(`${index + 1}/${total}件 · ${courseMetadata({ fullname: course }).title} · ${assignmentText(name)}`);
      },
    });
    if (controller.signal.aborted) throw new CancelledError();
    if (session !== currentSession || operation !== controller) return;
    assignmentResults = result;
    assignmentCourses = courses;
    assignmentState = 'ready';
    renderAssignments();
    const incomplete = result.warnings.length || result.items.some(item => item.status === 'unknown');
    status(`${courses.length}授業・${result.items.length}件の確認が終わりました。${incomplete ? '確認できない情報があります。注意と各授業の表示を確認してください。' : '授業ごとに提出状況をまとめました。'}`, !!incomplete);
  } catch (error) {
    if (operation === controller && session === currentSession) {
      resetAssignments(error instanceof CancelledError ? 'cancelled' : 'error');
      status(errorMessage(error), !(error instanceof CancelledError));
    }
  } finally {
    if (operation === controller) { operation = null; operationKind = null; busy(false); }
  }
}

function changeMode(next) {
  if (operation && operationKind !== 'assignments') return;
  stopAssignmentCheck();
  mode = next;
  $('mode-assignments').setAttribute('aria-pressed', mode === 'assignments');
  $('mode-materials').setAttribute('aria-pressed', mode === 'materials');
  $('assignment-panel').hidden = mode !== 'assignments';
  $('materials-panel').hidden = mode !== 'materials';
  renderCourses();
  if (mode === 'assignments' && session) scheduleAssignmentCheck();
  else status(session ? '資料を保存する授業を選んでください。保存ボタンを押すまでダウンロードは始まりません。'
    : 'Moodleにログインしてください。');
}

function scopeChanged(delay = 0) {
  selected.clear();
  renderCourses();
  if (mode === 'assignments') scheduleAssignmentCheck(delay);
  else status('保存対象を絞り込みました。授業を選んでください。');
}

function log(message, state = '') {
  const row = node('p', message, `log-row ${state}`);
  $('activity-log').append(row);
  $('activity-log').scrollTop = $('activity-log').scrollHeight;
}
function errorMessage(error) { return error instanceof MoodleError ? error.message : '処理に失敗しました。再度お試しください。'; }

const canStorePassword = typeof window.PasswordCredential === 'function' && !!navigator.credentials?.store;
const canSaveDirectly = typeof window.showSaveFilePicker === 'function';
$('remember-option').hidden = !canStorePassword;
if (canSaveDirectly) document.querySelector('.download-hint').append(' ZIPの保存先を選んでから取得します。');

$('show-password').addEventListener('click', () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('show-password').textContent = show ? '隠す' : '表示';
  $('show-password').setAttribute('aria-label', `パスワードを${show ? '隠す' : '表示'}`);
  $('show-password').setAttribute('aria-pressed', show);
});

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (operation) return;
  const controller = new AbortController();
  operation = controller;
  operationKind = 'login';
  busy(true);
  status('Moodleにログインして、授業一覧を取得しています…');
  try {
    const username = $('username').value.trim();
    const password = $('password').value;
    session = await login(username, password, { signal: controller.signal });
    if (canStorePassword && $('remember').checked) {
      try {
        const credential = new PasswordCredential({ id: username, password, name: cleanName(session.info.fullname || username) });
        Promise.resolve(navigator.credentials.store(credential)).then(() => {
          $('password-note').textContent = '保存・自動入力の設定は、ブラウザのパスワードマネージャーで確認できます。';
        }).catch(() => { $('password-note').textContent = 'ブラウザに保存を依頼できませんでした。パスワードマネージャーの設定を確認してください。'; });
      } catch { $('password-note').textContent = 'ブラウザに保存を依頼できませんでした。'; }
    }
    $('password').value = '';
    $('password').type = 'password';
    $('show-password').textContent = '表示';
    $('show-password').setAttribute('aria-pressed', 'false');
    $('show-password').setAttribute('aria-label', 'パスワードを表示');
    $('login-form').hidden = true;
    $('session-box').hidden = false;
    $('account-name').textContent = cleanName(session.info.fullname || username);
    $('account-heading').textContent = 'ログイン中';
    initializeScope();
    renderCourses();
    resetAssignments();
    status('ログインしました。資料を保存する授業を選んでください。');
  } catch (error) {
    session?.client.clear();
    session = null;
    status(errorMessage(error), !(error instanceof CancelledError));
  } finally {
    operation = null;
    operationKind = null;
    busy(false);
  }
  if (session && mode === 'assignments') scheduleAssignmentCheck();
});

$('logout-button').addEventListener('click', () => {
  if (operation && operationKind !== 'assignments') return;
  stopAssignmentCheck();
  session?.client.clear();
  session = null;
  selected.clear();
  clearArchive();
  $('login-form').hidden = false;
  $('session-box').hidden = true;
  $('password').value = '';
  $('remember').checked = false;
  $('course-search').value = '';
  $('year-filter').replaceChildren(new Option('すべての年度', 'all'));
  $('quarter-filter').value = 'all';
  $('assignment-filter').value = 'pending';
  $('account-heading').textContent = 'Moodleにログイン';
  $('account-name').textContent = '';
  $('activity-log').replaceChildren();
  resetAssignments();
  renderCourses();
  status('ログアウトしました。保存したパスワードの削除はブラウザの設定から行えます。');
  busy(false);
});

$('mode-assignments').addEventListener('click', () => changeMode('assignments'));
$('mode-materials').addEventListener('click', () => changeMode('materials'));
$('year-filter').addEventListener('change', () => scopeChanged());
$('quarter-filter').addEventListener('change', () => scopeChanged());
$('course-search').addEventListener('input', () => scopeChanged(250));
$('select-all').addEventListener('click', () => {
  const shown = visibleCourses();
  const remove = shown.every(course => selected.has(course.id));
  for (const course of shown) { if (remove) selected.delete(course.id); else selected.add(course.id); }
  renderCourses();
});
$('assignment-filter').addEventListener('change', renderAssignments);
$('assignment-button').addEventListener('click', () => checkAssignments());

$('download-button').addEventListener('click', async () => {
  if (operation || !session || mode !== 'materials' || !selected.size) return;
  const courses = session.courses.filter(course => selected.has(course.id));
  const preview = $('preview').checked;
  const controller = new AbortController();
  operation = controller;
  operationKind = 'download';
  clearArchive();
  $('activity-log').replaceChildren();
  busy(true);
  let writable = null;
  try {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const filename = `moodle-materials-${date}.zip`;
    if (!preview && canSaveDirectly) {
      status('ZIPの保存先を選んでください。');
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'ZIPファイル', accept: { 'application/zip': ['.zip'] } }],
      });
      writable = await handle.createWritable();
    }
    const materials = await collectMaterials(session.client, courses, {
      signal: controller.signal,
      onCourse: course => status(`${cleanName(course.fullname)} の資料一覧を確認しています…`),
    });
    if (!materials.length) {
      status('選択した授業に、取得できるMoodle内のファイルはありませんでした。');
      return;
    }
    if (preview) {
      for (const material of materials) log(`${material.course} / ${material.name}`);
      status(`取得予定: ${materials.length}件。資料はまだ保存していません。`);
      return;
    }
    const result = await createArchive(session.client, materials, {
      signal: controller.signal, writable,
      onProgress: progress => {
        if (progress.stage === 'zip') {
          $('progress').removeAttribute('value');
          status(`${progress.saved}件の資料をZIPにまとめています…`);
        } else {
          $('progress').max = progress.total;
          $('progress').value = progress.index;
          status(`${progress.index + 1} / ${progress.total}件 · ${progress.name} · ${formatBytes(progress.bytes)}`);
          if (progress.stage === 'saved') log(`取得済み · ${progress.name}`, 'success');
          if (progress.stage === 'failed') log(`失敗 · ${progress.name} — ${progress.message}`, 'error');
        }
      },
    });
    writable = null;
    if (result.blob) {
      archiveURL = URL.createObjectURL(result.blob);
      $('archive-link').href = archiveURL;
      $('archive-link').download = filename;
      $('archive-link').hidden = false;
      $('archive-link').click();
    }
    status(result.saved
      ? `ZIPを${result.direct ? '保存' : '作成'}しました。取得 ${result.saved}件 / 失敗 ${result.failures.length}件 · ${formatBytes(result.bytes)}`
      : `資料を取得できませんでした。失敗 ${result.failures.length}件。取得結果を確認してください。`, !!result.failures.length);
  } catch (error) {
    if (error?.name === 'AbortError') error = new CancelledError();
    status(errorMessage(error), !(error instanceof CancelledError));
  } finally {
    await writable?.abort().catch(() => {});
    operation = null;
    operationKind = null;
    busy(false);
  }
});

$('cancel-button').addEventListener('click', () => {
  clearTimeout(autoTimer);
  autoTimer = null;
  operation?.abort();
  $('cancel-button').disabled = true;
  status('処理を中止しています…');
});

renderCourses();
renderAssignments();
busy(false);
