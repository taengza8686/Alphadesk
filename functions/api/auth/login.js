import { json, hashPw, getUser, makeToken, sessionCookie, safeEq, rateCount, rateHit, rateClear, clientIp } from '../../../functions-lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.PF_KV) return json({ error: 'not_configured' }, 503);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: '요청 형식이 올바르지 않습니다' }, 400); }
  const id = String(b?.id || '').trim().toLowerCase();
  const pw = String(b?.password || '');
  const rk = 'login:' + clientIp(request);
  if ((await rateCount(env, rk)) >= 10) return json({ error: '로그인 실패가 많아 15분간 잠겼습니다' }, 429);
  const u = await getUser(env, id, true);
  const ok = u?.pw && safeEq((await hashPw(pw, u.pw.salt, u.pw.iter)).hash, u.pw.hash);
  if (!ok) { await rateHit(env, rk, 100); return json({ error: '아이디 또는 비밀번호가 맞지 않습니다' }, 401); }
  if (u.status === 'pending') return json({ error: '가입 승인 대기 중입니다. 관리자 승인 후 로그인할 수 있습니다' }, 403);
  if (u.status !== 'approved') return json({ error: '사용이 제한된 계정입니다' }, 403);
  await rateClear(env, rk);
  const token = await makeToken(env, u);
  return json({ ok: true, id: u.id }, 200, { 'Set-Cookie': sessionCookie(token) });
}
