// 여러 페이지 본문 한 번에 — GET ?parent=<id> 또는 ?ids=a,b,c (최대 100개) — 기업별·섹터별 실적 표 계산용
import { json, needDb } from '../../../functions-lib/notes.js';

export async function onRequestGet({ request, env }) {
  const e = needDb(env); if (e) return e;
  const sp = new URL(request.url).searchParams;
  const parent = sp.get('parent');
  if (parent) {
    const { results } = await env.NOTES_DB.prepare('SELECT id, parent_id, title, html, updated_at FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort').bind(parent).all();
    return json({ pages: results }, 200, { 'Cache-Control': 'private, no-cache' });
  }
  const ids = (sp.get('ids') || '').split(',').map(s => s.trim()).filter(s => /^[0-9a-f]{32}$/.test(s)).slice(0, 100);
  if (!ids.length) return json({ pages: [] });
  const { results } = await env.NOTES_DB.prepare(`SELECT id, parent_id, title, html, updated_at FROM nodes WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all();
  return json({ pages: results }, 200, { 'Cache-Control': 'private, no-cache' });
}
