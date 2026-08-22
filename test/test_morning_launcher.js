const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'scripts', 'morning-10min.mjs'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(pkg.scripts.morning === 'node scripts/morning-10min.mjs', 'npm morning entry missing');
assert(src.includes("const expectedBranch = 'agent/reuse-os-v0.1-e2e'"), 'expected branch gate missing');
assert(src.includes("approval !== 'PUSH'"), 'exact PUSH approval gate missing');
assert(src.includes("[...clasp.prefix, 'push']"), 'clasp push path missing');
assert(src.indexOf("approval !== 'PUSH'") < src.indexOf("[...clasp.prefix, 'push']"), 'push appears before approval gate');
assert(src.includes("process.argv.includes('--dry-run')"), 'dry-run path missing');
assert(src.includes('no clasp push, no browser open'), 'dry-run no-write declaration missing');
assert(!src.includes("'deploy'"), 'launcher must not invoke clasp deploy');
assert(src.includes('Sandbox only'), 'Sandbox-only policy missing');
assert(src.includes('Do not commit this local binding'), 'local binding warning missing');

console.log('✅ 10-minute morning launcher safety contract PASS');
