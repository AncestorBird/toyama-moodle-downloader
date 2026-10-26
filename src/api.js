export const SITE = 'https://moodle52.u-toyama.ac.jp';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const READ_FUNCTIONS = new Set([
  'core_webservice_get_site_info', 'core_enrol_get_users_courses', 'core_course_get_contents',
]);

export class MoodleError extends Error {}
export class CancelledError extends MoodleError {
  constructor() { super('取得を中止しました。'); }
}

export function validateURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new MoodleError('取得先URLが正しくありません。'); }
  if (url.origin !== SITE || url.username || url.password) {
    throw new MoodleError('取得先が対象のMoodle以外のため中止しました。');
  }
  return url;
}

export function fileURL(value) {
  const url = validateURL(value);
  if (url.pathname === '/pluginfile.php' || url.pathname.startsWith('/pluginfile.php/')) {
    url.pathname = '/webservice' + url.pathname;
  }
  if (url.pathname !== '/webservice/pluginfile.php' && !url.pathname.startsWith('/webservice/pluginfile.php/')) {
    throw new MoodleError('対応していないファイル取得URLです。');
  }
  url.searchParams.delete('token');
  url.searchParams.delete('wstoken');
  url.hash = '';
  return url;
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new CancelledError();
}

async function readBytes(response, maxBytes, signal, onBytes = () => {}) {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new MoodleError('応答サイズが上限を超えました。授業を分けて取得してください。');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new MoodleError('応答サイズが上限を超えました。');
    return bytes;
  }
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      checkCancelled(signal);
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new MoodleError('応答サイズが上限を超えました。授業を分けて取得してください。');
      chunks.push(value);
      onBytes(size);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function post(url, params, { signal, maxBytes = MAX_JSON_BYTES, onBytes } = {}) {
  validateURL(url);
  checkCancelled(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 45000);
  try {
    const response = await fetch(url, {
      method: 'POST', body: new URLSearchParams(params),
      mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (!response.ok) throw new MoodleError(`MoodleからHTTP ${response.status}が返りました。`);
    const bytes = await readBytes(response, maxBytes, signal, onBytes);
    return { bytes, type: response.headers.get('content-type') || '' };
  } catch (error) {
    if (signal?.aborted) throw new CancelledError();
    if (error instanceof MoodleError) throw error;
    throw new MoodleError('Moodleと通信できませんでした。ネット接続、サイトの稼働状況、ブラウザからの接続許可を確認してください。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function apiError(data) {
  if (!data || typeof data !== 'object' || !(data.exception || data.errorcode || data.error)) return;
  const code = String(data.errorcode || 'apierror').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const hints = {
    invalidlogin: 'ユーザー名・パスワードを確認してください。',
    invalidtoken: 'ログインし直してください。',
    requirecorrectaccess: 'このアカウントではAPIを利用できません。',
    servicenotavailable: 'このアカウントではモバイルAPIを利用できません。',
    forcepasswordchangenotice: '大学のサイトでパスワード変更が必要です。',
  };
  throw new MoodleError(`Moodle APIエラー: ${code}。${hints[code] || 'API権限や追加認証を確認してください。'}`);
}

async function requestJSON(path, params, options) {
  const { bytes } = await post(SITE + path, params, options);
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new MoodleError('APIからJSON以外の応答が返りました。'); }
  apiError(data);
  return data;
}

export class MoodleClient {
  #token;
  constructor(token) { this.#token = token; }
  clear() { this.#token = null; }

  async call(name, params = {}, options) {
    if (!READ_FUNCTIONS.has(name)) throw new MoodleError('読み取り用API以外は呼び出せません。');
    if (!this.#token) throw new MoodleError('ログインしてください。');
    return requestJSON('/webservice/rest/server.php', {
      ...params, wstoken: this.#token, wsfunction: name, moodlewsrestformat: 'json',
    }, options);
  }

  async file(item, { signal, maxBytes = MAX_FILE_BYTES, onBytes } = {}) {
    if (!this.#token) throw new MoodleError('ログインしてください。');
    if (Number(item.filesize) > maxBytes) throw new MoodleError('資料がサイズ上限を超えています。CLI版で取得してください。');
    const { bytes, type } = await post(fileURL(item.fileurl).href,
      { token: this.#token, forcedownload: 1 }, { signal, maxBytes, onBytes });
    if (type.includes('text/html') && !String(item.mimetype || '').startsWith('text/html')) {
      throw new MoodleError('資料の代わりにログインページが返りました。');
    }
    if (bytes.length <= MAX_JSON_BYTES) {
      let data;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* 通常の資料 */ }
      if (data?.errorcode && (data.exception || data.message)) apiError(data);
    }
    if (item.filesize != null && bytes.length !== Number(item.filesize)) {
      throw new MoodleError('ファイルサイズが一致しないため保存を中止しました。');
    }
    return bytes;
  }
}

export async function login(username, password, options) {
  if (!username.trim() || !password) throw new MoodleError('ユーザー名とパスワードを入力してください。');
  const result = await requestJSON('/login/token.php', {
    username: username.trim(), password, service: 'moodle_mobile_app',
  }, options);
  if (!result || typeof result.token !== 'string' || !result.token) {
    throw new MoodleError('認証トークンを取得できませんでした。追加認証が必要な可能性があります。');
  }
  const client = new MoodleClient(result.token);
  try {
    const info = await client.call('core_webservice_get_site_info', {}, options);
    if (!Number.isInteger(info.userid)) throw new MoodleError('利用者情報を取得できませんでした。');
    const courses = await client.call('core_enrol_get_users_courses', { userid: info.userid }, options);
    if (!Array.isArray(courses) || courses.some(c => !Number.isInteger(c.id) || typeof c.fullname !== 'string')) {
      throw new MoodleError('授業一覧を取得できませんでした。');
    }
    courses.sort((a, b) => (b.startdate || 0) - (a.startdate || 0) || b.id - a.id);
    return { client, info, courses };
  } catch (error) { client.clear(); throw error; }
}
