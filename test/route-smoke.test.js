#!/usr/bin/env node
/**
 * Smoke-test critical routes without starting a listener (Vercel-safe export).
 */
process.env.VERCEL = "1";

const assert = require("assert");
const app = require("../server");

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = { method, url: path, headers: {} };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      getHeader(k) {
        return this.headers[k.toLowerCase()];
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
      send(body) {
        resolve({ status: this.statusCode, body });
      },
      end(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    app.handle(req, res, (err) => (err ? reject(err) : resolve({ status: 500 })));
  });
}

async function main() {
  const health = await request("GET", "/health");
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.status, "ok");

  const stats = await request("GET", "/stats");
  assert.strictEqual(stats.status, 200);
  assert.ok(typeof stats.body.totalBounties === "number");

  const bounties = await request("GET", "/bounties");
  assert.strictEqual(bounties.status, 200);
  assert.ok(Array.isArray(bounties.body));

  const apiBounties = await request("GET", "/api/bounties");
  assert.strictEqual(apiBounties.status, 200);
  assert.ok(Array.isArray(apiBounties.body));

  const x402 = await request("GET", "/.well-known/x402");
  assert.strictEqual(x402.status, 200);

  console.log("route smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
