import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { reconcile, updateProduct, validateState, wishlistIdentity } from './state.mjs';

const execFileAsync = promisify(execFile);
async function readState(file, identity) {
  let info;
  try { info = await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new Error('state must be a regular file (not a symlink)');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  validateState(state, identity);
  return state;
}
async function extract(url) {
  const command = process.env.AMAZON_WISHLIST_EXTRACT_COMMAND || 'amazon-wishlist-extract';
  let output;
  try {
    output = await execFileAsync(command, [url], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 360000
    });
  } catch (error) {
    let reason = error.message;
    if (error.stdout) {
      try {
        const partial = JSON.parse(error.stdout);
        reason = 'extractor result: ' + (partial.completionReason || 'incomplete');
      } catch { /* Preserve the original command failure. */ }
    }
    throw new Error(reason, { cause: error });
  }
  try { return JSON.parse(output.stdout); }
  catch (error) { throw new Error('extractor returned invalid JSON', { cause: error }); }
}
async function atomicWrite(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function run(url, filename, { getObservation = extract } = {}) {
  const identity = wishlistIdentity(url);
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new TypeError('state JSON pathname is required');
  }
  const file = path.resolve(filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  let lockHandle;
  try {
    lockHandle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('monitor state is locked: ' + lock);
    throw error;
  }
  try {
    const previous = await readState(file, identity);
    const observation = await getObservation(url);
    const next = reconcile(previous, observation, identity);
    await atomicWrite(file, next);
    const last = next.checks[next.checks.length - 1];
    return {
      stateFile: file,
      wishlistUrl: identity,
      checkedAt: last.checkedAt,
      itemCount: last.itemCount,
      verified: last.items.filter(item => item.price.verified).length,
      unverified: last.items.filter(item => !item.price.verified).length,
      historyLength: next.checks.length,
      completionReason: last.completionReason,
      summary: next.summary
    };
  } finally {
    await lockHandle.close();
    await fs.unlink(lock);
  }
}

function parseTarget(value) {
  if (value === 'clear') return null;
  const match = /^([1-9]\d*)(?:[.,](\d{1,2}))?$/.exec(value);
  if (!match) throw new TypeError('target must be a positive EUR amount or clear');
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new TypeError('target is too large');
  return cents;
}

export async function edit(filename, asin, changes) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new TypeError('monitor JSON pathname is required');
  }
  const file = path.resolve(filename);
  const lock = file + '.lock';
  let lockHandle;
  try {
    lockHandle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('monitor state is locked: ' + lock);
    throw error;
  }
  try {
    // Read and validate before modifying any state. Do not synthesize an
    // arbitrary wishlist or empty monitor while editing user-owned targets.
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const identity = wishlistIdentity(data.wishlistUrl);
    validateState(data, identity);
    const next = updateProduct(data, identity, asin, changes);
    await atomicWrite(file, next);
    return {
      stateFile: file, asin,
      targetCents: next.products[asin].targetCents,
      note: next.products[asin].note,
      targetReached: next.products[asin].targetReached,
      historyLength: next.checks.length
    };
  } finally {
    await lockHandle.close();
    await fs.unlink(lock);
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  try {
    let result;
    if (process.argv.length === 4) {
      result = await run(process.argv[2], process.argv[3]);
    } else if (process.argv.length === 6 && process.argv[2] === 'target') {
      result = await edit(process.argv[3], process.argv[4], {
        targetCents: parseTarget(process.argv[5])
      });
    } else if (process.argv.length === 6 && process.argv[2] === 'note') {
      result = await edit(process.argv[3], process.argv[4], {
        note: process.argv[5] === 'clear' ? '' : process.argv[5]
      });
    } else {
      console.error('usage: amazon-wishlist-monitor <wishlist-url> <state.json>');
      console.error('       amazon-wishlist-monitor target <state.json> <ASIN> <EUR|clear>');
      console.error('       amazon-wishlist-monitor note <state.json> <ASIN> <text|clear>');
      process.exitCode = 2;
    }
    if (result) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    console.error('amazon-wishlist-monitor: ' + error.message);
    process.exitCode = 1;
  }
}
