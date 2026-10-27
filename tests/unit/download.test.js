import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { CancelledError, MoodleError, SITE } from '../../src/api.js';
import { cleanName, collectMaterials, createArchive, formatBytes, MAX_ARCHIVE_BYTES } from '../../src/download.js';

const item = { type: 'file', filename: '../資料.pdf', filepath: '/', fileurl: SITE + '/pluginfile.php/1/file.pdf', filesize: 3 };
const materials = [{ item, path: '授業/資料.pdf', name: '資料.pdf', course: '授業' }];

test('safe names preserve Japanese and stay inside byte limits', () => {
  assert.equal(cleanName('<b>授業</b> &amp; 資料/../'), '授業 & 資料_.._');
  assert.equal(cleanName(' .. '), '名称なし');
  assert.ok(new TextEncoder().encode(cleanName('あ😀'.repeat(100))).length <= 160);
  assert.ok(!cleanName('a\\b/c:*?').includes('/'));
});

test('material discovery ignores external, hidden and non-file items, and deduplicates', async () => {
  const sections = [{ id: 2, name: '../第1回', modules: [
    { id: 3, name: '資料', contents: [item, item, { ...item, fileurl: 'https://example.com/file' }, { ...item, type: 'url' }] },
    { id: 4, name: '非表示', uservisible: false, contents: [item] },
  ] }];
  const client = { call: async () => sections };
  const found = await collectMaterials(client, [{ id: 1, fullname: 'テスト授業' }]);
  assert.equal(found.length, 1);
  assert.match(found[0].path, /^1_テスト授業\/2_.*\/3_資料\/[a-f0-9]{16}_/);
  assert.ok(!found[0].path.split('/').includes('..'));
});

test('ZIP contains intact bytes with Japanese folder names', async () => {
  const client = { file: async () => new Uint8Array([1, 2, 3]) };
  const result = await createArchive(client, materials);
  assert.equal(result.saved, 1);
  assert.equal(result.bytes, 3);
  assert.deepEqual(result.failures, []);
  const zip = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.deepEqual(zip['授業/資料.pdf'], new Uint8Array([1, 2, 3]));
});

test('a failed file is reported while successful files remain available', async () => {
  const client = { file: async value => { if (value.bad) throw new MoodleError('取得エラー'); return new Uint8Array([1]); } };
  const result = await createArchive(client, [...materials, { item: { ...item, bad: true }, path: 'bad.pdf', name: 'bad.pdf' }]);
  assert.equal(result.saved, 1);
  assert.equal(result.failures[0].message, '取得エラー');
  assert.ok(result.blob);
  const zip = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.deepEqual(Object.keys(zip), ['授業/資料.pdf']);
});

test('cancellation produces no archive and stops further downloads', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = { file: async () => { calls++; controller.abort(); return new Uint8Array([1]); } };
  await assert.rejects(createArchive(client, [...materials, ...materials], { signal: controller.signal }), CancelledError);
  assert.equal(calls, 1);
});

test('oversized batches are rejected before downloading', async () => {
  let called = false;
  const client = { file: async () => { called = true; } };
  await assert.rejects(createArchive(client, [{ ...materials[0], item: { filesize: MAX_ARCHIVE_BYTES + 1 } }]), /1 GB/);
  assert.equal(called, false);
});

test('declared batches above 200 MiB and at exactly 1 GiB reach the download step', async () => {
  assert.equal(MAX_ARCHIVE_BYTES, 1024 * 1024 * 1024);
  for (const sizes of [Array(6).fill(40 * 1024 * 1024), [...Array(20).fill(50 * 1024 * 1024), 24 * 1024 * 1024]]) {
    const reachedDownload = new Error('test stops before allocating large file bodies');
    let calls = 0;
    const client = { file: async () => { calls++; throw reachedDownload; } };
    const batch = sizes.map((filesize, index) => ({ ...materials[0], path: `file-${index}`, item: { ...item, filesize } }));
    await assert.rejects(createArchive(client, batch), error => error === reachedDownload);
    assert.equal(calls, 1);
  }
});

test('incremental ZIP snapshots each completed file before the next buffer is reused', async () => {
  const buffer = new Uint8Array(3);
  let calls = 0;
  const client = { file: async () => { buffer.fill(++calls); return buffer; } };
  const batch = ['first.pdf', 'second.pdf', 'third.pdf'].map(path => ({ ...materials[0], path }));
  const result = await createArchive(client, batch);
  const zip = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.equal(result.bytes, 9);
  assert.equal(result.saved, 3);
  for (const [index, { path }] of batch.entries()) assert.deepEqual(zip[path], new Uint8Array(3).fill(index + 1));
});

test('cancellation between ZIP entries and before finalization produces no archive', async () => {
  for (const stage of ['saved', 'zip']) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(createArchive({ file: async () => { calls++; return new Uint8Array([1]); } }, materials, {
      signal: controller.signal,
      onProgress: progress => { if (progress.stage === stage) controller.abort(); },
    }), CancelledError);
    assert.equal(calls, 1);
  }
});

test('large sizes are shown in gigabytes', () => {
  assert.equal(formatBytes(MAX_ARCHIVE_BYTES), '1.0 GB');
  assert.equal(formatBytes(50 * 1024 * 1024), '50.0 MB');
});

test('direct saving writes each file before downloading the next and closes a valid ZIP', async () => {
  const chunks = [];
  let closed = false;
  const writable = {
    write: async chunk => { await Promise.resolve(); chunks.push(chunk.slice()); },
    close: async () => { closed = true; },
    abort: async () => { assert.fail('successful ZIP must not abort'); },
  };
  let calls = 0;
  const client = { file: async () => {
    if (calls) assert.ok(chunks.length > 0, 'previous file must already be written');
    return new Uint8Array([++calls]);
  } };
  const result = await createArchive(client, [...materials, { ...materials[0], path: 'second.pdf' }], { writable });
  assert.equal(result.direct, true);
  assert.equal(result.blob, null);
  assert.equal(closed, true);
  const zip = unzipSync(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  assert.deepEqual(zip['授業/資料.pdf'], new Uint8Array([1]));
  assert.deepEqual(zip['second.pdf'], new Uint8Array([2]));
});

test('direct saving aborts on cancellation, write failure, or invalid batch', async () => {
  for (const mode of ['cancel', 'write-error', 'oversized']) {
    const controller = new AbortController();
    let aborted = false, closed = false;
    const failure = new Error('mock disk failure');
    const writable = {
      write: async () => { if (mode === 'write-error') throw failure; },
      close: async () => { closed = true; },
      abort: async () => { aborted = true; },
    };
    const batch = mode === 'oversized' ? [{ ...materials[0], item: { filesize: MAX_ARCHIVE_BYTES + 1 } }] : materials;
    await assert.rejects(createArchive({ file: async () => new Uint8Array([1]) }, batch, {
      writable, signal: controller.signal,
      onProgress: progress => { if (mode === 'cancel' && progress.stage === 'zip') controller.abort(); },
    }), error => mode === 'write-error' ? error === failure : error instanceof MoodleError);
    assert.equal(aborted, true);
    assert.equal(closed, false);
  }
});

test('empty material lists do not create empty ZIPs', async () => {
  const result = await createArchive({}, []);
  assert.equal(result.blob, null);
  assert.equal(result.saved, 0);
});

test('untrusted IDs cannot become ZIP directory components', async () => {
  for (const bad of ['../../../../outside', '1', 0, -1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ['course', 'section', 'module']) {
      const course = { id: field === 'course' ? bad : 1, fullname: '授業' };
      const module = { id: field === 'module' ? bad : 3, name: '資料', contents: [item] };
      const section = { id: field === 'section' ? bad : 2, modules: [module] };
      await assert.rejects(collectMaterials({ call: async () => [section] }, [course]), MoodleError);
    }
  }
});

test('unsafe archive paths are rejected before any download', async () => {
  for (const path of ['../outside', '/absolute', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:evil', 'a\x00b', 'a/.. /b', 'a/nul.txt', 'a/file.']) {
    let calls = 0;
    await assert.rejects(createArchive({ file: async () => { calls++; } }, [{ ...materials[0], path }]), MoodleError);
    assert.equal(calls, 0);
  }
});

test('very long names truncate without splitting UTF-8 characters', { timeout: 2000 }, () => {
  assert.equal(cleanName('あ😀'.repeat(100000)), 'あ😀'.repeat(22) + 'あ');
  assert.equal(cleanName('<'.repeat(100000)), '_'.repeat(160));
  assert.equal(cleanName('a' + ' '.repeat(100000) + 'b'), 'a');
});
