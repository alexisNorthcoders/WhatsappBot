/**
 * @param {string} contentType value of Content-Type without parameters normalization optional
 * @param {string} bodyText decoded response body
 */
export function isHtmlLikeResponse(contentType, bodyText) {
  const ct = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    return true;
  }
  if (
    ct.startsWith('application/json') ||
    ct.startsWith('image/') ||
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct === 'application/pdf' ||
    ct.endsWith('+json')
  ) {
    return false;
  }

  const head = String(bodyText || '').trimStart().slice(0, 8000);
  if (/^<!DOCTYPE\s+html/i.test(head)) return true;
  if (/^<html[\s>]/i.test(head)) return true;
  if (/^<\?xml/i.test(head) && /<html[\s>]/i.test(head)) return true;
  return false;
}
