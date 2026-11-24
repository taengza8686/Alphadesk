// 07 노트 공용: D1 접근·권한·유틸
import { json } from './auth.js';

export const now = () => new Date().toISOString();
export const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
};
export const canEdit = u => !!u && u.role === 'admin';
export function needDb(env) { return env.NOTES_DB ? null : json({ error: 'not_configured', message: '노트 저장소(D1)가 아직 연결되지 않았습니다' }, 503); }
export function needEditor(data) { return canEdit(data.user) ? null : json({ error: 'forbidden', message: '편집 권한이 없습니다(관리자 화면에서 편집 권한 부여 필요)' }, 403); }
export async function body(request) { try { return await request.json(); } catch (e) { return null; } }
export const cleanTitle = t => String(t ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
export function stripText(html) {
  return String(html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|tr|div|blockquote|summary)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
// 위험한 태그·속성 제거 (편집기 스키마가 1차로 거르고, 저장 시 한 번 더)
export function sanitize(html) {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|vbscript|data:text)[^"']*\2/gi, '$1=$2#$2');
}
export { json };
