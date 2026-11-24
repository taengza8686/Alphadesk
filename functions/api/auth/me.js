import { json } from '../../../functions-lib/auth.js';
export async function onRequestGet({ data }) {
  const u = data.user;
  return u ? json({ id: u.id, email: u.email, role: u.role || 'user' }) : json({ error: 'login_required' }, 401);
}
