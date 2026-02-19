import { Marked } from "marked";
import hljs from "highlight.js";

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      const langLabel = language
        ? `<span class="code-lang">${escapeHtmlAttr(language)}</span>`
        : "";
      const copyBtn = `<button class="code-copy-btn" data-code="${escapeHtmlAttr(text)}" onclick="copyCode(this)" title="Copy code">Copy</button>`;
      return `<pre class="hljs">${langLabel}${copyBtn}<code>${highlighted}</code></pre>`;
    },
    link({ href, text }) {
      // Strip dangerous protocol links to prevent XSS
      const safeHref = /^(javascript|data|vbscript|file):/i.test(href ?? "") ? "#" : (href ?? "#");
      return `<a href="${escapeHtmlAttr(safeHref)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}
