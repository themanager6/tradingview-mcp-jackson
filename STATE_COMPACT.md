# STATE_COMPACT

Quick-read context file. Generated 2026-07-07 from repo ground truth.

## REPO PURPOSE
MCP bridge for TradingView Desktop via Chrome DevTools Protocol (port 9222). Fork of tradesdontlie/tradingview-mcp with added morning-brief workflow, rules config, session save/compare, `tv brief` CLI, and TV Desktop v2.14+ launch fix. ~78 MCP tools for reading/controlling a live chart (data, Pine dev, alerts, replay, drawing, UI).

## CURRENT VERSION
`tradingview-mcp` v1.0.0 (package.json)

## KEY PATHS / ENTRY POINTS
- `src/server.js` — MCP server entry (`npm start`)
- `src/cli/index.js` — CLI entry (`tv` bin / `npm run tv`)
- `src/core/` — core modules; `src/tools/` — MCP tool implementations
- `scripts/state_logger.js` — indicator state sampler; writes JSONL to `logs/indicator_state/` (one file per day, e.g. `2026-05-13.jsonl`)
- `scripts/` — Phase 4 bulk-alert runners, inject_pine_source.mjs, etc.
- `tests/` — e2e.test.js, pine_analyze.test.js, cli.test.js (`npm test`)
- `skills/` — chart-analysis, multi-symbol-scan, pine-develop, replay-practice, strategy-report
- `data/logs/` — session handoffs, Phase 4 run artifacts
- `docs/ict-reference/`, `agents/`, `screenshots/`

## RECENT COMMITS (last 10)
```
c965b05 state_logger: sample MYM (CBOT_MINI:MYM1!) — observe-only
3619b1f fix: fixCdpText encoding correction for sync_value garbled characters
f3ea4dc tp: add AMD manipulation phase gate (C6 precursor)
8daa89f state_logger: fix CP/TP score extraction for v23 indicators
a12ebef Add Thread_Handoff_2026-05-11.html — session handoff document
d781c43 Tracked file updates: morning.js, pine.js, launch_tv_debug.bat, README, package-lock
555e505 state_logger: add parseAnchorTf() + entry_anchor_tf field
c8ce9a9 Thread handoff v3: broker reconciliation findings + Out_of_session investigation
08896c5 Phase 4f verification complete — all 65 webhook URLs + 90/90 signal_kind confirmed
9e8828d Logger layout ngChRWJV promoted to v23 Trade Plan — 17 TP fields live
```

## KNOWN OPEN ITEMS
- MGC bar feed silent since 6/12 — needs fix, not yet diagnosed.
- TODO/FIXME sweep: only one hit — `src/core/pine.js:522` contains "TODO: add library description here", which is boilerplate inside the Pine library template string, not an actionable repo TODO. No other TODO/FIXME comments found outside node_modules.

## ENVIRONMENT NOTES
- MCP must be launched from this folder (`C:\Users\suthe\tradingview-mcp-jackson`) or MCP won't load.
- Active TradingView layout: `ngChRWJV`.

## CC SESSION RULES
- One CC session per repo at a time.
- Commit promptly.
- Verify fixes actually work — never declare success without proof.
- Scripts never silently retune their own thresholds (recommend, never rewrite).
- On any blocker or real decision, stop and ask.
