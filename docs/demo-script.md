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

# 4. Check the demo accounts (2 users) and the policy index (8 paragraphs embedded by the local model)
docker compose exec -T db psql -U opspilot -d opspilot -c 'SELECT email, display_name FROM users ORDER BY email'
docker compose exec -T db psql -U opspilot -d opspilot -c 'SELECT policy_id, embedding_model, vector_dims(embedding) FROM policy_chunks ORDER BY file'
```

Access points:
- **Console UI:** [http://localhost:3000](http://localhost:3000). Without a session it redirects to `/login`. Sign in as Alex (`alex@opspilot.test`); Sam (`sam@opspilot.test`) is the second account. Both use the password `opspilot-demo` (from `DEMO_USER_PASSWORD`). The **Demo accounts** buttons fill in the email; the password is typed.
- **API Swagger Docs:** [http://localhost:8000/docs](http://localhost:8000/docs). `/runs` calls need **Authorize** with an `access_token` from `POST /auth/login`.

---

## 2. Demo Timing & Narration Outline (5–10 Minutes)

| Timestamp | Topic & Screen Action | Talking Points |
| --- | --- | --- |
| **0:00 – 0:45** | **Introduction, Scenario Context & Sign-in**<br>Open `/`, which redirects to `/login`; sign in as Alex. | Introduce OpsPilot as an autonomous operations copilot with human-in-the-loop approval. Explain the business scenario: seeded customer orders in PostgreSQL, 8 shipping policy documents, and an approval boundary for write actions on a simulated refund ledger. Each operator signs in and sees only their own runs; the session token stays in an HttpOnly cookie that browser JavaScript never sees. |
| **0:45 – 2:15** | **Scenario 1: Draft-Only Analysis**<br>Paste draft prompt and submit, then expand the `search_policies` card. | The user asks to find orders over $500 that shipped late last month and draft refund emails. The model chooses `date_math`, `query_orders`, and `search_policies`. Emphasize that read tools execute freely, emails are drafted in the response, and **no write actions or refunds are initiated**. Point out the "why it matched" badges on each policy: **Policy ID** (the query named it, so it ranks first), **Keyword** (shared words, with title words counting most) and **Meaning NN%** (cosine similarity from the local embedding model, shown when it clears the 0.6 floor). The footer says how many of the 8 policies matched and that the search ran in hybrid mode. |
| **2:15 – 4:30** | **Scenario 2: Explicit Refund with Human Approval**<br>Paste explicit refund prompt for `ORD-1006`. | The user explicitly asks to issue an eligible refund. The agent queries order `ORD-1006` ($845.05 total) and shipping policies ($10\%$ refund up to $\$100$). The backend proposes an $84.51 refund, creates an immutable pending approval record, and pauses execution. **Refresh the browser** to prove the pending proposal survives reload. Click **Approve**; the worker resumes, executes the simulated write, and displays the final answer. |
| **4:30 – 6:00** | **Scenario 3: Rejection with Required Reason**<br>Paste explicit refund prompt for `ORD-1001`. | Ask to refund `ORD-1001`. When the approval card appears, click **Reject Proposal…**. Demonstrate that rejection requires a non-blank reason (enter *"Customer requested store credit"*). The agent receives the rejection as a tool observation and politely acknowledges it without writing to the ledger. |
| **6:00 – 7:00** | **Runs History & Replay**<br>Navigate to `/runs`. | Show the paginated history of past runs with status badges, turn counts, tool calls, token usage, and duration. Click on the approved run to demonstrate full trace replay from persisted PostgreSQL records. Copy its URL for the next step. |
| **7:00 – 8:00** | **Two Users, Separate Runs**<br>Open the account menu, **Sign out**, sign in as Sam, open `/runs`, then paste Alex's run URL. | Sam's list holds only Sam's runs ("No runs yet" on a fresh stack), and Alex's run shows **Run not found**: the API answers `404` for another user's run, exactly as for a missing one, so a run ID reveals nothing. Sign-out revoked the session on the backend, so a stream still open with it would close with `4401` within one 15-second keepalive. |
| **8:00 – 8:45** | **Architecture & Invariants**<br>Show architecture diagram. | Highlight key engineering decisions: native tool calling loop for transparent step limits, a WebSocket for streaming (accepted first, then checked, with close codes that mirror HTTP statuses) with separate HTTP POST commands for mutations, and transactional idempotency. To show the stream itself, open DevTools > Network > WS on a live run: the stream's Messages tab shows `stream.ready`, then each event as it commits. Add the two newer ones: backend-for-frontend sessions (an opaque token in an HttpOnly cookie; the database keeps only its SHA-256) and hybrid policy search inside PostgreSQL (policy ID, full-text keywords and pgvector meaning, with keyword coverage and similarity averaged). |

---

## 3. Exact Prompts for Demonstration

### Prompt 1: Read-and-Draft Analysis (No write)
```text
Find orders over $500 that shipped late last month and draft a short refund email for each. Cite the applicable policy. Keep each email to two sentences.
```
*Expected Result:* Model calls `date_math`, `query_orders` (with `min_amount_minor: 50000`, `late_only: true`), and `search_policies` (`EMAIL-01`). The search card lists `EMAIL-01` first with a **Policy ID** badge. Output contains drafted notification emails. No approval card appears.

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

Run owners and sessions, to show user isolation and token storage in the database:

```sh
docker compose exec -T db psql -U opspilot -d opspilot -c "
SELECT u.email, count(r.id) AS runs
FROM users AS u LEFT JOIN runs AS r ON r.user_id = u.id
GROUP BY u.email ORDER BY u.email;
"
docker compose exec -T db psql -U opspilot -d opspilot -c "
SELECT u.email, left(s.token_hash, 12) AS token_hash_start, s.expires_at, s.revoked_at
FROM user_sessions AS s JOIN users AS u ON u.id = s.user_id
ORDER BY s.created_at DESC LIMIT 4;
"
```

- **Runs per user:** on a fresh stack, Alex owns the demo runs and Sam owns none, which is what each one's `/runs` page showed.
- **Sessions:** only a SHA-256 of each token is stored, never the token itself, and Alex's signed-out session has `revoked_at` set.
