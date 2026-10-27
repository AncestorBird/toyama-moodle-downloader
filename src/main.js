import { CancelledError, login, MoodleError } from './api.js';
import { cleanName, collectMaterials, createArchive, formatBytes } from './download.js';

const $ = id => document.getElementById(id);
let session = null;
let operation = null;
let archiveURL = null;
const selected = new Set();

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function busy(active) {
  $('login-button').disabled = active;
  for (const id of ['username', 'password', 'show-password', 'remember']) $(id).disabled = active;
  for (const id of ['logout-button', 'course-search', 'select-all', 'preview']) $(id).disabled = active || !session;
  $('download-button').disabled = active || !session || !selected.size;
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

function visibleCourses() {
  const query = $('course-search').value.trim().toLocaleLowerCase();
  return (session?.courses || []).filter(course =>
    `${cleanName(course.fullname)} ${course.id}`.toLocaleLowerCase().includes(query));
}

function selection() {
  $('selected-count').textContent = selected.size;
  $('download-button').disabled = !!operation || !selected.size;
  const shown = visibleCourses();
  $('select-all').textContent = shown.length && shown.every(course => selected.has(course.id))
    ? '表示中の選択を解除' : '表示中をすべて選択';
}

function renderCourses() {
  const fragment = document.createDocumentFragment();
  const courses = visibleCourses();
  for (const course of courses) {
    const row = document.createElement('label');
    row.className = 'course-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = course.id;
    checkbox.checked = selected.has(course.id);
    checkbox.disabled = !!operation;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(course.id); else selected.delete(course.id);
      selection();
    });
    const text = document.createElement('span');
    text.className = 'course-name';
    const name = document.createElement('strong');
    name.textContent = cleanName(course.fullname);
    const id = document.createElement('span');
    id.textContent = `授業ID ${course.id}`;
    text.append(name, id);
    row.append(checkbox, text);
    fragment.append(row);
  }
  if (!courses.length) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = session.courses.length ? '検索条件に合う授業はありません。' : '登録されている授業はありません。';
    fragment.append(empty);
  }
  $('course-list').replaceChildren(fragment);
  selection();
}

function log(message, state = '') {
  const row = document.createElement('p');
  row.className = `log-row ${state}`;
  row.textContent = message;
  $('activity-log').append(row);
  $('activity-log').scrollTop = $('activity-log').scrollHeight;
}

function errorMessage(error) {
  return error instanceof MoodleError ? error.message : '処理に失敗しました。再度お試しください。';
}

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
        }).catch(() => {
          $('password-note').textContent = 'ブラウザに保存を依頼できませんでした。パスワードマネージャーの設定を確認してください。';
        });
      } catch {
        $('password-note').textContent = 'ブラウザに保存を依頼できませんでした。パスワードマネージャーの設定を確認してください。';
      }
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
    $('course-count').textContent = `${session.courses.length}件の授業`;
    renderCourses();
    status(`ログインしました。資料を取得する授業を選んでください。`);
  } catch (error) {
    session?.client.clear();
    session = null;
    status(errorMessage(error), !(error instanceof CancelledError));
  } finally {
    operation = null;
    busy(false);
  }
});

$('logout-button').addEventListener('click', () => {
  if (operation) return;
  session?.client.clear();
  session = null;
  selected.clear();
  clearArchive();
  $('login-form').hidden = false;
  $('session-box').hidden = true;
  $('password').value = '';
  $('remember').checked = false;
  $('course-search').value = '';
  $('account-heading').textContent = 'Moodleにログイン';
  $('course-count').textContent = '未接続';
  $('selected-count').textContent = '0';
  $('course-list').replaceChildren(initialEmptyState.cloneNode(true));
  $('activity-log').replaceChildren();
  status('ログアウトしました。保存したパスワードの削除は、ブラウザのパスワードマネージャーから行えます。');
  busy(false);
});

$('course-search').addEventListener('input', renderCourses);
$('select-all').addEventListener('click', () => {
  const shown = visibleCourses();
  const remove = shown.every(course => selected.has(course.id));
  for (const course of shown) { if (remove) selected.delete(course.id); else selected.add(course.id); }
  renderCourses();
});

$('download-button').addEventListener('click', async () => {
  if (operation || !session || !selected.size) return;
  const courses = session.courses.filter(course => selected.has(course.id));
  const preview = $('preview').checked;
  const controller = new AbortController();
  operation = controller;
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
    busy(false);
  }
});

$('cancel-button').addEventListener('click', () => {
  operation?.abort();
  $('cancel-button').disabled = true;
  status('処理を中止しています…');
});

const initialEmptyState = $('course-list').firstElementChild.cloneNode(true);
$('login-button').disabled = false;
