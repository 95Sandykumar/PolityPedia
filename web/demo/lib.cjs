/**
 * Shared helpers for the demo seed tooling. NO secrets in this file: every key
 * is read from web/.env.local at run time and never printed.
 *
 * Needs the `pg` package. The web app does not depend on it, so we look in
 * (1) a normal require, (2) $PG_MODULE, (3) the Claude scratchpad copy.
 * Fix for a fresh machine:  npm i --no-save pg   (from web/)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(WEB_ROOT, '.env.local');

function loadPg() {
  const tries = [
    'pg',
    process.env.PG_MODULE,
    'C:/Users/95san/AppData/Local/Temp/claude/4efcc787bde00883/fd6da8ea-7fca-434c-9e84-3236e69ee259/scratchpad/pgrun/node_modules/pg',
  ].filter(Boolean);
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      /* try next */
    }
  }
  throw new Error('pg module not found. Run: npm i --no-save pg  (from web/) or set PG_MODULE.');
}

const envText = fs.readFileSync(ENV_FILE, 'utf8');
function env(name) {
  const m = envText.match(new RegExp('^' + name + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

const URL_ = env('NEXT_PUBLIC_SUPABASE_URL');
const ANON = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SVC = env('SUPABASE_SERVICE_ROLE_KEY');
const PROJECT_REF = 'fkcuqwywxpvoxgzszhdq';

// Safety: this tooling only ever touches the PolityPedia project.
if (!URL_ || !URL_.includes(PROJECT_REF)) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL does not point at the PolityPedia project. Refusing to run.');
}

/** DB connection through the IPv4 session pooler (the direct host is IPv6 only). */
async function db() {
  const { Client } = loadPg();
  const dbUrl = env('SUPABASE_DB_URL');
  const m = dbUrl.match(/^postgres(?:ql)?:\/\/([^:]+):(.*)@([^@]+?):(\d+)\/(\w+)$/);
  const password = m[2].replace(/^\[|\]$/g, '');
  const c = new Client({
    host: 'aws-0-ap-south-1.pooler.supabase.com',
    port: 5432,
    user: 'postgres.' + PROJECT_REF,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 60000,
  });
  await c.connect();
  return c;
}

async function call(method, p, { key = ANON, bearer, body, headers = {} } = {}) {
  const h = { apikey: key, ...headers };
  h.Authorization = 'Bearer ' + (bearer || key);
  let b = body;
  if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
    h['Content-Type'] = h['Content-Type'] || 'application/json';
    b = JSON.stringify(body);
  }
  const r = await fetch(URL_ + p, { method, headers: h, body: b });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, text, json };
}

/** Same alias scheme everywhere. */
const BASE_EMAIL = '95sandeepkumar95';
const EMAILS = {
  teacher: `${BASE_EMAIL}+teacher@gmail.com`,
  admin: `${BASE_EMAIL}+admin@gmail.com`,
  student: `${BASE_EMAIL}+student@gmail.com`,
  boss: `${BASE_EMAIL}@gmail.com`,
  pending: 'demo-pending@example.com',
  s1: 'demo-s1@example.com',
  s2: 'demo-s2@example.com',
  s3: 'demo-s3@example.com',
};
const DEMO_USER_KEYS = ['teacher', 'admin', 'student', 'pending', 's1', 's2', 's3'];

/** Deterministic uuid from a name, so re-seeding keeps every URL stable. */
function uid(name) {
  const h = crypto.createHash('sha1').update('politypedia-demo:' + name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function findUserId(c, email) {
  const r = await c.query('select id from auth.users where lower(email)=lower($1)', [email]);
  return r.rows[0] ? r.rows[0].id : null;
}

/** Create a confirmed auth user with NO password and NO email sent. */
async function ensureAuthUser(c, email) {
  let id = await findUserId(c, email);
  if (id) return { id, created: false };
  const r = await call('POST', '/auth/v1/admin/users', {
    key: SVC,
    body: { email, email_confirm: true },
  });
  if (r.status >= 300) throw new Error(`create user failed (${r.status}) for ${email.replace(/@.*/, '@...')}`);
  id = r.json.id;
  return { id, created: true };
}

async function deleteAuthUser(id) {
  const r = await call('DELETE', '/auth/v1/admin/users/' + id, { key: SVC });
  return r.status;
}

const BUCKET = 'papers';

async function storagePut(objectPath, bytes) {
  const r = await call('POST', `/storage/v1/object/${BUCKET}/${objectPath}`, {
    key: SVC,
    body: new Uint8Array(bytes),
    headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
  });
  if (r.status >= 300) throw new Error(`storage upload failed (${r.status}) for ${objectPath}`);
}

async function storageRemoveFolder(folder) {
  const l = await call('POST', `/storage/v1/object/list/${BUCKET}`, {
    key: SVC,
    body: { prefix: folder, limit: 200, offset: 0 },
  });
  const names = Array.isArray(l.json) ? l.json.map((o) => `${folder}/${o.name}`) : [];
  if (names.length === 0) return 0;
  const d = await call('DELETE', `/storage/v1/object/${BUCKET}`, { key: SVC, body: { prefixes: names } });
  if (d.status >= 300) throw new Error('storage delete failed (' + d.status + ')');
  return names.length;
}

module.exports = {
  WEB_ROOT, URL: URL_, ANON, SVC, PROJECT_REF, EMAILS, DEMO_USER_KEYS, BUCKET,
  db, call, uid, findUserId, ensureAuthUser, deleteAuthUser, storagePut, storageRemoveFolder,
};
