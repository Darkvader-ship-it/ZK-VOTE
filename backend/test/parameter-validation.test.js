/**
 * Parameter Validation Tests
 *
 * Tests route parameter validation for all parameterized endpoints
 */

import { strict as assert } from "assert";
import { test, describe } from "node:test";
import request from "supertest";
import express from "express";
import { validateParams } from "../src/middleware/validate.js";
import {
  daoParamsSchema,
  proposalParamsSchema,
  commentParamsSchema,
  cidParamsSchema,
  nullifierParamsSchema,
  commitmentParamsSchema,
  archiveParamsSchema,
} from "../src/validation/schemas.js";

describe("Parameter Validation Tests", () => {
  // Create test app
  const app = express();
  app.use(express.json());

  // Test routes with parameter validation
  app.get("/dao/:daoId", validateParams(daoParamsSchema), (req, res) => {
    const { daoId } = req.validatedParams;
    res.json({ daoId, type: typeof daoId });
  });

  app.get("/proposal/:daoId/:proposalId", validateParams(proposalParamsSchema), (req, res) => {
    const { daoId, proposalId } = req.validatedParams;
    res.json({ daoId, proposalId, types: [typeof daoId, typeof proposalId] });
  });

  app.get("/comment/:daoId/:proposalId/:commentId", validateParams(commentParamsSchema), (req, res) => {
    const { daoId, proposalId, commentId } = req.validatedParams;
    res.json({ daoId, proposalId, commentId });
  });

  app.get("/ipfs/:cid", validateParams(cidParamsSchema), (req, res) => {
    const { cid } = req.validatedParams;
    res.json({ cid });
  });

  app.get("/bridge/nullifier/:daoId/:proposalId/:nullifier", validateParams(nullifierParamsSchema), (req, res) => {
    const { daoId, proposalId, nullifier } = req.validatedParams;
    res.json({ daoId, proposalId, nullifier });
  });

  app.get("/challenge/:commitment", validateParams(commitmentParamsSchema), (req, res) => {
    const { commitment } = req.validatedParams;
    res.json({ commitment });
  });

  app.get("/archive/:archiveId", validateParams(archiveParamsSchema), (req, res) => {
    const { archiveId } = req.validatedParams;
    res.json({ archiveId });
  });

  describe("DAO ID Parameter Validation", () => {
    test("should accept positive integer", async () => {
      const response = await request(app)
        .get("/dao/123")
        .expect(200);
      
      assert.equal(response.body.daoId, 123);
      assert.equal(response.body.type, "number");
    });

    test("should reject negative integer", async () => {
      await request(app)
        .get("/dao/-1")
        .expect(400);
    });

    test("should reject zero", async () => {
      await request(app)
        .get("/dao/0")
        .expect(400);
    });

    test("should reject non-integer", async () => {
      await request(app)
        .get("/dao/123.45")
        .expect(400);
    });

    test("should reject non-numeric string", async () => {
      await request(app)
        .get("/dao/abc")
        .expect(400);
    });

    test("should reject empty string", async () => {
      await request(app)
        .get("/dao/")
        .expect(404); // Route not matched
    });

    test("should reject very large number", async () => {
      await request(app)
        .get(`/dao/${Number.MAX_SAFE_INTEGER + 1}`)
        .expect(400);
    });
  });

  describe("Proposal Parameters Validation", () => {
    test("should accept valid daoId and proposalId", async () => {
      const response = await request(app)
        .get("/proposal/123/456")
        .expect(200);
      
      assert.equal(response.body.daoId, 123);
      assert.equal(response.body.proposalId, 456);
      assert.deepEqual(response.body.types, ["number", "number"]);
    });

    test("should reject invalid daoId", async () => {
      await request(app)
        .get("/proposal/abc/456")
        .expect(400);
    });

    test("should reject invalid proposalId", async () => {
      await request(app)
        .get("/proposal/123/abc")
        .expect(400);
    });

    test("should reject negative values", async () => {
      await request(app)
        .get("/proposal/-1/456")
        .expect(400);
      
      await request(app)
        .get("/proposal/123/-1")
        .expect(400);
    });
  });

  describe("Comment Parameters Validation", () => {
    test("should accept valid daoId, proposalId, and commentId", async () => {
      const response = await request(app)
        .get("/comment/123/456/789")
        .expect(200);
      
      assert.equal(response.body.daoId, 123);
      assert.equal(response.body.proposalId, 456);
      assert.equal(response.body.commentId, 789);
    });

    test("should reject invalid commentId", async () => {
      await request(app)
        .get("/comment/123/456/abc")
        .expect(400);
    });
  });

  describe("IPFS CID Parameter Validation", () => {
    test("should accept valid CIDv0", async () => {
      const cid = "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o";
      const response = await request(app)
        .get(`/ipfs/${cid}`)
        .expect(200);
      
      assert.equal(response.body.cid, cid);
    });

    test("should accept valid CIDv1 (bafy)", async () => {
      const cid = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
      const response = await request(app)
        .get(`/ipfs/${cid}`)
        .expect(200);
      
      assert.equal(response.body.cid, cid);
    });

    test("should accept valid CIDv1 (bafk)", async () => {
      const cid = "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy";
      const response = await request(app)
        .get(`/ipfs/${cid}`)
        .expect(200);
      
      assert.equal(response.body.cid, cid);
    });

    test("should reject invalid CID format", async () => {
      await request(app)
        .get("/ipfs/invalid-cid")
        .expect(400);
    });

    test("should reject short CID", async () => {
      await request(app)
        .get("/ipfs/Qm123")
        .expect(400);
    });

    test("should reject non-base58 characters in CIDv0", async () => {
      await request(app)
        .get("/ipfs/QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE70") // '0' is invalid
        .expect(400);
    });
  });

  describe("Nullifier Parameter Validation", () => {
    test("should accept valid hex nullifier", async () => {
      const nullifier = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const response = await request(app)
        .get(`/bridge/nullifier/123/456/${nullifier}`)
        .expect(200);
      
      assert.equal(response.body.nullifier, nullifier);
    });

    test("should accept hex without 0x prefix", async () => {
      const nullifier = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const response = await request(app)
        .get(`/bridge/nullifier/123/456/${nullifier}`)
        .expect(200);
      
      assert.equal(response.body.nullifier, nullifier);
    });

    test("should reject non-hex characters", async () => {
      await request(app)
        .get("/bridge/nullifier/123/456/0xGHIJKLMN")
        .expect(400);
    });

    test("should reject too long hex string", async () => {
      const longHex = "0x" + "a".repeat(65);
      await request(app)
        .get(`/bridge/nullifier/123/456/${longHex}`)
        .expect(400);
    });

    test("should reject empty nullifier", async () => {
      await request(app)
        .get("/bridge/nullifier/123/456/")
        .expect(404); // Route not matched
    });
  });

  describe("Commitment Parameter Validation", () => {
    test("should accept valid 64-char hex commitment", async () => {
      const commitment = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const response = await request(app)
        .get(`/challenge/${commitment}`)
        .expect(200);
      
      assert.equal(response.body.commitment, commitment);
    });

    test("should accept commitment with 0x prefix", async () => {
      const commitment = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const response = await request(app)
        .get(`/challenge/${commitment}`)
        .expect(200);
      
      assert.equal(response.body.commitment, commitment);
    });

    test("should reject short commitment", async () => {
      await request(app)
        .get("/challenge/123abc")
        .expect(400);
    });

    test("should reject long commitment", async () => {
      const longCommitment = "a".repeat(65);
      await request(app)
        .get(`/challenge/${longCommitment}`)
        .expect(400);
    });

    test("should reject non-hex commitment", async () => {
      await request(app)
        .get("/challenge/GHIJ1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab")
        .expect(400);
    });
  });

  describe("Archive ID Parameter Validation", () => {
    test("should accept positive archive ID", async () => {
      const response = await request(app)
        .get("/archive/42")
        .expect(200);
      
      assert.equal(response.body.archiveId, 42);
    });

    test("should reject negative archive ID", async () => {
      await request(app)
        .get("/archive/-1")
        .expect(400);
    });

    test("should reject non-numeric archive ID", async () => {
      await request(app)
        .get("/archive/abc")
        .expect(400);
    });
  });

  describe("Error Response Format", () => {
    test("should return 400 status for invalid parameters", async () => {
      const response = await request(app)
        .get("/dao/invalid")
        .expect(400);
      
      assert.equal(response.body.error, "Invalid URL parameters");
      assert(response.body.details);
      assert(Array.isArray(response.body.details));
      assert(response.body.details.length > 0);
    });

    test("should include field information in error details", async () => {
      const response = await request(app)
        .get("/dao/-1")
        .expect(400);
      
      assert(response.body.details);
      const detail = response.body.details[0];
      assert(detail.field);
      assert(detail.message);
      assert(detail.field.includes("daoId"));
      assert(detail.message.includes("positive"));
    });
  });

  describe("Type Coercion", () => {
    test("should convert string numbers to actual numbers", async () => {
      const response = await request(app)
        .get("/dao/123")
        .expect(200);
      
      // Should be converted from string "123" to number 123
      assert.equal(typeof response.body.daoId, "number");
      assert.equal(response.body.daoId, 123);
    });

    test("should handle large numbers within safe range", async () => {
      const largeNum = Number.MAX_SAFE_INTEGER;
      const response = await request(app)
        .get(`/dao/${largeNum}`)
        .expect(200);
      
      assert.equal(response.body.daoId, largeNum);
    });
  });

  describe("Edge Cases", () => {
    test("should handle URL encoded parameters", async () => {
      // Test with URL encoded CID
      const cid = "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o";
      const response = await request(app)
        .get(`/ipfs/${encodeURIComponent(cid)}`)
        .expect(200);
      
      assert.equal(response.body.cid, cid);
    });

    test("should handle multiple parameter validation failures", async () => {
      const response = await request(app)
        .get("/comment/abc/def/ghi")
        .expect(400);
      
      // Should have multiple validation errors
      assert(response.body.details.length >= 3);
    });
  });
});