import { Zip, ZipPassThrough } from 'fflate';
import { CancelledError, fileURL, MAX_FILE_BYTES, MoodleError } from './api.js';

export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export function cleanName(value) {
  let text = String(value).replace(/<[^<>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g,
    entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' })[entity]);
  text = text.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^[ .]+/, '');
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(160));
  return text.slice(0, read).replace(/[ .]+$/g, '') || '名称なし';
}

function requireID(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new MoodleError('資料のIDが正しくありません。');
}

export function validateArchivePath(path) {
  if (typeof path !== 'string' || /[\\:*?"<>|\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => !part || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new MoodleError('ZIPの保存パスが正しくありません。');
  }
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export async function collectMaterials(client, courses, { signal, onCourse = () => {} } = {}) {
  const materials = new Map();
  for (const course of courses) {
    if (signal?.aborted) throw new CancelledError();
    requireID(course.id);
    onCourse(course);
    const sections = await client.call('core_course_get_contents', { courseid: course.id }, { signal });
    if (!Array.isArray(sections)) throw new MoodleError('授業の内容を取得できませんでした。');
    for (const section of sections) {
      requireID(section?.id);
      if (section.modules != null && !Array.isArray(section.modules)) throw new MoodleError('授業の内容が正しくありません。');
      for (const module of section.modules || []) {
        requireID(module?.id);
        if (module.contents != null && !Array.isArray(module.contents)) throw new MoodleError('資料の内容が正しくありません。');
        if (module.uservisible === false) continue;
        for (const item of module.contents || []) {
          if (item.type !== 'file' || !item.fileurl || !item.filename) continue;
          try { fileURL(item.fileurl); } catch { continue; }
          const identity = JSON.stringify([course.id, module.id, item.filepath || '/', item.filename]);
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
          const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
          const path = `${course.id}_${cleanName(course.fullname)}/${section.id}_${cleanName(section.name || '資料')}`
            + `/${module.id}_${cleanName(module.name)}/${key}_${cleanName(item.filename)}`;
          validateArchivePath(path);
          materials.set(path, { item, path, name: cleanName(item.filename), course: cleanName(course.fullname) });
        }
      }
    }
  }
  return [...materials.values()];
}

export async function createArchive(client, materials, { signal, writable, onProgress = () => {} } = {}) {
  // Write ZIP chunks to the destination per file, or snapshot them as Blob
  // parts for browsers without a file picker. Avoid retaining all source buffers
  // and allocating another contiguous copy of the complete ZIP.
  const parts = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw new MoodleError('ZIPの作成に失敗しました。取得する授業を減らしてお試しください。');
    parts.push(writable ? chunk : new Blob([chunk]));
  });
  const failures = [];
  let bytes = 0, saved = 0;
  try {
    for (const material of materials) validateArchivePath(material.path);
    const declaredTotal = materials.reduce((sum, { item }) => sum + Math.max(0, Number(item.filesize) || 0), 0);
    if (declaredTotal > MAX_ARCHIVE_BYTES) throw new MoodleError('合計が1 GBを超えています。選ぶ授業を減らして取得してください。');
    for (const [index, material] of materials.entries()) {
      if (signal?.aborted) throw new CancelledError();
      const base = { index, total: materials.length, name: material.name, saved, failed: failures.length };
      onProgress({ ...base, stage: 'file', bytes });
      let data;
      try {
        data = await client.file(material.item, {
          signal, maxBytes: Math.min(MAX_FILE_BYTES, MAX_ARCHIVE_BYTES - bytes),
          onBytes: received => onProgress({ ...base, stage: 'file', bytes: bytes + received }),
        });
      } catch (error) {
        if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
        if (!(error instanceof MoodleError)) throw error;
        failures.push({ name: material.name, message: error.message });
        onProgress({ ...base, stage: 'failed', message: error.message, failed: failures.length, bytes });
        continue;
      }
      if (signal?.aborted) throw new CancelledError();
      const partStart = parts.length;
      const entry = new ZipPassThrough(material.path);
      zip.add(entry);
      entry.push(data, true);
      if (writable) {
        // Await the destination after every file to keep at most one file queued.
        for (const part of parts) await writable.write(part);
        parts.length = 0;
      } else {
        // Verify asynchronous Blob construction before requesting the next file.
        try {
          await Promise.all(parts.slice(partStart).map(part => part.slice(0, 1).arrayBuffer()));
        } catch {
          throw new MoodleError('ブラウザでZIPデータを保持できませんでした。取得する授業を減らしてお試しください。');
        }
      }
      bytes += data.length;
      saved += 1;
      data = null;
      onProgress({ ...base, stage: 'saved', saved, bytes });
      // Let the browser handle cancellation and release the previous file buffer.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (signal?.aborted) throw new CancelledError();
    if (!saved) {
      await writable?.abort();
      return { blob: null, saved, failures, bytes };
    }
    onProgress({ stage: 'zip', saved, failed: failures.length, bytes });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (signal?.aborted) throw new CancelledError();
    zip.end();
    if (writable) {
      for (const part of parts) await writable.write(part);
      if (signal?.aborted) throw new CancelledError();
      await writable.close();
      return { blob: null, direct: true, saved, failures, bytes };
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    if (signal?.aborted) throw new CancelledError();
    return { blob: new Blob(parts, { type: 'application/zip' }), saved, failures, bytes };
  } catch (error) {
    await writable?.abort().catch(() => {});
    if (signal?.aborted) throw new CancelledError();
    throw error;
  } finally {
    zip.terminate();
    parts.length = 0;
  }
}
