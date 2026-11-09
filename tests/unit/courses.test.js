import test from 'node:test';
import assert from 'node:assert/strict';
import { courseMetadata, courseYears, defaultCourseScope, filterCourses } from '../../src/courses.js';

const courses = [
  { id: 1, fullname: '2026_Q3_火2_オブジェクト指向_片桐　' },
  { id: 2, fullname: '2026_Q3_月4_ヒューマンコンピュータインタラクション_野澤' },
  { id: 3, fullname: '2026_Q4_木1_情報理論_玉木' },
  { id: 4, fullname: '2026_Q1_水3_情報倫理_沖野' },
  { id: 5, fullname: '2026_Q2_火3_離散数学_菊島' },
  { id: 6, fullname: '2025_Q3_火2_プログラミング入門_担当教員' },
  { id: 7, fullname: '2026_情報共有_学修ガイドライン' },
  { id: 8, fullname: '個別の連絡用コース' },
];

test('recognized Toyama course names have concise titles while preserving their original names', () => {
  assert.deepEqual(courseMetadata(courses[0]), {
    year: '2026', quarter: '3', title: 'オブジェクト指向 · 片桐',
    originalName: courses[0].fullname, termLabel: '2026年度 · Q3',
  });
  assert.equal(courseMetadata({ fullname: '2026_Q3_知能情報工学実験Ｂ_担当教員' }).title,
    '知能情報工学実験Ｂ · 担当教員');
});

test('unclassified names stay intact and remain reachable with all/other scopes', () => {
  assert.equal(courseMetadata(courses[6]).title, courses[6].fullname);
  assert.equal(courseMetadata(courses[7]).quarter, 'other');
  assert.deepEqual(filterCourses(courses, { quarter: 'other' }).map(course => course.id), [7, 8]);
  assert.equal(filterCourses(courses).length, courses.length);
  assert.deepEqual(filterCourses(courses, { year: '2026', quarter: 'other' }).map(course => course.id), [7]);
});

test('course identifiers provide a year fallback without inventing a quarter or altering the name', () => {
  const item = { id: 12, fullname: '専門演習', shortname: '2026_176208' };
  assert.equal(courseMetadata(item).year, '2026');
  assert.equal(courseMetadata(item).quarter, 'other');
  assert.equal(courseMetadata(item).title, '専門演習');
  assert.deepEqual(courseYears([...courses, item]), ['2026', '2025']);
});

test('scope filters intersect year, quarter and full-name/title/id search without mutating courses', () => {
  const before = JSON.stringify(courses);
  assert.deepEqual(filterCourses(courses, { year: '2026', quarter: '3' }).map(course => course.id), [1, 2]);
  assert.deepEqual(filterCourses(courses, { year: '2026', quarter: '3', query: '片桐' }), [courses[0]]);
  assert.deepEqual(filterCourses(courses, { query: '  2026_Q4  ' }), [courses[2]]);
  assert.deepEqual(filterCourses(courses, { query: '８' }), [courses[7]]);
  assert.equal(JSON.stringify(courses), before);
});

test('term parsing accepts full-width metadata and renders source markup as inert title text', () => {
  const item = { id: 10, fullname: '<b>２０２６＿Ｑ３＿火２＿ＡＩ演習＿担当教員</b>' };
  const parsed = courseMetadata(item);
  assert.equal(parsed.year, '2026');
  assert.equal(parsed.quarter, '3');
  assert.equal(parsed.title, 'ＡＩ演習 · 担当教員');
  assert.deepEqual(filterCourses([item], { year: '2026', quarter: '3', query: 'ai演習' }), [item]);
  assert.equal(courseMetadata({ fullname: '2026_Q3_Q4_複数学期の授業' }).quarter, 'other');
});

test('initial scope uses the current JST academic year and represented quarter', () => {
  assert.deepEqual(defaultCourseScope(courses, new Date('2026-11-09T12:00:00Z')),
    { year: '2026', quarter: '3' });
  assert.deepEqual(defaultCourseScope(courses, new Date('2027-02-10T00:00:00Z')),
    { year: '2026', quarter: '4' });
  assert.deepEqual(defaultCourseScope(courses, new Date('2026-06-01T00:00:00Z')),
    { year: '2026', quarter: '2' });
});

test('JST midnight determines academic-year and quarter boundaries independent of host timezone', () => {
  const boundaryCourses = [
    { id: 11, fullname: '2025_Q4_前年度の授業' },
    { id: 12, fullname: '2026_Q1_新年度の授業' },
    { id: 13, fullname: '2026_Q4_冬の授業' },
  ];
  assert.deepEqual(defaultCourseScope(boundaryCourses, new Date('2026-03-31T14:59:59Z')),
    { year: '2025', quarter: '4' });
  assert.deepEqual(defaultCourseScope(boundaryCourses, new Date('2026-03-31T15:00:00Z')),
    { year: '2026', quarter: '1' });
  assert.deepEqual(defaultCourseScope(boundaryCourses, new Date('2026-11-30T15:00:00Z')),
    { year: '2026', quarter: '4' });
});

test('missing current-year or quarter data falls back to a useful nonempty scope', () => {
  assert.deepEqual(defaultCourseScope([courses[2]], new Date('2026-11-09T12:00:00Z')),
    { year: '2026', quarter: 'all' });
  assert.deepEqual(defaultCourseScope([courses[5]], new Date('2026-11-09T12:00:00Z')),
    { year: '2025', quarter: '3' });
  assert.deepEqual(defaultCourseScope([courses[7]], new Date('2026-11-09T12:00:00Z')),
    { year: 'all', quarter: 'all' });
  assert.deepEqual(defaultCourseScope([], new Date('2026-11-09T12:00:00Z')),
    { year: 'all', quarter: 'all' });
});
