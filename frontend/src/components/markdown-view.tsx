"use client";

import React, { useState } from "react";
import { parseEmailMeta, parseMarkdownBlocks, type MarkdownBlock } from "../lib/markdown";

interface MarkdownViewProps {
  content: string;
}

/**
 * Parses inline markdown: **bold**, *italic*, `code`, and [link](url).
 */
function renderInline(text: string): React.ReactNode {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    if (!part) return null;

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="inline-code">{part.slice(1, -1)}</code>;
    }
    const linkMatch = part.match(/^\[(.*?)\]\((.*?)\)$/);
    if (linkMatch) {
      return (
        <a key={index} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
          {linkMatch[1]}
        </a>
      );
    }
    return part;
  });
}

function renderBlock(block: MarkdownBlock, blockIndex: number): React.ReactNode {
  switch (block.type) {
    case "divider":
      return <hr key={blockIndex} className="markdown-hr" />;

    case "code_block": {
      const lines = block.raw.split("\n");
      const code = lines.slice(1, -1).join("\n");
      return (
        <pre key={blockIndex} className="code-block">
          <code>{code}</code>
        </pre>
      );
    }

    case "heading": {
      let titleText = block.raw;
      if (titleText.startsWith("**") && titleText.endsWith("**")) {
        titleText = titleText.slice(2, -2);
      }
      if (block.level === 1) {
        return <h1 key={blockIndex} className="markdown-h1">{renderInline(titleText)}</h1>;
      }
      if (block.level === 2) {
        return (
          <h2 key={blockIndex} className={`markdown-h2 ${block.isDraftEmail ? "draft-email-header" : ""}`}>
            {block.isDraftEmail && <span className="email-badge-icon" aria-hidden="true">✉</span>}
            {renderInline(titleText)}
          </h2>
        );
      }
      return <h3 key={blockIndex} className="markdown-h3">{renderInline(titleText)}</h3>;
    }

    case "summary":
      return (
        <div key={blockIndex} className="markdown-summary-box">
          <div className="summary-title">Summary</div>
          <div className="summary-body">{renderInline(block.raw)}</div>
        </div>
      );

    case "email_meta": {
      const lines = block.lines || [];
      return (
        <div key={blockIndex} className="email-meta-card">
          {lines.map((line, lineIndex) => {
            const meta = parseEmailMeta(line);
            if (meta) {
              return (
                <div key={lineIndex} className="email-meta-row">
                  <span className="email-meta-label">{meta.label}:</span>
                  <span className="email-meta-value">{renderInline(meta.value)}</span>
                </div>
              );
            }
            return (
              <div key={lineIndex} className="email-meta-subline">
                {renderInline(line)}
              </div>
            );
          })}
        </div>
      );
    }

    case "list":
      return (
        <ul key={blockIndex} className="markdown-ul">
          {(block.lines || []).map((item, liIndex) => (
            <li key={liIndex}>{renderInline(item)}</li>
          ))}
        </ul>
      );

    case "paragraph":
    default: {
      const lines = block.lines || [block.raw];
      return (
        <p key={blockIndex} className="markdown-p">
          {lines.map((line, lineIndex) => (
            <React.Fragment key={lineIndex}>
              {renderInline(line)}
              {lineIndex < lines.length - 1 && <br />}
            </React.Fragment>
          ))}
        </p>
      );
    }
  }
}

/**
 * Render structured Markdown with headings, email meta, dividers, and paragraphs.
 */
function renderFormattedMarkdown(content: string): React.ReactNode {
  const blocks = parseMarkdownBlocks(content);
  return blocks.map((block, index) => renderBlock(block, index));
}

export default function MarkdownView({ content }: MarkdownViewProps) {
  const [mode, setMode] = useState<"formatted" | "raw">("formatted");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback if clipboard API is not available
      setCopied(false);
    }
  };

  return (
    <div className="markdown-container">
      <div className="markdown-toolbar">
        <div className="markdown-toggle-group">
          <button
            type="button"
            className={`btn-toggle ${mode === "formatted" ? "active" : ""}`}
            onClick={() => setMode("formatted")}
            aria-pressed={mode === "formatted"}
          >
            Formatted View
          </button>
          <button
            type="button"
            className={`btn-toggle ${mode === "raw" ? "active" : ""}`}
            onClick={() => setMode("raw")}
            aria-pressed={mode === "raw"}
          >
            Raw Markdown
          </button>
        </div>
        <button
          type="button"
          className="btn-copy"
          onClick={handleCopy}
          aria-label="Copy markdown content"
        >
          {copied ? "✓ Copied" : "Copy Markdown"}
        </button>
      </div>

      <div className="markdown-body">
        {mode === "formatted" ? (
          <div className="markdown-formatted">{renderFormattedMarkdown(content)}</div>
        ) : (
          <pre className="raw-markdown-block">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
