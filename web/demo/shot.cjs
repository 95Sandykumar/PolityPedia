/**
 * Full-page screenshot of a route as a demo role.
 *
 *   node demo/shot.cjs <student|teacher|admin> <route> <out.png> [mobile|desktop]
 *
 * Needs the dev server on http://localhost:3000 and Chrome. Loads
 * cookie-<role>.json (made by qa-login.cjs; re-minted automatically when it is
 * missing or older than 40 minutes, because the access token lives ~1 hour).
 * mobile = 390x844 @2x, desktop = 1280x900. Prints the final path and status
 * so a redirect away from the asked route is visible.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { mint, OUT_DIR } = require('./qa-login.cjs');

const BASE = process.env.QA_BASE || 'http://localhost:3000';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function loadPuppeteer() {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const paths = [globalRoot, path.join(globalRoot, 'puppeteer', 'node_modules')];
  return require(require.resolve('puppeteer-core', { paths }));
}

async function main() {
  const [role, route, out, device = 'desktop'] = process.argv.slice(2);
  if (!role || !route || !out) {
    console.log('usage: node demo/shot.cjs <student|teacher|admin> <route> <out.png> [mobile|desktop]');
    process.exit(2);
  }
  const cookieFile = path.join(OUT_DIR, `cookie-${role}.json`);
  let stale = true;
  try {
    stale = Date.now() - fs.statSync(cookieFile).mtimeMs > 40 * 60 * 1000;
  } catch {
    /* missing */
  }
  if (stale) await mint(role);
  const cookie = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));

  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport(
      device === 'mobile'
        ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
        : { width: 1280, height: 900, deviceScaleFactor: 1 },
    );
    await page.setCookie({ ...cookie, sameSite: 'Lax' });
    const res = await page.goto(BASE + route, { waitUntil: 'networkidle2', timeout: 120000 });
    // Client-side fetches (admin payouts, alert badge) may land after network idle; QA_WAIT=ms to wait longer.
    await new Promise((r) => setTimeout(r, Number(process.env.QA_WAIT) || 1200));
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await page.screenshot({ path: out, fullPage: true });
    const u = new URL(page.url());
    console.log(`status=${res ? res.status() : '?'} final=${u.pathname}${u.search} ${u.pathname === route.split('?')[0] ? 'SAME' : 'REDIRECTED'}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.log('SHOT FAILED:', String(e.message).slice(0, 300));
  process.exit(1);
});
