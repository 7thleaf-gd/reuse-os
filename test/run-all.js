/**
 * 全テストをまとめて実行する。
 *   npm test
 * もしくは
 *   node test/run-all.js
 *
 * 【これらのテストについて】
 * GASの機能（SpreadsheetApp / PropertiesService / UrlFetchApp / LockService）を
 * 偽物に差し替えて、src/*.gs を素のNode.jsで実行している。
 * 外部APIには一切つながないので、何度実行しても課金も副作用も発生しない。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter(f => f.startsWith('test_') && f.endsWith('.js'))
  .sort();

let failed = 0;
files.forEach(f => {
  process.stdout.write(f.padEnd(30) + ' ');
  try {
    const out = execFileSync('node', [path.join(__dirname, f)], { encoding: 'utf8' });
    console.log(out.trim().split('\n').pop());
  } catch (e) {
    failed++;
    console.log('❌ FAILED');
    console.log((e.stdout || '') + (e.stderr || ''));
  }
});

console.log('');
if (failed) {
  console.log(`❌ ${failed} / ${files.length} スイートが失敗しました`);
  process.exit(1);
}
console.log(`✅ ${files.length} スイート全通過（外部API実通信 0回）`);
