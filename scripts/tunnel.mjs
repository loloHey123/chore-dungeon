// Self-healing Cloudflare tunnel.
//
// The free `cloudflared` quick tunnel hands out a NEW random *.trycloudflare.com
// URL every time it starts (e.g. after a Mac mini reboot). This wrapper owns the
// cloudflared process, watches its output for the assigned URL, and — whenever
// the URL changes — rewrites public/config.js and pushes it so GitHub Pages
// redeploys pointing at the new URL. Result: reboots fix themselves.
//
// Run under pm2 in place of raw cloudflared:
//   pm2 start scripts/tunnel.mjs --name cd-tunnel
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(REPO, 'public', 'config.js');
const PORT = process.env.PORT || 8787;
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || 'cloudflared';
const GIT = process.env.GIT_BIN || 'git';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let current = null;

function log(...a) { console.log('[tunnel]', ...a); }

function configUrl() {
  const m = readFileSync(CONFIG, 'utf8').match(/apiBase:\s*'([^']*)'/);
  return m ? m[1] : '';
}

function git(args) {
  return execFileSync(GIT, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function publish(url) {
  try {
    const src = readFileSync(CONFIG, 'utf8').replace(/apiBase:\s*'[^']*'/, `apiBase: '${url}'`);
    writeFileSync(CONFIG, src);
    git(['add', 'public/config.js']);
    // Nothing staged (identical) → skip.
    try { git(['diff', '--cached', '--quiet']); log('config.js unchanged, nothing to push'); return; } catch { /* has changes */ }
    git(['commit', '-m', 'Auto-update tunnel URL']);
    try {
      git(['push', 'origin', 'HEAD']);
    } catch {
      // Remote moved on — rebase once and retry.
      git(['pull', '--rebase', 'origin', 'main']);
      git(['push', 'origin', 'HEAD']);
    }
    log('published new tunnel URL to GitHub Pages:', url);
  } catch (e) {
    log('failed to publish config.js:', e.message);
  }
}

function onUrl(url) {
  if (url === current) return;
  current = url;
  log('tunnel URL:', url);
  if (url !== configUrl()) publish(url);
  else log('config.js already matches; no push needed');
}

function start() {
  log(`starting cloudflared → http://localhost:${PORT}`);
  const cf = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const scan = (buf) => { const m = buf.toString().match(URL_RE); if (m) onUrl(m[0]); };
  cf.stdout.on('data', scan);
  cf.stderr.on('data', scan);
  cf.on('exit', (code) => {
    log(`cloudflared exited (${code}); exiting so pm2 restarts us fresh`);
    process.exit(code || 1);
  });
}

start();
