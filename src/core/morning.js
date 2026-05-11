/**
 * Morning brief core logic.
 * Reads rules.json, scans watchlist symbols, returns structured data
 * for Claude to apply bias criteria and generate a session brief.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");

function loadRules(rulesPath) {
  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, "rules.json"),
    join(homedir(), ".tradingview-mcp", "rules.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { rules: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch (e) {
        throw new Error(`Failed to parse rules.json at ${p}: ${e.message}`);
      }
    }
  }

  throw new Error(
    "No rules.json found. Copy rules.example.json to rules.json and fill in your trading rules.\n" +
      "Looked in:\n" +
      candidates
        .filter(Boolean)
        .map((p) => `  - ${p}`)
        .join("\n"),
  );
}

export async function runBrief({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const { watchlist = [], default_timeframe = "240" } = rules;

  if (!watchlist.length) {
    throw new Error(
      "rules.json watchlist is empty. Add at least one symbol to your watchlist array.",
    );
  }

  // Save current chart state so we can restore after scanning
  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  const results = [];

  for (const symbol of watchlist) {
    try {
      await chart.setSymbol({ symbol });
      await chart.setTimeframe({ timeframe: default_timeframe });

      // Wait for chart to reflect the correct symbol before reading data
      let ready = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        const state = await chart.getState();
        const loadedSymbol = (state.symbol || "").toUpperCase();
        const expectedSymbol = symbol.includes(":")
          ? symbol.split(":")[1].toUpperCase()
          : symbol.toUpperCase();
        if (loadedSymbol.includes(expectedSymbol) || expectedSymbol.includes(loadedSymbol)) {
          ready = true;
          break;
        }
      }

      if (!ready) {
        results.push({ symbol, error: `Chart did not switch to ${symbol} after retries` });
        continue;
      }

      await new Promise((r) => setTimeout(r, 1000));

      // Switch to 1-min for Context Panel (indicator is loaded on 1-min charts)
      await chart.setTimeframe({ timeframe: "1" });
      await new Promise((r) => setTimeout(r, 1500));

      const [state, indicators, quote, contextPanel] = await Promise.all([
        chart.getState(),
        data.getStudyValues(),
        data.getQuote({}),
        data.getPineTables({ study_filter: "Context Panel" }),
      ]);

      // Parse Context Panel rows into a structured object for easier reading
      let context = null;
      try {
        const rows = contextPanel?.studies?.[0]?.tables?.[0]?.rows || [];
        if (rows.length) {
          context = {};
          for (const row of rows) {
            const [key, val] = row.split(" | ");
            if (!key) continue;
            const k = key.trim();
            const v = val ? val.trim() : "";
            if (k.includes("WATCHLIST"))       context.watchlist_scores = v;
            else if (k.includes("MNQ ") && v)  context.watchlist_detail = (context.watchlist_detail || "") + row + " | ";
            else if (k === "Dollar:")           context.dollar = v;
            else if (k.startsWith("Impact on"))context.dollar_impact = v;
            else if (k === "Market / ATR:")     context.market_mode = v;
            else if (k === "3-Day Trend:")      context.trend = v;
            else if (k === "Best Direction:")   context.best_direction = v;
            else if (k === "W.Bias / Narrative:") context.bias_narrative = v;
            else if (k === "Session Bias:")     context.session_bias = v;
            else if (k === "Current Session:")  context.current_session = v;
            else if (k === "Liquidity Swept:")  context.sweep = v;
            else if (k.includes("Pending Liq"))context.pending_liq = v;
            else if (k.includes("FPFVG SETUP")) context.fpfvg_setup = v;
            else if (k.startsWith("✓ ID") || k.startsWith("○ ID")) context.fpfvg_steps = (context.fpfvg_steps || "") + row + " ";
            else if (k === "Confluences:")      context.confluences = v;
            else if (k.includes("ENTER NOW") || k.includes("ALL STARS")) context.signal = row;
            else if (k.includes("⏳ WAIT"))     context.wait_reason = v;
            else if (k.includes("⚠  Size"))    context.size_warning = v;
          }
          // Also keep raw rows for full context
          context.raw = rows;
        }
      } catch (_) {}

      results.push({
        symbol,
        timeframe: "1",
        state,
        indicators,
        quote,
        context,
      });
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }

  // Restore original chart state
  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe)
        await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rules_loaded_from: loadedFrom,
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      notes: rules.notes || null,
    },
    symbols_scanned: results,
    instruction: [
      "Each symbol in symbols_scanned now includes a `context` field from the Context Panel indicator.",
      "Use context.trend for 3-day trend, context.best_direction for trade direction, context.bias_narrative for W.Bias/Narrative,",
      "context.sweep for liquidity sweep, context.fpfvg_setup for setup status, context.confluences for confluence count,",
      "context.signal for any ALL STARS ALIGNED alerts, context.pending_liq for blocking liquidity levels,",
      "context.current_session for session window, context.dollar for dollar filter status.",
      "For each symbol output: SYMBOL — price | Bias: [from best_direction+bias_narrative] | Key level: [pending_liq or relevant price] | Setup: [fpfvg_setup + confluences] | Session: [current_session].",
      "Flag any context.signal = ALL STARS ALIGNED immediately at the top.",
      "End with a one-line overall market read. Be direct. No preamble.",
    ].join(" "),
  };
}

export function saveSession({ brief, date } = {}) {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  // Fall back to yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
