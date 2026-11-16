import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ReactNode } from 'react';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (!href.startsWith('#')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  }
});

/** Markdown → sanitized HTML. Wikilinks become in-app links; everything goes through DOMPurify last. */
export function renderMarkdown(md: string, links: { id: string; title: string }[] = []): string {
  const byTitle = new Map(links.map((l) => [l.title.toLowerCase(), l.id]));
  const withLinks = md.replace(/\[\[([^\]\n|]{1,200})(?:\|([^\]\n]*))?\]\]/g, (_m, title: string, alias?: string) => {
    const id = byTitle.get(title.trim().toLowerCase());
    const label = (alias || title).replace(/[[\]]/g, '');
    return id ? `[${label}](#/notes/${id})` : `[${label}](#/search?q=${encodeURIComponent(title)})`;
  });
  const html = marked.parse(withLinks, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
}

/** Search snippets mark hits with \x01…\x02; render them as <mark> without ever using innerHTML. */
export function highlight(snippet: string): ReactNode[] {
  return snippet.split(/(\x01[^\x02]*\x02)/).map((part, i) =>
    part.startsWith('\x01') ? <mark key={i}>{part.slice(1, -1)}</mark> : part);
}

export const plain = (s: string) => s.replace(/[\x01\x02]/g, '');

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
export function timeAgo(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [n, unit] of steps) {
    if (Math.abs(v) < n) return rtf.format(Math.round(v), unit);
    v /= n;
  }
  return '';
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
export const fmtNum = (n: number) => n.toLocaleString('es');
export const fmtBytes = (b: number) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1).replace('.', ',')} KB` : `${(b / 1048576).toFixed(1).replace('.', ',')} MB`;

/** Line diff (LCS). Returns rows tagged as same/add/del. */
export function lineDiff(a: string, b: string): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const x = a.split('\n'), y = b.split('\n');
  // ponytail: O(n·m) table, capped; switch to Myers diff if users diff very long documents.
  if (x.length * y.length > 4_000_000) return [{ kind: 'del', text: '(documento demasiado largo para comparar línea a línea)' }];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out: { kind: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: x[i++] });
    else out.push({ kind: 'add', text: y[j++] });
  }
  while (i < x.length) out.push({ kind: 'del', text: x[i++] });
  while (j < y.length) out.push({ kind: 'add', text: y[j++] });
  return out;
}
