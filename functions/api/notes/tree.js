// 노트 트리(본문 제외) — GET ?trash=1 이면 휴지통
import { json, needDb, canEdit } from '../../../functions-lib/notes.js';

export async function onRequestGet({ request, env, data }) {
  const e = needDb(env); if (e) return e;
  const trash = new URL(request.url).searchParams.get('trash') === '1';
  const q = trash
    ? `SELECT id, parent_id, title, icon, sort, updated_at, deleted_at FROM nodes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 300`
    : `SELECT id, parent_id, title, icon, sort, updated_at, created_at, length(html) AS size FROM nodes WHERE deleted_at IS NULL`;
  const { results } = await env.NOTES_DB.prepare(q).all();
  return json({ nodes: results, canEdit: canEdit(data.user) }, 200, { 'Cache-Control': 'private, no-cache' });
}
