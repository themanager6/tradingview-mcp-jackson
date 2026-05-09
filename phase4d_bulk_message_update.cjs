#!/usr/bin/env node
// Phase 4d — Bulk update message bodies on all in-scope TV alert subscriptions.
//
// Two transformations:
//   1. 60 already-JSON alerts: insert "signal_kind":"entry" before closing }
//      via string surgery. Uses force_overwrite=true to bypass the existing
//      "skip if {" idempotency guard.
//   2. 58 SWING/Intraday legacy text alerts: classify by message prefix, build
//      JSON per Phase 4b schema (validation.py + LISTENER.md), replace via
//      force_overwrite=false (existing idempotency for non-JSON inputs is fine).
//   1 "Sell Stop" alert: OUT OF SCOPE — logged but not touched.
//
// Pre-conditions:
//   - TV Desktop running with CDP on port 9222
//   - TV Alerts panel open in widget bar
//   - DOM filter cleared so virtual list shows all 119 alerts
//
// Output (data/logs/, append-only JSONL):
//   - phase4d_pre_update_<ts>.jsonl   rollback artifact (every alert mutated)
//   - phase4d_success_<ts>.jsonl      per-alert success/skipped record
//   - phase4d_failures_<ts>.jsonl     per-alert failure record (with error)
//
// Usage:
//   node phase4d_bulk_message_update.cjs --dry-run                # plan only
//   node phase4d_bulk_message_update.cjs --alert-id 4613866901    # single
//   node phase4d_bulk_message_update.cjs --limit 5                # first N
//   node phase4d_bulk_message_update.cjs --resume-from <log>      # skip done
//   node phase4d_bulk_message_update.cjs                          # full run

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('./node_modules/ws/index.js');

// ── Paths ─────────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const PRE_UPDATE_LOG = path.join(LOG_DIR, `phase4d_pre_update_${TS}.jsonl`);
const SUCCESS_LOG    = path.join(LOG_DIR, `phase4d_success_${TS}.jsonl`);
const FAILURE_LOG    = path.join(LOG_DIR, `phase4d_failures_${TS}.jsonl`);
const DRY_RUN_PLAN   = path.join(LOG_DIR, `phase4d_dry_run_plan_${TS}.json`);

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const idIdx = args.indexOf('--alert-id');
const onlyAlertId = idIdx >= 0 ? parseInt(args[idIdx + 1], 10) : null;
const resumeIdx = args.indexOf('--resume-from');
const resumeFrom = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
// --chunk-size N: after every N actual update-attempts (skips don't count),
// idle 5 min before the next attempt. Default: no chunking. Used to stay
// under TV's per-session write quota (Phase 1F at 59 was clean; Phase 4d
// at 116 hit the quota — keeping each chunk under ~50 is the safe zone).
const chunkIdx = args.indexOf('--chunk-size');
const chunkSize = chunkIdx >= 0 ? parseInt(args[chunkIdx + 1], 10) : null;

// Resume: load success log, build skip-set of alert_ids that were updated or skipped.
// Failures are NOT in the skip-set so they get retried automatically.
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

// ── Pattern → JSON classifier (Phase 4b schema) ──────────────────────────
const base = (panel_version) => ({
  version: '1', panel_version, ticker: '{{ticker}}', price: '__PX__', timestamp: '{{time}}',
});

const PATTERNS = [
  { prefix: '🚨 SWING ENTER', build: (msg) => {
      const direction = msg.includes('BEARISH') ? 'SHORT' : msg.includes('BULLISH') ? 'LONG' : null;
      if (!direction) return null;
      return { ...base('swing'), direction, tier: 'swing', alert_type: 'swing_enter', signal_kind: 'entry' };
    } },
  { prefix: '⚡ SWING — Sweep Reversal Signal', build: () =>
      ({ ...base('swing'), alert_type: 'sweep_reversal', signal_kind: 'liquidity_event',
         observation_metadata: { event_type: 'sweep_reversal', side: 'sell_side', implies_direction: 'LONG' } }) },
  { prefix: '🔴 SWING — Price Entered Premium Zone', build: () =>
      ({ ...base('swing'), alert_type: 'premium_zone_entry', signal_kind: 'zone_event',
         observation_metadata: { zone_side: 'premium', zone_pct_threshold: 25, implies_setup: 'sweep_fvg_short' } }) },
  { prefix: '🟢 SWING — Price Entered Discount Zone', build: () =>
      ({ ...base('swing'), alert_type: 'discount_zone_entry', signal_kind: 'zone_event',
         observation_metadata: { zone_side: 'discount', zone_pct_threshold: 25, implies_setup: 'sweep_fvg_long' } }) },
  { prefix: '📈 SWING — HTF Turned Bullish', build: () =>
      ({ ...base('swing'), alert_type: 'htf_trend_change', signal_kind: 'regime_change',
         observation_metadata: { regime_after: 'bullish', timeframe_class: 'HTF', variant: 'htf_trend_change' } }) },
  { prefix: '📉 SWING — HTF Turned Bearish', build: () =>
      ({ ...base('swing'), alert_type: 'htf_trend_change', signal_kind: 'regime_change',
         observation_metadata: { regime_after: 'bearish', timeframe_class: 'HTF', variant: 'htf_trend_change' } }) },
  // Side OMITTED per Step A finding (SWING Pine alertcondition is side-agnostic)
  { prefix: '💥 SWING — Sweep Detected', build: () =>
      ({ ...base('swing'), alert_type: 'sweep_detected', signal_kind: 'liquidity_event',
         observation_metadata: { event_type: 'sweep_detected' } }) },
  // regime_after dropped per operator decision (Discovery Mode has no clean direction)
  { prefix: '🚀 SWING — Discovery Mode Started', build: () =>
      ({ ...base('swing'), alert_type: 'discovery_mode_start', signal_kind: 'regime_change',
         observation_metadata: { timeframe_class: 'HTF', variant: 'discovery_mode_start' } }) },
  // Intraday observation alerts — panel_version=v23 (CP/TP-side, not SWING)
  { prefix: '📈 Intraday Trending UP', build: () =>
      ({ ...base('v23'), alert_type: 'intraday_trend_change', signal_kind: 'regime_change',
         observation_metadata: { regime_after: 'bullish', timeframe_class: 'intraday', variant: 'intraday_trend_change' } }) },
  { prefix: '📉 Intraday Trending DOWN', build: () =>
      ({ ...base('v23'), alert_type: 'intraday_trend_change', signal_kind: 'regime_change',
         observation_metadata: { regime_after: 'bearish', timeframe_class: 'intraday', variant: 'intraday_trend_change' } }) },
  { prefix: '📉 Downtrend Detected — Avoid Longs', build: () =>
      ({ ...base('v23'), alert_type: 'avoid_longs_warning', signal_kind: 'regime_change',
         observation_metadata: { regime_after: 'bearish', timeframe_class: 'daily', variant: 'avoid_longs_warning' } }) },
];

function classify(alert) {
  const msg = alert.message || '';
  if (msg.trim() === 'Sell Stop') return { kind: 'out_of_scope', reason: 'non-SWING legacy stop alert' };
  if (msg.startsWith('{')) return { kind: 'json_existing', current: msg };
  for (const p of PATTERNS) {
    if (msg.startsWith(p.prefix)) {
      const payload = p.build(msg);
      if (!payload) return { kind: 'unmatched', reason: `matched ${p.prefix} but build returned null`, current: msg };
      return { kind: 'text_to_json', payload };
    }
  }
  return { kind: 'unmatched', reason: 'no pattern matched', current: msg };
}

function buildMessageString(payload) {
  return JSON.stringify(payload).replace('"__PX__"', '{{close}}');
}

function addSignalKindToJSON(currentMessage) {
  if (!currentMessage.endsWith('}')) throw new Error('current message does not end with }');
  if (currentMessage.includes('"signal_kind"')) return null; // already present
  return currentMessage.slice(0, -1) + ',"signal_kind":"entry"}';
}

// ── CDP plumbing (mirror update_alerts.cjs) ──────────────────────────────
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

// ── Stash + clearSearch (mirror update_alerts.cjs) ───────────────────────
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

// ── Per-alert update IIFE (mirrors src/core/alerts.js updateMessage) ─────
// force_overwrite is interpolated at build time as literal true/false.
// expectedOldMessage (from REST plan) is verified against dialog content
// before mutation per feedback_items_drift_dialog_verification.md memory.
function buildUpdateExpr(alertId, newMessage, forceOverwrite, expectedOldMessage) {
  const newMsgEsc = JSON.stringify(newMessage);
  const expectedEsc = JSON.stringify(expectedOldMessage || '');
  const fo = forceOverwrite ? 'true' : 'false';
  return `(async function () {
    const items = window.__efItems; const callbacks = window.__efCallbacks;
    if (!items || !callbacks) return { error: 'stash missing' };
    const idx = items.findIndex(it => it.id === ${alertId});
    if (idx < 0) return { error: 'alert_id not found in items', alert_id: ${alertId} };
    // Force-close any stuck dialog from a prior iteration before opening this alert.
    // Stuck dialogs corrupt later iterations: onEditButtonClick may not refresh
    // an already-open dialog cleanly, causing false-skips or save misroutes.
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
    callbacks.onEditButtonClick(idx);
    let dialog = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (dialog && dialog.offsetWidth) break;
    }
    if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alertId} };

    // Wait briefly for content to fully load — TV's create-edit-dialog may
    // template-render before alert data swaps in. Verify dialog content
    // matches expected message from REST (per feedback_items_drift_dialog_verification.md).
    await new Promise(r => setTimeout(r, 200));
    const msgBtn = dialog.querySelector('[data-qa-id="alert-message-button"]');
    if (!msgBtn) return { error: 'no alert-message-button', alert_id: ${alertId} };
    // For verification, use textContent (no HTML entities). For idempotency
    // and audit, the data-overflow-tooltip-html fallback preserves the
    // original behavior.
    const oldMessageForVerify = (msgBtn.textContent || '').trim();
    const expected = ${expectedEsc};
    if (expected) {
      const matchLen = Math.min(oldMessageForVerify.length, expected.length, 80);
      const matched = matchLen > 0 && (
        oldMessageForVerify === expected ||
        oldMessageForVerify.substring(0, matchLen) === expected.substring(0, matchLen)
      );
      if (!matched) {
        // Items[]-drift detected — bail safely without mutation
        const cancel = dialog.querySelector('[data-qa-id="cancel"]');
        if (cancel) {
          const pk = Object.keys(cancel).find(k => k.startsWith('__reactProps$'));
          if (pk && cancel[pk].onClick) cancel[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: cancel, target: cancel, nativeEvent: {} });
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
          const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
          if (!still || !still.offsetWidth) break;
        }
        return {
          error: 'dialog_content_mismatch',
          alert_id: ${alertId},
          expected_preview: expected.substring(0, 100),
          observed_preview: oldMessageForVerify.substring(0, 100),
        };
      }
    }
    const oldMessage = (msgBtn.getAttribute('data-overflow-tooltip-html') || msgBtn.textContent || '').trim();
    if (oldMessage.startsWith('{') && !${fo}) {
      const cancel = dialog.querySelector('[data-qa-id="cancel"]');
      if (cancel) {
        const pk = Object.keys(cancel).find(k => k.startsWith('__reactProps$'));
        if (pk && cancel[pk].onClick) cancel[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: cancel, target: cancel, nativeEvent: {} });
      }
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 50));
        const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (!still || !still.offsetWidth) break;
      }
      return { skipped: true, reason: 'already_json', alert_id: ${alertId}, old_message_preview: oldMessage.substring(0, 80) };
    }
    const msgPK = Object.keys(msgBtn).find(k => k.startsWith('__reactProps$'));
    if (!msgPK || !msgBtn[msgPK].onClick) return { error: 'no onClick on alert-message-button', alert_id: ${alertId} };
    msgBtn[msgPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: msgBtn, target: msgBtn, nativeEvent: {} });
    let ta = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      ta = document.querySelector('#alert-message');
      if (ta && ta.offsetWidth) break;
    }
    if (!ta || !ta.offsetWidth) return { error: 'textarea did not appear', alert_id: ${alertId} };
    const newMsg = ${newMsgEsc};
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, newMsg);
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    if (ta.value !== newMsg) return { error: 'value did not stick', alert_id: ${alertId} };
    const messageModal = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
    const editorRoot = messageModal || dialog;
    const usingModal = !!messageModal;
    const apply = editorRoot.querySelector('[data-qa-id="submit"]');
    if (!apply) return { error: 'no apply submit', alert_id: ${alertId} };
    const applyPK = Object.keys(apply).find(k => k.startsWith('__reactProps$'));
    if (!applyPK || !apply[applyPK].onClick) return { error: 'no onClick on apply', alert_id: ${alertId} };
    apply[applyPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: apply, target: apply, nativeEvent: {} });
    let editorClosed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (usingModal) {
        const m = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
        if (!m || !m.offsetWidth) { editorClosed = true; break; }
      } else {
        const t = document.querySelector('#alert-message');
        if (!t || !t.offsetWidth) { editorClosed = true; break; }
      }
    }
    if (!editorClosed) return { error: 'editor did not close after apply', alert_id: ${alertId} };
    const msgBtnAfter = dialog.querySelector('[data-qa-id="alert-message-button"]');
    const newBtnText = msgBtnAfter ? (msgBtnAfter.textContent || '').trim() : '';
    if (!newBtnText.startsWith('{')) return { error: 'message-button not JSON after apply', alert_id: ${alertId} };
    await new Promise(r => setTimeout(r, 100));
    const save = dialog.querySelector('[data-qa-id="submit"]');
    if (!save) return { error: 'no save button', alert_id: ${alertId} };
    if ((save.textContent || '').trim() !== 'Save') return { error: 'submit text not Save', alert_id: ${alertId} };
    const savePK = Object.keys(save).find(k => k.startsWith('__reactProps$'));
    if (!savePK || !save[savePK].onClick) return { error: 'no onClick on save', alert_id: ${alertId} };
    save[savePK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: save, target: save, nativeEvent: {} });
    // Save poll: 120 × 50ms = 6000ms (was 4000ms). Extended for retry under
    // rate-limit recovery — saves can be slow when TV's quota is near limit.
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 50));
      const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (!still || !still.offsetWidth) {
        return { updated: true, alert_id: ${alertId}, old_message: oldMessage.substring(0, 250), new_message: newMsg, ui_path: usingModal ? 'modal' : 'inline', forced: ${fo} };
      }
    }
    // Timeout — REST verify (per feedback_ui_vs_cloud_persistence_lag.md)
    try {
      const restCheck = await fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include', cache: 'no-store' }).then(r => r.json());
      if (restCheck && restCheck.s === 'ok' && Array.isArray(restCheck.r)) {
        const a = restCheck.r.find(x => x.alert_id === ${alertId});
        if (a && (a.message || '') === newMsg) {
          return { updated: true, alert_id: ${alertId}, old_message: oldMessage.substring(0, 250), new_message: newMsg, ui_path: usingModal ? 'modal' : 'inline', forced: ${fo}, confirmation_path: 'delayed_no_visual_confirm', note: 'dialog did not close but REST verified message updated' };
        }
      }
    } catch (e) { /* fall through */ }
    return { error: 'dialog did not close after save (REST shows message unchanged)', alert_id: ${alertId} };
  })()`;
}

async function fetchAlerts(cdp) {
  return cdp.eval(`fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
    .then(r => r.json())
    .then(d => {
      if (d.s !== 'ok' || !Array.isArray(d.r)) return { alerts: [], error: d.errmsg || 'unexpected' };
      return { alerts: d.r.map(a => {
        let sym = a.symbol;
        try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e){}
        return { alert_id: a.alert_id, symbol: sym, message: a.message, active: a.active, resolution: a.resolution };
      }) };
    })
    .catch(e => ({ alerts: [], error: e.message }))`);
}

// ── Main ─────────────────────────────────────────────────────────────────
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; console.log('\n[SIGINT received — finishing current alert and exiting]'); });

async function main() {
  console.log('================================================================');
  console.log('  Phase 4d — Bulk message body conversion');
  console.log('================================================================');
  console.log(`Mode:         ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (Number.isFinite(limit)) console.log(`Limit:        ${limit}`);
  if (onlyAlertId) console.log(`Only alert:   ${onlyAlertId}`);
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
  // Threshold lowered 100 -> 50 (2026-05-09): post-SWING-delete alive count is ~97,
  // not the pre-delete 119. Aligns with phase4e_bulk_webhook_url_update.cjs:471.
  if (itemsCount < 90) console.warn(`items_count=${itemsCount}. Expected 90+ post-SWING-delete; some alerts may be filtered.`);

  const fetchRes = await fetchAlerts(cdp);
  if (!fetchRes || fetchRes.error) { console.error('fetchAlerts failed:', fetchRes); ws.close(); process.exit(1); }
  console.log(`Fetched ${fetchRes.alerts.length} alerts via REST`);

  const plan = [];
  for (const a of fetchRes.alerts) {
    if (alreadyDone.has(a.alert_id)) continue;
    if (onlyAlertId && a.alert_id !== onlyAlertId) continue;
    const c = classify(a);
    if (c.kind === 'out_of_scope') {
      plan.push({ alert_id: a.alert_id, symbol: a.symbol, kind: 'out_of_scope', current: a.message, reason: c.reason });
    } else if (c.kind === 'unmatched') {
      plan.push({ alert_id: a.alert_id, symbol: a.symbol, kind: 'unmatched', current: a.message, reason: c.reason });
    } else if (c.kind === 'json_existing') {
      const newMsg = addSignalKindToJSON(c.current);
      if (newMsg === null) plan.push({ alert_id: a.alert_id, symbol: a.symbol, kind: 'json_already_has_signal_kind', current: c.current });
      else plan.push({ alert_id: a.alert_id, symbol: a.symbol, kind: 'json_add_signal_kind', current: c.current, new_message: newMsg, force_overwrite: true });
    } else if (c.kind === 'text_to_json') {
      plan.push({ alert_id: a.alert_id, symbol: a.symbol, kind: 'text_to_json', current: a.message, new_message: buildMessageString(c.payload), force_overwrite: false });
    }
  }

  const planLimited = plan.slice(0, limit);
  const tally = {};
  for (const p of planLimited) tally[p.kind] = (tally[p.kind] || 0) + 1;
  console.log('\nPlan tally:');
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(34)} ${v}`);
  console.log(`  ${'TOTAL'.padEnd(34)} ${planLimited.length}`);

  if (dryRun) {
    fs.writeFileSync(DRY_RUN_PLAN, JSON.stringify(planLimited, null, 2));
    console.log(`\nDRY RUN — plan written to ${DRY_RUN_PLAN}`);
    ws.close(); process.exit(0);
  }

  console.log('\n================================================================');
  console.log('  Updating alerts');
  console.log('================================================================');

  let nUpdated = 0, nSkipped = 0, nFailed = 0, nOOS = 0, nUnmatched = 0;
  let attemptedCount = 0; // counts only actual update-attempts, used for chunking
  const t0 = Date.now();

  for (let i = 0; i < planLimited.length; i++) {
    if (interrupted) break;
    const p = planLimited[i];
    const tag = `[${(i+1).toString().padStart(3)}/${planLimited.length}] aid=${p.alert_id} ${p.symbol.padEnd(22)} ${p.kind.padEnd(28)}`;

    if (p.kind === 'out_of_scope') {
      nOOS++;
      fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'skipped_oos', alert_id: p.alert_id, symbol: p.symbol, current: p.current, reason: p.reason }) + '\n');
      console.log(`${tag} ⊝ out-of-scope (${p.reason})`); continue;
    }
    if (p.kind === 'unmatched') {
      nUnmatched++;
      fs.appendFileSync(FAILURE_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'unmatched', alert_id: p.alert_id, symbol: p.symbol, current: p.current.substring(0, 200), reason: p.reason }) + '\n');
      console.log(`${tag} ✗ unmatched (${p.reason})`); continue;
    }
    if (p.kind === 'json_already_has_signal_kind') {
      nSkipped++;
      fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'skipped', alert_id: p.alert_id, symbol: p.symbol, reason: 'already_has_signal_kind' }) + '\n');
      console.log(`${tag} ⊝ already has signal_kind`); continue;
    }

    // Chunk-break: if chunkSize is set and we've completed exactly N attempts,
    // idle 5 min before starting the next chunk. Skips this for attempt #1.
    if (chunkSize && attemptedCount > 0 && attemptedCount % chunkSize === 0) {
      console.log(`\n--- chunk break: ${attemptedCount} attempts done, idling 5 min before next chunk ---`);
      await sleep(300000);
      console.log(`--- chunk break complete, resuming ---\n`);
    }
    attemptedCount++;

    fs.appendFileSync(PRE_UPDATE_LOG, JSON.stringify({ ts: new Date().toISOString(), alert_id: p.alert_id, symbol: p.symbol, kind: p.kind, old_message: p.current, new_message: p.new_message, force_overwrite: p.force_overwrite }) + '\n');

    try {
      const res = await cdp.eval(buildUpdateExpr(p.alert_id, p.new_message, p.force_overwrite, p.current));
      if (res && res.updated) {
        nUpdated++;
        fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'updated', alert_id: p.alert_id, symbol: p.symbol, kind: p.kind, force_overwrite: p.force_overwrite, ui_path: res.ui_path }) + '\n');
        console.log(`${tag} ✓ updated`);
      } else if (res && res.skipped) {
        nSkipped++;
        fs.appendFileSync(SUCCESS_LOG, JSON.stringify({ ts: new Date().toISOString(), action: 'skipped', alert_id: p.alert_id, symbol: p.symbol, reason: res.reason }) + '\n');
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
      console.log(`--- progress: ${i+1}/${planLimited.length} [${elapsed}s] updated=${nUpdated} skipped=${nSkipped} oos=${nOOS} unmatched=${nUnmatched} failed=${nFailed} ---`);
    }
    await sleep(5000);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log('\n================================================================');
  console.log('  Summary');
  console.log('================================================================');
  console.log(`  Updated:         ${nUpdated}`);
  console.log(`  Skipped:         ${nSkipped}`);
  console.log(`  Out of scope:    ${nOOS}`);
  console.log(`  Unmatched:       ${nUnmatched}`);
  console.log(`  Failed:          ${nFailed}`);
  console.log(`  Elapsed:         ${elapsed}s`);
  console.log(`  Pre-update log:  ${PRE_UPDATE_LOG}`);
  console.log(`  Success log:     ${SUCCESS_LOG}`);
  if (nFailed + nUnmatched > 0) console.log(`  Failure log:     ${FAILURE_LOG}`);
  if (interrupted) console.log('  Run interrupted by SIGINT.');

  ws.close();
  process.exit(nFailed + nUnmatched > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
