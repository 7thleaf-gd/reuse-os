const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src') + '/';
const src = fs.readFileSync(SRC_DIR + 'phase1-e2e-preflight.gs', 'utf8');

function runWithConfig(config, testCode) {
  global.CONFIG = config;
  eval(src + '\n' + testCode);
}

const completeSandboxConfig = {
  VISION_API_KEY: 'vision-secret-value',
  GOOGLE_API_KEY: 'google-secret-value',
  DISCOGS_TOKEN: 'discogs-secret-value',
  SHEET_ID: 'sheet-123',
  DRIVE_FOLDER_ID: 'drive-123',
  EBAY_ENV: 'sandbox',
  EBAY_CLIENT_ID: 'client-123',
  EBAY_CLIENT_SECRET: 'client-secret-value',
  EBAY_RUNAME: 'runame-123',
  EBAY_REFRESH_TOKEN: 'refresh-secret-value',
  EBAY_OAUTH_TOKEN: ''
};

runWithConfig(completeSandboxConfig, `
  const result = getPhase1E2EPreflight({});
  if (!result.ok) throw new Error('sandbox should pass');
  if (result.env !== 'sandbox') throw new Error('expected sandbox');
  if (result.mode !== 'READ_ONLY_PREFLIGHT') throw new Error('wrong mode');
  if (result.next !== 'READY_FOR_EXPLICIT_E2E_RUN') throw new Error('wrong next state');

  const serialized = JSON.stringify(result);
  ['vision-secret-value', 'google-secret-value', 'discogs-secret-value', 'client-secret-value', 'refresh-secret-value']
    .forEach(secret => {
      if (serialized.includes(secret)) throw new Error('secret leaked: ' + secret);
    });
`);

runWithConfig({
  ...completeSandboxConfig,
  DISCOGS_TOKEN: '',
  EBAY_REFRESH_TOKEN: '',
  EBAY_OAUTH_TOKEN: ''
}, `
  const result = getPhase1E2EPreflight({});
  if (result.ok) throw new Error('missing config should block');
  if (!result.blockers.includes('core_config')) throw new Error('core_config blocker missing');
  if (!result.blockers.includes('ebay_oauth')) throw new Error('ebay_oauth blocker missing');
  let threw = false;
  try { assertPhase1E2EReady_({}); } catch (e) { threw = true; }
  if (!threw) throw new Error('assert helper must fail closed');
`);

runWithConfig({ ...completeSandboxConfig, EBAY_ENV: 'production' }, `
  const blocked = getPhase1E2EPreflight({ env: 'production' });
  if (blocked.ok) throw new Error('production must be blocked without explicit confirmation');
  if (!blocked.blockers.includes('production_gate')) throw new Error('production_gate blocker missing');

  const allowed = getPhase1E2EPreflight({
    env: 'production',
    productionConfirmation: PHASE1_PRODUCTION_CONFIRMATION
  });
  if (!allowed.ok) throw new Error('explicitly confirmed production should pass when all other checks pass');
`);

runWithConfig({
  ...completeSandboxConfig,
  EBAY_REFRESH_TOKEN: '',
  EBAY_OAUTH_TOKEN: 'temporary-manual-token'
}, `
  const result = getPhase1E2EPreflight({});
  if (!result.ok) throw new Error('manual OAuth token should satisfy preflight auth check');
  if (JSON.stringify(result).includes('temporary-manual-token')) throw new Error('manual token leaked');
`);

console.log('✅ PHASE1 E2E PREFLIGHT ASSERTIONS PASSED');
