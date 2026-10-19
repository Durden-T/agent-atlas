export const keywords = ['agent', 'harness', 'skill', 'claude', 'codex'] as const;
export interface SearchWork {
  kind: 'search';
  bucket: string;
  keyword: string;
  page: number;
  pushedDate: string | null;
  start: string | null;
  end: string | null;
  grain: 'root' | 'early' | 'year' | 'month' | 'day' | 'stars';
  starMin: number;
  starMax: number | null;
  done: boolean;
}
export const queryFor = (work: SearchWork) =>
  [
    `${work.keyword} in:name,description,readme`,
    'is:public fork:false',
    work.starMax !== null ? `stars:${work.starMin}..${work.starMax}` : `stars:>=${work.starMin}`,
    work.pushedDate ? `pushed:>=${work.pushedDate}` : '',
    work.start && work.end
      ? `created:${work.start}..${new Date(Date.parse(work.end) - 86400000).toISOString().slice(0, 10)}`
      : work.start
        ? `created:>=${work.start}`
        : work.end
          ? `created:<${work.end}`
          : '',
  ]
    .filter(Boolean)
    .join(' ');
const date = (year: number, month = 0, day = 1) =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
export function splitSearch(work: SearchWork, highestStar: number, year: number): SearchWork[] {
  const common = { ...work, page: 1, done: false };
  if (work.grain === 'root')
    return [
      { ...common, start: null, end: '2008-01-01', grain: 'early' },
      ...Array.from({ length: year - 2008 + 1 }, (_, i) => ({
        ...common,
        start: date(2008 + i),
        end: date(2009 + i),
        grain: 'year' as const,
      })),
    ];
  const y = work.start ? Number(work.start.slice(0, 4)) : year,
    m = work.start ? Number(work.start.slice(5, 7)) - 1 : 0;
  if (work.grain === 'year')
    return Array.from({ length: 12 }, (_, i) => ({
      ...common,
      start: date(y, i),
      end: date(y, i + 1),
      grain: 'month' as const,
    }));
  if (work.grain === 'month')
    return Array.from({ length: new Date(Date.UTC(y, m + 1, 0)).getUTCDate() }, (_, i) => ({
      ...common,
      start: date(y, m, i + 1),
      end: date(y, m, i + 2),
      grain: 'day' as const,
    }));
  const high = work.starMax ?? highestStar,
    mid = Math.floor((work.starMin + high) / 2);
  if (high <= work.starMin) return [];
  return [
    { ...common, grain: 'stars', starMax: mid },
    { ...common, grain: 'stars', starMin: mid + 1, starMax: high },
  ];
}
