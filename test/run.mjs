import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: {
    '$app/environment': './test/stubs/environment.ts',
    $lib: './src/lib'
  }
};

const suites = ['store', 'migration'];

for (const suite of suites) {
  await build({
    ...common,
    entryPoints: [`test/${suite}.test.ts`],
    outfile: `node_modules/.cache/${suite}-test.mjs`
  });
}

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [`node_modules/.cache/${suite}-test.mjs`], {
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
