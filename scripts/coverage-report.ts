import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
interface FileCoverage {
  path: string;
  totalLineCount: number;
  coveredLineCount: number;
  coveredLinePercent: number;
}
interface Summary {
  files: FileCoverage[];
  totals: FileCoverage;
}
export default async function* report(
  events: AsyncIterable<{ type: string; data: { summary?: Summary } }>,
) {
  for await (const event of events) {
    if (event.type !== 'test:coverage' || !event.data.summary) continue;
    const summary = event.data.summary;
    mkdirSync('coverage', { recursive: true });
    writeFileSync('coverage/node-summary.json', JSON.stringify(summary, null, 2));
    const files: FileCoverage[] = [];
    function visit(path: string) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts')) {
          const covered = summary.files.find((f) => resolve(f.path) === resolve(file));
          files.push(
            covered ?? {
              path: file,
              totalLineCount: readFileSync(file, 'utf8').split('\n').length,
              coveredLineCount: 0,
              coveredLinePercent: 0,
            },
          );
        }
      }
    }
    visit('src');
    const total = files.reduce((n, f) => n + f.totalLineCount, 0),
      covered = files.reduce((n, f) => n + f.coveredLineCount, 0),
      percent = (100 * covered) / total;
    writeFileSync(
      'coverage/overall-summary.json',
      JSON.stringify(
        {
          method:
            'Conservative: every unloaded source file counts as zero; loaded TSX uses inline source maps.',
          files,
          total,
          covered,
          percent,
        },
        null,
        2,
      ),
    );
    yield `Conservative whole-application line coverage: ${percent.toFixed(2)}% (${covered}/${total}); unloaded files, including App and main, count as zero.\n`;
    if (percent < 70) throw new Error('Whole-application coverage is below 70%');
    const core = files.filter((f) => /collection|judgment|shared/.test(f.path)),
      coreTotal = core.reduce((n, f) => n + f.totalLineCount, 0),
      coreCovered = core.reduce((n, f) => n + f.coveredLineCount, 0);
    yield `Core discovery, lifecycle, classification and shared rules: ${((100 * coreCovered) / coreTotal).toFixed(2)}% (${coreCovered}/${coreTotal}).\n`;
    if (coreCovered / coreTotal < 0.95) throw new Error('Core coverage is below 95%');
  }
}
