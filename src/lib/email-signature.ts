/**
 * Merging a plain-text email body with an HTML signature into one HTML document
 * Gmail can send.
 *
 * Gmail has no API flag that appends a user's signature for you — `insertSignature`
 * on `drafts.create` / `messages.send` looks like it should do this and is silently
 * ignored; it has never been a real parameter on either endpoint. The signature has
 * to be fetched separately (`users.settings.sendAs`, where Gmail stores it as HTML)
 * and appended to the body by hand, which is what this does.
 *
 * Pure and dependency-free: escaping the body without double-escaping the
 * signature is easy to get subtly wrong and cheap to pin down in tests.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The body, escaped and with line breaks turned into `<br>`, followed by the
 * signature exactly as Gmail stored it — already HTML, never escaped a second
 * time. Returned as HTML even with no signature, so the message has one
 * consistent content type rather than switching on whether one was found.
 */
export function composeHtmlBody(body: string, signatureHtml: string | null): string {
  const html = escapeHtml(body).split("\n").join("<br>\n");
  const signature = (signatureHtml ?? "").trim();
  return signature ? `${html}<br><br>\n${signature}` : html;
}
