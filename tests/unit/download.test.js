import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { CancelledError, MoodleError, SITE } from '../../src/api.js';
import { cleanName, collectMaterials, createArchive } from '../../src/download.js';

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
  await assert.rejects(createArchive(client, [{ ...materials[0], item: { filesize: 201 * 1024 * 1024 } }]), /200 MB/);
  assert.equal(called, false);
});

test('empty material lists do not create empty ZIPs', async () => {
  const result = await createArchive({}, []);
  assert.equal(result.blob, null);
  assert.equal(result.saved, 0);
});
