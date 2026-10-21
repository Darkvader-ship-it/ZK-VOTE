import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

const token = "openapi-test-token-32-chars-min!";

const setupApp = async () => {
  process.env.RELAYER_SECRET_KEY =
    "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
  process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
  process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
  process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
  process.env.SOROBAN_RPC_URL = "http://localhost";
  process.env.CORS_ORIGIN = "http://localhost";
  process.env.NETWORK_PASSPHRASE = "Test";
  process.env.RELAYER_AUTH_TOKEN = token;
  process.env.HEALTH_EXPOSE_DETAILS = "true";
  process.env.RELAYER_TEST_MODE = "true";

  const relayer = await import("../src/index.ts");
  return relayer.app;
};

test("GET /health response validates against its OpenAPI response schema", async () => {
  const app = await setupApp();
  const { healthResponseSchema } = await import("../src/openapi.ts");

  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.doesNotThrow(() => healthResponseSchema.parse(res.body));
});

test("GET /ready response validates against its OpenAPI response schema", async () => {
  const app = await setupApp();
  const { readyResponseSchema } = await import("../src/openapi.ts");

  const res = await request(app).get("/ready");
  assert.equal(res.status, 200);
  assert.doesNotThrow(() => readyResponseSchema.parse(res.body));
});

test("GET /config response validates against its OpenAPI response schema", async () => {
  const app = await setupApp();
  const { configResponseSchema } = await import("../src/openapi.ts");

  const res = await request(app).get("/config");
  assert.equal(res.status, 200);
  assert.doesNotThrow(() => configResponseSchema.parse(res.body));
});

test("GET /daos response validates against its OpenAPI response schema", async () => {
  const app = await setupApp();
  const { daosListResponseSchema } = await import("../src/openapi.ts");

  const res = await request(app).get("/daos");
  assert.equal(res.status, 200);
  assert.doesNotThrow(() => daosListResponseSchema.parse(res.body));
});

test("POST /vote error response validates against the shared ErrorResponse schema", async () => {
  const app = await setupApp();
  const { errorResponseSchema } = await import("../src/openapi.ts");

  const res = await request(app)
    .post("/vote")
    .set("Authorization", `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      choice: true,
      nullifier: "0x1",
      root: "0x1",
      proof: { a: "0x", b: "0x", c: "0x" },
    });
  assert.equal(res.status, 400);
  assert.doesNotThrow(() => errorResponseSchema.parse(res.body));
});

test("GET /api-docs/openapi.json serves a valid OpenAPI 3.1 document covering every route", async () => {
  const app = await setupApp();
  const { ENDPOINTS } = await import("../src/openapi.ts");

  const res = await request(app).get("/api-docs/openapi.json");
  assert.equal(res.status, 200);
  assert.equal(res.body.openapi, "3.1.0");
  assert.equal(Object.keys(res.body.paths).length, ENDPOINTS.length);
});
