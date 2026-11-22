# OpsPilot AI — Rehearsal & Live Demo Guide

This guide provides the exact prompts, expected observations, SQL verification commands, and narration structure for a 5–10 minute recorded walkthrough and technical interview.

---

## 1. Setup & Preflight

From the repository root:
```sh
# 1. Start clean local environment
docker compose up --build -d

# 2. Check health
curl -fsS http://localhost:8000/health/ready
curl -fsS -o /dev/null http://localhost:3000/

# 3. Check seeded orders count (30 synthetic orders)
docker compose exec -T db psql -U opspilot -d opspilot -c 'SELECT count(*) FROM orders'
```

Access points:
- **Console UI:** [http://localhost:3000](http://localhost:3000)
- **API Swagger Docs:** [http://localhost:8000/docs](http://localhost:8000/docs)

---

## 2. Demo Timing & Narration Outline (5–10 Minutes)

| Timestamp | Topic & Screen Action | Talking Points |
| --- | --- | --- |
| **0:00 – 0:45** | **Introduction & Scenario Context**<br>Show console homepage (`/`). | Introduce OpsPilot as an autonomous operations copilot with human-in-the-loop approval. Explain the business scenario: seeded customer orders in PostgreSQL, 8 shipping policy documents, and an approval boundary for write actions on a simulated refund ledger. |
| **0:45 – 2:15** | **Scenario 1: Draft-Only Analysis**<br>Paste draft prompt and submit. | The user asks to find orders over $500 that shipped late last month and draft refund emails. The model chooses `date_math`, `query_orders`, and `search_policies`. Emphasize that read tools execute freely, emails are drafted in the response, and **no write actions or refunds are initiated**. |
| **2:15 – 4:30** | **Scenario 2: Explicit Refund with Human Approval**<br>Paste explicit refund prompt for `ORD-1006`. | The user explicitly asks to issue an eligible refund. The agent queries order `ORD-1006` ($845.05 total) and shipping policies ($10\%$ refund up to $\$100$). The backend proposes an $84.51 refund, creates an immutable pending approval record, and pauses execution. **Refresh the browser** to prove the pending proposal survives reload. Click **Approve**; the worker resumes, executes the simulated write, and displays the final answer. |
| **4:30 – 6:00** | **Scenario 3: Rejection with Required Reason**<br>Paste explicit refund prompt for `ORD-1001`. | Ask to refund `ORD-1001`. When the approval card appears, click **Reject Proposal…**. Demonstrate that rejection requires a non-blank reason (enter *"Customer requested store credit"*). The agent receives the rejection as a tool observation and politely acknowledges it without writing to the ledger. |
| **6:00 – 7:15** | **Runs History & Replay**<br>Navigate to `/runs`. | Show the paginated history of past runs with status badges, turn counts, tool calls, token usage, and duration. Click on the approved run to demonstrate full trace replay from persisted PostgreSQL records. |
| **7:15 – 8:00** | **Architecture & Invariants**<br>Show architecture diagram. | Highlight key engineering decisions: native tool calling loop for transparent step limits, SSE for streaming with separate HTTP POST commands for mutations, and transactional idempotency. |

---

## 3. Exact Prompts for Demonstration

### Prompt 1: Read-and-Draft Analysis (No write)
```text
Find orders over $500 that shipped late last month and draft a short refund email for each. Cite the applicable policy. Keep each email to two sentences.
```
*Expected Result:* Model calls `date_math`, `query_orders` (with `min_amount_minor: 50000`, `late_only: true`), and `search_policies` (`EMAIL-01`). Output contains drafted notification emails. No approval card appears.

### Prompt 2: Explicit Refund with Human Approval
```text
Check the late-shipment policy and issue the eligible simulated refund for ORD-1006. Show the proposed amount and evidence for my approval.
```
*Expected Result:* Model queries `ORD-1006` and policies, proposes $84.51 USD ($8,451 cents). Run pauses in `awaiting_approval`. Approval card shows order context and "Simulated refund" badge. Survives page reload. Clicking Approve writes 1 row to the simulated ledger and completes the run.

### Prompt 3: Rejection Flow
```text
Please issue the eligible late-shipment refund for ORD-1001 and wait for my decision.
```
*Expected Result:* Model pauses for approval on `ORD-1001` ($62.50 USD). Enter rejection reason: *"Customer requested review of the shipping date. Leave this order unchanged."* Model resumes and confirms rejection. Zero ledger writes for `ORD-1001`.

---

## 4. SQL Verification (Independent Proof of Invariants)

Run this query inside PostgreSQL to verify the simulated ledger independently of model text:

```sh
docker compose exec -T db psql -U opspilot -d opspilot -c "
SELECT r.order_id, count(*) AS entries, sum(r.amount_minor) AS total_cents, r.currency, r.policy_version
FROM refunds AS r
GROUP BY r.order_id, r.currency, r.policy_version;
"
```

- **After Prompt 1 (Draft):** 0 rows returned (no refunds issued).
- **After Prompt 2 (Approve ORD-1006):** Exactly 1 row (`order_id: ORD-1006`, `entries: 1`, `total_cents: 8451`).
- **After Prompt 3 (Reject ORD-1001):** Still only 1 row (ORD-1001 produces 0 entries).
