// Prints gzip sizes of the built bundles and fails if the core exceeds the budget.
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET = 30 * 1024;
const dist = join(import.meta.dirname, '..', 'dist');
let failed = false;
for (const f of readdirSync(dist).filter((f) => /\.(js|cjs)$/.test(f))) {
  const gz = gzipSync(readFileSync(join(dist, f))).length;
  const over = gz > BUDGET;
  failed ||= over;
  console.log(`${f.padEnd(28)} ${(gz / 1024).toFixed(1).padStart(6)} KB gzip${over ? '  ✗ over budget' : ''}`);
}
process.exit(failed ? 1 : 0);
