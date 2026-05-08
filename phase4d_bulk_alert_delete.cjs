#!/usr/bin/env node
// Phase 4d-companion — Bulk DELETE TV alert subscriptions by alert_id list.
//
// Built 2026-05-08 to support the SWING-strategy retirement: 51 SWING-prefixed
// alerts to be removed before completing Phase 4d/4e/4f. Pattern mirrors
// phase4d_bulk_message_update.cjs (CDP-direct, chunked, resumable).
//
// Pre-conditions:
//   - TV Desktop running with CDP on port 9222
//   - TV Alerts panel open in widget bar
//   - DOM filter cleared so virtual list shows all 119 alerts
//   - TV WS write throttle has reset (verify with single-alert smoke first)
//
// Output (data/logs/, append-only JSONL):
//   - phase4d_bulk_delete_pre_<ts>.jsonl    pre-delete state for each alert (rollback artifact via SWING archive if needed)
//   - phase4d_bulk_delete_success_<ts>.jsonl per-alert success record
//   - phase4d_bulk_delete_failures_<ts>.jsonl per-alert failure record
//
// Usage:
//   node phase4d_bulk_alert_delete.cjs --dry-run                 # plan only
//   node phase4d_bulk_alert_delete.cjs --alert-id NNNN           # single alert (smoke test)
//   node phase4d_bulk_alert_delete.cjs --ids "id1,id2,id3"       # explicit comma list
//   node phase4d_bulk_alert_delete.cjs --ids-from <file.txt>     # one id per line, # comments OK
//   node phase4d_bulk_alert_delete.cjs --resume-from <log>       # skip already-deleted
//   node phase4d_bulk_alert_delete.cjs --chunk-size 30           # idle 5min after every N attempts
//   node phase4d_bulk_alert_delete.cjs --force                   # bypass items_count >= 100 pre-flight
//   node phase4d_bulk_alert_delete.cjs                           # SAFE DEFAULT: errors with no input
//
// SAFETY: this script will NOT delete anything without explicit alert_id input
// (--alert-id, --ids, or --ids-from). No "delete all alerts I find" mode.

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('./node_modules/ws/index.js');

// ── Paths ─────────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const PRE_LOG     = path.join(LOG_DIR, `phase4d_bulk_delete_pre_${TS}.jsonl`);
const SUCCESS_LOG = path.join(LOG_DIR, `phase4d_bulk_delete_success_${TS}.jsonl`);
const FAILURE_LOG = path.join(LOG_DIR, `phase4d_bulk_delete_failures_${TS}.jsonl`);
const DRY_RUN_PLAN = path.join(LOG_DIR, `phase4d_bulk_delete_dry_run_${TS}.json`);

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const idIdx = args.indexOf('--alert-id');
const onlyAlertId = idIdx >= 0 ? parseInt(args[idIdx + 1], 10) : null;
const idsIdx = args.indexOf('--ids');
const idsCsv = idsIdx >= 0 ? args[idsIdx + 1] : null;
const idsFileIdx = args.indexOf('--ids-from');
const idsFile = idsFileIdx >= 0 ? args[idsFileIdx + 1] : null;
const resumeIdx = args.indexOf('--resume-from');
const resumeFrom = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const chunkIdx = args.indexOf('--chunk-size');
const chunkSize = chunkIdx >= 0 ? parseInt(args[chunkIdx + 1], 10) : null;
// --force: bypass the items_count >= 100 pre-flight. Use ONLY when you've
// intentionally reduced the alive alert count (e.g., mid-bulk-delete the
// count has dropped below 100 and you want to continue). Without this
// flag, the runner aborts to guard against accidental runs on a filtered
// panel showing a small subset of alerts.
const forceFlag = args.includes('--force');

// Build target list — REQUIRED for safety. No "delete everything" default.
let targetIds = [];
if (onlyAlertId) {
  targetIds = [onlyAlertId];
} else if (idsCsv) {
  targetIds = idsCsv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
} else if (idsFile) {
  if (!fs.existsSync(idsFile)) { console.error(`--ids-from path not found: ${idsFile}`); process.exit(1); }
  targetIds = fs.readFileSync(idsFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(s => parseInt(s, 10))
    .filter(n => Number.isFinite(n));
}
if (targetIds.length === 0) {
  console.error('No target alert_ids provided. Use --alert-id N OR --ids "id1,id2,..." OR --ids-from <file>.');
  console.error('Refusing to run with empty target list (safety guard against accidental mass delete).');
  process.exit(1);
}

// Resume: skip ids already successfully deleted.
const alreadyDone = new Set();
if (resumeFrom) {
  if (!fs.existsSync(resumeFrom)) { console.error(`--resume-from path not found: ${resumeFrom}`); process.exit(1); }
  for (const line of fs.readFileSync(resumeFrom, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (r.alert_id && (r.action === 'deleted' || r.action === 'not_found')) alreadyDone.add(r.alert_id);
    } catch {}
  }
}

// ── CDP plumbing (mirror phase4d_bulk_message_update.cjs) ────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); res.on('error', reject); }).on('error', reject);
  });
}

class CDPClient {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map();
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      }
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.id++; this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails).substring(0, 500));
    return r.result?.value;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Stash + clearSearch (same as phase4d_bulk_message_update.cjs) ────────
const STASH_INIT = `(function () {
  const desc = document.querySelector('[data-name="alert-item-description"]');
  if (!desc) return { error: 'no alert-item-description — open Alerts panel first' };
  const fk = Object.keys(desc).find(k => k.startsWith('__reactFiber$'));
  let walker = desc[fk];
  for (let d = 0; d < 30; d++) {
    if (!walker) break;
    const mp = walker.memoizedProps;
    if (mp && mp.itemCount && mp.itemData && Array.isArray(mp.itemData.items)) {
      window.__efCallbacks = mp.itemData.callbacks; window.__efItems = mp.itemData.items;
      return { stashed: true, items_count: mp.itemData.items.length };
    }
    walker = walker.return;
  }
  return { error: 'virtual list not found' };
})()`;

const CLEAR_SEARCH = `(function () {
  const s = document.querySelector('input[type="search"], input[placeholder*="earch" i]');
  if (!s) return { cleared: false };
  const before = s.value;
  if (before === '') return { was_empty: true };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(s, ''); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  return { cleared: true, before_value: before };
})()`;

const RESTASH = `(async function () {
  await new Promise(r => setTimeout(r, 800));
  const desc = document.querySelector('[data-name="alert-item-description"]');
  if (!desc) return { error: 'no description after restash' };
  const fk = Object.keys(desc).find(k => k.startsWith('__reactFiber$'));
  let walker = desc[fk];
  for (let d = 0; d < 30; d++) {
    if (!walker) break;
    const mp = walker.memoizedProps;
    if (mp && mp.itemCount && mp.itemData && Array.isArray(mp.itemData.items)) {
      window.__efCallbacks = mp.itemData.callbacks; window.__efItems = mp.itemData.items;
      return { restashed: true, items_count: mp.itemData.items.length };
    }
    walker = walker.return;
  }
  return { error: 'virtual list not found after restash' };
})()`;

// ── Per-alert delete IIFE — mirrors src/core/alerts.js deleteAlert exactly ─
function buildDeleteExpr(alertId, expectedMessage) {
  const expectedEsc = JSON.stringify(expectedMessage || '');
  return `(async function deleteOne() {
    const items = window.__efItems; const callbacks = window.__efCallbacks;
    if (!items || !callbacks) return { error: 'stash missing' };
    const idx = items.findIndex(it => it.id === ${alertId});
    if (idx < 0) return { error: 'items_drift_alert_not_in_items', alert_id: ${alertId}, items_total: items.length };

    async function cleanStuckDialog() {
      const stuckEditor = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
      if (stuckEditor && stuckEditor.offsetWidth) {
        const c = stuckEditor.querySelector('[data-qa-id="cancel"]');
        if (c) {
          const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
          if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
          const m = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
          if (!m || !m.offsetWidth) break;
        }
      }
      const stuckDialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (stuckDialog && stuckDialog.offsetWidth) {
        const c = stuckDialog.querySelector('[data-qa-id="cancel"]');
        if (c) {
          const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
          if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
          const d = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
          if (!d || !d.offsetWidth) break;
        }
      }
    }
    await cleanStuckDialog();

    async function cleanCancel() {
      const dlg = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (dlg && dlg.offsetWidth) {
        const c = dlg.querySelector('[data-qa-id="cancel"]');
        if (c) {
          const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
          if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
          const d = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
          if (!d || !d.offsetWidth) break;
        }
      }
    }

    callbacks.onEditButtonClick(idx);
    let dialog = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (dialog && dialog.offsetWidth) break;
    }
    if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alertId} };

    await new Promise(r => setTimeout(r, 200));
    const msgBtn = dialog.querySelector('[data-qa-id="alert-message-button"]');
    if (!msgBtn) { await cleanCancel(); return { error: 'no alert-message-button in dialog', alert_id: ${alertId} }; }
    const observedMessage = (msgBtn.textContent || '').trim();
    const expected = ${expectedEsc};
    const matchLen = Math.min(observedMessage.length, expected.length, 80);
    const matched = matchLen > 0 && (
      observedMessage === expected ||
      observedMessage.substring(0, matchLen) === expected.substring(0, matchLen)
    );
    if (!matched) {
      await cleanCancel();
      return {
        error: 'dialog_content_mismatch', alert_id: ${alertId},
        expected_preview: expected.substring(0, 100),
        observed_preview: observedMessage.substring(0, 100),
        observed_len: observedMessage.length, expected_len: expected.length,
      };
    }

    const deleteBtn = dialog.querySelector('[data-qa-id="delete"]');
    if (!deleteBtn) { await cleanCancel(); return { error: 'no [data-qa-id=delete] in dialog', alert_id: ${alertId} }; }
    const deletePK = Object.keys(deleteBtn).find(k => k.startsWith('__reactProps$'));
    if (!deletePK || !deleteBtn[deletePK].onClick) {
      await cleanCancel();
      return { error: 'no onClick on delete button', alert_id: ${alertId} };
    }
    deleteBtn[deletePK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: deleteBtn, target: deleteBtn, nativeEvent: {} });

    // Poll: 120 × 50ms = 6000ms (was 1500ms). Bumped per
    // feedback_ui_vs_cloud_persistence_lag.md — TV's UI can lag well past
    // 1.5s even when the delete itself has landed in cloud. Better to wait
    // 6s here than false-fail and re-try a delete that already succeeded.
    let confirmModal = null;
    let dialogClosedDirectly = false;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 50));
      confirmModal = document.querySelector('[data-qa-id="confirm-dialog"]') ||
        document.querySelector('[data-name="alert-delete-confirm"]') ||
        (function() {
          const dialogs = document.querySelectorAll('[role="dialog"], [data-qa-id*="dialog"]');
          for (const d of dialogs) {
            if (d === dialog) continue;
            if (!d.offsetWidth) continue;
            const txt = (d.textContent || '').toLowerCase();
            if (/sure|confirm|delete this alert|remove this alert/i.test(txt) && /cancel|no|keep/i.test(txt)) return d;
          }
          return null;
        })();
      if (confirmModal) break;
      const stillMain = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (!stillMain || !stillMain.offsetWidth) { dialogClosedDirectly = true; break; }
    }

    if (dialogClosedDirectly) {
      return { deleted: true, alert_id: ${alertId}, confirmation_path: 'direct_no_confirm', observed_preview: observedMessage.substring(0, 100) };
    }
    if (confirmModal) {
      const confirmCandidates = [
        confirmModal.querySelector('[data-qa-id="confirm"]'),
        confirmModal.querySelector('[data-qa-id="yes"]'),
        confirmModal.querySelector('[data-qa-id="submit"]'),
        confirmModal.querySelector('[data-qa-id="delete"]'),
      ];
      let confirmBtn = null;
      for (const c of confirmCandidates) {
        if (c && c.offsetWidth) { confirmBtn = c; break; }
      }
      if (!confirmBtn) {
        for (const b of confirmModal.querySelectorAll('button')) {
          if (!b.offsetWidth) continue;
          const t = (b.textContent || '').trim().toLowerCase();
          if (/^(yes|confirm|delete|ok|remove)$/.test(t)) { confirmBtn = b; break; }
        }
      }
      if (!confirmBtn) {
        await cleanCancel();
        return { error: 'confirm_modal_appeared_but_no_confirm_button', alert_id: ${alertId}, modal_text_preview: (confirmModal.textContent || '').substring(0, 200) };
      }
      const confirmPK = Object.keys(confirmBtn).find(k => k.startsWith('__reactProps$'));
      if (!confirmPK || !confirmBtn[confirmPK].onClick) {
        await cleanCancel();
        return { error: 'no onClick on confirm button', alert_id: ${alertId} };
      }
      confirmBtn[confirmPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: confirmBtn, target: confirmBtn, nativeEvent: {} });
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 50));
        const stillMain = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (!stillMain || !stillMain.offsetWidth) {
          return { deleted: true, alert_id: ${alertId}, confirmation_path: 'modal_confirmed', observed_preview: observedMessage.substring(0, 100) };
        }
      }
      return { error: 'main dialog did not close after confirm click', alert_id: ${alertId}, confirmation_path: 'modal_confirmed_but_dialog_stuck' };
    }
    await cleanCancel();
    return { error: 'no confirm modal and dialog did not close within 6000ms', alert_id: ${alertId} };
  })()`;
}

async function fetchAlerts(cdp) {
  return cdp.eval(`fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include', cache: 'no-store' })
    .then(r => r.json())
    .then(d => {
      if (d.s !== 'ok' || !Array.isArray(d.r)) return { alerts: [], error: d.errmsg || 'unexpected' };
      return { alerts: d.r.map(a => {
        let sym = a.symbol;
        try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e){}
        return { alert_id: a.alert_id, symbol: sym, message: a.message };
      }) };
    })
    .catch(e => ({ alerts: [], error: e.message }))`);
}

// ── Main ─────────────────────────────────────────────────────────────────
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; console.log('\n[SIGINT received — finishing current alert and exiting]'); });

async function main() {
  console.log('================================================================');
  console.log('  Phase 4d-companion — Bulk alert DELETE');
  console.log('================================================================');
  console.log(`Mode:         ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Targets:      ${targetIds.length} alert_id(s)`);
  if (resumeFrom) console.log(`Resume from:  ${resumeFrom} (${alreadyDone.size} already done)`);
  if (chunkSize) console.log(`Chunk size:   ${chunkSize} (5-min idle between chunks)`);
  console.log();

  const targets = await httpGet('http://localhost:9222/json');
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.error('No CDP page target'); process.exit(1); }
  console.log(`Target:       ${target.title}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  const cdp = new CDPClient(ws);

  // Stash + clearSearch + restash
  const stashRes = await cdp.eval(STASH_INIT);
  if (!stashRes || stashRes.error) { console.error('Stash failed:', stashRes); ws.close(); process.exit(1); }
  console.log(`Initial stash: items_count=${stashRes.items_count}`);
  const clr = await cdp.eval(CLEAR_SEARCH);
  let itemsCount = stashRes.items_count;
  if (clr.cleared && clr.before_value) {
    const re = await cdp.eval(RESTASH);
    if (!re || re.error) { console.error('Restash failed:', re); ws.close(); process.exit(1); }
    itemsCount = re.items_count;
    console.log(`Search-clear:  cleared=${JSON.stringify(clr.before_value)}; restash items_count=${itemsCount}`);
  }
  if (itemsCount < 100 && !forceFlag) {
    console.error(`items_count=${itemsCount} too low (< 100) — DOM filter may be active. Aborting.`);
    console.error('If you have intentionally reduced the alive count (e.g., mid-delete batch), pass --force to bypass.');
    console.error('Resolve filter (chart-scope toggle, filter chip, etc.) per project_phase4e_dom_filter_blocker.md');
    ws.close(); process.exit(1);
  }
  if (itemsCount !== 119 && itemsCount !== 68) {
    console.warn(`expected 119 (pre-delete) or 68 (post-SWING-delete), got ${itemsCount}. Continuing.`);
  }

  // Fetch current state to capture expected messages for verification
  const fetchRes = await fetchAlerts(cdp);
  if (!fetchRes || fetchRes.error) { console.error('fetchAlerts failed:', fetchRes); ws.close(); process.exit(1); }
  console.log(`Fetched ${fetchRes.alerts.length} alerts via REST`);

  // Build plan: only target ids that are still present
  const byId = {};
  for (const a of fetchRes.alerts) byId[a.alert_id] = a;
  const plan = [];
  for (const id of targetIds) {
    if (alreadyDone.has(id)) {
      plan.push({ alert_id: id, kind: 'skip_resume', reason: 'already in resume log' });
    } else if (!byId[id]) {
      plan.push({ alert_id: id, kind: 'not_found', reason: 'not in current REST list (already deleted)' });
    } else {
      plan.push({
        alert_id: id, kind: 'delete',
        symbol: byId[id].symbol,
        expected_message_preview: (byId[id].message || '').substring(0, 100),
        expected_message: byId[id].message || '',
      });
    }
  }

  const tally = {};
  for (const p of plan) tally[p.kind] = (tally[p.kind] || 0) + 1;
  console.log('\nPlan tally:');
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`  ${'TOTAL'.padEnd(20)} ${plan.length}`);

  if (dryRun) {
    fs.writeFileSync(DRY_RUN_PLAN, JSON.stringify(plan, null, 2));
    console.log(`\nDRY RUN — plan written to ${DRY_RUN_PLAN}`);
    ws.close(); process.exit(0);
  }

  console.log('\n================================================================');
  console.log('  Deleting alerts');
  console.log('================================================================');
  let nDeleted = 0, nNotFound = 0, nSkippedResume = 0, nFailed = 0;
  let attemptedCount = 0;
  const t0 = Date.now();

  for (let i = 0; i < plan.length; i++) {
    if (interrupted) break;
    const p = plan[i];
    const tag = `[${(i+1).toString().padStart(3)}/${plan.length}] aid=${p.alert_id} ${(p.symbol || '?').padEnd(22)}`;

    if (p.kind === 'skip_resume') {
      nSkippedResume++;
      fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'skipped_resume', alert_id: p.alert_id, reason: p.reason }) + '\n');
      console.log(`${tag} ⊝ resume-skip`); continue;
    }
    if (p.kind === 'not_found') {
      nNotFound++;
      fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'not_found', alert_id: p.alert_id, reason: p.reason }) + '\n');
      console.log(`${tag} ⊝ not_found (already deleted)`); continue;
    }

    // Chunk break before next attempt
    if (chunkSize && attemptedCount > 0 && attemptedCount % chunkSize === 0) {
      console.log(`\n--- chunk break: ${attemptedCount} attempts done, idling 5 min before next chunk ---`);
      await sleep(300000);
      console.log(`--- chunk break complete, resuming ---\n`);
    }
    attemptedCount++;

    fs.appendFileSync(PRE_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      alert_id: p.alert_id,
      symbol: p.symbol,
      pre_delete_message: p.expected_message,
    }) + '\n');

    try {
      const res = await cdp.eval(buildDeleteExpr(p.alert_id, p.expected_message));
      if (res && res.deleted) {
        nDeleted++;
        fs.appendFileSync(SUCCESS_LOG, JSON.stringify({
          ts: new Date().toISOString(), action: 'deleted',
          alert_id: p.alert_id, symbol: p.symbol,
          confirmation_path: res.confirmation_path,
        }) + '\n');
        console.log(`${tag} ✓ deleted (${res.confirmation_path})`);
      } else {
        nFailed++;
        fs.appendFileSync(FAILURE_LOG, JSON.stringify({ ts: new Date().toISOString(), record: p, error: res }) + '\n');
        console.log(`${tag} ✗ failed: ${JSON.stringify(res).substring(0, 160)}`);
      }
    } catch (e) {
      nFailed++;
      fs.appendFileSync(FAILURE_LOG, JSON.stringify({ ts: new Date().toISOString(), record: p, error: String(e) }) + '\n');
      console.log(`${tag} ✗ exception: ${String(e).substring(0, 160)}`);
    }

    if ((i + 1) % 10 === 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`--- progress: ${i+1}/${plan.length} [${elapsed}s] deleted=${nDeleted} not_found=${nNotFound} resume_skip=${nSkippedResume} failed=${nFailed} ---`);
    }
    await sleep(1000);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log('\n================================================================');
  console.log('  Summary');
  console.log('================================================================');
  console.log(`  Deleted:         ${nDeleted}`);
  console.log(`  Not found:       ${nNotFound}`);
  console.log(`  Resume-skipped:  ${nSkippedResume}`);
  console.log(`  Failed:          ${nFailed}`);
  console.log(`  Elapsed:         ${elapsed}s`);
  console.log(`  Pre-delete log:  ${PRE_LOG}`);
  console.log(`  Success log:     ${SUCCESS_LOG}`);
  if (nFailed > 0) console.log(`  Failure log:     ${FAILURE_LOG}`);
  if (interrupted) console.log('  Run interrupted by SIGINT.');
  ws.close();
  process.exit(nFailed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
