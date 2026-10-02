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
	'table',
	'tr',
	'td',
	'th'
];

export function sanitizeCardHtml(dirty: string): string {
	return DOMPurify.sanitize(dirty, {
		ALLOWED_TAGS,
		ALLOWED_ATTR: ['src', 'alt', 'class', 'href', 'target', 'rel'],
		FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math'],
		ALLOW_DATA_ATTR: false
	});
}
