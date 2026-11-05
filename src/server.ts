import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { CONFIG } from "./config.js";
import { loadControls, setControls, prerequisites, type Mode } from "./runtime.js";
import { loadState, stateExists, loadOutbox, tailLog, log } from "./store.js";
import { publicWallets } from "./wallets.js";
import { storageProblem, backupInfo, exportBundle, restoreBundle } from "./persist.js";
import { runTestSwap, loadTestSwaps, testSwapStatus } from "./testswap.js";
import { walletOverview, createWallet, fundWallet, sweepWallet, clearWalletCache } from "./transfers.js";

// DASHBOARD
// GET  /             the page
// GET  /api/status   everything the page shows (no secrets)
// POST /api/controls turn agents on/off and switch paper/live, drafts/live (password required)
const page = () => readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

function authed(req: IncomingMessage) {
  if (!CONFIG.dashboardPassword) return false;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(CONFIG.dashboardPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ledger(mode: Mode) {
  if (!stateExists(mode)) return null;
  const s = loadState(mode);
  return { mode, startedAt: s.startedAt, snapshot: s.lastSnapshot, signals: s.signals, trades: s.trades.slice(-60).reverse(), equity: s.equity, lastAnalysis: s.lastAnalysis, lastProcessedDay: s.lastProcessedDay };
}

async function status() {
  const posts = loadOutbox().slice(-40).reverse().map(({ facts, ...e }) => ({ ...e, mode: facts?.mode }));
  return {
    agentName: CONFIG.agentName,
    strategy: CONFIG.strategy,
    sleeves: CONFIG.sleeves.map((s) => ({ id: s.id, label: s.label, asset: s.asset, weight: s.weight })),
    limits: CONFIG.limits,
    lending: { mode: CONFIG.lending.mode, paperApy: CONFIG.lending.paperApy, cashBufferUsd: CONFIG.lending.cashBufferUsd },
    killSwitch: CONFIG.killSwitch,
    storage: { problem: storageProblem(), dataDir: CONFIG.dataDir, volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || null, backups: backupInfo() },
    controls: loadControls(),
    prerequisites: prerequisites(),
    canControl: Boolean(CONFIG.dashboardPassword),
    ledgers: { paper: ledger("paper"), live: ledger("live") },
    posts,
    log: tailLog(40),
    testSwap: { ...testSwapStatus(), wallets: await publicWallets(), history: loadTestSwaps().slice(-20).reverse() },
    walletAdmin: await walletOverview().catch((e) => ({ enabled: false, missing: [(e as Error).message], wallets: [], history: [] })),
    serverTime: new Date().toISOString(),
  };
}

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

export function startServer() {
  createServer(async (req, res) => {
    try {
      // Everything is behind the password when one is set
      if (CONFIG.dashboardPassword && !authed(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="agent dashboard"' });
        return res.end("password required");
      }
      const url = new URL(req.url || "/", "http://x");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
        return res.end(page());
      }
      if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, await status());
      if (req.method === "GET" && url.pathname === "/api/backup") {
        if (!CONFIG.dashboardPassword) return json(res, 403, { error: "backups need DASHBOARD_PASSWORD" });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="agent-backup-${new Date().toISOString().slice(0, 10)}.json"` });
        log("backup.downloaded");
        return res.end(JSON.stringify(exportBundle()));
      }
      if (req.method === "POST" && url.pathname === "/api/backup/restore") {
        if (!CONFIG.dashboardPassword) return json(res, 403, { error: "restore needs DASHBOARD_PASSWORD" });
        if (!authed(req) || req.headers["x-dashboard"] !== "1") return json(res, 403, { error: "forbidden" });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 20_000_000) return json(res, 413, { error: "too large" }); }
        const p = JSON.parse(body || "{}");
        if (p.confirm !== "RESTORE") return json(res, 400, { error: "type RESTORE to confirm" });
        const out = restoreBundle(p.bundle);
        log("backup.restored", out);
        return json(res, 200, out);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/wallets/")) {
        if (!CONFIG.dashboardPassword) return json(res, 403, { error: "wallet admin needs DASHBOARD_PASSWORD" });
        if (!authed(req) || req.headers["x-dashboard"] !== "1") return json(res, 403, { error: "forbidden" });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 2000) return json(res, 413, { error: "too large" }); }
        const p = JSON.parse(body || "{}");
        const action = url.pathname.split("/")[3];
        let out: unknown;
        if (action === "create") out = await createWallet(String(p.name || ""), p.role === "trading" ? "trading" : "test");
        else if (action === "fund") out = await fundWallet(String(p.id), Number(p.sol || 0), Number(p.usdc || 0));
        else if (action === "sweep") out = await sweepWallet(String(p.id), Boolean(p.remove));
        else return json(res, 404, { error: "unknown action" });
        clearWalletCache();
        return json(res, 200, out);
      }
      if (req.method === "POST" && url.pathname === "/api/test-swap") {
        if (!CONFIG.dashboardPassword) return json(res, 403, { error: "test swaps need DASHBOARD_PASSWORD" });
        if (!authed(req) || req.headers["x-dashboard"] !== "1") return json(res, 403, { error: "forbidden" });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 2000) return json(res, 413, { error: "too large" }); }
        const p = JSON.parse(body || "{}");
        const rec = await runTestSwap({ walletId: String(p.walletId), from: String(p.from), to: String(p.to), amountUsd: Number(p.amountUsd) });
        return json(res, rec.status === "ok" ? 200 : 502, rec);
      }
      if (req.method === "POST" && url.pathname === "/api/controls") {
        // Custom header + JSON body: blocks cross-site form posts
        if (!CONFIG.dashboardPassword) return json(res, 403, { error: "controls need DASHBOARD_PASSWORD" });
        if (!authed(req) || req.headers["x-dashboard"] !== "1") return json(res, 403, { error: "forbidden" });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 2000) return json(res, 413, { error: "too large" }); }
        const patch = JSON.parse(body || "{}");
        const next = setControls(patch);
        log("controls.changed", next);
        return json(res, 200, next);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  }).listen(CONFIG.port, () => log("dashboard.listening", { port: CONFIG.port, password: Boolean(CONFIG.dashboardPassword) }));
}
