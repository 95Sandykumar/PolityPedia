// Overnight preview deploy for PolityPedia.
//
// Finds the newest ralph/night-* branch, and if it has an app (web/package.json)
// and a commit not deployed yet, builds a Vercel PREVIEW deploy of that commit
// (never production) and sends the link to Boss on Telegram.
// It never pushes git and never touches the main working tree: it deploys from
// a throwaway detached worktree.
//
// Run:  node scripts/preview-deploy.mjs           (deploy if there is something new)
//       node scripts/preview-deploy.mjs --dry-run (say what it would do)
// Scheduled by PM2 app "polity-preview" (see notes.md). Exit 0 on success or
// nothing to do, 1 on a real failure.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(REPO, '.preview');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const VERCEL_ORG_ID = 'team_69fQMR09JMP0ps5RLIUe9e8T';
const VERCEL_PROJECT_ID = 'prj_2W4QiJuP5kS2CWPu45rVR3XBU2tz';
const NOTIFY = 'C:/Users/95san/Documents/AI & Business/builder/claudeclaw/scripts/notify.sh';
const DRY = process.argv.includes('--dry-run');
// Full paths: under PM2, a bare "bash" can resolve to WSL (System32\bash.exe).
const pick = (p, fallback) => (fs.existsSync(p) ? p : fallback);
const BASH = pick('C:/Program Files/Git/usr/bin/bash.exe', 'bash');
const VERCEL = pick('C:/Users/95san/AppData/Roaming/npm/vercel.cmd', 'vercel');

const log = (msg) => console.log(`[polity-preview ${new Date().toISOString()}] ${msg}`);
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

function newestNightBranch() {
  const out = git('for-each-ref', '--sort=-refname', '--format=%(refname:short)', 'refs/heads/ralph/night-*');
  return out.split('\n').filter(Boolean)[0] ?? null;
}

function hasApp(sha) {
  try {
    git('cat-file', '-e', `${sha}:web/package.json`);
    return true;
  } catch {
    return false;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function notify(text) {
  const r = spawnSync(BASH, [NOTIFY, text], { encoding: 'utf8' });
  log(`telegram: exit ${r.status} ${(r.stdout || r.stderr || '').trim()}`);
}

function main() {
  const branch = newestNightBranch();
  if (!branch) return log('no ralph/night-* branch yet. Nothing to deploy.');
  const sha = git('rev-parse', branch);
  if (!hasApp(sha)) return log(`${branch} (${sha.slice(0, 7)}) has no web/package.json yet. Nothing to deploy.`);
  const state = readState();
  if (state.sha === sha) return log(`${sha.slice(0, 7)} already deployed: ${state.url}`);
  const done = git('log', '--oneline', `main..${sha}`).split('\n').filter(Boolean).length;
  if (DRY) return log(`DRY RUN: would deploy ${branch} at ${sha.slice(0, 7)} (${done} commits past main).`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polity-preview-'));
  try {
    git('worktree', 'add', '--detach', tmp, sha);
    log(`deploying ${branch} ${sha.slice(0, 7)} from ${tmp}`);
    const r = spawnSync(`"${VERCEL}"`, ['deploy', '--yes', '--target=preview'], {
      cwd: tmp,
      encoding: 'utf8',
      shell: true,
      timeout: 20 * 60 * 1000,
      env: { ...process.env, VERCEL_ORG_ID, VERCEL_PROJECT_ID },
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const url = (out.match(/https:\/\/[a-z0-9-]+\.vercel\.app/gi) ?? []).pop();
    if (r.status !== 0 || !url) {
      log(`deploy FAILED (exit ${r.status}).\n${out.slice(-3000)}`);
      notify(`PolityPedia preview deploy FAILED for ${branch} ${sha.slice(0, 7)}. Log: pm2 logs polity-preview`);
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sha, branch, url, at: new Date().toISOString() }, null, 2));
    log(`deployed: ${url}`);
    notify(`PolityPedia preview is up (${branch}, ${done} commits): ${url}\nLog in to Vercel to open it. Preview only, not production.`);
  } finally {
    try {
      git('worktree', 'remove', '--force', tmp);
    } catch (e) {
      log(`worktree cleanup failed: ${e.message}`);
    }
  }
}

main();
