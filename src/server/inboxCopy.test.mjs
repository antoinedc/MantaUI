import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeInboxCancel,
  describeInboxSetDelivery,
  ATTACHMENTS_NOT_RESTORED,
  SET_DELIVERY_UNCONFIRMED,
  ALREADY_SENT,
  CANCEL_UNCONFIRMED,
  CANCELLED_TEXT_LOST,
} from "./inboxCopy.mjs";

const item = (text, attachmentCount = 0) => ({ id: "m", text, attachmentCount, delivery: "queue" });

test("cancelled + restore → restores the text, no message", () => {
  assert.deepEqual(describeInboxCancel({ outcome: "cancelled", item: item("the text") }, { restore: true }), {
    notice: null,
    error: null,
    restoreText: "the text",
  });
});

test("cancelled without restore (the × button) restores nothing", () => {
  assert.equal(describeInboxCancel({ outcome: "cancelled", item: item("t") }, { restore: false }).restoreText, null);
  assert.equal(describeInboxCancel({ outcome: "cancelled", item: item("t") }).restoreText, null);
});

test("cancelled with attachments adds the re-attach note, only when restoring", () => {
  const withFiles = item("t", 2);
  assert.equal(describeInboxCancel({ outcome: "cancelled", item: withFiles }, { restore: true }).notice, ATTACHMENTS_NOT_RESTORED);
  assert.equal(describeInboxCancel({ outcome: "cancelled", item: withFiles }, { restore: false }).notice, null);
});

test("cancelled WITHOUT item: restore → text-lost notice, no throw, not a failure", () => {
  assert.deepEqual(describeInboxCancel({ outcome: "cancelled" }, { restore: true }), {
    notice: CANCELLED_TEXT_LOST,
    error: null,
    restoreText: null,
  });
});

test("cancelled WITHOUT item and no restore: everything null (the row vanishing is the confirmation)", () => {
  assert.deepEqual(describeInboxCancel({ outcome: "cancelled" }, { restore: false }), {
    notice: null,
    error: null,
    restoreText: null,
  });
});

test("delivered → 'Already sent to the agent', nothing restored", () => {
  assert.deepEqual(describeInboxCancel({ outcome: "delivered" }, { restore: true }), {
    notice: ALREADY_SENT,
    error: null,
    restoreText: null,
  });
});

test("unknown → may still be sent, nothing restored (it could go out twice)", () => {
  assert.deepEqual(describeInboxCancel({ outcome: "unknown" }, { restore: true }), {
    notice: null,
    error: CANCEL_UNCONFIRMED,
    restoreText: null,
  });
});

test("a missing / garbled result is treated as unknown, never as cancelled", () => {
  assert.equal(describeInboxCancel(null, { restore: true }).restoreText, null);
  assert.match(describeInboxCancel(undefined, { restore: true }).error, /may still be sent/);
  assert.equal(describeInboxCancel({}, { restore: true }).error, CANCEL_UNCONFIRMED);
});

test("set-delivery: changed → nothing to show", () => {
  assert.deepEqual(describeInboxSetDelivery({ outcome: "changed" }), { notice: null, error: null });
});

test("set-delivery: delivered → a notice", () => {
  assert.deepEqual(describeInboxSetDelivery({ outcome: "delivered" }), { notice: ALREADY_SENT, error: null });
});

test("set-delivery: unknown / null / garbled → an error, never silent", () => {
  for (const r of [{ outcome: "unknown" }, null, undefined, {}]) {
    assert.deepEqual(describeInboxSetDelivery(r), { notice: null, error: SET_DELIVERY_UNCONFIRMED });
  }
});
