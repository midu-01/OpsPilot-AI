/**
 * Splits a final answer into email drafts. The backend asks the model to write each
 * draft as:
 *
 *   ## **Draft Email 1**
 *   **To:** customer@example.test
 *   **Subject:** Refund for Late Delivery - Order ORD-1001
 *   (body)
 *   ---
 *   **Summary:** ...
 *
 * Returns null when the answer has no drafts, so it renders as plain markdown.
 */

export interface EmailDraft {
  title: string;
  to: string | null;
  subject: string | null;
  /** Markdown body without the To/Subject lines. */
  body: string;
}

export interface AnswerWithDrafts {
  intro: string;
  drafts: EmailDraft[];
  summary: string | null;
}

const DRAFT_HEADING = /^#{1,6}\s*\**\s*(draft email\b[^*]*?)\s*\**\s*$/i;
const META_LINE = /^\s*\**\s*(to|subject)\s*:\s*\**\s*(.*?)\s*$/i;
const SUMMARY_LINE = /^\s*\**\s*summary\s*:\s*\**\s*/i;
const SEPARATOR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Removes separator lines and blank lines from both ends. */
function trimBlock(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && (!lines[start].trim() || SEPARATOR.test(lines[start]))) start += 1;
  while (end > start && (!lines[end - 1].trim() || SEPARATOR.test(lines[end - 1]))) end -= 1;
  return lines.slice(start, end).join("\n");
}

function parseDraft(title: string, lines: string[]): EmailDraft {
  let to: string | null = null;
  let subject: string | null = null;
  const body: string[] = [];
  for (const line of lines) {
    const meta = META_LINE.exec(line);
    if (meta && meta[1].toLowerCase() === "to" && to === null) to = meta[2].replace(/\*+$/, "").trim();
    else if (meta && meta[1].toLowerCase() === "subject" && subject === null) subject = meta[2].replace(/\*+$/, "").trim();
    else body.push(line);
  }
  return { title, to, subject, body: trimBlock(body) };
}

export function splitEmailDrafts(markdown: string): AnswerWithDrafts | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings: { index: number; title: string }[] = [];
  lines.forEach((line, index) => {
    const match = DRAFT_HEADING.exec(line.trim());
    if (match) headings.push({ index, title: match[1].replace(/\*+/g, "").trim() });
  });
  if (headings.length === 0) return null;

  const drafts: EmailDraft[] = [];
  let summary: string | null = null;
  headings.forEach((heading, position) => {
    const end = position + 1 < headings.length ? headings[position + 1].index : lines.length;
    let section = lines.slice(heading.index + 1, end);
    if (position === headings.length - 1) {
      // A summary after the last draft belongs to the whole answer, not the email.
      const summaryAt = section.findIndex((line) => SUMMARY_LINE.test(line));
      if (summaryAt !== -1) {
        summary = trimBlock([section[summaryAt].replace(SUMMARY_LINE, ""), ...section.slice(summaryAt + 1)]) || null;
        section = section.slice(0, summaryAt);
      }
    }
    drafts.push(parseDraft(heading.title, section));
  });

  return { intro: trimBlock(lines.slice(0, headings[0].index)), drafts, summary };
}

/** Plain text for the clipboard: To and Subject lines, then the body without markdown line breaks. */
export function draftToPlainText(draft: EmailDraft): string {
  const header = [draft.to ? `To: ${draft.to}` : null, draft.subject ? `Subject: ${draft.subject}` : null].filter(Boolean);
  const body = draft.body.replace(/[ \t]+$/gm, "");
  return header.length > 0 ? `${header.join("\n")}\n\n${body}` : body;
}
