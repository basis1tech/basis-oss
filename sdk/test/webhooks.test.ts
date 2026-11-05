// Verifies against a delivery recorded from the Basis server's real signing
// code (buildWebhookDelivery), not a re-implementation. If the server's
// scheme changes, re-record fixtures/webhook-delivery.json from it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyWebhookSignature } from "../src/index.ts";

interface Delivery {
  secret: string;
  body: string;
  signature: string;
}

const delivery = JSON.parse(readFileSync(new URL("fixtures/webhook-delivery.json", import.meta.url), "utf8")) as Delivery;
const SECRET = delivery.secret;

describe("verifyWebhookSignature", () => {
  test("accepts the server's own signature (string body)", async () => {
    assert.equal(await verifyWebhookSignature({ payload: delivery.body, signature: delivery.signature, secret: SECRET }), true);
  });

  test("accepts the server's own signature (byte body)", async () => {
    const payload = new TextEncoder().encode(delivery.body);
    assert.equal(await verifyWebhookSignature({ payload, signature: delivery.signature, secret: SECRET }), true);
  });

  test("the scheme is sha256=<hex HMAC of the raw body>", () => {
    const expected = createHmac("sha256", SECRET).update(delivery.body).digest("hex");
    assert.equal(delivery.signature, `sha256=${expected}`);
  });

  test("rejects a tampered body", async () => {
    const tampered = delivery.body.replace('"completed"', '"failed"');
    assert.equal(await verifyWebhookSignature({ payload: tampered, signature: delivery.signature, secret: SECRET }), false);
  });

  test("rejects the wrong secret", async () => {
    assert.equal(await verifyWebhookSignature({ payload: delivery.body, signature: delivery.signature, secret: "other" }), false);
  });

  test("rejects a missing or malformed header", async () => {
    for (const signature of [null, undefined, "", "sha1=abc", delivery.signature.slice(7)]) {
      assert.equal(await verifyWebhookSignature({ payload: delivery.body, signature, secret: SECRET }), false);
    }
  });

  test("rejects a re-serialized body even if semantically equal", async () => {
    const reserialized = JSON.stringify(JSON.parse(delivery.body), null, 2);
    assert.equal(await verifyWebhookSignature({ payload: reserialized, signature: delivery.signature, secret: SECRET }), false);
  });

  test("throws without a secret", async () => {
    await assert.rejects(verifyWebhookSignature({ payload: "{}", signature: "sha256=00", secret: "" }), TypeError);
  });
});
