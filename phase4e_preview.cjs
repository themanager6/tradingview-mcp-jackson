#!/usr/bin/env node
// Phase 4e — Pre-flight preview of webhook URL state for target alerts.
//
// Read-only. Surveys current webhook URL + toggle state of target alerts
// via DOM probing. Reports breakdown of:
//   - already_set: URL matches target → bulk runner will skip
//   - needs_update: URL differs (or empty toggle off) → bulk runner will write
//   - probe_error: DOM probe failed → bulk runner may also fail
//
// Use BEFORE running phase4e_bulk_webhook_url_update.cjs to preview impact.
// Helps the operator estimate throttle exposure (only "needs_update" alerts
// burn writes) and identify pre-existing UI quirks (probe_error count).
//
// Pre-conditions:
//   - TV Desktop running with CDP on port 9222
//   - TV Alerts panel open
//
// Usage:
//   node phase4e_preview.cjs --url <expected_url> --ids-from <file.txt>
//   node phase4e_preview.cjs --url <expected_url> --ids "id1,id2,id3"
//   node phase4e_preview.cjs --url <expected_url> --alert-id NNNN
//
// Output:
//   - Console summary: counts by category
//   - Per-alert detail when count is small enough to be useful
//   - data/logs/phase4e_preview_<ts>.json for full per-alert results

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('./node_modules/ws/index.js');

const LOG_DIR = path.join(__dirname, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const REPORT_PATH = path.join(LOG_DIR, `phase4e_preview_${TS}.json`);

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const expectedUrl = urlIdx >= 0 ? args[urlIdx + 1] : null;
const idIdx = args.indexOf('--alert-id');
const onlyAlertId = idIdx >= 0 ? parseInt(args[idIdx + 1], 10) : null;
const idsIdx = args.indexOf('--ids');
const idsCsv = idsIdx >= 0 ? args[idsIdx + 1] : null;
const idsFileIdx = args.indexOf('--ids-from');
const idsFile = idsFileIdx >= 0 ? args[idsFileIdx + 1] : null;
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

if (!expectedUrl) {
  console.error('--url <expected_webhook_url> is required.');
  process.exit(1);
}
if (!/^https?:\/\//i.test(expectedUrl)) {
  console.error(`--url must start with http:// or https:// (got: ${expectedUrl})`);
  process.exit(1);
}

let targetIds = [];
if (onlyAlertId) targetIds = [onlyAlertId];
else if (idsCsv) targetIds = idsCsv.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
else if (idsFile) {
  if (!fs.existsSync(idsFile)) { console.error(`--ids-from path not found: ${idsFile}`); process.exit(1); }
  targetIds = fs.readFileSync(idsFile, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(s => parseInt(s, 10)).filter(Number.isFinite);
}
if (targetIds.length === 0) {
  console.error('No targets. Use --alert-id, --ids, or --ids-from.');
  process.exit(1);
}
targetIds = targetIds.slice(0, limit);

// ── CDP plumbing (minimal — same pattern as other phase4x runners) ───────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); res.on('error', reject); }).on('error', reject);
  });
}
class CDPClient {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); } });
  }
  send(method, params) { return new Promise((resolve, reject) => { const id = this.id++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).substring(0, 300)); return r.result?.value; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Per-alert probe IIFE — open dialog → notif modal → read URL+toggle → cancel ──
function buildProbeExpr(alertId) {
  return `(async function () {
    const items = window.__efItems; const callbacks = window.__efCallbacks;
    if (!items || !callbacks) return { error: 'stash missing' };
    const idx = items.findIndex(it => it.id === ${alertId});
    if (idx < 0) return { error: 'items_drift_alert_not_in_items', alert_id: ${alertId} };

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

    callbacks.onEditButtonClick(idx);
    let dialog = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (dialog && dialog.offsetWidth) break;
    }
    if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alertId} };

    await new Promise(r => setTimeout(r, 200));
    const notifBtn = dialog.querySelector('[data-qa-id="alert-notifications-button"]');
    if (!notifBtn) { await cleanCancel(); return { error: 'no notifications button', alert_id: ${alertId} }; }
    const notifPK = Object.keys(notifBtn).find(k => k.startsWith('__reactProps$'));
    if (!notifPK || !notifBtn[notifPK].onClick) { await cleanCancel(); return { error: 'no onClick on notif btn', alert_id: ${alertId} }; }
    notifBtn[notifPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: notifBtn, target: notifBtn, nativeEvent: {} });

    let modal = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      modal = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
      if (modal && modal.offsetWidth) break;
    }
    if (!modal || !modal.offsetWidth) { await cleanCancel(); return { error: 'modal did not appear', alert_id: ${alertId} }; }

    const urlInput = modal.querySelector('[data-qa-id="ui-lib-Input-input webhook-input-input"]');
    const checkbox = modal.querySelector('label[data-qa-id="webhook"] input[data-qa-id="ui-lib-checkbox-input-input"]')
                  || modal.querySelector('[data-qa-id="webhook"] [data-qa-id="ui-lib-checkbox-input-input"]');
    const result = {
      alert_id: ${alertId},
      url_input_value: urlInput ? (urlInput.value || '') : null,
      url_input_disabled: urlInput ? !!urlInput.disabled : null,
      checkbox_checked: checkbox ? !!checkbox.checked : null,
    };
    await cleanCancel();
    return result;
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
        return { alert_id: a.alert_id, symbol: sym };
      }) };
    })
    .catch(e => ({ alerts: [], error: e.message }))`);
}

async function main() {
  console.log('================================================================');
  console.log('  Phase 4e — Webhook URL state preview (read-only)');
  console.log('================================================================');
  console.log(`Expected URL:    ${expectedUrl}`);
  console.log(`Targets:         ${targetIds.length} alert_id(s)`);
  console.log(`Report:          ${REPORT_PATH}`);
  console.log();

  const targets = await httpGet('http://localhost:9222/json');
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.error('No CDP page target'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  const cdp = new CDPClient(ws);

  // Stash items + callbacks
  const stashRes = await cdp.eval(`(function () {
    const desc = document.querySelector('[data-name="alert-item-status"]');
    if (!desc) return { error: 'panel not open' };
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
  })()`);
  if (!stashRes || stashRes.error) { console.error('Stash failed:', stashRes); ws.close(); process.exit(1); }
  console.log(`Stashed:         items_count=${stashRes.items_count}`);

  // Fetch alive alerts to enrich symbol info
  const fetchRes = await fetchAlerts(cdp);
  const symLookup = {};
  if (fetchRes && !fetchRes.error) {
    for (const a of fetchRes.alerts) symLookup[a.alert_id] = a.symbol;
  }

  // Build skip set: ids missing from REST → 'not_found' without DOM probe
  const aliveSet = new Set((fetchRes?.alerts || []).map(a => a.alert_id));
  const probeQueue = [];
  const notFound = [];
  for (const id of targetIds) {
    if (aliveSet.has(id)) probeQueue.push(id);
    else notFound.push(id);
  }
  console.log(`Alive targets:   ${probeQueue.length}`);
  console.log(`Not found:       ${notFound.length} (already deleted or never existed)`);
  console.log();

  // Probe each alive target
  console.log('Probing each alive target (this takes ~3s/alert)...');
  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < probeQueue.length; i++) {
    const id = probeQueue[i];
    const sym = symLookup[id] || '?';
    process.stdout.write(`[${(i+1).toString().padStart(3)}/${probeQueue.length}] aid=${id} ${sym.padEnd(22)} ... `);
    try {
      const res = await cdp.eval(buildProbeExpr(id));
      if (res && res.error) {
        process.stdout.write(`✗ ${res.error}\n`);
        results.push({ alert_id: id, symbol: sym, kind: 'probe_error', error: res.error });
      } else {
        const url_match = res.url_input_value === expectedUrl;
        const toggle_on = res.checkbox_checked === true && res.url_input_disabled === false;
        let kind;
        if (url_match && toggle_on) kind = 'already_set';
        else kind = 'needs_update';
        process.stdout.write(`${kind === 'already_set' ? '✓ already set' : '⚠ needs update'}` +
          ` (url='${(res.url_input_value || '').substring(0, 40)}' toggle=${res.checkbox_checked})\n`);
        results.push({ alert_id: id, symbol: sym, kind, ...res });
      }
    } catch (e) {
      process.stdout.write(`✗ exception: ${String(e).substring(0, 80)}\n`);
      results.push({ alert_id: id, symbol: sym, kind: 'probe_error', error: String(e) });
    }
    await sleep(200);
  }
  for (const id of notFound) {
    results.push({ alert_id: id, symbol: symLookup[id] || '?', kind: 'not_found' });
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);

  // Summary
  const tally = { already_set: 0, needs_update: 0, probe_error: 0, not_found: 0 };
  for (const r of results) tally[r.kind] = (tally[r.kind] || 0) + 1;

  console.log();
  console.log('────── Summary ──────');
  console.log(`  already_set:   ${tally.already_set}    (bulk runner will skip these — no write needed)`);
  console.log(`  needs_update:  ${tally.needs_update}    (bulk runner will WRITE — burns this many throttle slots)`);
  console.log(`  probe_error:   ${tally.probe_error}    (DOM probe failed — bulk may also fail)`);
  console.log(`  not_found:     ${tally.not_found}    (no longer in REST — silently skip on bulk run)`);
  console.log(`  TOTAL:         ${results.length}`);
  console.log();
  console.log(`  Elapsed:       ${elapsed}s`);
  console.log(`  Throttle plan: ${tally.needs_update} writes upcoming. With chunk-size 30 + 5min idle: ~${Math.ceil(tally.needs_update / 30)} chunks.`);
  console.log();

  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    ts: new Date().toISOString(),
    expected_url: expectedUrl,
    targets_count: targetIds.length,
    tally,
    elapsed_sec: elapsed,
    results,
  }, null, 2));
  console.log(`  Report:        ${REPORT_PATH}`);

  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
