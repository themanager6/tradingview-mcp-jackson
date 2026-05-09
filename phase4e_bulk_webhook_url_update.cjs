#!/usr/bin/env node
// Phase 4e — Bulk webhook URL update on TV alert subscriptions.
//
// Pre-conditions:
//   - TV Desktop running with CDP on port 9222
//   - TV Alerts panel open in widget bar
//   - DOM filter cleared so virtual list shows all alive alerts
//   - TV WS write throttle has reset (verify with single-alert smoke first)
//   - TV account 2FA satisfied (per project_tv_webhook_2fa_gate.md) —
//     without 2FA the webhook toggle is silently rejected
//
// Output (data/logs/, append-only JSONL):
//   - phase4e_pre_update_<ts>.jsonl    pre-update state for each alert
//   - phase4e_success_<ts>.jsonl       per-alert success record
//   - phase4e_failures_<ts>.jsonl      per-alert failure record
//
// Usage:
//   node phase4e_bulk_webhook_url_update.cjs --url <new_url> --dry-run                # plan only
//   node phase4e_bulk_webhook_url_update.cjs --url <new_url> --alert-id NNNN          # single alert smoke
//   node phase4e_bulk_webhook_url_update.cjs --url <new_url> --ids "id1,id2,id3"      # comma list
//   node phase4e_bulk_webhook_url_update.cjs --url <new_url> --ids-from <file.txt>    # one-id-per-line
//   node phase4e_bulk_webhook_url_update.cjs --url <new_url> --chunk-size 30          # chunked w/ idle
//   node phase4e_bulk_webhook_url_update.cjs --url <new_url> --resume-from <log>      # skip done
//
// SAFETY: requires --url AND requires explicit alert_id input. No "update
// every alert" default. Webhook URL changes affect production alert
// delivery; refusing to run without explicit scope is intentional.

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('./node_modules/ws/index.js');

// ── Paths ─────────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const PRE_LOG     = path.join(LOG_DIR, `phase4e_pre_update_${TS}.jsonl`);
const SUCCESS_LOG = path.join(LOG_DIR, `phase4e_success_${TS}.jsonl`);
const FAILURE_LOG = path.join(LOG_DIR, `phase4e_failures_${TS}.jsonl`);
const DRY_RUN_PLAN = path.join(LOG_DIR, `phase4e_dry_run_${TS}.json`);

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const urlIdx = args.indexOf('--url');
const newUrl = urlIdx >= 0 ? args[urlIdx + 1] : null;
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

// Validate --url is provided and well-formed
if (!newUrl) {
  console.error('--url <webhook_url> is required.');
  console.error('Refusing to run without explicit URL (safety guard).');
  process.exit(1);
}
if (!/^https?:\/\//i.test(newUrl)) {
  console.error(`--url must start with http:// or https:// (got: ${newUrl})`);
  process.exit(1);
}

// Build target list — REQUIRED for safety. No "update everything" default.
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
  console.error('Refusing to run with empty target list (safety guard against accidental mass update).');
  process.exit(1);
}

// Resume: skip ids already updated.
const alreadyDone = new Set();
if (resumeFrom) {
  if (!fs.existsSync(resumeFrom)) { console.error(`--resume-from path not found: ${resumeFrom}`); process.exit(1); }
  for (const line of fs.readFileSync(resumeFrom, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (r.alert_id && (r.action === 'updated' || (r.action || '').startsWith('skipped'))) alreadyDone.add(r.alert_id);
    } catch {}
  }
}

// ── CDP plumbing (mirror phase4d_bulk_*) ─────────────────────────────────
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

// ── Stash + clearSearch (same as phase4d_bulk_*) ─────────────────────────
const STASH_INIT = `(function () {
  const desc = document.querySelector('[data-name="alert-item-status"]');
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
  const desc = document.querySelector('[data-name="alert-item-status"]');
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

// ── Per-alert webhook URL update IIFE ────────────────────────────────────
// Mirrors src/core/alerts.js:updateWebhookUrl. Adds dialog-content
// verification (per feedback_items_drift_dialog_verification.md memory).
function buildUpdateExpr(alertId, expectedMessage, targetUrl) {
  const expectedEsc = JSON.stringify(expectedMessage || '');
  const urlEsc = JSON.stringify(targetUrl);
  return `(async function () {
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
      const stuckNotif = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
      if (stuckNotif && stuckNotif.offsetWidth) {
        const c = stuckNotif.querySelector('[data-qa-id="cancel"]');
        if (c) {
          const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
          if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
          const m = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
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
      const modal = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
      if (modal && modal.offsetWidth) {
        const c = modal.querySelector('[data-qa-id="cancel"]');
        if (c) {
          const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
          if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
          const m = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
          if (!m || !m.offsetWidth) break;
        }
      }
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

    // 1. Open the create-edit-dialog
    callbacks.onEditButtonClick(idx);
    let dialog = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (dialog && dialog.offsetWidth) break;
    }
    if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alertId} };

    // 2. Wait for content to fully load + verify dialog content matches the
    //    alert we expected (guards against items[]-drift).
    await new Promise(r => setTimeout(r, 200));
    const msgBtnVerify = dialog.querySelector('[data-qa-id="alert-message-button"]');
    if (!msgBtnVerify) { await cleanCancel(); return { error: 'no alert-message-button in dialog', alert_id: ${alertId} }; }
    const observedMessage = (msgBtnVerify.textContent || '').trim();
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
      };
    }

    // 3. Click notifications fieldset button to open the modal
    const notifBtn = dialog.querySelector('[data-qa-id="alert-notifications-button"]');
    if (!notifBtn) { await cleanCancel(); return { error: 'no alert-notifications-button', alert_id: ${alertId} }; }
    const notifPK = Object.keys(notifBtn).find(k => k.startsWith('__reactProps$'));
    if (!notifPK || !notifBtn[notifPK].onClick) { await cleanCancel(); return { error: 'no onClick on alert-notifications-button', alert_id: ${alertId} }; }
    notifBtn[notifPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: notifBtn, target: notifBtn, nativeEvent: {} });

    // 4. Wait for notifications modal
    let modal = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      modal = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
      if (modal && modal.offsetWidth) break;
    }
    if (!modal || !modal.offsetWidth) { await cleanCancel(); return { error: 'notifications modal did not appear', alert_id: ${alertId} }; }

    // 5. Read current webhook state
    const urlInput = modal.querySelector('[data-qa-id="ui-lib-Input-input webhook-input-input"]');
    if (!urlInput) { await cleanCancel(); return { error: 'webhook URL input not found in modal', alert_id: ${alertId} }; }
    const oldUrl = urlInput.value || '';
    const wasDisabled = !!urlInput.disabled;

    // 6. Idempotency: if URL matches AND toggle is on (input enabled), skip
    const newUrl = ${urlEsc};
    if (oldUrl === newUrl && !wasDisabled) {
      await cleanCancel();
      return { skipped: true, reason: 'already_set', alert_id: ${alertId}, current_url: oldUrl };
    }

    // 7. If toggle OFF, flip via native checked-setter + dispatch real DOM events
    //    (Phase 4c discovered: React-controlled checkbox needs real DOM events,
    //    not synthetic onChange invocation, to actually toggle parent state)
    let toggleWasEnabled = false;
    if (wasDisabled) {
      const checkbox = modal.querySelector('label[data-qa-id="webhook"] input[data-qa-id="ui-lib-checkbox-input-input"]')
                    || modal.querySelector('[data-qa-id="webhook"] [data-qa-id="ui-lib-checkbox-input-input"]');
      if (!checkbox) { await cleanCancel(); return { error: 'webhook toggle checkbox not found', alert_id: ${alertId} }; }
      const checkedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
      checkedSetter.call(checkbox, true);
      checkbox.dispatchEvent(new Event('click', { bubbles: true }));
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      toggleWasEnabled = true;
      // Diagnostic reads — preserve from Phase 4c for failure-path debugging
      const checkboxCheckedAfterClick = !!checkbox.checked;
      await new Promise(r => setTimeout(r, 100));
      const checkboxCheckedAfter100ms = !!checkbox.checked;
      await new Promise(r => setTimeout(r, 200));
      const checkboxCheckedAfter300ms = !!checkbox.checked;
      await new Promise(r => setTimeout(r, 50));
      let enabled = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 25));
        if (!urlInput.disabled) { enabled = true; break; }
      }
      if (!enabled) {
        await cleanCancel();
        return {
          error: 'toggle_enabled_but_input_still_disabled',
          alert_id: ${alertId},
          checkbox_checked_after_click: checkboxCheckedAfterClick,
          checkbox_checked_after_100ms: checkboxCheckedAfter100ms,
          checkbox_checked_after_300ms: checkboxCheckedAfter300ms,
          input_disabled_after_500ms: !!urlInput.disabled,
          input_value_after_500ms: urlInput.value || '',
        };
      }
    }

    // 8. Set the URL value via native setter + dispatch input/change
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(urlInput, newUrl);
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    urlInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    if (urlInput.value !== newUrl) {
      await cleanCancel();
      return { error: 'url value did not stick', alert_id: ${alertId}, observed_value: urlInput.value };
    }

    // 9. Click modal Apply
    const apply = modal.querySelector('[data-qa-id="submit"]');
    if (!apply) { await cleanCancel(); return { error: 'no submit (apply) in notifications modal', alert_id: ${alertId} }; }
    const applyPK = Object.keys(apply).find(k => k.startsWith('__reactProps$'));
    if (!applyPK || !apply[applyPK].onClick) { await cleanCancel(); return { error: 'no onClick on apply', alert_id: ${alertId} }; }
    apply[applyPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: apply, target: apply, nativeEvent: {} });

    // 10. Wait for modal to close
    let modalClosed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      const stillModal = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
      if (!stillModal || !stillModal.offsetWidth) { modalClosed = true; break; }
    }
    if (!modalClosed) { await cleanCancel(); return { error: 'notifications modal did not close after apply', alert_id: ${alertId} }; }

    // 11. Click outer dialog Save
    await new Promise(r => setTimeout(r, 100));
    const dialogAfter = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
    if (!dialogAfter || !dialogAfter.offsetWidth) {
      return { error: 'outer dialog vanished after modal apply', alert_id: ${alertId} };
    }
    const save = dialogAfter.querySelector('[data-qa-id="submit"]');
    if (!save) { await cleanCancel(); return { error: 'no save button in outer dialog', alert_id: ${alertId} }; }
    if ((save.textContent || '').trim() !== 'Save') { await cleanCancel(); return { error: 'outer submit text not Save', alert_id: ${alertId}, save_text: (save.textContent || '').trim() }; }
    const savePK = Object.keys(save).find(k => k.startsWith('__reactProps$'));
    if (!savePK || !save[savePK].onClick) { await cleanCancel(); return { error: 'no onClick on save', alert_id: ${alertId} }; }
    save[savePK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: save, target: save, nativeEvent: {} });

    // 12. Wait for outer dialog to close. Poll up to 6s (matches phase4d save poll).
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 50));
      const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (!still || !still.offsetWidth) {
        return {
          updated: true,
          alert_id: ${alertId},
          old_url: oldUrl,
          new_url: newUrl,
          toggle_was_enabled: toggleWasEnabled,
        };
      }
    }
    return { error: 'outer_save_failed_after_modal_apply', alert_id: ${alertId}, modal_applied: true };
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
  console.log('  Phase 4e — Bulk webhook URL update');
  console.log('================================================================');
  console.log(`Mode:         ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Targets:      ${targetIds.length} alert_id(s)`);
  console.log(`New URL:      ${newUrl}`);
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
  if (itemsCount < 50) {
    console.error(`items_count=${itemsCount} too low — DOM filter still active. Aborting.`);
    console.error('Resolve filter (chart-scope toggle, filter chip, etc.) per project_phase4e_dom_filter_blocker.md');
    ws.close(); process.exit(1);
  }

  const fetchRes = await fetchAlerts(cdp);
  if (!fetchRes || fetchRes.error) { console.error('fetchAlerts failed:', fetchRes); ws.close(); process.exit(1); }
  console.log(`Fetched ${fetchRes.alerts.length} alerts via REST`);

  const byId = {};
  for (const a of fetchRes.alerts) byId[a.alert_id] = a;
  const plan = [];
  for (const id of targetIds) {
    if (alreadyDone.has(id)) {
      plan.push({ alert_id: id, kind: 'skip_resume', reason: 'already in resume log' });
    } else if (!byId[id]) {
      plan.push({ alert_id: id, kind: 'not_found', reason: 'not in current REST list (deleted)' });
    } else {
      plan.push({
        alert_id: id, kind: 'update',
        symbol: byId[id].symbol,
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
  console.log('  Updating webhook URLs');
  console.log('================================================================');
  let nUpdated = 0, nSkipped = 0, nNotFound = 0, nResumeSkip = 0, nFailed = 0;
  let attemptedCount = 0;
  const t0 = Date.now();

  for (let i = 0; i < plan.length; i++) {
    if (interrupted) break;
    const p = plan[i];
    const tag = `[${(i+1).toString().padStart(3)}/${plan.length}] aid=${p.alert_id} ${(p.symbol || '?').padEnd(22)}`;

    if (p.kind === 'skip_resume') {
      nResumeSkip++;
      fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'skipped_resume', alert_id: p.alert_id, reason: p.reason }) + '\n');
      console.log(`${tag} ⊝ resume-skip`); continue;
    }
    if (p.kind === 'not_found') {
      nNotFound++;
      fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'not_found', alert_id: p.alert_id, reason: p.reason }) + '\n');
      console.log(`${tag} ⊝ not_found`); continue;
    }

    // Chunk break before next attempt
    if (chunkSize && attemptedCount > 0 && attemptedCount % chunkSize === 0) {
      console.log(`\n--- chunk break: ${attemptedCount} attempts done, idling 5 min ---`);
      await sleep(300000);
      console.log(`--- chunk break complete, resuming ---\n`);
    }
    attemptedCount++;

    fs.appendFileSync(PRE_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      alert_id: p.alert_id, symbol: p.symbol,
      target_url: newUrl,
    }) + '\n');

    try {
      const res = await cdp.eval(buildUpdateExpr(p.alert_id, p.expected_message, newUrl));
      if (res && res.updated) {
        nUpdated++;
        fs.appendFileSync(SUCCESS_LOG, JSON.stringify({
          ts: new Date().toISOString(), action: 'updated',
          alert_id: p.alert_id, symbol: p.symbol,
          old_url: res.old_url, new_url: res.new_url,
          toggle_was_enabled: res.toggle_was_enabled,
        }) + '\n');
        console.log(`${tag} ✓ updated (toggle_was_enabled=${res.toggle_was_enabled})`);
      } else if (res && res.skipped) {
        nSkipped++;
        fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'skipped', alert_id: p.alert_id, reason: res.reason }) + '\n');
        console.log(`${tag} ⊝ skipped (${res.reason})`);
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
      console.log(`--- progress: ${i+1}/${plan.length} [${elapsed}s] updated=${nUpdated} skipped=${nSkipped} not_found=${nNotFound} failed=${nFailed} ---`);
    }
    await sleep(1000);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log('\n================================================================');
  console.log('  Summary');
  console.log('================================================================');
  console.log(`  Updated:         ${nUpdated}`);
  console.log(`  Skipped:         ${nSkipped}`);
  console.log(`  Not found:       ${nNotFound}`);
  console.log(`  Resume-skipped:  ${nResumeSkip}`);
  console.log(`  Failed:          ${nFailed}`);
  console.log(`  Elapsed:         ${elapsed}s`);
  console.log(`  Pre-update log:  ${PRE_LOG}`);
  console.log(`  Success log:     ${SUCCESS_LOG}`);
  if (nFailed > 0) console.log(`  Failure log:     ${FAILURE_LOG}`);
  if (interrupted) console.log('  Run interrupted by SIGINT.');
  ws.close();
  process.exit(nFailed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
