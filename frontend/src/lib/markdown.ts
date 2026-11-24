/**
 * Pure Markdown parsing utilities for OpsPilot email drafts and status output.
 */

export interface EmailMeta {
  label: string;
  value: string;
}

/**
 * Checks if line is an email metadata field like `**To:** email` or `**Subject:** title`.
 */
export function parseEmailMeta(line: string): EmailMeta | null {
  const match = line.match(/^\s*\*\*(To|Subject|From|Date):\*\*\s*(.*)$/i);
  if (match) {
    return { label: match[1], value: match[2].trim() };
  }
  return null;
}

export type MarkdownBlockType =
  | "divider"
  | "code_block"
  | "heading"
  | "summary"
  | "email_meta"
  | "list"
  | "paragraph";

export interface MarkdownBlock {
  type: MarkdownBlockType;
  raw: string;
  level?: number;
  lines?: string[];
  metaItems?: EmailMeta[];
  isDraftEmail?: boolean;
}

/**
 * Parses raw text into semantic blocks for clean structured rendering.
 */
export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const rawBlocks = content.split(/\n\n+/);
  const blocks: MarkdownBlock[] = [];

  for (const block of rawBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // 1. Horizontal divider
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "divider", raw: trimmed });
      continue;
    }

    // 2. Fenced code block
    if (trimmed.startsWith("```")) {
      blocks.push({ type: "code_block", raw: trimmed });
      continue;
    }

    // 3. Headings (#, ##, ###)
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const titleText = headingMatch[2].trim();
      const isDraftEmail = /draft email/i.test(titleText);
      blocks.push({
        type: "heading",
        raw: titleText,
        level,
        isDraftEmail,
      });
      continue;
    }

    // 4. Summary box
    if (trimmed.startsWith("**Summary:**") || trimmed.startsWith("Summary:")) {
      blocks.push({
        type: "summary",
        raw: trimmed.replace(/^\*{0,2}Summary:\*{0,2}\s*/, ""),
      });
      continue;
    }

    // 5. Lines inside paragraph (check for **To:** and **Subject:**)
    const lines = trimmed.split("\n");
    const hasEmailMeta = lines.some((l) => parseEmailMeta(l) !== null);

    if (hasEmailMeta) {
      const metaItems: EmailMeta[] = [];
      for (const line of lines) {
        const meta = parseEmailMeta(line);
        if (meta) {
          metaItems.push(meta);
        }
      }
      blocks.push({
        type: "email_meta",
        raw: trimmed,
        lines,
        metaItems,
      });
      continue;
    }

    // 6. Unordered list
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      blocks.push({
        type: "list",
        raw: trimmed,
        lines: lines.map((l) => l.replace(/^\s*[-*]\s+/, "")),
      });
      continue;
    }

    // 7. Regular paragraph
    blocks.push({
      type: "paragraph",
      raw: trimmed,
      lines,
    });
  }

  return blocks;
}
