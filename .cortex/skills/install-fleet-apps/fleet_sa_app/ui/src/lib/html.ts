// HTML-escaping helper for deck.gl tooltips.
//
// deck.gl renders a tooltip's `html` field via innerHTML, so any data-derived
// value interpolated into a tooltip template must be escaped first. Free-text
// fields (POI/city names, offer listing text, product) can otherwise carry
// markup and execute as XSS. Static labels and numbers do not need escaping,
// but escaping them is harmless. Use `text` (deck.gl sets textContent) when no
// markup is needed; use this when a template genuinely needs `html`.

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}
