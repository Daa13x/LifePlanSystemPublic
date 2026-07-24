import { Marked } from 'marked';

// Chat Markdown: render bold, lists, code, tables, and links, but neutralise
// injection vectors, because the output feeds dangerouslySetInnerHTML and a
// local model reply (or an attached context file it echoes) is untrusted.
// Raw HTML is escaped; link/image hrefs are protocol-checked (marked's default
// cleanUrl does NOT block javascript: URLs in v14, so we do it ourselves).
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeUrl(href) {
  const value = String(href ?? '').trim();
  if (!value) return null;
  // Anchors and relative paths are safe as-is.
  if (/^(#|\/|\.\/|\.\.\/)/.test(value)) return value;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return value; // no scheme => treat as a relative reference
  return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase()) ? value : null;
}

const chatMarkdown = new Marked({ gfm: true, breaks: true });
chatMarkdown.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const clean = sanitizeUrl(href);
      if (!clean) return text; // drop unsafe link, keep the visible text
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(clean)}" target="_blank" rel="noopener noreferrer nofollow"${titleAttr}>${text}</a>`;
    },
    image({ href, title, text }) {
      const clean = sanitizeUrl(href);
      if (!clean) return escapeHtml(text || '');
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(clean)}" alt="${escapeHtml(text || '')}"${titleAttr} />`;
    }
  }
});

export function renderMarkdown(source) {
  return chatMarkdown.parse(String(source ?? ''), { async: false });
}
