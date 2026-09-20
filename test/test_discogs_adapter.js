const fs = require('fs');
const path = require('path');
const SRC_DIR = path.join(__dirname, '..', 'src') + '/';

global.Logger = { log: () => {} };
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperties: () => ({}),
    getProperty: () => null,
    setProperty: () => {}
  })
};

const srcCfg = fs.readFileSync(SRC_DIR + 'config.gs', 'utf8');
const srcAdapters = fs.readFileSync(SRC_DIR + 'channel-adapters.gs', 'utf8');

const testCode = `
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

CONFIG.DISCOGS_TOKEN = '';
var missing = DiscogsAdapter.isConfigured();
assert(missing.ok === false, 'missing token must fail closed');

CONFIG.DISCOGS_TOKEN = 'discogs-test-token';
var cfg = DiscogsAdapter.isConfigured();
assert(cfg.ok === true, 'token should configure adapter');

var steps = DiscogsAdapter.buildStopSteps('12345');
assert(steps.length === 1, 'one stop step');
assert(steps[0].name === 'deleteListing', 'stop step name');
assert(steps[0].request.method === 'delete', 'stop uses DELETE');
assert(steps[0].request.url === 'https://api.discogs.com/marketplace/listings/12345', 'listing URL');
assert(steps[0].request.headers.Authorization === 'Discogs token=discogs-test-token', 'token auth header');
assert(steps[0].request.headers['User-Agent'].indexOf('7thleaf-ReuseOS') !== -1, 'descriptive User-Agent');

assert(DiscogsAdapter.interpretStop('deleteListing', 204, '').success === true, '204 stop success');
assert(DiscogsAdapter.interpretStop('deleteListing', 404, '').success === true, '404 idempotent stop success');
assert(DiscogsAdapter.interpretStop('deleteListing', 500, 'boom').success === false, '500 stop failure');

var verify404 = DiscogsAdapter.interpretVerify(404, '');
assert(verify404.verified === true, '404 verify means listing absent');

var verifyLive = DiscogsAdapter.interpretVerify(200, JSON.stringify({status:'For Sale'}));
assert(verifyLive.verified === false, 'For Sale must remain unsafe');

['Draft','Expired','Sold'].forEach(function(status) {
  var r = DiscogsAdapter.interpretVerify(200, JSON.stringify({status:status}));
  assert(r.verified === true, status + ' should be non-purchasable');
});

var unknown = DiscogsAdapter.interpretVerify(200, JSON.stringify({status:'Something New'}));
assert(unknown.verified === null, 'unknown status must fail closed');

console.log('✅ DISCOGS ADAPTER ASSERTIONS PASSED (external API calls: 0)');
`;

eval(srcCfg + '\n' + srcAdapters + '\n' + testCode);
