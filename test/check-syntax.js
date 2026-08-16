/**
 * src/ の全 .gs ファイルの構文チェックと、
 * ファイルをまたいだグローバル名の重複チェック。
 *
 * GASは全ファイルを1つの名前空間に展開するため、
 * 同名の function / const が2つあると後勝ちで静かに壊れる。
 * これはエディタ上では気づきにくいので機械的に検出する。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.gs'));

let bad = 0;
const names = {};

files.forEach(f => {
  const src = fs.readFileSync(path.join(SRC, f), 'utf8');
  const tmp = path.join(os.tmpdir(), 'chk_' + f.replace(/\.gs$/, '.js'));
  fs.writeFileSync(tmp, src);
  try {
    execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
    console.log('✅ ' + f);
  } catch (e) {
    bad++;
    console.log('❌ ' + f + '\n' + (e.stderr || '').toString().split('\n').slice(0, 4).join('\n'));
  }
  fs.unlinkSync(tmp);

  src.split('\n').forEach(line => {
    const m = line.match(/^function\s+([A-Za-z0-9_$]+)/) || line.match(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/);
    if (m) (names[m[1]] = names[m[1]] || []).push(f);
  });
});

const dupes = Object.keys(names).filter(n => new Set(names[n]).size > 1);
console.log('');
if (dupes.length) {
  console.log('❌ 複数ファイルで同じ名前が定義されています（GASでは後勝ちで壊れます）:');
  dupes.forEach(n => console.log('   ' + n + ' → ' + [...new Set(names[n])].join(', ')));
  process.exit(1);
}
console.log('✅ グローバル名の重複なし');

const doGets = files.filter(f => /^function doGet\b/m.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
if (doGets.length > 1) {
  console.log('❌ doGet が複数あります: ' + doGets.join(', '));
  process.exit(1);
}
console.log('✅ doGet は ' + (doGets[0] || 'なし'));

if (bad) process.exit(1);
