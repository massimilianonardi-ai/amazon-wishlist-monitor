import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { reconcile, updateProduct, importSettings, validateState, wishlistIdentity } from './state.mjs';
import { readLegacySheetCsv } from './legacy-sheet.mjs';
import { renderHtmlReport, htmlReportPath } from './report.mjs';

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
    await handle.writeFile(typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', 'utf8');
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
// The JSON is authoritative. Render before changing it, then publish HTML after
// committing the JSON. If the second write fails, the explicit "report"
// command can safely recreate the derived HTML without repeating extraction.
async function commitState(file, state) {
  const reportFile = htmlReportPath(file);
  const html = renderHtmlReport(state);
  await atomicWrite(file, state);
  await atomicWrite(reportFile, html);
  return reportFile;
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
    const reportFile = await commitState(file, next);
    const last = next.checks[next.checks.length - 1];
    return {
      stateFile: file,
      reportFile,
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
    const reportFile = await commitState(file, next);
    return {
      stateFile: file, reportFile, asin,
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


export async function importSheet(filename, csvFilename) {
  const file = path.resolve(filename);
  const csv = readLegacySheetCsv(await fs.readFile(csvFilename, 'utf8'));
  const lock = file + '.lock';
  let handle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('monitor state is locked: ' + lock);
    throw error;
  }
  try {
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    const identity = wishlistIdentity(previous.wishlistUrl);
    const result = importSettings(previous, identity, csv);
    const reportFile = await commitState(file, result.state);
    return {
      stateFile: file, reportFile, imported: result.imported, skipped: result.skipped,
      historyLength: result.state.checks.length
    };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

/** Rebuild the HTML from the saved JSON without visiting Amazon or touching history. */
export async function regenerateReport(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new TypeError('monitor JSON pathname is required');
  }
  const file = path.resolve(filename), lock = file + '.lock';
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('monitor state is locked: ' + lock);
    throw error;
  }
  try {
    const info = await fs.lstat(file);
    if (!info.isFile()) throw new Error('state must be a regular file');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    const html = renderHtmlReport(state);
    const reportFile = htmlReportPath(file);
    await atomicWrite(reportFile, html);
    return { stateFile: file, reportFile, checkedAt: state.lastCheckedAt };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  try {
    let result;
    if (process.argv.length === 4 && process.argv[2] === 'report') {
      result = await regenerateReport(process.argv[3]);
    } else if (process.argv.length === 4) {
      result = await run(process.argv[2], process.argv[3]);
    } else if (process.argv.length === 6 && process.argv[2] === 'target') {
      result = await edit(process.argv[3], process.argv[4], {
        targetCents: parseTarget(process.argv[5])
      });
    } else if (process.argv.length === 5 && process.argv[2] === 'import-sheet') {
      result = await importSheet(process.argv[3], process.argv[4]);
    } else if (process.argv.length === 6 && process.argv[2] === 'baseline') {
      result = await edit(process.argv[3], process.argv[4], {
        legacyMinimumCents: parseTarget(process.argv[5])
      });
    } else if (process.argv.length === 6 && process.argv[2] === 'note') {
      result = await edit(process.argv[3], process.argv[4], {
        note: process.argv[5] === 'clear' ? '' : process.argv[5]
      });
    } else {
      console.error('usage: amazon-wishlist-monitor <wishlist-url> <state.json>');
      console.error('       amazon-wishlist-monitor report <state.json>');
      console.error('       amazon-wishlist-monitor target <state.json> <ASIN> <EUR|clear>');
      console.error('       amazon-wishlist-monitor note <state.json> <ASIN> <text|clear>');
      console.error('       amazon-wishlist-monitor baseline <state.json> <ASIN> <EUR|clear>');
      console.error('       amazon-wishlist-monitor import-sheet <state.json> <tab.csv>');
      process.exitCode = 2;
    }
    if (result) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    console.error('amazon-wishlist-monitor: ' + error.message);
    process.exitCode = 1;
  }
}
