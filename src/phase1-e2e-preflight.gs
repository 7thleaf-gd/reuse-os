/**
 * Phase 1 E2E Preflight Gate
 *
 * Real-item eBay E2E must never start from an unknown configuration state.
 * This file performs a read-only readiness check and returns blockers without
 * exposing secret values or calling external APIs.
 *
 * Default policy:
 * - sandbox is allowed when configuration is complete
 * - production is blocked unless the caller supplies the exact confirmation token
 * - no write, no listing creation, no token refresh, no UrlFetchApp call happens here
 */

const PHASE1_PRODUCTION_CONFIRMATION = 'RUN_EBAY_PRODUCTION_ONE_ITEM';

function phase1Check_(id, ok, note) {
  return {
    id: id,
    ok: !!ok,
    note: String(note || '')
  };
}

function phase1MissingKeys_(keys) {
  return keys.filter(function (key) {
    return !CONFIG[key];
  });
}

/**
 * Read-only Phase 1 readiness check.
 *
 * options:
 *   env: 'sandbox' | 'production' (optional; falls back to CONFIG.EBAY_ENV)
 *   productionConfirmation: exact token required only for production
 */
function getPhase1E2EPreflight(options) {
  options = options || {};

  const env = String(options.env || CONFIG.EBAY_ENV || 'sandbox').toLowerCase();
  const checks = [];

  const coreKeys = ['VISION_API_KEY', 'GOOGLE_API_KEY', 'DISCOGS_TOKEN', 'SHEET_ID', 'DRIVE_FOLDER_ID'];
  const missingCore = phase1MissingKeys_(coreKeys);
  checks.push(phase1Check_(
    'core_config',
    missingCore.length === 0,
    missingCore.length ? 'missing: ' + missingCore.join(', ') : 'Hunter / Inventory base configuration present'
  ));

  const validEnv = env === 'sandbox' || env === 'production';
  checks.push(phase1Check_(
    'ebay_env',
    validEnv,
    validEnv ? 'environment: ' + env : 'EBAY_ENV must be sandbox or production'
  ));

  const appMissing = phase1MissingKeys_(['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME']);
  checks.push(phase1Check_(
    'ebay_app',
    appMissing.length === 0,
    appMissing.length ? 'missing eBay app settings: ' + appMissing.join(', ') : 'eBay app settings present'
  ));

  const oauthReady = !!(CONFIG.EBAY_REFRESH_TOKEN || CONFIG.EBAY_OAUTH_TOKEN);
  checks.push(phase1Check_(
    'ebay_oauth',
    oauthReady,
    oauthReady ? 'OAuth material present (value hidden)' : 'eBay OAuth is not connected yet'
  ));

  const productionRequested = env === 'production';
  const productionConfirmed = options.productionConfirmation === PHASE1_PRODUCTION_CONFIRMATION;
  checks.push(phase1Check_(
    'production_gate',
    !productionRequested || productionConfirmed,
    productionRequested
      ? (productionConfirmed
          ? 'production one-item run explicitly confirmed'
          : 'production blocked: explicit one-item confirmation is required')
      : 'sandbox path; production confirmation not required'
  ));

  const blockers = checks.filter(function (check) { return !check.ok; });

  return {
    ok: blockers.length === 0,
    mode: 'READ_ONLY_PREFLIGHT',
    env: env,
    productionRequested: productionRequested,
    checks: checks,
    blockers: blockers.map(function (check) { return check.id; }),
    next: blockers.length === 0
      ? 'READY_FOR_EXPLICIT_E2E_RUN'
      : 'BLOCKED_UNTIL_PREFLIGHT_PASSES'
  };
}

/**
 * Fail-closed helper for any future E2E runner.
 * The runner must call this before any external write.
 */
function assertPhase1E2EReady_(options) {
  const result = getPhase1E2EPreflight(options);
  if (!result.ok) {
    throw new Error('Phase 1 E2E preflight blocked: ' + result.blockers.join(', '));
  }
  return result;
}
