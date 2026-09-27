#!/usr/bin/env node
// Generate missing raw art via the Codex CLI's image_generation tool.
//
//   node scripts/art/generate.mjs [--jobs 4] [--only cards,gods] [id ...]
//
// Writes art-src/<kind>/<id>.png. Existing files are skipped, so the script is
// safe to re-run after failures. Per-image logs go to art-src/logs/<id>.log.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, promptFor } from './manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../art-src');

const args = process.argv.slice(2);
let jobs = 4;
let only = null;
const ids = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--jobs') jobs = Number(args[++i]);
  else if (args[i] === '--only') only = new Set(args[++i].split(','));
  else ids.push(args[i]);
}

const todo = ENTRIES.filter((en) =>
  (!only || only.has(en.kind)) &&
  (ids.length === 0 || ids.includes(en.id)) &&
  !existsSync(path.join(ROOT, en.kind, `${en.id}.png`)));

console.log(`${todo.length} images to generate with ${jobs} parallel jobs`);
mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

function runOnce(entry, attempt) {
  const dir = path.join(ROOT, entry.kind);
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${entry.id}.png`);
  const prompt =
    `Use your image generation tool to create exactly ONE image with this prompt:\n\n${promptFor(entry)}\n\n` +
    `If the image is rejected by moderation, soften any violent wording and retry while keeping the mood. ` +
    `Save the final image as ${out} (copy it from wherever the tool saved it). Do not create any other files. ` +
    `Reply only with the saved path.`;
  const log = createWriteStream(path.join(ROOT, 'logs', `${entry.id}.log`), { flags: 'a' });
  log.write(`\n===== attempt ${attempt} ${new Date().toISOString()}\n`);
  return new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', dir, prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      log.end();
      resolve(existsSync(out));
    });
  });
}

let done = 0;
let failed = 0;
async function worker() {
  while (todo.length > 0) {
    const entry = todo.shift();
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) ok = await runOnce(entry, attempt);
    if (ok) done++; else failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${entry.kind}/${entry.id}  (${done} done, ${failed} failed, ${todo.length} queued)`);
  }
}

await Promise.all(Array.from({ length: jobs }, worker));
console.log(`finished: ${done} ok, ${failed} failed`);
