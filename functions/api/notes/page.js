// 페이지 본문 읽기/저장 — GET ?id= / PUT {id,title,html,rev,force}
import { json, needDb, needEditor, body, now, sanitize, stripText, cleanTitle } from '../../../functions-lib/notes.js';
const KEEP_REVS = 40;

export async function onRequestGet({ request, env }) {
  const e = needDb(env); if (e) return e;
  const id = new URL(request.url).searchParams.get('id') || '';
  const row = await env.NOTES_DB.prepare('SELECT id, parent_id, title, icon, cover, html, rev, source, created_at, updated_at, updated_by, deleted_at FROM nodes WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404);
  return json(row, 200, { 'Cache-Control': 'private, no-cache' });
}

export async function onRequestPut({ request, env, data }) {
  const e = needDb(env) || needEditor(data); if (e) return e;
  const b = await body(request);
  if (!b || !b.id) return json({ error: 'bad_request' }, 400);
  const html = sanitize(b.html ?? '');
  if (html.length > 1900000) return json({ error: 'too_large', message: '페이지가 너무 큽니다(약 1.9MB 한도). 내용을 하위 페이지로 나눠주세요' }, 413);
  const db = env.NOTES_DB;
  const cur = await db.prepare('SELECT id, title, html, rev, deleted_at FROM nodes WHERE id = ?').bind(b.id).first();
  if (!cur) return json({ error: 'not_found' }, 404);
  if (!b.force && Number(b.rev) !== Number(cur.rev)) return json({ error: 'conflict', message: '다른 곳에서 먼저 수정됐습니다', rev: cur.rev }, 409);
  const title = b.title === undefined ? cur.title : cleanTitle(b.title);
  const t = now(); const rev = cur.rev + 1;
  // 자동 저장이 잦으므로 이전 버전은 10분에 한 번만 보관
  const last = await db.prepare('SELECT saved_at FROM revisions WHERE page_id = ? ORDER BY rev DESC LIMIT 1').bind(cur.id).first();
  const keep = !last || (Date.now() - Date.parse(last.saved_at)) > 10 * 60 * 1000;
  const st = [];
  if (keep && cur.html) st.push(db.prepare('INSERT OR REPLACE INTO revisions (page_id, rev, title, html, saved_at, saved_by) VALUES (?, ?, ?, ?, ?, ?)').bind(cur.id, cur.rev, cur.title, cur.html, t, data.user.id));
  await db.batch([
    ...st,
    db.prepare("UPDATE nodes SET title = ?, html = ?, text = ?, rev = ?, source = 'app', updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(title, html, stripText(html).slice(0, 200000), rev, t, data.user.id, cur.id),
    db.prepare('DELETE FROM revisions WHERE page_id = ? AND rev NOT IN (SELECT rev FROM revisions WHERE page_id = ? ORDER BY rev DESC LIMIT ?)').bind(cur.id, cur.id, KEEP_REVS),
  ]);
  return json({ ok: true, rev, updated_at: t });
}
