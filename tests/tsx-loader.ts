import { registerHooks } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';
const sources = new Map<string, string>();
const root = new URL('../src/web/', import.meta.url);
for (const file of readdirSync(root).filter((file) => file.endsWith('.tsx'))) {
  const url = new URL(file, root),
    result = await transformWithOxc(readFileSync(url, 'utf8'), fileURLToPath(url), {
      lang: 'tsx',
      jsx: { runtime: 'automatic' },
      sourcemap: true,
    });
  sources.set(
    url.href,
    result.code +
      '\n//# sourceMappingURL=data:application/json;base64,' +
      Buffer.from(JSON.stringify(result.map)).toString('base64'),
  );
}
registerHooks({
  load(url, context, nextLoad) {
    const source = sources.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: 'module', shortCircuit: true, source };
  },
});
