import { json, hashPw, putUser, getUser, rateHit, clientIp } from '../../../functions-lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.PF_KV) return json({ error: 'not_configured' }, 503);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: '요청 형식이 올바르지 않습니다' }, 400); }
  const id = String(b?.id || '').trim().toLowerCase();
  const pw = String(b?.password || '');
  const email = String(b?.email || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,20}$/.test(id)) return json({ error: 'ID는 영문 소문자·숫자·._- 3~20자입니다' }, 400);
  if (pw.length < 8 || pw.length > 100) return json({ error: '비밀번호는 8자 이상이어야 합니다' }, 400);
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return json({ error: '이메일 형식이 올바르지 않습니다' }, 400);
  if (!(await rateHit(env, 'signup:' + clientIp(request), 5, 3600))) return json({ error: '가입 신청이 너무 많습니다. 1시간 후 다시 시도하세요' }, 429);
  if (await getUser(env, id, true)) return json({ error: '이미 사용 중인 ID입니다' }, 409);
  const pwh = await hashPw(pw);
  await putUser(env, { id, email, pw: pwh, status: 'pending', role: 'user', sv: 1, createdAt: new Date().toISOString() });
  return json({ ok: true, status: 'pending' });
}
