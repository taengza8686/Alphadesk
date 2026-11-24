import { json, sessionCookie } from '../../../functions-lib/auth.js';
export async function onRequest() { return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) }); }
