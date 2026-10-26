import { zipSync } from 'fflate';
import { CancelledError, fileURL, MAX_FILE_BYTES, MoodleError } from './api.js';

export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export function cleanName(value) {
  let text = String(value).replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g,
    entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' })[entity]);
  text = text.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  const chars = Array.from(text);
  while (new TextEncoder().encode(chars.join('')).length > 160) chars.pop();
  return chars.join('') || '名称なし';
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export async function collectMaterials(client, courses, { signal, onCourse = () => {} } = {}) {
  const materials = new Map();
  for (const course of courses) {
    if (signal?.aborted) throw new CancelledError();
    onCourse(course);
    const sections = await client.call('core_course_get_contents', { courseid: course.id }, { signal });
    if (!Array.isArray(sections)) throw new MoodleError('授業の内容を取得できませんでした。');
    for (const section of sections) {
      for (const module of section.modules || []) {
        if (module.uservisible === false) continue;
        for (const item of module.contents || []) {
          if (item.type !== 'file' || !item.fileurl || !item.filename) continue;
          try { fileURL(item.fileurl); } catch { continue; }
          const identity = JSON.stringify([course.id, module.id, item.filepath || '/', item.filename]);
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
          const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
          const path = `${course.id}_${cleanName(course.fullname)}/${section.id}_${cleanName(section.name || '資料')}`
            + `/${module.id}_${cleanName(module.name)}/${key}_${cleanName(item.filename)}`;
          materials.set(path, { item, path, name: cleanName(item.filename), course: cleanName(course.fullname) });
        }
      }
    }
  }
  return [...materials.values()];
}

export async function createArchive(client, materials, { signal, onProgress = () => {} } = {}) {
  const declaredTotal = materials.reduce((sum, { item }) => sum + Math.max(0, Number(item.filesize) || 0), 0);
  if (declaredTotal > MAX_ARCHIVE_BYTES) throw new MoodleError('合計が200 MBを超えています。選ぶ授業を減らして取得してください。');
  const files = Object.create(null);
  const failures = [];
  let bytes = 0, saved = 0;
  for (const [index, material] of materials.entries()) {
    if (signal?.aborted) throw new CancelledError();
    const base = { index, total: materials.length, name: material.name, saved, failed: failures.length };
    onProgress({ ...base, stage: 'file', bytes });
    try {
      const data = await client.file(material.item, {
        signal, maxBytes: Math.min(MAX_FILE_BYTES, MAX_ARCHIVE_BYTES - bytes),
        onBytes: received => onProgress({ ...base, stage: 'file', bytes: bytes + received }),
      });
      files[material.path] = data;
      bytes += data.length;
      saved += 1;
      onProgress({ ...base, stage: 'saved', saved, bytes });
    } catch (error) {
      if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
      if (!(error instanceof MoodleError)) throw error;
      failures.push({ name: material.name, message: error.message });
      onProgress({ ...base, stage: 'failed', message: error.message, failed: failures.length, bytes });
    }
  }
  if (signal?.aborted) throw new CancelledError();
  if (!saved) return { blob: null, saved, failures, bytes };
  onProgress({ stage: 'zip', saved, failed: failures.length, bytes });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (signal?.aborted) throw new CancelledError();
  const archive = zipSync(files, { level: 0 });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (signal?.aborted) throw new CancelledError();
  return { blob: new Blob([archive], { type: 'application/zip' }), saved, failures, bytes };
}
