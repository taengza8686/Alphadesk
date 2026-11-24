// 트리 조작 — POST {op: create|rename|move|delete|restore|purge|icon, ...}
import { json, needDb, needEditor, body, now, newId, cleanTitle, sanitize, stripText } from '../../../functions-lib/notes.js';

async function subtree(db, id) {
  const { results } = await db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id) SELECT id FROM t`).bind(id).all();
  return results.map(r => r.id);
}

export async function onRequestPost({ request, env, data }) {
  const e = needDb(env) || needEditor(data); if (e) return e;
  const b = await body(request); if (!b) return json({ error: 'bad_json' }, 400);
  const db = env.NOTES_DB; const t = now(); const who = data.user.id;
  switch (b.op) {
    case 'create': {
      const parent = b.parent_id || null;
      if (parent && !(await db.prepare('SELECT 1 FROM nodes WHERE id = ? AND deleted_at IS NULL').bind(parent).first())) return json({ error: 'no_parent' }, 400);
      let sort = Number(b.sort);
      if (!Number.isFinite(sort)) {
        const m = await db.prepare(`SELECT ${b.first ? 'MIN(sort) - 1' : 'MAX(sort) + 1'} AS s FROM nodes WHERE parent_id IS ? AND deleted_at IS NULL`).bind(parent).first();
        sort = m?.s ?? 0;
      }
      const id = newId(); const html = sanitize(b.html || '');
      await db.prepare('INSERT INTO nodes (id, parent_id, title, icon, sort, html, text, source, rev, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, \'app\', 1, ?, ?, ?)')
        .bind(id, parent, cleanTitle(b.title) || '제목 없음', b.icon || null, sort, html, stripText(html).slice(0, 200000), t, t, who).run();
      return json({ ok: true, id, sort });
    }
    case 'rename':
      await db.prepare('UPDATE nodes SET title = ?, updated_at = ?, updated_by = ?, source = \'app\' WHERE id = ?').bind(cleanTitle(b.title) || '제목 없음', t, who, b.id).run();
      return json({ ok: true });
    case 'icon':
      await db.prepare('UPDATE nodes SET icon = ?, updated_at = ? WHERE id = ?').bind(String(b.icon || '').slice(0, 16) || null, t, b.id).run();
      return json({ ok: true });
    case 'move': {
      const parent = b.parent_id || null;
      if (parent) { const ids = await subtree(db, b.id); if (ids.includes(parent)) return json({ error: 'cycle', message: '자기 하위로는 옮길 수 없습니다' }, 400); }
      const sort = Number.isFinite(Number(b.sort)) ? Number(b.sort) : ((await db.prepare('SELECT MAX(sort) + 1 AS s FROM nodes WHERE parent_id IS ?').bind(parent).first())?.s ?? 0);
      await db.prepare('UPDATE nodes SET parent_id = ?, sort = ?, updated_at = ? WHERE id = ?').bind(parent, sort, t, b.id).run();
      return json({ ok: true, sort });
    }
    case 'delete': {
      const ids = await subtree(db, b.id);
      await db.batch(ids.map(id => db.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(t, id)));
      return json({ ok: true, count: ids.length });
    }
    case 'restore': {
      const ids = await subtree(db, b.id);
      const row = await db.prepare('SELECT parent_id FROM nodes WHERE id = ?').bind(b.id).first();
      const parentAlive = !row?.parent_id || await db.prepare('SELECT 1 FROM nodes WHERE id = ? AND deleted_at IS NULL').bind(row.parent_id).first();
      const st = ids.map(id => db.prepare('UPDATE nodes SET deleted_at = NULL WHERE id = ?').bind(id));
      if (!parentAlive) st.push(db.prepare('UPDATE nodes SET parent_id = NULL WHERE id = ?').bind(b.id));
      await db.batch(st);
      return json({ ok: true, count: ids.length });
    }
    case 'revisions': {
      const { results } = await db.prepare('SELECT rev, title, saved_at, saved_by, length(html) AS size FROM revisions WHERE page_id = ? ORDER BY rev DESC LIMIT 40').bind(b.id).all();
      return json({ revisions: results });
    }
    case 'revision': {
      const r = await db.prepare('SELECT rev, title, html, saved_at FROM revisions WHERE page_id = ? AND rev = ?').bind(b.id, b.rev).first();
      return r ? json(r) : json({ error: 'not_found' }, 404);
    }
    default: return json({ error: 'bad_op' }, 400);
  }
}
