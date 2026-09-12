import { z } from 'zod';

const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const htmlMarkup = /<\/?[a-z][^>]*>|<!--|<!doctype/iu;

/** Plain text is still rendered with textContent/Vue interpolation, never innerHTML. */
export function plainText(maxCharacters: number, minCharacters = 0, trim = true) {
  const base = trim ? z.string().trim() : z.string();
  return base.max(maxCharacters * 2)
    .refine(value => Array.from(value).length <= maxCharacters, `最多 ${maxCharacters} 个字符`)
    .refine(value => Array.from(value).length >= minCharacters, `至少 ${minCharacters} 个字符`)
    .refine(value => !forbiddenControls.test(value), '文字包含不允许的控制字符')
    .refine(value => !htmlMarkup.test(value), '请使用纯文字或结构化富文本，不接受原始 HTML');
}

export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
export const VersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SortOrderSchema = z.number().int().min(0).max(1_000_000).default(0);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const SlugSchema = z.string().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const UtcTimestampSchema = z.string().datetime({ offset: false });

export function isSafeHttpsUrl(value: string): boolean {
  if (!/^https:\/\//iu.test(value) || /[\s\\\u0000-\u001F\u007F]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export function isSafeInternalHref(value: string): boolean {
  if (/^#[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) return true;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (/[\s\\\u0000-\u001F\u007F]/u.test(value) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return false;
  try { return new URL(value, 'https://internal.invalid').origin === 'https://internal.invalid'; }
  catch { return false; }
}

export const HttpsUrlSchema = z.string().max(2048).refine(isSafeHttpsUrl, '需要不带账号信息的 HTTPS 地址');
export const SafeHrefSchema = z.string().max(2048)
  .refine(value => isSafeHttpsUrl(value) || isSafeInternalHref(value), '链接必须是站内路径或 HTTPS 地址');

export function requireUniqueIds(items: readonly { id: string }[], ctx: z.RefinementCtx, path: string[] = []) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', message: 'ID 不可重复', path: [...path, index, 'id'] });
    seen.add(item.id);
  });
}

/** Guard recursive JSON before Zod traverses it. HTTP code must also cap raw body bytes. */
export function boundedTreeProblem(value: unknown, maxDepth = 24, maxNodes = 5000): string | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const next = stack.pop()!;
    if (++nodes > maxNodes) return '内容树节点过多';
    if (next.depth > maxDepth) return '内容嵌套过深';
    if (next.value && typeof next.value === 'object') {
      if (seen.has(next.value)) return '内容必须是无循环的 JSON 树';
      seen.add(next.value);
      for (const child of Object.values(next.value)) stack.push({ value: child, depth: next.depth + 1 });
    }
  }
  return null;
}

export function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Infinity : new TextEncoder().encode(serialized).byteLength;
  } catch { return Infinity; }
}
