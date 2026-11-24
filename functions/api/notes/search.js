// 제목·본문 검색 — GET ?q=
import { json, needDb } from '../../../functions-lib/notes.js';

export async function onRequestGet({ request, env }) {
  const e = needDb(env); if (e) return e;
  const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 100);
  if (q.length < 2) return json({ results: [] });
  const { results } = await env.NOTES_DB.prepare(
    `SELECT id, parent_id, title, updated_at, instr(lower(title), lower(?1)) AS ti, instr(lower(text), lower(?1)) AS pos,
            substr(text, max(1, instr(lower(text), lower(?1)) - 60), 180) AS snip
     FROM nodes WHERE deleted_at IS NULL AND (instr(lower(title), lower(?1)) > 0 OR instr(lower(text), lower(?1)) > 0)
     ORDER BY (ti > 0) DESC, updated_at DESC LIMIT 60`).bind(q).all();
  return json({ results });
}
