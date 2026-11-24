// 관리자: 가입 신청 승인·거절·차단·삭제, 기존 공유 포트폴리오 이전 (X-Admin-Key = PF_PASSWORD)
import { json, isAdmin, getUser, putUser, bustUser, rateCount, rateHit, clientIp } from '../../../functions-lib/auth.js';

async function guard(request, env) {
  if (!env.PF_KV) return json({ error: 'not_configured' }, 503);
  const rk = 'admin:' + clientIp(request);
  if ((await rateCount(env, rk)) >= 10) return json({ error: '관리자 비밀번호 실패가 많아 15분간 잠겼습니다' }, 429);
  if (!isAdmin(request, env)) { await rateHit(env, rk, 100); return json({ error: '관리자 비밀번호가 맞지 않습니다' }, 401); }
  return null;
}

export async function onRequestGet({ request, env }) {
  const g = await guard(request, env); if (g) return g;
  const users = [];
  let cursor;
  do {
    const l = await env.PF_KV.list({ prefix: 'user:', cursor });
    for (const k of l.keys) {
      const u = await env.PF_KV.get(k.name, 'json');
      if (u) users.push({ id: u.id, email: u.email, status: u.status, role: u.role || 'user', createdAt: u.createdAt, approvedAt: u.approvedAt || null,
        hasPortfolio: !!(await env.PF_KV.get('portfolio:' + u.id)) });
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  users.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return json({ users, legacyPortfolio: !!(await env.PF_KV.get('portfolio')) });
}

export async function onRequestPost({ request, env }) {
  const g = await guard(request, env); if (g) return g;
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const id = String(b?.id || '').toLowerCase();
  const u = await getUser(env, id, true);
  if (!u) return json({ error: '없는 사용자입니다' }, 404);
  const now = new Date().toISOString();
  switch (b.action) {
    case 'approve': u.status = 'approved'; u.approvedAt = now; break;
    case 'reject': u.status = 'rejected'; u.sv = (u.sv || 1) + 1; break;
    case 'block': u.status = 'blocked'; u.sv = (u.sv || 1) + 1; break;
    case 'admin': u.role = u.role === 'admin' ? 'user' : 'admin'; break;
    case 'delete':
      await env.PF_KV.delete('user:' + id); await env.PF_KV.delete('portfolio:' + id); bustUser(id);
      return json({ ok: true });
    case 'migrate': {
      const legacy = await env.PF_KV.get('portfolio');
      if (!legacy) return json({ error: '이전할 기존 저장본이 없습니다' }, 404);
      await env.PF_KV.put('portfolio:' + id, legacy);
      return json({ ok: true });
    }
    default: return json({ error: 'unknown_action' }, 400);
  }
  await putUser(env, u);
  return json({ ok: true, status: u.status, role: u.role });
}
