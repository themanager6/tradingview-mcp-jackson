// Edge Finder v22.3 indicator state logger.
// Binds to a dedicated TradingView CDP target by layout ID and samples
// Context Panel + Trade Plan tables across 8 instruments every 5 minutes.
// JSONL output, one file per UTC day, schema documented in
// logs/indicator_state/SCHEMA.md.
//
// Usage:
//   node scripts/state_logger.js          # recurring 5-min cycles
//   node scripts/state_logger.js --once   # single cycle, exit

import CDP from 'chrome-remote-interface';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOGS_DIR = join(PROJECT_ROOT, 'logs', 'indicator_state');
const PID_FILE = join(LOGS_DIR, '.logger.pid');

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const LOGGER_LAYOUT_ID = 'ngChRWJV';

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const SYMBOL_LOAD_RETRIES = 8;
const SYMBOL_LOAD_RETRY_MS = 1500;
const SETTLE_MS = 12000;

const TP_SCORE_MAX = 7;
const CP_SCORE_MAX = 10;

const SYMBOLS = [
  'COMEX_MINI:MGC1!',
  'CME_MINI:MNQ1!',
  'NYMEX:MCL1!',
  'CME_MINI:MES1!',
  'FX:EURUSD',
  'FX:EURJPY',
  'FX:USDJPY',
  'FX:GBPUSD',
];

const SCHEMA_FIELDS = [
  'timestamp_utc', 'event', 'symbol', 'symbol_short', 'chart_timeframe',
  'panel_version', 'tp_score', 'tp_score_max', 'cp_score', 'cp_score_max',
  'sync_value', 'sync_cp_component', 'sync_tp_component', 'status_text',
  'warning_text', 'direction_bias', 'market_mode', 'atr_value',
  'session_current', 'session_bias', 'liquidity_swept', 'pending_liq',
  'fpfvg_setup', 'confluences', 'wick_quad', 'range_classification',
  'auth_state', 'daily_quadrant', 'weekly_quadrant', 'monthly_quadrant',
  'twentyd_quadrant', 'wait_reason',
  // INDICATOR-10 Component 3 — v23 fields (29 total, matches SCHEMA.md v2)
  'twenty_day_position', 'equilibrium_block_active',
  'session_ce_value', 'session_ce_source', 'session_ce_swept', 'ce_bias_hint',
  'nearest_rth_gap_ce', 'nearest_rth_gap_age', 'nearest_rth_gap_distance_ticks',
  'gradient_overlap_active', 'gradient_overlap_source', 'gradient_overlap_count',
  'pda_1_active', 'pda_2_active', 'pda_3_active', 'pda_count',
  'entry_anchor_price', 'entry_anchor_type', 'pda_hierarchy_count',
  'warning_body_through_ce', 'warning_time_in_gap', 'time_in_gap_bars',
  'warning_puppy_on_porch', 'warning_barcoding', 'barcoding_overlap_pct', 'warning_count',
  'pda_time_counter', 'pda_time_exceeded', 'pda_time_status',
  'raw_cp_rows', 'raw_tp_rows', 'error',
];

// ---------- record helpers ----------

function emptyRecord() {
  const r = {};
  for (const f of SCHEMA_FIELDS) r[f] = null;
  return r;
}

function orderedRecord(partial) {
  const r = emptyRecord();
  for (const f of SCHEMA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(partial, f)) r[f] = partial[f];
  }
  return r;
}

function symbolShort(s) {
  const after = s.includes(':') ? s.split(':')[1] : s;
  return after.replace(/1!$/, '');
}

function isoUtc() {
  return new Date().toISOString();
}

function utcDateString() {
  return new Date().toISOString().slice(0, 10);
}

function todaysJsonlPath() {
  return join(LOGS_DIR, `${utcDateString()}.jsonl`);
}

function appendRecord(record) {
  const line = JSON.stringify(orderedRecord(record)) + '\n';
  appendFileSync(todaysJsonlPath(), line, 'utf8');
}

// ---------- PID lock ----------

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true;
    return false;
  }
}

function acquirePidLock() {
  if (existsSync(PID_FILE)) {
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    const otherPid = parseInt(raw, 10);
    if (Number.isFinite(otherPid) && pidIsAlive(otherPid)) {
      throw new Error(
        `PID lock held by live process ${otherPid} (${PID_FILE}). Stop the other logger before starting a new one.`
      );
    }
    log(`stale PID file (pid ${raw} not alive); reclaiming`);
    unlinkSync(PID_FILE);
  }
  writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function releasePidLock() {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch (_) {}
}

// ---------- logging ----------

function log(msg) {
  process.stdout.write(`[state_logger ${isoUtc()}] ${msg}\n`);
}

function logErr(msg) {
  process.stderr.write(`[state_logger ${isoUtc()}] ERROR ${msg}\n`);
}

// ---------- CDP target binding ----------

async function findLoggerTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const matchPattern = new RegExp(`/chart/${LOGGER_LAYOUT_ID}/`, 'i');
  return targets.filter((t) => t.type === 'page' && matchPattern.test(t.url));
}

async function tvHealthCheck() {
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch (_) {
    return false;
  }
}

// ---------- CDP session ----------

class CdpSession {
  constructor() {
    this.client = null;
    this.targetId = null;
  }
  async connect(targetId) {
    this.client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    await this.client.Runtime.enable();
    await this.client.Page.enable();
    await this.client.DOM.enable();
    this.targetId = targetId;
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'evaluation error';
      throw new Error(msg);
    }
    return result.result?.value;
  }
  async close() {
    try {
      if (this.client) await this.client.close();
    } catch (_) {}
    this.client = null;
  }
}

// ---------- chart control (scoped to logger tab) ----------

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

async function chartGetState(s) {
  return s.evaluate(`
    (function() {
      var chart = ${CHART_API};
      if (!chart) return null;
      var studies = [];
      try {
        studies = chart.getAllStudies().map(function(st){
          return { id: st.id, name: st.name || st.title || 'unknown' };
        });
      } catch(e) {}
      return { symbol: chart.symbol(), resolution: chart.resolution(), studies: studies };
    })()
  `);
}

async function chartSetSymbol(s, symbol) {
  await s.evaluate(`
    (function() {
      return new Promise(function(resolve) {
        var chart = ${CHART_API};
        chart.setSymbol(${JSON.stringify(symbol)}, {});
        setTimeout(resolve, 500);
      })
    })()
  `, true);
}

async function chartSetTimeframe(s, tf) {
  await s.evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${JSON.stringify(tf)}, {});
    })()
  `);
}

async function waitForSymbolMatch(s, expected) {
  const expUpper = expected.includes(':') ? expected.split(':')[1].toUpperCase() : expected.toUpperCase();
  for (let i = 0; i < SYMBOL_LOAD_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, SYMBOL_LOAD_RETRY_MS));
    try {
      const state = await chartGetState(s);
      const cur = (state?.symbol || '').toUpperCase();
      if (cur && (cur.includes(expUpper) || expUpper.includes(cur))) return true;
    } catch (_) {}
  }
  return false;
}

async function getStudyValues(s) {
  const data = await s.evaluate(`
    (function() {
      var chart = ${CHART_API}._chartWidget;
      if (!chart) return [];
      var sources = chart.model().model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var ds = sources[si];
        if (!ds.metaInfo) continue;
        try {
          var meta = ds.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = ds.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var it = items[i];
                  if (it._value && it._value !== '∅' && it._title) values[it._title] = it._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return data || [];
}

async function getPineTables(s, studyFilter) {
  const filter = (studyFilter || '').replace(/'/g, "\\'");
  const raw = await s.evaluate(`
    (function() {
      var chart = ${CHART_API}._chartWidget;
      if (!chart) return [];
      var sources = chart.model().model().dataSources();
      var results = [];
      var filter = '${filter}';
      for (var si = 0; si < sources.length; si++) {
        var ds = sources[si];
        if (!ds.metaInfo) continue;
        try {
          var meta = ds.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = ds._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.dwgtablecells;
            if (outer) {
              var inner = outer.get('tableCells');
              if (inner) {
                try {
                  var coll = inner.get(false);
                  if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                    coll._primitivesDataById.forEach(function(v, id) { items.push({ id: id, raw: v }); });
                  }
                } catch(e2) {}
              }
            }
          } catch(e) {}
          // Fallback: some layouts expose table cells one level shallower
          // (inner.get(false) is not a function). Read inner._primitivesDataById directly.
          if (items.length === 0) {
            try {
              var outer2 = pc.dwgtablecells;
              if (outer2) {
                var inner2 = outer2.get('tableCells');
                if (inner2 && inner2._primitivesDataById && inner2._primitivesDataById.size > 0) {
                  inner2._primitivesDataById.forEach(function(v, id) { items.push({ id: id, raw: v }); });
                }
              }
            } catch(e3) {}
          }
          if (items.length > 0) results.push({ name: name, items: items });
        } catch(e) {}
      }
      return results;
    })()
  `);
  if (!raw || raw.length === 0) return [];
  return raw.map((sObj) => {
    const tables = {};
    for (const item of sObj.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map((rn) => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map((cn) => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: sObj.name, tables: tableList };
  });
}

// ---------- panel parsers ----------

function flattenTableStudies(tableStudies) {
  // Returns flat array of all row strings across all tables across all matched studies.
  const rows = [];
  for (const st of tableStudies || []) {
    for (const tbl of st.tables || []) {
      for (const row of tbl.rows || []) rows.push(row);
    }
  }
  return rows;
}

function parseAnchorTf(rawCpRows, fpfvgSetup) {
  if (!rawCpRows || !fpfvgSetup) return null;
  const setup = fpfvgSetup.toUpperCase();
  const dir = setup.includes('BULLISH') ? 'BULLISH' : setup.includes('BEARISH') ? 'BEARISH' : null;
  if (!dir) return null;
  const htfRow = rawCpRows.find((r) => /^HTF FVG:/.test(r));
  if (!htfRow) return null;
  const cells = htfRow.split(' | ');
  if (cells.length < 2) return null;
  // Match e.g. "4H BULLISH", "1H BEARISH", "Daily BULLISH"
  const re = /(\d+H|Daily|1D|W)\s+(BULLISH|BEARISH)/gi;
  let m;
  while ((m = re.exec(cells[1])) !== null) {
    if (m[2].toUpperCase() === dir) return m[1];
  }
  return null;
}

function findRow(rows, predicate) {
  if (!rows) return null;
  for (const r of rows) {
    if (predicate(r)) return r;
  }
  return null;
}

function rowAfterLabel(row, labelRegex) {
  if (!row) return null;
  const cells = row.split(' | ');
  if (cells.length >= 2 && labelRegex.test(cells[0])) {
    return cells.slice(1).join(' | ').trim();
  }
  return row.replace(labelRegex, '').trim();
}

function rowCells(row) {
  if (!row) return [];
  return row.split(' | ').map((c) => c.trim());
}

function parseCpFields(rawCpRows) {
  const out = {
    panel_version_cp: null,
    warning_text: null,
    direction_bias: null,
    market_mode: null,
    atr_value: null,
    session_current: null,
    session_bias: null,
    liquidity_swept: null,
    pending_liq: null,
    fpfvg_setup: null,
    confluences: null,
    wick_quad: null,
    range_classification: null,
    auth_state: null,
    daily_quadrant: null,
    weekly_quadrant: null,
    monthly_quadrant: null,
    twentyd_quadrant: null,
    wait_reason: null,
    // INDICATOR-10 Component 3 — v23 row additions (CP-side 12 fields)
    twenty_day_position: null,
    equilibrium_block_active: null,
    session_ce_value: null,
    session_ce_source: null,
    session_ce_swept: null,
    ce_bias_hint: null,
    nearest_rth_gap_ce: null,
    nearest_rth_gap_age: null,
    nearest_rth_gap_distance_ticks: null,
    gradient_overlap_active: null,
    gradient_overlap_source: null,
    gradient_overlap_count: null,
  };
  if (!rawCpRows || rawCpRows.length === 0) return out;

  // Header row e.g. "EDGE FINDER  v22.3 | MGC"
  const header = rawCpRows[0] || '';
  const versionMatch = header.match(/v(\d+\.\d+(?:\.\d+)?)/);
  if (versionMatch) out.panel_version_cp = `CP v${versionMatch[1]}`;

  // CHART row: "── CHART ── | TRANSITIONING | PRIME (133.9/296.4)"
  const chartRow = findRow(rawCpRows, (r) => /── CHART ──/.test(r));
  if (chartRow) {
    const cells = rowCells(chartRow);
    if (cells.length >= 2) out.market_mode = cells[1] || null;
    if (cells.length >= 3) out.atr_value = cells[2] || null;
  }

  // D/W/M/20D row
  const quadRow = findRow(rawCpRows, (r) => /D \/ W\s*\/\s*M \/ 20D:/.test(r));
  if (quadRow) {
    const merged = quadRow.replace(/^.*?:\s*\|\s*/, '');
    const dMatch = merged.match(/D:\s*(-?[\d.]+%[DP])/);
    const wMatch = merged.match(/W:\s*(-?[\d.]+%[DP])/);
    const mMatch = merged.match(/M:\s*(-?[\d.]+%[DP])/);
    const tMatch = merged.match(/20:\s*(-?[\d.]+%[DP])/);
    if (dMatch) out.daily_quadrant = dMatch[1];
    if (wMatch) out.weekly_quadrant = wMatch[1];
    if (mMatch) out.monthly_quadrant = mMatch[1];
    if (tMatch) out.twentyd_quadrant = tMatch[1];
  }

  // Direction / Bias row
  const dirRow = findRow(rawCpRows, (r) => /^Direction \/ Bias:/.test(r));
  if (dirRow) {
    const cells = rowCells(dirRow);
    if (cells.length >= 2) out.direction_bias = cells.slice(1).join(' | ');
  }

  // Warning row
  const warnRow = findRow(rawCpRows, (r) => /^Warning:/.test(r));
  if (warnRow) out.warning_text = rowAfterLabel(warnRow, /^Warning:\s*/);

  // Session Bias
  const sbRow = findRow(rawCpRows, (r) => /^Session Bias:/.test(r));
  if (sbRow) out.session_bias = rowAfterLabel(sbRow, /^Session Bias:\s*/);

  // Current Session
  const csRow = findRow(rawCpRows, (r) => /^Current Session:/.test(r));
  if (csRow) {
    const cells = rowCells(csRow);
    if (cells.length >= 2) out.session_current = cells.slice(1).join(' | ');
  }

  // Liquidity Swept
  const lsRow = findRow(rawCpRows, (r) => /^Liquidity Swept:/.test(r));
  if (lsRow) out.liquidity_swept = rowAfterLabel(lsRow, /^Liquidity Swept:\s*/);

  // Pending Liq
  const plRow = findRow(rawCpRows, (r) => /Pending Liq:/.test(r));
  if (plRow) {
    const cells = rowCells(plRow);
    if (cells.length >= 2) out.pending_liq = cells.slice(1).join(' | ');
  }

  // FPFVG SETUP — header row "── FPFVG SETUP ── | <state>"
  const fpRow = findRow(rawCpRows, (r) => /── FPFVG SETUP ──/.test(r));
  if (fpRow) {
    const cells = rowCells(fpRow);
    if (cells.length >= 2) out.fpfvg_setup = cells.slice(1).join(' | ');
  }

  // Confluences
  const confRow = findRow(rawCpRows, (r) => /^Confluences:/.test(r));
  if (confRow) {
    const cells = rowCells(confRow);
    if (cells.length >= 2) out.confluences = cells.slice(1).join(' | ');
  }

  // WICK QUAD: "── WICK QUAD ── | 25:... | Auth: LOW"
  const wqRow = findRow(rawCpRows, (r) => /── WICK QUAD ──/.test(r));
  if (wqRow) {
    const cells = rowCells(wqRow);
    if (cells.length >= 2) out.wick_quad = cells[1] || null;
    if (cells.length >= 3) {
      const authMatch = cells[2].match(/Auth:\s*(.+)/);
      if (authMatch) out.auth_state = authMatch[1].trim();
    }
  }

  // RANGE
  const rgRow = findRow(rawCpRows, (r) => /── RANGE ──/.test(r));
  if (rgRow) {
    const cells = rowCells(rgRow);
    if (cells.length >= 2) out.range_classification = cells.slice(1).join(' | ');
  }

  // WAIT
  const waitRow = findRow(rawCpRows, (r) => /WAIT:/.test(r) && /⏳|^WAIT:/.test(r));
  if (waitRow) out.wait_reason = rowAfterLabel(waitRow, /^.*?WAIT:\s*\|?\s*/);

  // INDICATOR-10 Component 3 — v23 CP-side row parsers
  Object.assign(out, parse20DayPosRow(rawCpRows));
  Object.assign(out, parseSessionCERow(rawCpRows));
  Object.assign(out, parseNearestRTHRow(rawCpRows));
  Object.assign(out, parseGradientRow(rawCpRows));

  return out;
}

function parseTpFields(rawTpRows) {
  const out = {
    panel_version_tp: null,
    sync_value: null,
    sync_cp_component: null,
    sync_tp_component: null,
    status_text: null,
    // INDICATOR-10 Component 3 — v23 row additions (TP-side 17 fields)
    pda_1_active: null,
    pda_2_active: null,
    pda_3_active: null,
    pda_count: null,
    entry_anchor_price: null,
    entry_anchor_type: null,
    pda_hierarchy_count: null,
    warning_body_through_ce: null,
    warning_time_in_gap: null,
    time_in_gap_bars: null,
    warning_puppy_on_porch: null,
    warning_barcoding: null,
    barcoding_overlap_pct: null,
    warning_count: null,
    pda_time_counter: null,
    pda_time_exceeded: null,
    pda_time_status: null,
  };
  if (!rawTpRows || rawTpRows.length === 0) return out;

  const header = rawTpRows[0] || '';
  const versionMatch = header.match(/v(\d+\.\d+(?:\.\d+)?)/);
  if (versionMatch) out.panel_version_tp = `TP v${versionMatch[1]}`;

  // SYNC row — example: "SYNC: | CP: - (5/10) · TP: 3/7 → WAIT"
  // Tolerate either single-cell or label-value layouts.
  const syncRow = findRow(rawTpRows, (r) => /\bSYNC\b/i.test(r));
  if (syncRow) {
    // Use cells[1]: drops col-2 "🚨" that v23 ENTER state appends.
    const syncCells = rowCells(syncRow);
    let body = syncCells.length >= 2 ? syncCells[1] : syncRow.replace(/^.*?SYNC:\s*\|?\s*/i, '');
    const arrowSplit = body.split(/→|->/);
    if (arrowSplit.length >= 2) {
      const left = arrowSplit[0];
      const right = arrowSplit.slice(1).join('→').trim();
      out.sync_value = right.trim() || null;
      const cpMatch = left.match(/CP:[^·|]*/);
      const tpMatch = left.match(/TP:[^·|]*/);
      if (cpMatch) out.sync_cp_component = cpMatch[0].trim();
      if (tpMatch) out.sync_tp_component = tpMatch[0].trim();
    } else {
      out.sync_value = body.trim() || null;
    }
  }

  // STATUS row
  const statusRow = findRow(rawTpRows, (r) => /\bSTATUS\b/i.test(r));
  if (statusRow) {
    // Use cells[1]: drops col-2 "✅" that v23 ENTER state appends.
    const statusCells = rowCells(statusRow);
    out.status_text = (statusCells.length >= 2 ? statusCells[1] : statusRow.replace(/^.*?STATUS:?\s*\|?\s*/i, '').trim()) || null;
  }

  // INDICATOR-10 Component 3 — v23 TP-side row parsers
  Object.assign(out, parse3PDAsRow(rawTpRows));
  Object.assign(out, parseEntryAnchorRow(rawTpRows));
  Object.assign(out, parseWarningsRow(rawTpRows));
  Object.assign(out, parsePDATimerRow(rawTpRows));

  return out;
}

function studyValueNumber(studies, indicatorNameFragment, fieldName) {
  if (!studies) return null;
  const match = studies.find((s) => (s.name || '').includes(indicatorNameFragment));
  if (!match || !match.values) return null;
  const v = match.values[fieldName];
  if (v === undefined || v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- per-symbol sample ----------

async function sampleOneSymbol(s, symbol, panelVersionFromState) {
  const ts = isoUtc();
  const base = {
    timestamp_utc: ts,
    event: 'sample',
    symbol,
    symbol_short: symbolShort(symbol),
    chart_timeframe: '1m',
    panel_version: panelVersionFromState,
    tp_score: null,
    tp_score_max: TP_SCORE_MAX,
    cp_score: null,
    cp_score_max: CP_SCORE_MAX,
    sync_value: null,
    sync_cp_component: null,
    sync_tp_component: null,
    status_text: null,
    warning_text: null,
    direction_bias: null,
    market_mode: null,
    atr_value: null,
    session_current: null,
    session_bias: null,
    liquidity_swept: null,
    pending_liq: null,
    fpfvg_setup: null,
    confluences: null,
    wick_quad: null,
    range_classification: null,
    auth_state: null,
    daily_quadrant: null,
    weekly_quadrant: null,
    monthly_quadrant: null,
    twentyd_quadrant: null,
    wait_reason: null,
    // INDICATOR-10 Component 3 — v23 fields (29 total)
    twenty_day_position: null,
    equilibrium_block_active: null,
    session_ce_value: null,
    session_ce_source: null,
    session_ce_swept: null,
    ce_bias_hint: null,
    nearest_rth_gap_ce: null,
    nearest_rth_gap_age: null,
    nearest_rth_gap_distance_ticks: null,
    gradient_overlap_active: null,
    gradient_overlap_source: null,
    gradient_overlap_count: null,
    pda_1_active: null,
    pda_2_active: null,
    pda_3_active: null,
    pda_count: null,
    entry_anchor_price: null,
    entry_anchor_type: null,
    pda_hierarchy_count: null,
    warning_body_through_ce: null,
    warning_time_in_gap: null,
    time_in_gap_bars: null,
    warning_puppy_on_porch: null,
    warning_barcoding: null,
    barcoding_overlap_pct: null,
    warning_count: null,
    pda_time_counter: null,
    pda_time_exceeded: null,
    pda_time_status: null,
    raw_cp_rows: null,
    raw_tp_rows: null,
    error: null,
  };

  try {
    await chartSetSymbol(s, symbol);
    await chartSetTimeframe(s, '1');
    const ok = await waitForSymbolMatch(s, symbol);
    if (!ok) {
      return { ...base, event: 'symbol_did_not_load', error: `chart did not switch to ${symbol} after ${SYMBOL_LOAD_RETRIES} retries` };
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const [studies, cpTables, tpTables] = await Promise.all([
      getStudyValues(s),
      getPineTables(s, 'Context Panel'),
      getPineTables(s, 'Trade Plan'),
    ]);

    const rawCp = flattenTableStudies(cpTables);
    const rawTp = flattenTableStudies(tpTables);

    const cpFields = parseCpFields(rawCp);
    const tpFields = parseTpFields(rawTp);

    const cpScore = studyValueNumber(studies, 'Context Panel', 'CP Quality Score');
    const tpScore = studyValueNumber(studies, 'Trade Plan', 'TP Quality Score');

    const versionParts = [cpFields.panel_version_cp, tpFields.panel_version_tp].filter(Boolean);
    const panel_version = versionParts.length ? versionParts.join(' / ') : panelVersionFromState;

    return {
      ...base,
      panel_version,
      tp_score: tpScore,
      cp_score: cpScore,
      sync_value: tpFields.sync_value,
      sync_cp_component: tpFields.sync_cp_component,
      sync_tp_component: tpFields.sync_tp_component,
      status_text: tpFields.status_text,
      warning_text: cpFields.warning_text,
      direction_bias: cpFields.direction_bias,
      market_mode: cpFields.market_mode,
      atr_value: cpFields.atr_value,
      session_current: cpFields.session_current,
      session_bias: cpFields.session_bias,
      liquidity_swept: cpFields.liquidity_swept,
      pending_liq: cpFields.pending_liq,
      fpfvg_setup: cpFields.fpfvg_setup,
      confluences: cpFields.confluences,
      wick_quad: cpFields.wick_quad,
      range_classification: cpFields.range_classification,
      auth_state: cpFields.auth_state,
      daily_quadrant: cpFields.daily_quadrant,
      weekly_quadrant: cpFields.weekly_quadrant,
      monthly_quadrant: cpFields.monthly_quadrant,
      twentyd_quadrant: cpFields.twentyd_quadrant,
      wait_reason: cpFields.wait_reason,
      // Layer 2 (2026-05-09): v23 CP-side fields (12) — parsers populate
      // these but the return spread previously dropped them on the floor,
      // leaving JSONL with all-None v23 columns. Sub-project 2's bridge
      // (edge-finder-outcome-tracker/src/listener/state_logger_reader.py)
      // reads from JSONL, so propagating here unlocks Pre-Launch report data.
      twenty_day_position: cpFields.twenty_day_position,
      equilibrium_block_active: cpFields.equilibrium_block_active,
      session_ce_value: cpFields.session_ce_value,
      session_ce_source: cpFields.session_ce_source,
      session_ce_swept: cpFields.session_ce_swept,
      ce_bias_hint: cpFields.ce_bias_hint,
      nearest_rth_gap_ce: cpFields.nearest_rth_gap_ce,
      nearest_rth_gap_age: cpFields.nearest_rth_gap_age,
      nearest_rth_gap_distance_ticks: cpFields.nearest_rth_gap_distance_ticks,
      gradient_overlap_active: cpFields.gradient_overlap_active,
      gradient_overlap_source: cpFields.gradient_overlap_source,
      gradient_overlap_count: cpFields.gradient_overlap_count,
      // Layer 2 — v23 TP-side fields (17)
      pda_1_active: tpFields.pda_1_active,
      pda_2_active: tpFields.pda_2_active,
      pda_3_active: tpFields.pda_3_active,
      pda_count: tpFields.pda_count,
      entry_anchor_price: tpFields.entry_anchor_price,
      entry_anchor_type: tpFields.entry_anchor_type,
      entry_anchor_tf: parseAnchorTf(rawCp, cpFields.fpfvg_setup),
      pda_hierarchy_count: tpFields.pda_hierarchy_count,
      warning_body_through_ce: tpFields.warning_body_through_ce,
      warning_time_in_gap: tpFields.warning_time_in_gap,
      time_in_gap_bars: tpFields.time_in_gap_bars,
      warning_puppy_on_porch: tpFields.warning_puppy_on_porch,
      warning_barcoding: tpFields.warning_barcoding,
      barcoding_overlap_pct: tpFields.barcoding_overlap_pct,
      warning_count: tpFields.warning_count,
      pda_time_counter: tpFields.pda_time_counter,
      pda_time_exceeded: tpFields.pda_time_exceeded,
      pda_time_status: tpFields.pda_time_status,
      raw_cp_rows: rawCp,
      raw_tp_rows: rawTp,
    };
  } catch (e) {
    return { ...base, event: 'sample', error: String(e?.message || e) };
  }
}

// ---------- cycle ----------

let stopRequested = false;

function detectPanelVersionFromStudies(studies) {
  const cp = studies?.find((st) => /Context Panel/i.test(st.name || ''));
  const tp = studies?.find((st) => /Trade Plan/i.test(st.name || ''));
  const cpV = cp ? (cp.name.match(/v(\d+\.\d+(?:\.\d+)?)/) || [])[1] : null;
  const tpV = tp ? (tp.name.match(/v(\d+\.\d+(?:\.\d+)?)/) || [])[1] : null;
  if (!cpV && !tpV) return null;
  return [cpV ? `CP v${cpV}` : null, tpV ? `TP v${tpV}` : null].filter(Boolean).join(' / ');
}

async function runCycle() {
  const cycleStart = Date.now();
  log('cycle starting');

  // Step 1: TV alive?
  const alive = await tvHealthCheck();
  if (!alive) {
    appendRecord({
      timestamp_utc: isoUtc(),
      event: 'tv_unreachable',
      error: `CDP port ${CDP_PORT} not responding`,
    });
    log('tv_unreachable — skipping cycle');
    return;
  }

  // Step 2: find logger tab
  const tabs = await findLoggerTargets();
  if (tabs.length === 0) {
    appendRecord({
      timestamp_utc: isoUtc(),
      event: 'logger_tab_missing',
      error: `no tab with layout ${LOGGER_LAYOUT_ID}`,
    });
    log(`logger tab missing (layout ${LOGGER_LAYOUT_ID}) — skipping cycle`);
    return;
  }
  if (tabs.length > 1) {
    // Refuse to run on a duplicated logger tab — can't disambiguate safely.
    appendRecord({
      timestamp_utc: isoUtc(),
      event: 'logger_tab_missing',
      error: `multiple tabs match layout ${LOGGER_LAYOUT_ID}; close duplicates and retry`,
    });
    logErr(`multiple tabs match layout ${LOGGER_LAYOUT_ID}; close duplicates and retry`);
    return;
  }
  const tab = tabs[0];

  // Step 3: bind CDP
  const session = new CdpSession();
  let originalSymbol = null;
  let originalResolution = null;
  try {
    await session.connect(tab.id);
    log(`bound to CDP target ${tab.id.slice(0, 8)} (layout ${LOGGER_LAYOUT_ID})`);

    const initialState = await chartGetState(session);
    originalSymbol = initialState?.symbol || null;
    originalResolution = initialState?.resolution || null;
    const panelVersionDetected = detectPanelVersionFromStudies(initialState?.studies);

    let written = 0;
    for (const sym of SYMBOLS) {
      if (stopRequested) {
        log('stop requested mid-cycle; halting symbol loop');
        break;
      }
      try {
        const rec = await sampleOneSymbol(session, sym, panelVersionDetected);
        appendRecord(rec);
        written++;
        log(`  ${rec.symbol_short.padEnd(7)} event=${rec.event} cp=${rec.cp_score ?? 'null'} tp=${rec.tp_score ?? 'null'} sync=${rec.sync_value ?? 'null'}`);
      } catch (e) {
        appendRecord({
          timestamp_utc: isoUtc(),
          event: 'sample',
          symbol: sym,
          symbol_short: symbolShort(sym),
          chart_timeframe: '1m',
          panel_version: panelVersionDetected,
          tp_score_max: TP_SCORE_MAX,
          cp_score_max: CP_SCORE_MAX,
          error: String(e?.message || e),
        });
        logErr(`${sym}: ${e?.message || e}`);
      }
    }

    // Step 4: restore
    if (originalSymbol) {
      try {
        await chartSetSymbol(session, originalSymbol);
        if (originalResolution) await chartSetTimeframe(session, originalResolution);
        log(`restored chart to ${originalSymbol} @ ${originalResolution || '?'}`);
      } catch (e) {
        logErr(`failed to restore chart: ${e?.message || e}`);
      }
    }

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    log(`cycle complete — wrote ${written} records in ${elapsed}s`);
  } catch (e) {
    logErr(`cycle failed: ${e?.message || e}`);
  } finally {
    await session.close();
  }
}

// ---------- main ----------

async function main() {
  const onceMode = process.argv.includes('--once');

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  acquirePidLock();
  log(`pid ${process.pid} acquired lock at ${PID_FILE}`);
  log(`mode: ${onceMode ? 'single cycle (--once)' : 'recurring 5-min'}`);
  log(`layout id: ${LOGGER_LAYOUT_ID}`);
  log(`logging to: ${todaysJsonlPath()}`);

  const handleSigint = async () => {
    if (stopRequested) return;
    stopRequested = true;
    log('SIGINT received — stopping');
    releasePidLock();
    log('PID lock released; exiting');
    process.exit(0);
  };
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigint);

  if (onceMode) {
    try {
      await runCycle();
    } finally {
      releasePidLock();
      log('--once finished; exiting');
    }
    process.exit(0);
  }

  // Recurring mode
  while (!stopRequested) {
    const cycleStart = Date.now();
    await runCycle();
    if (stopRequested) break;
    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(SAMPLE_INTERVAL_MS - elapsed, 1000);
    log(`next cycle in ${(wait / 1000).toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR-10 Component 3 — v23 row parsers (P1a centralized helpers)
// One helper per new dashboard row. Each takes rows array, returns object with
// the 2-7 fields it owns. P5 null safety: null = unknown (row absent or "—" cell),
// false = known-not-active, true = known-active.
// ═══════════════════════════════════════════════════════════════════════════════

function parse20DayPosRow(rows) {
  const out = { twenty_day_position: null, equilibrium_block_active: null };
  const row = findRow(rows, (r) => /^20-DAY POS:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  if (cells.length >= 2) {
    const m = cells[1].match(/(-?\d+(?:\.\d+)?)%/);
    if (m) out.twenty_day_position = parseFloat(m[1]);
  }
  if (cells.length >= 3) {
    out.equilibrium_block_active = /EQUILIBRIUM BLOCK/.test(cells[2]);
  }
  return out;
}

function parseSessionCERow(rows) {
  const out = { session_ce_value: null, session_ce_source: null, session_ce_swept: null, ce_bias_hint: null };
  const row = findRow(rows, (r) => /^SESSION CE:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  if (cells.length >= 2) {
    if (cells[1] === '—') {
      out.session_ce_source = '—';
    } else {
      const sourceMatch = cells[1].match(/^(NDOG|RTH)/);
      if (sourceMatch) out.session_ce_source = sourceMatch[1];
      const priceMatch = cells[1].match(/@\s+(-?[\d.]+)/);
      if (priceMatch) out.session_ce_value = parseFloat(priceMatch[1]);
      if (/\(swept\)/.test(cells[1])) out.session_ce_swept = true;
      else if (/\(unswept\)/.test(cells[1])) out.session_ce_swept = false;
    }
  }
  if (cells.length >= 3) {
    out.ce_bias_hint = cells[2];
  }
  return out;
}

function parseNearestRTHRow(rows) {
  const out = { nearest_rth_gap_ce: null, nearest_rth_gap_age: null, nearest_rth_gap_distance_ticks: null };
  const row = findRow(rows, (r) => /^NEAREST RTH:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  if (cells.length >= 2 && cells[1] !== '—') {
    const ageToInt = { 'today': 0, 'yesterday': 1, '2 days ago': 2 };
    const ageMatch = cells[1].match(/^(today|yesterday|2 days ago)/);
    if (ageMatch) out.nearest_rth_gap_age = ageToInt[ageMatch[1]] ?? null;
    const priceMatch = cells[1].match(/@\s+(-?[\d.]+)/);
    if (priceMatch) out.nearest_rth_gap_ce = parseFloat(priceMatch[1]);
  }
  if (cells.length >= 3 && cells[2] !== '—') {
    const distMatch = cells[2].match(/(\d+)\s+ticks/);
    if (distMatch) out.nearest_rth_gap_distance_ticks = parseInt(distMatch[1], 10);
  }
  return out;
}

function parseGradientRow(rows) {
  const out = { gradient_overlap_active: null, gradient_overlap_source: null, gradient_overlap_count: null };
  const row = findRow(rows, (r) => /^GRADIENT:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  const cellSource = cells[1] || '';
  const cellMarker = cells[2] || '';
  if (cellMarker === '—' || !cellMarker) return out;
  if (/✗/.test(cellMarker)) {
    out.gradient_overlap_active = false;
    out.gradient_overlap_source = cellSource;
    out.gradient_overlap_count = 0;
    return out;
  }
  if (/✓/.test(cellMarker)) {
    out.gradient_overlap_active = true;
    out.gradient_overlap_source = cellSource;
    if (/NESTED/.test(cellMarker)) {
      const plusCount = (cellSource.match(/\s\+\s/g) || []).length;
      out.gradient_overlap_count = plusCount + 1;
    } else {
      out.gradient_overlap_count = 1;
    }
  }
  return out;
}

function parse3PDAsRow(rows) {
  const out = { pda_1_active: null, pda_2_active: null, pda_3_active: null, pda_count: null };
  const row = findRow(rows, (r) => /^3 PDAs:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  const cellMarkers = cells[1] || '';
  const cellCount = cells[2] || '';
  if (cellMarkers === '— — —' || !cellMarkers) {
    out.pda_count = 0;
    return out;
  }
  if (/✓\s+Sweep/.test(cellMarkers)) out.pda_1_active = true;
  else if (/✗\s+Sweep/.test(cellMarkers)) out.pda_1_active = false;
  if (/✓\s+FPFVG/.test(cellMarkers)) out.pda_2_active = true;
  else if (/✗\s+FPFVG/.test(cellMarkers)) out.pda_2_active = false;
  if (/✓\s+Time\+Grad/.test(cellMarkers)) out.pda_3_active = true;
  else if (/✗\s+Time\+Grad/.test(cellMarkers)) out.pda_3_active = false;
  const countMatch = cellCount.match(/(\d+)\/3/);
  if (countMatch) out.pda_count = parseInt(countMatch[1], 10);
  return out;
}

function parseEntryAnchorRow(rows) {
  const out = { entry_anchor_price: null, entry_anchor_type: null, pda_hierarchy_count: null };
  const row = findRow(rows, (r) => /^ENTRY ANCHOR:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  if (cells.length >= 2 && cells[1] !== '— @ —') {
    const typeMatch = cells[1].match(/^(Wick CE|FVG midpoint|Bullish VI|Bearish VI)/);
    if (typeMatch) out.entry_anchor_type = typeMatch[1];
    const priceMatch = cells[1].match(/@\s+(-?[\d.]+)/);
    if (priceMatch) out.entry_anchor_price = parseFloat(priceMatch[1]);
  }
  if (cells.length >= 3) {
    if (/single/.test(cells[2])) out.pda_hierarchy_count = 1;
    else {
      const m = cells[2].match(/(\d+)\s+overlap/);
      if (m) out.pda_hierarchy_count = parseInt(m[1], 10);
    }
  }
  return out;
}

function parseWarningsRow(rows) {
  const out = {
    warning_body_through_ce: null,
    warning_time_in_gap: null,
    time_in_gap_bars: null,
    warning_puppy_on_porch: null,
    warning_barcoding: null,
    barcoding_overlap_pct: null,
    warning_count: null,
  };
  const row = findRow(rows, (r) => /^WARNINGS:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  const cellList = cells[1] || '';
  const cellCount = cells[2] || '';
  // P5 null safety: row PRESENT → set booleans to true/false (not null)
  out.warning_body_through_ce = /BODY-THRU-CE/.test(cellList);
  out.warning_time_in_gap     = /Time-in-Gap/.test(cellList);
  out.warning_puppy_on_porch  = /Puppy-on-Porch/.test(cellList);
  out.warning_barcoding       = /Barcoding/.test(cellList);
  if (out.warning_time_in_gap) {
    const m = cellList.match(/Time-in-Gap\s+\((\d+)b\)/);
    if (m) out.time_in_gap_bars = parseInt(m[1], 10);
  }
  if (out.warning_barcoding) {
    const m = cellList.match(/Barcoding\s+\((\d+(?:\.\d+)?)%\)/);
    if (m) out.barcoding_overlap_pct = parseFloat(m[1]);
  }
  const countMatch = cellCount.match(/(\d+)\/4/);
  if (countMatch) out.warning_count = parseInt(countMatch[1], 10);
  return out;
}

function parsePDATimerRow(rows) {
  const out = { pda_time_counter: null, pda_time_exceeded: null, pda_time_status: null };
  const row = findRow(rows, (r) => /^PDA TIMER:/.test(r));
  if (!row) return out;
  const cells = rowCells(row);
  const cellText = cells[1] || '';
  const cellMarker = cells[2] || '';
  if (/no PDA contact/.test(cellText)) {
    out.pda_time_counter = 0;
    out.pda_time_exceeded = false;
    out.pda_time_status = 'GREEN';
    return out;
  }
  const countMatch = cellText.match(/(\d+)\/5/);
  if (countMatch) out.pda_time_counter = parseInt(countMatch[1], 10);
  const statusMatch = cellText.match(/(GREEN|YELLOW|RED)/);
  if (statusMatch) out.pda_time_status = statusMatch[1];
  out.pda_time_exceeded = /⛔/.test(cellMarker) || (out.pda_time_counter !== null && out.pda_time_counter >= 5);
  return out;
}

export {
  parse20DayPosRow,
  parseSessionCERow,
  parseNearestRTHRow,
  parseGradientRow,
  parse3PDAsRow,
  parseEntryAnchorRow,
  parseWarningsRow,
  parsePDATimerRow,
};

// Only auto-run main() when invoked directly (not when import'd for testing).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    logErr(`fatal: ${e?.message || e}`);
    releasePidLock();
    process.exit(1);
  });
}
