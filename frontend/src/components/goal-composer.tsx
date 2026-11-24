"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createRun, ApiError } from "../lib/api";

const EXAMPLE_PROMPTS = [
  {
    title: "Draft-only late shipment analysis",
    tag: "Read-only",
    tagClass: "badge-tag-read",
    prompt:
      "Find orders over $500 that shipped late last month and draft a refund email for each.",
    description:
      "Analyzes seeded orders, evaluates eligibility against policies, and drafts customer emails. Does not create refunds.",
  },
  {
    title: "Explicit refund proposal",
    tag: "Requires Approval",
    tagClass: "badge-tag-approval",
    prompt:
      "Check the late-shipment policy and propose an eligible simulated refund for ORD-1001. Wait for my approval.",
    description:
      "Calculates refund amount and creates an approval card. Waits for your approval before writing to the ledger.",
  },
];

export default function GoalComposer() {
  const [goal, setGoal] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed) {
      setError("Please enter an operations goal.");
      return;
    }
    if (trimmed.length > 2000) {
      setError("Goal cannot exceed 2000 characters.");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const run = await createRun(trimmed);
      router.push(`/runs/${run.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.detail || err.message);
      } else {
        setError(err instanceof Error ? err.message : "Failed to submit run");
      }
      setIsSubmitting(false);
    }
  }

  function handleSelectExample(prompt: string) {
    setGoal(prompt);
    setError(null);
  }

  const charCount = goal.trim().length;

  return (
    <div className="card">
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="goal-input" className="form-label">
            Operations Goal *
          </label>
          <textarea
            id="goal-input"
            className="form-textarea"
            placeholder="Describe what you want OpsPilot to do (e.g. Find late orders and draft emails)..."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={isSubmitting}
            maxLength={2000}
            rows={4}
            required
            aria-describedby="goal-char-counter"
          />
          <div id="goal-char-counter" className="char-counter">
            {charCount} / 2000 characters
          </div>
        </div>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting || !goal.trim()}
          >
            {isSubmitting ? "Starting run…" : "Run OpsPilot Agent"}
          </button>
        </div>
      </form>

      {/* Example Prompts */}
      <div className="prompt-examples">
        <h3 style={{ fontSize: "0.95rem", margin: "0 0 10px", color: "var(--color-text)" }}>
          Example Operations Prompts
        </h3>
        <div className="prompt-grid">
          {EXAMPLE_PROMPTS.map((ex, idx) => (
            <button
              key={idx}
              type="button"
              className="prompt-card"
              onClick={() => handleSelectExample(ex.prompt)}
              disabled={isSubmitting}
              aria-label={`Select example: ${ex.title}`}
            >
              <div className="prompt-card-header">
                <span className="prompt-card-title">{ex.title}</span>
                <span className={`badge ${ex.tagClass}`}>{ex.tag}</span>
              </div>
              <p className="prompt-card-text">{ex.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
