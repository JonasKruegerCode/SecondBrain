import { marked } from "marked";

const escape = (text: string) => text.replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Model text may format an answer, never inject HTML or load remote media. */
export function chatMarkdown(source: string): string {
  const renderer = new marked.Renderer();
  renderer.html = html => escape(html);
  renderer.image = (_href, _title, text) => escape(text);
  const table = renderer.table.bind(renderer);
  renderer.table = (header, body) => `<div class="chat-table" tabindex="0" role="region" aria-label="Answer table; scroll horizontally to read all columns">${table(header, body)}</div>`;
  renderer.link = (href, _title, text) => {
    if (!href) return text;
    // Only absolute HTTP(S) and explicit wiki-page URLs are navigable. Escaping
    // attributes also keeps entity-encoded schemes and quotes inert.
    if (/^https?:\/\//i.test(href))
      return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    if (/^\/wiki\/[^\s]*$/.test(href)) return `<a href="${escape(href)}">${text}</a>`;
    return text;
  };
  return marked.parse(source, { renderer, async: false, gfm: true, breaks: true }) as string;
}
