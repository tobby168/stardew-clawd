#!/usr/bin/env node
/*
 * Generates per-beat MP3s from scripts/video/script.json using OpenAI TTS,
 * then probes each MP3's duration with ffprobe and writes a manifest the
 * orchestrator reads to know how long to sleep on each beat.
 *
 * Usage:  node scripts/video/generate-tts.mjs [--force] [--only=<beatId>]
 *   --force      regenerate even if the mp3 already exists
 *   --only=ID    regenerate only the named beat (skips others)
 *
 * Reads OPENAI_API_KEY from .env (or environment). Voice + model come from
 * script.json so the source of truth is one place.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SCRIPT_PATH = resolve(__dirname, 'script.json');
const AUDIO_DIR = resolve(__dirname, 'audio');
const MANIFEST_PATH = resolve(AUDIO_DIR, 'manifest.json');

function loadDotEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const txt = readFileSync(envPath, 'utf-8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k]) continue; // existing env wins
    let value = v;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[k] = value;
  }
}

loadDotEnv();

const KEY = process.env.OPENAI_API_KEY;
if (!KEY || KEY.length < 20) {
  console.error('OPENAI_API_KEY missing or looks like a placeholder; set it in .env');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || true] : [a, true];
  }),
);

const script = JSON.parse(readFileSync(SCRIPT_PATH, 'utf-8'));
const voice = script.voice ?? 'echo';
const model = script.model ?? 'gpt-4o-mini-tts';
const instructions = script.instructions;

if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });

async function tts(text) {
  const body = {
    model,
    voice,
    input: text,
    response_format: 'mp3',
  };
  if (instructions && /gpt-4o/.test(model)) body.instructions = instructions;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 400)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

function probeDurationSec(mp3Path) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mp3Path}"`,
    { encoding: 'utf-8' },
  );
  return parseFloat(out.trim());
}

const manifest = [];
for (const beat of script.beats) {
  const outPath = resolve(AUDIO_DIR, `${beat.id}.mp3`);
  const skip =
    !args.force &&
    existsSync(outPath) &&
    (!args.only || args.only === beat.id);
  const isTarget = !args.only || args.only === beat.id;

  if (!isTarget && existsSync(outPath)) {
    const durationSec = probeDurationSec(outPath);
    manifest.push({ id: beat.id, file: `${beat.id}.mp3`, durationSec, action: beat.action });
    continue;
  }

  if (skip) {
    const durationSec = probeDurationSec(outPath);
    manifest.push({ id: beat.id, file: `${beat.id}.mp3`, durationSec, action: beat.action });
    console.log(`skip ${beat.id} (cached, ${durationSec.toFixed(2)}s)`);
    continue;
  }

  process.stdout.write(`tts ${beat.id} ... `);
  const buf = await tts(beat.text);
  writeFileSync(outPath, buf);
  const durationSec = probeDurationSec(outPath);
  console.log(`${(buf.length / 1024).toFixed(1)}KB, ${durationSec.toFixed(2)}s`);
  manifest.push({ id: beat.id, file: `${beat.id}.mp3`, durationSec, action: beat.action });
}

writeFileSync(MANIFEST_PATH, JSON.stringify({ voice, model, beats: manifest }, null, 2));
const total = manifest.reduce((s, b) => s + b.durationSec, 0);
console.log(`\nwrote ${manifest.length} beats, total ${total.toFixed(1)}s (${(total / 60).toFixed(2)} min)`);
console.log(`manifest: ${MANIFEST_PATH}`);
