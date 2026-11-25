import assert from "node:assert/strict";
import test from "node:test";
import { draftToPlainText, splitEmailDrafts } from "../../src/lib/email-drafts.ts";

// The exact layout ScenarioProvider produces (backend/app/agent/scenario_provider.py).
const ANSWER = `Perfect! I found 2 orders over $500 that shipped late last month. Following policy EMAIL-01, here are the draft refund emails for each:

---

## **Draft Email 1**

**To:** customer01@example.test  
**Subject:** Refund for Late Delivery - Order ORD-1001

Dear Demo Customer 01,

We sincerely apologize for the delayed delivery of your order ORD-1001 (USD $625.00).

Best regards,  
Operations Team

---

## **Draft Email 2**

**To:** customer06@example.test  
**Subject:** Refund for Late Delivery - Order ORD-1006

Dear Demo Customer 06,

We are sorry for the delay.

---

**Summary:** Found **2 late orders over $500**. All emails are ready for review and sending.`;

test("an answer with drafts splits into intro, one card per draft and a summary", () => {
  const result = splitEmailDrafts(ANSWER);
  assert.ok(result);
  assert.match(result.intro, /^Perfect! I found 2 orders/);
  assert.doesNotMatch(result.intro, /---/);
  assert.equal(result.drafts.length, 2);
  assert.deepEqual(
    result.drafts.map((draft) => [draft.title, draft.to, draft.subject]),
    [
      ["Draft Email 1", "customer01@example.test", "Refund for Late Delivery - Order ORD-1001"],
      ["Draft Email 2", "customer06@example.test", "Refund for Late Delivery - Order ORD-1006"],
    ],
  );
  assert.match(result.drafts[0].body, /^Dear Demo Customer 01,/);
  assert.match(result.drafts[0].body, /Operations Team$/);
  assert.equal(result.drafts[1].body, "Dear Demo Customer 06,\n\nWe are sorry for the delay.");
  assert.equal(result.summary, "Found **2 late orders over $500**. All emails are ready for review and sending.");
});

test("answers without drafts are left to plain markdown rendering", () => {
  assert.equal(splitEmailDrafts("No matching orders were found. No email drafts or refunds were created."), null);
});

test("drafts without bold markers or a summary still split", () => {
  const result = splitEmailDrafts("Intro\n\n### Draft email 1\nTo: a@example.test\nSubject: Hello\n\nBody text");
  assert.deepEqual(result?.drafts, [{ title: "Draft email 1", to: "a@example.test", subject: "Hello", body: "Body text" }]);
  assert.equal(result?.summary, null);
});

test("a copied draft is plain text with To and Subject first", () => {
  const result = splitEmailDrafts(ANSWER);
  assert.equal(
    draftToPlainText(result!.drafts[1]),
    "To: customer06@example.test\nSubject: Refund for Late Delivery - Order ORD-1006\n\nDear Demo Customer 06,\n\nWe are sorry for the delay.",
  );
  assert.equal(draftToPlainText({ title: "x", to: null, subject: null, body: "Only body" }), "Only body");
});
