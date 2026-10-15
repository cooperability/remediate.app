import DOMPurify from 'isomorphic-dompurify';

// Anki exports reference media by bare filename (`<img src="Screenshot….png">`),
// and a text export does not carry the media. Rendered as is, each one is a
// request for /cards/<filename> that 404s. Keep the filename where the reader can
// see it and drop the src, so nothing is fetched. Remote images still render;
// http is upgraded, since the CSP allows https only.
function placeholderMedia(node: Element) {
	const src = (node.getAttribute('src') ?? '').trim();
	if (/^https:\/\//i.test(src) || /^data:image\//i.test(src)) return;
	if (/^http:\/\//i.test(src)) {
		node.setAttribute('src', `https://${src.slice('http://'.length)}`);
		return;
	}
	// Already a placeholder: the editor re-sanitizes stored HTML on every save, and
	// naming it again would nest its alt text ("[image: [image: x.png]]").
	if (!src && node.getAttribute('class') === 'media-missing') return;
	const name = src || node.getAttribute('alt') || 'image';
	node.removeAttribute('src');
	node.setAttribute('alt', `[image: ${name.slice(0, 120)}]`);
	node.setAttribute('class', 'media-missing');
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (node.tagName === 'IMG') return placeholderMedia(node);
	if (node.tagName !== 'A') return;
	const href = node.getAttribute('href') ?? '';
	if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute('href');
	node.setAttribute('target', '_blank');
	node.setAttribute('rel', 'noopener noreferrer');
});

const ALLOWED_TAGS = [
	'b',
	'i',
	'u',
	'em',
	'strong',
	'div',
	'br',
	'p',
	'ul',
	'ol',
	'li',
	'code',
	'pre',
	'span',
	'img',
	'a',
	'sup',
	'sub',
	// The editor's strikethrough (browsers write <strike>), highlight and text styles.
	's',
	'strike',
	'mark',
	'h3',
	'h4',
	'table',
	'tr',
	'td',
	'th'
];

const CONFIG = {
	ALLOWED_TAGS,
	ALLOWED_ATTR: ['src', 'alt', 'class', 'href', 'target', 'rel'],
	FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math'],
	ALLOW_DATA_ATTR: false
};

export function sanitizeCardHtml(dirty: string): string {
	return DOMPurify.sanitize(dirty, CONFIG);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find and replace in a field's visible text, returning sanitized HTML, or the
 * field unchanged when nothing matched. It edits the parsed text nodes, so tags,
 * attributes and entity names are out of reach: `&` finds the character `&amp;`
 * stands for, and `<b>` in the replacement is stored as text.
 */
export function replaceText(html: string, find: string, replacement: string, matchCase: boolean) {
	if (!find) return html;
	const re = new RegExp(escapeRegExp(find), matchCase ? 'g' : 'gi');
	const root = DOMPurify.sanitize(html, { ...CONFIG, RETURN_DOM_FRAGMENT: true });
	const doc = root.ownerDocument;
	// 4 is NodeFilter.SHOW_TEXT. The server's DOM has no NodeFilter global.
	const walk = doc.createTreeWalker(root, 4);
	let changed = false;
	for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
		const next = t.data.replace(re, () => replacement);
		if (next === t.data) continue;
		t.data = next;
		changed = true;
	}
	if (!changed) return html;
	const box = doc.createElement('div');
	box.append(root);
	return box.innerHTML;
}
