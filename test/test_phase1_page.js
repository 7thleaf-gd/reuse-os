const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const router = fs.readFileSync(path.join(root, 'src/web-router.gs'), 'utf8');
const page = fs.readFileSync(path.join(root, 'src/phase1-ui.html'), 'utf8');
const preflight = fs.readFileSync(path.join(root, 'src/phase1-e2e-preflight.gs'), 'utf8');
const clasp = JSON.parse(fs.readFileSync(path.join(root, '.clasp.json'), 'utf8'));

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

assert(router.includes("phase1:  { file: 'phase1-ui'"), 'web router must expose the Phase 1 readiness page');
assert(page.includes('.getPhase1E2EPreflight()'), 'Phase 1 page must call the read-only preflight');
assert(!page.includes('assertPhase1E2EReady_('), 'readiness page must not invoke the E2E write gate');
assert(!page.includes('RUN_EBAY_PRODUCTION_ONE_ITEM'), 'readiness page must not contain the Production confirmation token');
assert(!page.includes('UrlFetchApp'), 'readiness page must not perform external API calls');
assert(preflight.includes("mode: 'READ_ONLY_PREFLIGHT'"), 'preflight must remain explicitly read-only');
assert(preflight.includes('production blocked: explicit one-item confirmation is required'), 'Production must remain fail-closed');
assert(Array.isArray(clasp.filePushOrder), '.clasp.json must define filePushOrder');
assert(clasp.filePushOrder.includes('src/phase1-e2e-preflight.gs'), 'clasp push order must include the Phase 1 preflight');

console.log('✅ Phase 1 readiness page safety contract PASS');
