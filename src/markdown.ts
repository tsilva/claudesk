import { Marked } from "marked";
import hljs from "highlight.js";

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
        ? `<span class="code-lang">${language}</span>`
        : "";
      return `<pre class="hljs">${langLabel}<code>${highlighted}</code></pre>`;
    },
    link({ href, text }) {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}
