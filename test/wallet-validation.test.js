process.env.VERCEL = '1';

const assert = require('assert');
const app = require('../server');

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      body: body || {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      end(b) { resolve({ status: this.statusCode, body: b }); },
    };
    app.handle(req, res, (err) => (err ? reject(err) : resolve({ status: 500 })));
  });
}

async function main() {
  const emptyClaim = await request('POST', '/bounties/does-not-exist/claim', { address: '' });
  assert.strictEqual(emptyClaim.status, 400, JSON.stringify(emptyClaim));
  assert.match(String(emptyClaim.body.error || ''), /valid address/i);

  const badClaim = await request('POST', '/bounties/does-not-exist/claim', { address: 'not-a-wallet' });
  assert.strictEqual(badClaim.status, 400);

  const missingClaim = await request('POST', '/bounties/does-not-exist/claim', {});
  assert.strictEqual(missingClaim.status, 400);

  const emptySubmit = await request('POST', '/bounties/does-not-exist/submit', { address: '', submission: 'x' });
  assert.strictEqual(emptySubmit.status, 400);

  console.log('wallet validation tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
