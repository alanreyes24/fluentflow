process.loadEnvFile('.env');
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
const PORT = 9455;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

// No --user-data-dir: the real profile, so the key lands where the app will
// look for it, encrypted by safeStorage the same way a hand-typed one would be.
const app = spawn('apps/desktop/dist/mac-arm64/FluentFlow.app/Contents/MacOS/FluentFlow',
  [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env, detached: true });

let browser;
for (let i = 0; i < 80 && !browser; i++) {
  try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null, protocolTimeout: 120000 }); } catch { await delay(250); }
}
const page = (await browser.pages()).find(p => !p.url().startsWith('devtools://'));
await delay(3000);

async function visible(sel, timeout = 15000) {
  await page.waitForFunction((s) => [...document.querySelectorAll(s)]
    .some(n => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }), { timeout, polling: 300 }, sel);
  const all = await page.$$(sel); let last = null;
  for (const h of all) if (await h.evaluate(n => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; })) last = h;
  return last;
}
const has = async (t) => (await page.evaluate(() => document.body.innerText)).includes(t);

if (await has('Continue without an account')) { (await visible('[aria-label="Continue without an account"]')).click(); await delay(1500); }
(await visible('[aria-label="Settings"]')).click(); await delay(1500);

const field = await visible('[aria-label="API key"]');
await field.click();
await page.keyboard.type(process.env.GEMINI_API_KEY);
await delay(300);
(await visible('[aria-label="Save key"]')).click();
await delay(2500);

const text = await page.evaluate(() => document.body.innerText);
console.log('connected :', /Connected/.test(text));
console.log('model     :', (text.match(/gemini-[\w.\-]+/) || ['(none)'])[0]);
await browser.disconnect();
