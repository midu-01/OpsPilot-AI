/**
 * Demo goals. They fill the composer; they never submit on their own.
 * The wording matches the deterministic routes in backend/app/agent/scenario_provider.py
 * (used by the offline `fake` model) and the prompts in docs/demo-script.md.
 */
export interface GoalPreset {
  id: "draft" | "approve" | "reject" | "zero";
  title: string;
  goal: string;
  /** What will happen, in plain words. */
  outcome: string;
  effect: "read-only" | "needs-approval";
}

export const GOAL_PRESETS: readonly GoalPreset[] = [
  {
    id: "draft",
    title: "Draft late-shipment emails",
    goal: "Find orders over $500 that shipped late last month and draft a short refund email for each. Cite the applicable policy. Keep each email to two sentences.",
    outcome: "Reads orders and policies, then drafts one email per late order. Nothing is written.",
    effect: "read-only",
  },
  {
    id: "approve",
    title: "Refund ORD-1006",
    goal: "Check the late-shipment policy and issue the eligible simulated refund for ORD-1006. Show the proposed amount and evidence for my approval.",
    outcome: "Proposes a $84.51 refund and pauses until you approve it. Approving writes to the simulated ledger.",
    effect: "needs-approval",
  },
  {
    id: "reject",
    title: "Refund ORD-1001, then reject it",
    goal: "Please issue the eligible late-shipment refund for ORD-1001 and wait for my decision.",
    outcome: "Proposes a $62.50 refund. Reject it with a reason; the agent reads your reason and responds.",
    effect: "needs-approval",
  },
  {
    id: "zero",
    title: "Search with no matches",
    goal: "Find orders over $10,000 that shipped late last month and draft a refund email for each.",
    outcome: "Finds no matching orders and says so instead of inventing drafts.",
    effect: "read-only",
  },
];
