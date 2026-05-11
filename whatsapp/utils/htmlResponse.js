/**
 * Detect RSS / Atom payloads so we don't treat them as browsing HTML even if tags look similar.
 * @param {string} head
 */
function looksLikeXmlFeed(head) {
  const h = head.trimStart().slice(0, 8192);
  if (!/^<\?xml\b/i.test(h) && !/^\s*</.test(h)) return false;
  return /<(rss|feed|rdf:RDF)\b/i.test(h);
}

/**
 * Require a conventional HTML document opener (avoid feeding random angle-bracket text to JSDOM).
 * @param {string} bodyText
 */
function hasStrongHtmlDocumentSignal(bodyText) {
  const head = String(bodyText ?? '').trimStart().slice(0, 49152);
  if (looksLikeXmlFeed(head)) return false;
  if (/^\s*<!DOCTYPE\s+html\b/i.test(head)) return true;
  if (/^\s*<html\b/i.test(head)) return true;
  if (/^<\?xml\b/i.test(head) && /<html\b/i.test(head)) return true;
  return false;
}

/**
 * Explicit Content-Types we never treat as page HTML regardless of accidental angle brackets.
 * @param {string} ct lowercase, no parameters
 */
function isExplicitPlainOrNonBrowsing(ct) {
  if (ct.startsWith('text/plain')) return true;
  if (ct.startsWith('application/json') || ct.endsWith('+json')) return true;
  if (ct === 'application/rss+xml' || ct === 'application/atom+xml') return true;
  if (ct.startsWith('application/vnd.api+json')) return true;
  if (
    ct.startsWith('image/') ||
    ct.startsWith('video/') ||
    ct.startsWith('audio/')
  ) {
    return true;
  }
  if (ct.startsWith('text/css')) return true;
  if (ct.startsWith('application/javascript')) return true;
  if (ct === 'application/pdf') return true;
  return false;
}

/**
 * @param {string} contentType value of Content-Type without parameters normalization optional
 * @param {string} bodyText decoded response body
 */
export function isHtmlLikeResponse(contentType, bodyText) {
  const ct = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const body = String(bodyText ?? '');

  if (looksLikeXmlFeed(body.trimStart().slice(0, 49152))) {
    return false;
  }

  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    return true;
  }

  if (isExplicitPlainOrNonBrowsing(ct)) {
    return false;
  }

  if (ct.startsWith('application/xml') || ct.startsWith('text/xml')) {
    return hasStrongHtmlDocumentSignal(body);
  }

  return hasStrongHtmlDocumentSignal(body);
}
