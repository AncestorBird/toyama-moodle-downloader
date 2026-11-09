import { assignmentText } from './assignments.js';

const YEAR = /^(?:19|20|21)\d{2}$/;
const QUARTER = /^Q([1-4])$/i;
const SCHEDULE = /^[月火水木金土日][1-9](?:[-・][1-9])?$/;
const normalized = value => String(value ?? '').normalize('NFKC').trim();

export function courseMetadata(course) {
  const originalName = typeof course?.fullname === 'string' ? course.fullname : '';
  const name = assignmentText(originalName);
  const segments = name.split(/[_＿]/).map(part => part.trim());
  const first = normalized(segments[0]);
  const shortFirst = normalized(course?.shortname).split(/[_\s-]/)[0];
  const year = YEAR.test(first) ? first : YEAR.test(shortFirst) ? shortFirst : '';
  const quarterParts = segments.map(part => normalized(part).match(QUARTER)).filter(Boolean);
  const quarter = quarterParts.length === 1 ? quarterParts[0][1] : 'other';

  // Only shorten the university's recognized year/quarter prefix. Other names
  // stay intact, rather than guessing which words are a title or an instructor.
  let title = name;
  if (YEAR.test(first) && QUARTER.test(normalized(segments[1]))) {
    let offset = 2;
    if (SCHEDULE.test(normalized(segments[offset]))) offset += 1;
    const rest = segments.slice(offset).filter(Boolean);
    if (rest.length) title = rest.join(' · ');
  }

  return {
    year, quarter, title: title || '名称なし', originalName,
    termLabel: [year ? `${year}年度` : '', quarter === 'other' ? '学期の指定なし' : `Q${quarter}`]
      .filter(Boolean).join(' · '),
  };
}

export function courseYears(courses) {
  return [...new Set(courses.map(course => courseMetadata(course).year).filter(Boolean))]
    .sort((a, b) => Number(b) - Number(a));
}

export function defaultCourseScope(courses, now = new Date()) {
  const instant = new Date(now).getTime();
  if (!Number.isFinite(instant)) throw new RangeError('日付が正しくありません。');
  // Fixed JST keeps browser/device timezone differences out of the initial scope.
  const japan = new Date(instant + 9 * 60 * 60 * 1000);
  const month = japan.getUTCMonth() + 1;
  const academicYear = String(japan.getUTCFullYear() - (month < 4 ? 1 : 0));
  const years = courseYears(courses);
  const year = years.includes(academicYear) ? academicYear : years[0] || 'all';
  // This is a changeable starting point, not an academic-calendar assertion.
  const candidate = month < 4 || month === 12 ? '4'
    : month < 6 ? '1' : month < 10 ? '2' : '3';
  const represented = courses.some(course => {
    const metadata = courseMetadata(course);
    return (year === 'all' || metadata.year === year) && metadata.quarter === candidate;
  });
  return { year, quarter: represented ? candidate : 'all' };
}

export function filterCourses(courses, { year = 'all', quarter = 'all', query = '' } = {}) {
  const search = normalized(query).toLocaleLowerCase('ja-JP');
  return courses.filter(course => {
    const metadata = courseMetadata(course);
    if (String(year) !== 'all' && metadata.year !== String(year)) return false;
    if (String(quarter) !== 'all' && metadata.quarter !== String(quarter)) return false;
    const haystack = normalized(`${metadata.originalName} ${assignmentText(metadata.originalName)} ${metadata.title} ${course.id}`)
      .toLocaleLowerCase('ja-JP');
    return !search || haystack.includes(search);
  });
}
