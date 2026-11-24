import assert from "node:assert/strict";
import test from "node:test";
import { parseEmailMeta, parseMarkdownBlocks } from "../../src/lib/markdown.ts";

test("parseEmailMeta extracts To, Subject, and From fields", () => {
  assert.deepEqual(parseEmailMeta("**To:** customer01@example.test  "), {
    label: "To",
    value: "customer01@example.test",
  });
  assert.deepEqual(parseEmailMeta("**Subject:** Refund for Late Delivery - Order ORD-1001"), {
    label: "Subject",
    value: "Refund for Late Delivery - Order ORD-1001",
  });
  assert.deepEqual(parseEmailMeta("   **From:** ops@example.test"), {
    label: "From",
    value: "ops@example.test",
  });
});

test("parseEmailMeta returns null for non-meta lines", () => {
  assert.equal(parseEmailMeta("Dear Demo Customer 01,"), null);
  assert.equal(parseEmailMeta("## **Draft Email 1**"), null);
  assert.equal(parseEmailMeta("---"), null);
  assert.equal(parseEmailMeta("**Summary:** Found 10 late orders"), null);
});

test("parseMarkdownBlocks parses email drafts structure correctly", () => {
  const content = `Perfect! I found 10 orders over $500.

---

## **Draft Email 1**

**To:** customer01@example.test  
**Subject:** Refund for Late Delivery - Order ORD-1001

Dear Demo Customer 01,

We sincerely apologize.

---

**Summary:** Found **10 late orders over $500**.`;

  const blocks = parseMarkdownBlocks(content);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[1].type, "divider");
  assert.equal(blocks[2].type, "heading");
  assert.equal(blocks[2].isDraftEmail, true);
  assert.equal(blocks[3].type, "email_meta");
  assert.equal(blocks[3].metaItems?.length, 2);
  assert.equal(blocks[4].type, "paragraph");
  assert.equal(blocks[5].type, "paragraph");
  assert.equal(blocks[6].type, "divider");
  assert.equal(blocks[7].type, "summary");
});
