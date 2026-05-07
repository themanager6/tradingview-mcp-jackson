#!/usr/bin/env node
// Bulk update Pine alertcondition subscription messages from emoji-prefixed text to JSON template.
//
// Phase A standalone script — Sub-project 1 / Phase 1E follow-up (Scenario B subscription update).
//
// Usage:
//   node update_alerts.cjs --dry-run                     # print plan only, no changes
//   node update_alerts.cjs --alert-id 4579835868         # update one specific alert
//   node update_alerts.cjs --limit 3                     # update first N alerts (testing)
//   node update_alerts.cjs                               # update ALL 59 target subscriptions
//
// Pre-conditions: TV Desktop running with CDP on port 9222, Alerts panel open in widget bar.
//
// Companion files:
//   <ef>/.alerts_target_mapping.json       — input (59 records, written by Phase A pre-build)
//   <ef>/alerts_pre_update_<date>.jsonl    — rollback log (per-alert old/new message)
//   <ef>/alerts_update_failures_<date>.jsonl — failure log
//   <ef>/.alerts_dry_run_plan.json         — dry-run output

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('./node_modules/ws/index.js');

// ── Paths ─────────────────────────────────────────────────────────────────
const EF_DIR = path.resolve(__dirname, '..', 'edge-finder-outcome-tracker');
const MAPPING_FILE = path.join(EF_DIR, '.alerts_target_mapping.json');
const DATE_TAG = '20260507';
const ROLLBACK_LOG = path.join(EF_DIR, `alerts_pre_update_${DATE_TAG}.jsonl`);
const FAILURE_LOG = path.join(EF_DIR, `alerts_update_failures_${DATE_TAG}.jsonl`);
const DRY_RUN_PLAN = path.join(EF_DIR, '.alerts_dry_run_plan.json');

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const idIdx = args.indexOf('--alert-id');
const onlyAlertId = idIdx >= 0 ? parseInt(args[idIdx + 1], 10) : null;

// ── JSON message builder ─────────────────────────────────────────────────
// Pine alert message format (post-substitution):
//   {"version":"1","panel_version":"<v22.2|v22.3|v23>","ticker":"{{ticker}}","price":{{close}},
//    "direction":"<LONG|SHORT>","tier":"<elite|all_stars|high_quality|dual_authorized>",
//    "alert_type":"<elite_setup|all_stars_aligned|high_quality_setup|enter_now_dual>",
//    "timestamp":"{{time}}"}
//
// {{close}} substitutes as a raw number (not quoted), so we placeholder-then-replace.
function buildNewMessage(record) {
  const obj = {
    version: '1',
    panel_version: record.panel_version,
    ticker: '{{ticker}}',
    price: '__CLOSE_PLACEHOLDER__',
    direction: record.direction,
    tier: record.tier,
    alert_type: record.alert_type,
    timestamp: '{{time}}',
  };
  let s = JSON.stringify(obj);
  s = s.replace('"__CLOSE_PLACEHOLDER__"', '{{close}}');
  return s;
}

// ── CDP helpers ─────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.on('message', data => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.pending.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  async evalAsync(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error('JS error: ' + JSON.stringify(res.exceptionDetails).substring(0, 500));
    }
    return res.result?.value;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Stash globals on window for reuse across eval calls ──────────────────
const STASH_INIT = `
(function init() {
  const desc = document.querySelector('[data-name="alert-item-description"]');
  if (!desc) return { error: 'no alert-item-description — open the Alerts panel first' };
  const fiberKey = Object.keys(desc).find(k => k.startsWith('__reactFiber$'));
  if (!fiberKey) return { error: 'no react fiber on description' };
  let walker = desc[fiberKey];
  for (let depth = 0; depth < 30; depth++) {
    if (!walker) break;
    const mp = walker.memoizedProps;
    if (mp && mp.itemCount && mp.itemData && Array.isArray(mp.itemData.items)) {
      window.__efCallbacks = mp.itemData.callbacks;
      window.__efItems = mp.itemData.items;
      return { stashed: true, items_count: mp.itemData.items.length };
    }
    walker = walker.return;
  }
  return { error: 'virtual list not found in fiber tree' };
})()
`;

// ── Defensively clear the alerts panel search filter ────────────────────
// (Operator may have inadvertently typed in the search box, which filters
// the items[] array and causes alert_id-not-found errors.)
const CLEAR_SEARCH = `
(function clearSearch() {
  const search = document.querySelector('input[type="search"], input[placeholder*="earch" i]');
  if (!search) return { cleared: false, reason: 'no search input' };
  const before = search.value;
  if (before === '') return { cleared: true, was_empty: true };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(search, '');
  search.dispatchEvent(new Event('input', { bubbles: true }));
  search.dispatchEvent(new Event('change', { bubbles: true }));
  return { cleared: true, before_value: before, after_value: search.value };
})()
`;

// ── Re-stash after filter clear (since items[] reference changes when filter recomputes) ──
const RESTASH_AND_VERIFY = `
(async function restash() {
  await new Promise(r => setTimeout(r, 800));
  const desc = document.querySelector('[data-name="alert-item-description"]');
  if (!desc) return { error: 'no alert-item-description after restash' };
  const fk = Object.keys(desc).find(k => k.startsWith('__reactFiber$'));
  let walker = desc[fk];
  for (let d = 0; d < 30; d++) {
    if (!walker) break;
    const mp = walker.memoizedProps;
    if (mp && mp.itemCount && mp.itemData && Array.isArray(mp.itemData.items)) {
      window.__efCallbacks = mp.itemData.callbacks;
      window.__efItems = mp.itemData.items;
      return { restashed: true, items_count: mp.itemData.items.length };
    }
    walker = walker.return;
  }
  return { error: 'virtual list not found after restash' };
})()
`;

// ── Per-alert update function (run inside TV page) ──────────────────────
function buildUpdateOneExpr(alertId, newMessage) {
  // newMessage is JSON-serialized then embedded; do double-encoding via JSON.stringify
  return `
(async function updateOne() {
  const items = window.__efItems;
  const callbacks = window.__efCallbacks;
  if (!items || !callbacks) return { error: 'stash missing' };

  const idx = items.findIndex(it => it.id === ${alertId});
  if (idx < 0) return { error: 'alert_id not found in items', alert_id: ${alertId} };

  // 1. Open the dialog
  callbacks.onEditButtonClick(idx);

  // Wait for dialog
  let dialog = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 50));
    dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
    if (dialog && dialog.offsetWidth) break;
  }
  if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alertId} };

  // 2. Find message button + capture old message
  const msgBtn = dialog.querySelector('[data-qa-id="alert-message-button"]');
  if (!msgBtn) return { error: 'no alert-message-button', alert_id: ${alertId} };
  const oldMessage = (msgBtn.getAttribute('data-overflow-tooltip-html') || msgBtn.textContent || '').trim();

  // Idempotency check
  if (oldMessage.startsWith('{')) {
    // Already JSON — close dialog without saving
    const cancel = dialog.querySelector('[data-qa-id="cancel"]');
    if (cancel) {
      const pk = Object.keys(cancel).find(k => k.startsWith('__reactProps$'));
      if (pk && cancel[pk].onClick) {
        cancel[pk].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: cancel, target: cancel, nativeEvent: {} });
      }
    }
    // Wait for close
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (!still || !still.offsetWidth) break;
    }
    return { skipped: true, reason: 'already_json', alert_id: ${alertId}, old_message_preview: oldMessage.substring(0, 80) };
  }

  // 3. Click message button via React fiber to expand the textarea
  const msgPropsKey = Object.keys(msgBtn).find(k => k.startsWith('__reactProps$'));
  if (!msgPropsKey || !msgBtn[msgPropsKey].onClick) {
    return { error: 'no onClick on alert-message-button', alert_id: ${alertId} };
  }
  msgBtn[msgPropsKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: msgBtn, target: msgBtn, nativeEvent: {} });

  // Wait for textarea
  let ta = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 50));
    ta = document.querySelector('#alert-message');
    if (ta && ta.offsetWidth) break;
  }
  if (!ta || !ta.offsetWidth) return { error: 'textarea did not appear', alert_id: ${alertId} };

  // 4. Set value via native setter + dispatch input event
  const newMsg = ${JSON.stringify(newMessage)};
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  nativeSetter.call(ta, newMsg);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));

  await new Promise(r => setTimeout(r, 100));

  if (ta.value !== newMsg) {
    return { error: 'value did not stick', alert_id: ${alertId}, expected_len: newMsg.length, actual_len: ta.value.length };
  }

  // 5a. Click Apply — TV uses TWO different UI paths for message editing:
  //   Path A (inline): the message editor expands inside the parent dialog — Apply is
  //                    parent.querySelector('[data-qa-id="submit"]') (text "Apply"); on
  //                    click it collapses back, parent footer's submit becomes "Save".
  //   Path B (modal):  a separate dialog [data-qa-id="alerts-message-edit-dialog"] opens
  //                    on top — Apply is modal.querySelector('[data-qa-id="submit"]'); on
  //                    click it closes the modal and commits new message into parent.
  // Path B's modal is at document level (sibling to parent), so dialog.querySelector won't
  // find it. We MUST check for the modal first and prefer its submit if present.
  const messageModal = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
  const editorRoot = messageModal || dialog;
  const usingModal = !!messageModal;
  const apply = editorRoot.querySelector('[data-qa-id="submit"]');
  if (!apply) return { error: 'no submit (apply) in editor root', alert_id: ${alertId}, modal_open: usingModal };
  const applyPropsKey = Object.keys(apply).find(k => k.startsWith('__reactProps$'));
  if (!applyPropsKey || !apply[applyPropsKey].onClick) {
    return { error: 'no onClick on submit (apply)', alert_id: ${alertId}, modal_open: usingModal };
  }
  apply[applyPropsKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: apply, target: apply, nativeEvent: {} });

  // 5b. Wait for editor to close — signal differs by path:
  //   Modal path: wait for the modal element to disappear
  //   Inline path: wait for the textarea to disappear
  let editorClosed = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (usingModal) {
      const stillModal = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
      if (!stillModal || !stillModal.offsetWidth) { editorClosed = true; break; }
    } else {
      const stillTa = document.querySelector('#alert-message');
      if (!stillTa || !stillTa.offsetWidth) { editorClosed = true; break; }
    }
  }
  if (!editorClosed) {
    return { error: 'editor did not close after apply', alert_id: ${alertId}, modal_path: usingModal };
  }

  // 5c. Sanity: confirm message-button now displays the new JSON (= Apply succeeded)
  const msgBtnAfter = dialog.querySelector('[data-qa-id="alert-message-button"]');
  const msgBtnText = msgBtnAfter ? (msgBtnAfter.textContent || '').trim() : '';
  if (!msgBtnText.startsWith('{')) {
    return { error: 'message-button does not show new JSON after apply', alert_id: ${alertId}, msg_btn_text_preview: msgBtnText.substring(0, 100) };
  }

  // 5d. Brief settle wait + re-query submit (now Save button in main dialog footer)
  await new Promise(r => setTimeout(r, 100));
  const save = dialog.querySelector('[data-qa-id="submit"]');
  if (!save) return { error: 'no submit (save) button after apply', alert_id: ${alertId} };
  const saveText = (save.textContent || '').trim();
  if (saveText !== 'Save') {
    return { error: 'submit text is not Save after apply', alert_id: ${alertId}, save_text: saveText };
  }
  const savePropsKey = Object.keys(save).find(k => k.startsWith('__reactProps$'));
  if (!savePropsKey || !save[savePropsKey].onClick) {
    return { error: 'no onClick on submit (save)', alert_id: ${alertId} };
  }
  save[savePropsKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: save, target: save, nativeEvent: {} });

  // 5e. Wait for dialog to close (= alert saved to TV cloud)
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 50));
    const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
    if (!still || !still.offsetWidth) {
      return { updated: true, alert_id: ${alertId}, old_message: oldMessage.substring(0, 250), new_message: newMsg };
    }
  }
  return { error: 'dialog did not close after save', alert_id: ${alertId}, old_message: oldMessage.substring(0, 250) };
})()
`;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('================================================================');
  console.log('  Pine alert subscription bulk updater');
  console.log('================================================================');
  console.log(`Mode:         ${dryRun ? 'DRY RUN (no changes)' : 'LIVE UPDATE'}`);
  if (Number.isFinite(limit)) console.log(`Limit:        ${limit}`);
  if (onlyAlertId) console.log(`Only alert:   ${onlyAlertId}`);
  console.log(`Mapping file: ${MAPPING_FILE}`);
  console.log();

  // Load mapping
  if (!fs.existsSync(MAPPING_FILE)) {
    console.error(`Mapping file not found: ${MAPPING_FILE}`);
    process.exit(1);
  }
  const mappingData = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  let records = mappingData.mappings;
  if (onlyAlertId) records = records.filter(r => r.alert_id === onlyAlertId);
  records = records.slice(0, limit);
  console.log(`Loaded ${records.length} target subscription record(s)`);
  if (records.length === 0) {
    console.error('No records to process. Check --alert-id matches.');
    process.exit(1);
  }

  // Build planned message
  const planned = records.map(r => ({
    ...r,
    new_message: buildNewMessage(r),
  }));

  // Print summary
  console.log();
  console.log('Planned distribution by panel_version:');
  const byPv = {};
  for (const p of planned) byPv[p.panel_version] = (byPv[p.panel_version] || 0) + 1;
  for (const [pv, c] of Object.entries(byPv).sort()) console.log(`  panel_version=${pv}: ${c}`);

  console.log();
  console.log('Planned by tier:');
  const byTier = {};
  for (const p of planned) byTier[`${p.tier} ${p.direction}`] = (byTier[`${p.tier} ${p.direction}`] || 0) + 1;
  for (const [k, c] of Object.entries(byTier).sort()) console.log(`  ${k}: ${c}`);

  console.log();
  console.log('Sample (first record):');
  const s = planned[0];
  console.log(`  alert_id:    ${s.alert_id}`);
  console.log(`  symbol:      ${s.symbol}`);
  console.log(`  active:      ${s.active}`);
  console.log(`  Pine:        ${s.pine_label}`);
  console.log(`  tier/dir:    ${s.tier} ${s.direction}`);
  console.log(`  OLD (curr):  ${s.current_message.substring(0, 140)}...`);
  console.log(`  NEW message: ${s.new_message}`);

  if (dryRun) {
    console.log();
    console.log('=== DRY RUN — no changes applied ===');
    fs.writeFileSync(DRY_RUN_PLAN, JSON.stringify(planned, null, 2));
    console.log(`Full plan saved to: ${DRY_RUN_PLAN}`);
    console.log(`Run without --dry-run to apply.`);
    process.exit(0);
  }

  // Connect to TV via CDP
  console.log();
  console.log('Connecting to TradingView via CDP...');
  const targets = await httpGet('http://localhost:9222/json');
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.error('No CDP page target found'); process.exit(1); }
  console.log(`  Target: ${target.title}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  const cdp = new CDPClient(ws);
  console.log('  Connected.');

  // Stash globals (initial)
  let stashRes = await cdp.evalAsync(STASH_INIT);
  console.log(`  Stash: ${JSON.stringify(stashRes)}`);
  if (!stashRes || stashRes.error) {
    console.error('Stash failed. Open the TV Alerts panel and try again.');
    ws.close();
    process.exit(1);
  }

  // Defensively clear search filter (operator may have typed in the search box;
  // filters items[] and causes alert_id-not-found errors)
  const clearRes = await cdp.evalAsync(CLEAR_SEARCH);
  console.log(`  Clear-search: ${JSON.stringify(clearRes)}`);
  if (clearRes && clearRes.before_value && clearRes.before_value !== '') {
    // Filter was active — re-stash after debounce
    const restashRes = await cdp.evalAsync(RESTASH_AND_VERIFY);
    console.log(`  Re-stash:    ${JSON.stringify(restashRes)}`);
    if (!restashRes || restashRes.error) {
      console.error('Re-stash failed after filter clear.');
      ws.close();
      process.exit(1);
    }
    stashRes = restashRes;
  }

  if (stashRes.items_count < 100) {
    console.error(`  ERROR: items_count=${stashRes.items_count} is suspiciously low (expected ~120). Aborting.`);
    console.error('  Manually clear all alert filters in TV (search box, type filter, activity filter) and try again.');
    ws.close();
    process.exit(1);
  }
  if (stashRes.items_count !== 120) {
    console.warn(`  WARNING: expected 120 items, got ${stashRes.items_count}. Continuing.`);
  }

  // Open log files (append mode)
  fs.appendFileSync(ROLLBACK_LOG, JSON.stringify({
    _session_start: new Date().toISOString(),
    _planned_count: planned.length,
    _mode: 'live',
  }) + '\n');
  fs.appendFileSync(FAILURE_LOG, JSON.stringify({
    _session_start: new Date().toISOString(),
    _planned_count: planned.length,
  }) + '\n');

  // Per-alert update
  let countUpdated = 0;
  let countSkipped = 0;
  let countFailed = 0;
  const startTime = Date.now();

  console.log();
  console.log('================================================================');
  console.log('  Updating subscriptions');
  console.log('================================================================');

  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    const prefix = `[${(i+1).toString().padStart(2)}/${planned.length}] aid=${p.alert_id} ${p.symbol.padEnd(22)} ${p.tier.padEnd(16)} ${p.direction.padEnd(5)} pv=${p.panel_version}`;
    process.stdout.write(prefix + ' ... ');
    try {
      const res = await cdp.evalAsync(buildUpdateOneExpr(p.alert_id, p.new_message));
      if (res && res.updated) {
        fs.appendFileSync(ROLLBACK_LOG, JSON.stringify({
          ts: new Date().toISOString(),
          alert_id: p.alert_id,
          symbol: p.symbol,
          tier: p.tier,
          direction: p.direction,
          panel_version: p.panel_version,
          old_message: res.old_message,
          new_message: res.new_message,
        }) + '\n');
        countUpdated++;
        process.stdout.write('✓ updated\n');
      } else if (res && res.skipped) {
        countSkipped++;
        process.stdout.write(`⊝ skipped (${res.reason})\n`);
      } else {
        countFailed++;
        fs.appendFileSync(FAILURE_LOG, JSON.stringify({
          ts: new Date().toISOString(),
          record: p,
          error: res,
        }) + '\n');
        process.stdout.write('✗ failed: ' + JSON.stringify(res).substring(0, 200) + '\n');
      }
    } catch (err) {
      countFailed++;
      fs.appendFileSync(FAILURE_LOG, JSON.stringify({
        ts: new Date().toISOString(),
        record: p,
        error: String(err),
      }) + '\n');
      process.stdout.write('✗ exception: ' + String(err).substring(0, 200) + '\n');
    }
    // Brief pause between updates
    await sleep(150);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log();
  console.log('================================================================');
  console.log('  Summary');
  console.log('================================================================');
  console.log(`  Updated: ${countUpdated}`);
  console.log(`  Skipped: ${countSkipped}`);
  console.log(`  Failed:  ${countFailed}`);
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`  Rollback log: ${ROLLBACK_LOG}`);
  if (countFailed > 0) console.log(`  Failure log:  ${FAILURE_LOG}`);
  console.log();

  ws.close();
  process.exit(countFailed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
