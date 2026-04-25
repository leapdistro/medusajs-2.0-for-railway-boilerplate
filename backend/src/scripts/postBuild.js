const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const MEDUSA_SERVER_PATH = path.join(process.cwd(), '.medusa', 'server');

// Check if .medusa/server exists - if not, build process failed
if (!fs.existsSync(MEDUSA_SERVER_PATH)) {
  throw new Error('.medusa/server directory not found. This indicates the Medusa build process failed. Please check for build errors.');
}

// Copy pnpm-lock.yaml
fs.copyFileSync(
  path.join(process.cwd(), 'pnpm-lock.yaml'),
  path.join(MEDUSA_SERVER_PATH, 'pnpm-lock.yaml')
);

// Copy .env if it exists
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  fs.copyFileSync(
    envPath,
    path.join(MEDUSA_SERVER_PATH, '.env')
  );
}

/**
 * Run a shell command with retry on transient failure. Used for the pnpm
 * install below — pnpm's content-addressable store sometimes hits ENOENT
 * mid-extract on Railway containers (cache eviction race). One retry
 * usually clears it. Final fallback drops --frozen-lockfile so pnpm can
 * recover by re-resolving missing entries.
 */
function runWithRetry(cmd, opts, attempts = [
  cmd,
  cmd,                                 // straight retry
  cmd.replace('--frozen-lockfile', ''), // last-ditch: allow lockfile update
]) {
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const label = i === 0 ? 'first attempt' : i === attempts.length - 1 ? 'final attempt (no frozen lockfile)' : `retry ${i}`;
    console.log(`postBuild: ${label} — ${attempt}`);
    try {
      execSync(attempt, opts);
      if (i > 0) console.log(`postBuild: succeeded on ${label}`);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`postBuild: ${label} failed, ${i < attempts.length - 1 ? 'retrying' : 'giving up'}...`);
      if (i < attempts.length - 1) {
        // Brief backoff before retry — gives the cache a moment to settle.
        const waitMs = (i + 1) * 2000;
        const start = Date.now();
        while (Date.now() - start < waitMs) { /* busy wait — execSync is sync */ }
      }
    }
  }
  throw lastErr;
}

// Install dependencies (with retry — postBuild blew up before due to a
// transient pnpm store ENOENT during cache extract).
console.log('Installing dependencies in .medusa/server...');
runWithRetry('pnpm i --prod --frozen-lockfile', {
  cwd: MEDUSA_SERVER_PATH,
  stdio: 'inherit',
});
