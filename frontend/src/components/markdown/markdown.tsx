import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@/lib/cx";

/**
 * Renders untrusted model output.
 * - Raw HTML in the markdown is dropped (skipHtml); nothing is injected as HTML.
 * - Links keep only http, https and mailto URLs, and open in a new tab without referrer.
 * - Images are not rendered, so model output cannot load remote content.
 */
const ALLOWED_LINK = /^(https?:|mailto:)/i;

function safeUrl(url: string): string {
  const cleaned = defaultUrlTransform(url);
  return ALLOWED_LINK.test(cleaned) ? cleaned : "";
}

const REMARK_PLUGINS = [remarkGfm];
const DISALLOWED = ["img"];

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

interface MarkdownProps {
  text: string;
  /** Shows a caret after the last block while the text is still arriving. */
  streaming?: boolean;
  className?: string;
}

export const Markdown = memo(function Markdown({ text, streaming = false, className }: MarkdownProps) {
  return (
    <div className={cx("markdown", streaming && "streaming-text", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        urlTransform={safeUrl}
        disallowedElements={DISALLOWED}
        unwrapDisallowed
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
