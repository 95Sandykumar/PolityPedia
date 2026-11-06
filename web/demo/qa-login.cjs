/**
 * Mint a real session for a demo alias WITHOUT sending any email.
 *
 *   node demo/qa-login.cjs <student|teacher|admin>
 *
 * 1. admin generate_link (magiclink) returns a hashed_token, no email is sent
 * 2. POST /auth/v1/verify with that token_hash returns the session
 * 3. the same cookie the app builds (src/lib/auth/session.ts encodeSession,
 *    name pp_session) is written to cookie-<role>.json in the scratchpad
 *    demo folder (override with QA_OUT_DIR).
 * Prints only "ok". Never prints a token.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib.cjs');

const OUT_DIR =
  process.env.QA_OUT_DIR ||
  'C:/Users/95san/AppData/Local/Temp/claude/4efcc787bde00883/fd6da8ea-7fca-434c-9e84-3236e69ee259/scratchpad/demo';
const ROLES = { student: L.EMAILS.student, teacher: L.EMAILS.teacher, admin: L.EMAILS.admin };

/** Same bytes as encodeSession() in src/lib/auth/session.ts: base64url of the JSON. */
function encodeSession(session) {
  return Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
}

async function mint(role) {
  const email = ROLES[role];
  if (!email) throw new Error('role must be one of: ' + Object.keys(ROLES).join(', '));

  const gen = await L.call('POST', '/auth/v1/admin/generate_link', {
    key: L.SVC,
    body: { type: 'magiclink', email },
  });
  const tokenHash = gen.json && (gen.json.hashed_token || (gen.json.properties && gen.json.properties.hashed_token));
  if (gen.status >= 300 || !tokenHash) throw new Error('generate_link failed (' + gen.status + ')');

  const ver = await L.call('POST', '/auth/v1/verify', { body: { type: 'magiclink', token_hash: tokenHash } });
  const j = ver.json || {};
  if (ver.status >= 300 || !j.access_token || !j.user) throw new Error('verify failed (' + ver.status + ')');

  // Role the way the app reads it (supabase-auth-client.ts toSession): with the user's own token.
  const bearer = j.access_token;
  const pr = await L.call('GET', '/rest/v1/profiles?select=role', { bearer });
  const appRole = Array.isArray(pr.json) && pr.json[0] ? pr.json[0].role : 'student';
  const session = {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : '',
    userId: j.user.id,
    role: appRole,
  };
  if (typeof j.expires_at === 'number') session.expiresAt = j.expires_at;
  else if (typeof j.expires_in === 'number') session.expiresAt = Math.floor(Date.now() / 1000) + j.expires_in;
  if (appRole === 'teacher') {
    const ts = await L.call('GET', '/rest/v1/teachers?select=status', { bearer });
    session.teacherStatus = Array.isArray(ts.json) && ts.json[0] ? ts.json[0].status : 'pending';
  }

  const cookie = {
    name: 'pp_session',
    value: encodeSession(session),
    domain: 'localhost',
    path: '/',
    httpOnly: true,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `cookie-${role}.json`);
  fs.writeFileSync(file, JSON.stringify(cookie));
  return { file, role: appRole };
}

module.exports = { mint, OUT_DIR };

if (require.main === module) {
  mint(process.argv[2])
    .then(() => console.log('ok'))
    .catch((e) => {
      console.log('FAILED:', String(e.message).slice(0, 200));
      process.exit(1);
    });
}
