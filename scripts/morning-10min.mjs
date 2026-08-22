#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repo = path.resolve(__dirname, '..');
const claspPath = path.join(repo, '.clasp.json');
const expectedBranch = 'agent/reuse-os-v0.1-e2e';
const dryRun = process.argv.includes('--dry-run');

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim();
}

function runOrFail(cmd, args, label) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd: repo, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`\n✗ ${label} failed. Stop here. Nothing after this gate was executed.`);
    process.exit(r.status || 1);
  }
}

function resolveClasp() {
  const globalVersion = runCapture('clasp', ['--version']);
  if (globalVersion) return { cmd: 'clasp', prefix: [], label: `clasp ${globalVersion}` };
  return { cmd: 'npx', prefix: ['--yes', '@google/clasp'], label: 'npx @google/clasp' };
}

function loadClaspConfig() {
  if (!fs.existsSync(claspPath)) throw new Error('.clasp.json not found');
  return JSON.parse(fs.readFileSync(claspPath, 'utf8'));
}

function isPlaceholder(scriptId) {
  return !scriptId || String(scriptId).includes('ここにApps Script') || String(scriptId).length < 20;
}

function maskScriptId(scriptId) {
  const s = String(scriptId || '');
  if (s.length < 8) return '(unset)';
  return `${s.slice(0, 4)}…${s.slice(-6)}`;
}

async function main() {
  process.chdir(repo);
  console.log('Reuse OS Phase 1 | 10-minute human gate');
  console.log('Policy: Sandbox only / no Production / no secret output');

  const branch = runCapture('git', ['branch', '--show-current']);
  if (!branch) throw new Error('not inside a readable git checkout');
  if (branch !== expectedBranch) {
    console.error(`\n✗ Current branch: ${branch}`);
    console.error(`  Expected: ${expectedBranch}`);
    console.error('  Branch switching is intentionally not automatic. Resolve local changes first, then rerun.');
    process.exit(2);
  }
  console.log(`✓ branch: ${branch}`);

  let cfg = loadClaspConfig();
  console.log(`• local Apps Script binding: ${maskScriptId(cfg.scriptId)}`);

  if (dryRun) {
    console.log('✓ dry-run contract PASS: no binding write, no clasp push, no browser open');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (isPlaceholder(cfg.scriptId)) {
      console.log('\n1/4 Apps Script binding');
      const scriptId = (await rl.question('Paste the target Apps Script scriptId here (local only): ')).trim();
      if (!/^[A-Za-z0-9_-]{20,}$/.test(scriptId)) {
        console.error('✗ scriptId format looks invalid. No file was changed.');
        process.exit(3);
      }
      cfg.scriptId = scriptId;
      fs.writeFileSync(claspPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      console.log(`✓ .clasp.json bound locally: ${maskScriptId(scriptId)}`);
      console.log('  Do not commit this local binding unless the project explicitly decides to track it.');
    } else {
      console.log('✓ existing local scriptId binding found');
    }

    console.log('\n2/4 Local safety verification');
    runOrFail('npm', ['run', 'verify'], 'npm verify');

    const clasp = resolveClasp();
    console.log(`\nUsing ${clasp.label}`);
    runOrFail(clasp.cmd, [...clasp.prefix, 'status'], 'clasp status');

    console.log('\n3/4 Explicit source push gate');
    console.log('Review the clasp status above. This push changes Apps Script source, but does NOT deploy a Web App.');
    const approval = (await rl.question('If the target is correct, type PUSH exactly. Anything else stops safely: ')).trim();
    if (approval !== 'PUSH') {
      console.log('SAFE STOP: no clasp push, no deploy. Rerun npm run morning when ready.');
      return;
    }

    runOrFail(clasp.cmd, [...clasp.prefix, 'push'], 'clasp push');
    console.log('✓ source push complete');

    console.log('\n4/4 Browser handoff');
    console.log('Opening Apps Script project. In the browser do only:');
    console.log('  Deploy → New deployment → Web app');
    console.log('  Execute as: Me');
    console.log('  Access: Only myself');
    console.log('Then copy the Web App URL. Open:');
    console.log('  <WEB_APP_URL>?page=setup');
    console.log('  <WEB_APP_URL>?page=phase1');
    console.log('Stop if the Phase 1 page is not fully green. First real run is Sandbox only.');

    spawnSync(clasp.cmd, [...clasp.prefix, 'open'], { cwd: repo, stdio: 'inherit' });
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
