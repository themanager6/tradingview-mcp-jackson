#!/usr/bin/env node
// Phase 4f — Verification probe for Phase 4d/4e completion.
//
// Read-only. Fetches REST alert state and validates against expected end
// state per Phase 4 schema. Optionally DOM-probes N sampled alerts to
// verify webhook URL (REST does not expose webhook URL — only DOM does).
//
// Pre-conditions:
//   - TV Desktop running with CDP on port 9222
//   - TV Alerts panel open (only required for --spot-check)
//
// Output:
//   - Console summary with pass/fail per check
//   - data/logs/phase4f_report_<ts>.json with full per-alert results
//   - Exit code: 0 if all checks pass, 1 if any failure
//
// Usage:
//   node phase4f_verify.cjs --expected-url <url>
//                            [--expected-count <N>]
//                            [--swing-deleted-ids-from <file>]
//                            [--spot-check-count <N>]
//                            [--report <path>]
//
// Examples:
//   node phase4f_verify.cjs --expected-url https://efl-tunnel.example.com/alert
//   node phase4f_verify.cjs --expected-url <url> --expected-count 67 --spot-check-count 10
//   node phase4f_verify.cjs --expected-url <url> --swing-deleted-ids-from .swing_delete_ids.txt

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('./node_modules/ws/index.js');

// ── Paths ─────────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--expected-url');
const expectedUrl = urlIdx >= 0 ? args[urlIdx + 1] : null;
const countIdx = args.indexOf('--expected-count');
const expectedCount = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : null;
const deletedIdsFileIdx = args.indexOf('--swing-deleted-ids-from');
const deletedIdsFile = deletedIdsFileIdx >= 0 ? args[deletedIdsFileIdx + 1] : null;
const spotCheckIdx = args.indexOf('--spot-check-count');
const spotCheckCount = spotCheckIdx >= 0 ? parseInt(args[spotCheckIdx + 1], 10) : 5;
const reportIdx = args.indexOf('--report');
const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : path.join(LOG_DIR, `phase4f_report_${TS}.json`);

if (!expectedUrl) {
  console.error('--expected-url <webhook_url> is required.');
  console.error('Without it, we cannot verify Phase 4e webhook URL writes landed.');
  process.exit(1);
}
if (!/^https?:\/\//i.test(expectedUrl)) {
  console.error(`--expected-url must start with http:// or https:// (got: ${expectedUrl})`);
  process.exit(1);
}

// Load expected-deleted IDs if provided
let expectedDeletedIds = new Set();
if (deletedIdsFile) {
  if (!fs.existsSync(deletedIdsFile)) {
    console.error(`--swing-deleted-ids-from path not found: ${deletedIdsFile}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(deletedIdsFile, 'utf8');
  const ids = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  expectedDeletedIds = new Set(ids);
}

// ── CDP plumbing ──────────────────────────────────────────────────────────
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

// ── Legacy text patterns (any of these prefixes = NOT correct end state) ─
const LEGACY_TEXT_PREFIXES = [
  '🚨 SWING', '⚡ SWING', '🔴 SWING', '🟢 SWING',
  '📈 SWING', '📉 SWING', '💥 SWING', '🚀 SWING',
  '🔥', '🚨 All Stars', '🚨 All-Stars',
  '📈 Intraday', '📉 Intraday',
  '📉 Downtrend Detected',
  'Sell Stop',
];

function isLegacyText(msg) {
  if (!msg) return false;
  if (msg.startsWith('{')) return false;
  return LEGACY_TEXT_PREFIXES.some(p => msg.startsWith(p));
}

// ── REST validation ──────────────────────────────────────────────────────
function validateRestState(alerts) {
  const checks = {
    total_count: alerts.length,
    expected_count: expectedCount,
    count_matches: expectedCount === null || alerts.length === expectedCount,
    json_with_signal_kind: 0,
    json_without_signal_kind: [],  // alert_id list
    legacy_text: [],                // alert_id list
    other: [],                      // alert_id list (e.g. "Sell Stop" if still alive)
    deleted_check: { performed: expectedDeletedIds.size > 0, missing_count: 0, present_count: 0, present_ids: [] },
  };
  for (const a of alerts) {
    const msg = a.message || '';
    if (msg.startsWith('{')) {
      if (msg.includes('"signal_kind"')) checks.json_with_signal_kind++;
      else checks.json_without_signal_kind.push(a.alert_id);
    } else if (isLegacyText(msg)) {
      checks.legacy_text.push(a.alert_id);
    } else {
      checks.other.push({ alert_id: a.alert_id, msg_preview: msg.substring(0, 60) });
    }
  }
  // Deleted check: every id in expectedDeletedIds should be ABSENT from alerts
  if (expectedDeletedIds.size > 0) {
    const aliveIds = new Set(alerts.map(a => a.alert_id));
    for (const id of expectedDeletedIds) {
      if (aliveIds.has(id)) {
        checks.deleted_check.present_count++;
        checks.deleted_check.present_ids.push(id);
      } else {
        checks.deleted_check.missing_count++;
      }
    }
  }
  return checks;
}

// ── DOM spot-check (read webhook URL from notifications modal) ─────────
function buildSpotCheckExpr(alertId) {
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

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('================================================================');
  console.log('  Phase 4f — Verification probe');
  console.log('================================================================');
  console.log(`Expected URL:        ${expectedUrl}`);
  if (expectedCount !== null) console.log(`Expected count:      ${expectedCount}`);
  if (expectedDeletedIds.size > 0) console.log(`Expected deleted:    ${expectedDeletedIds.size} ids from ${deletedIdsFile}`);
  console.log(`Spot-check count:    ${spotCheckCount}`);
  console.log(`Report path:         ${reportPath}`);
  console.log();

  const targets = await httpGet('http://localhost:9222/json');
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.error('No CDP page target'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  const cdp = new CDPClient(ws);

  // Stage 1: REST validation
  console.log('────── Stage 1: REST validation ──────');
  const fetchRes = await cdp.eval(`fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include', cache: 'no-store' })
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
  if (!fetchRes || fetchRes.error) { console.error('REST fetch failed:', fetchRes); ws.close(); process.exit(1); }

  const restChecks = validateRestState(fetchRes.alerts);
  console.log(`  Total alerts:                  ${restChecks.total_count}` + (expectedCount !== null ? ` (expected ${expectedCount}: ${restChecks.count_matches ? '✓' : '✗ MISMATCH'})` : ''));
  console.log(`  json_with_signal_kind:         ${restChecks.json_with_signal_kind}`);
  console.log(`  json_without_signal_kind:      ${restChecks.json_without_signal_kind.length}` + (restChecks.json_without_signal_kind.length === 0 ? ' ✓' : ' ✗'));
  if (restChecks.json_without_signal_kind.length > 0) {
    console.log(`    failing ids: ${restChecks.json_without_signal_kind.slice(0, 10).join(', ')}` + (restChecks.json_without_signal_kind.length > 10 ? ` (+${restChecks.json_without_signal_kind.length - 10} more)` : ''));
  }
  console.log(`  legacy_text:                   ${restChecks.legacy_text.length}` + (restChecks.legacy_text.length === 0 ? ' ✓' : ' ✗'));
  if (restChecks.legacy_text.length > 0) {
    console.log(`    failing ids: ${restChecks.legacy_text.slice(0, 10).join(', ')}`);
  }
  console.log(`  other (uncategorized):         ${restChecks.other.length}` + (restChecks.other.length === 0 ? ' ✓' : ' ✗'));
  if (restChecks.other.length > 0) {
    for (const o of restChecks.other.slice(0, 5)) console.log(`    aid=${o.alert_id}: ${o.msg_preview}`);
  }
  if (restChecks.deleted_check.performed) {
    const d = restChecks.deleted_check;
    console.log(`  expected-deleted check:        ${d.missing_count}/${expectedDeletedIds.size} missing` + (d.present_count === 0 ? ' ✓' : ' ✗'));
    if (d.present_count > 0) {
      console.log(`    NOT-deleted ids: ${d.present_ids.slice(0, 10).join(', ')}` + (d.present_count > 10 ? ` (+${d.present_count - 10} more)` : ''));
    }
  }
  console.log();

  // Stage 2: DOM spot-check (only on alive alerts in correct end state, picking randomly)
  console.log(`────── Stage 2: DOM spot-check (${spotCheckCount} alerts) ──────`);
  const goodAlerts = fetchRes.alerts.filter(a => (a.message || '').startsWith('{') && (a.message || '').includes('"signal_kind"'));
  const sampleN = Math.min(spotCheckCount, goodAlerts.length);
  const sampled = [];
  // Stable random sample (Fisher-Yates partial)
  const pool = [...goodAlerts];
  for (let i = 0; i < sampleN; i++) {
    const r = Math.floor(Math.random() * (pool.length - i)) + i;
    [pool[i], pool[r]] = [pool[r], pool[i]];
    sampled.push(pool[i]);
  }

  // Stash + clearSearch first
  await cdp.eval(`(function () {
    const desc = document.querySelector('[data-name="alert-item-description"]');
    if (!desc) return { error: 'panel not open' };
    const fk = Object.keys(desc).find(k => k.startsWith('__reactFiber$'));
    let walker = desc[fk];
    for (let d = 0; d < 30; d++) {
      if (!walker) break;
      const mp = walker.memoizedProps;
      if (mp && mp.itemCount && mp.itemData && Array.isArray(mp.itemData.items)) {
        window.__efCallbacks = mp.itemData.callbacks; window.__efItems = mp.itemData.items;
        return { stashed: true };
      }
      walker = walker.return;
    }
    return { error: 'virtual list not found' };
  })()`);

  const spotResults = [];
  for (const alert of sampled) {
    process.stdout.write(`  aid=${alert.alert_id} ${(alert.symbol || '?').padEnd(22)} ... `);
    try {
      const res = await cdp.eval(buildSpotCheckExpr(alert.alert_id));
      if (res && res.error) {
        process.stdout.write(`✗ probe error: ${res.error}\n`);
        spotResults.push({ alert_id: alert.alert_id, ok: false, error: res.error });
      } else {
        const url_match = res.url_input_value === expectedUrl;
        const toggle_on = res.checkbox_checked === true && res.url_input_disabled === false;
        const ok = url_match && toggle_on;
        process.stdout.write(`${ok ? '✓' : '✗'} url_match=${url_match} toggle_on=${toggle_on}\n`);
        if (!ok) {
          process.stdout.write(`    observed_url: ${res.url_input_value}\n`);
          process.stdout.write(`    checkbox=${res.checkbox_checked}, disabled=${res.url_input_disabled}\n`);
        }
        spotResults.push({ alert_id: alert.alert_id, ok, ...res });
      }
    } catch (e) {
      process.stdout.write(`✗ exception: ${String(e).substring(0, 100)}\n`);
      spotResults.push({ alert_id: alert.alert_id, ok: false, error: String(e) });
    }
    await sleep(300);
  }
  console.log();

  // ── Final summary + report ─────────────────────────────────────────────
  const spotPassCount = spotResults.filter(r => r.ok).length;
  const spotFailCount = spotResults.length - spotPassCount;

  const allChecksPassed =
    (expectedCount === null || restChecks.count_matches) &&
    restChecks.json_without_signal_kind.length === 0 &&
    restChecks.legacy_text.length === 0 &&
    restChecks.other.length === 0 &&
    restChecks.deleted_check.present_count === 0 &&
    spotFailCount === 0;

  console.log('────── Summary ──────');
  console.log(`  REST checks:      ${(expectedCount === null || restChecks.count_matches) && restChecks.json_without_signal_kind.length === 0 && restChecks.legacy_text.length === 0 && restChecks.other.length === 0 ? '✓ ALL PASS' : '✗ FAILURES'}`);
  if (restChecks.deleted_check.performed) {
    console.log(`  Deleted check:    ${restChecks.deleted_check.present_count === 0 ? '✓ all expected-deleted ids absent' : '✗ ' + restChecks.deleted_check.present_count + ' still alive'}`);
  }
  console.log(`  DOM spot-check:   ${spotPassCount}/${sampled.length} pass` + (spotFailCount === 0 ? ' ✓' : ' ✗'));
  console.log();
  console.log(`  OVERALL: ${allChecksPassed ? '✓ PHASE 4 VERIFIED COMPLETE' : '✗ FAILURES DETECTED — see report file'}`);
  console.log();

  const report = {
    ts: new Date().toISOString(),
    expected_url: expectedUrl,
    expected_count: expectedCount,
    rest_checks: restChecks,
    spot_check: {
      sampled_count: sampled.length,
      passed_count: spotPassCount,
      failed_count: spotFailCount,
      results: spotResults,
    },
    overall_passed: allChecksPassed,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  Report:           ${reportPath}`);

  ws.close();
  process.exit(allChecksPassed ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
