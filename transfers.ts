import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, TOKENS } from "./config.js";
import { log } from "./store.js";
import { addWallet, storedWallets, keystoreReady, removeWallet } from "./keystore.js";
import { listWallets, treasuryKeypair, keypairFor } from "./wallets.js";
import { balancesOf } from "./market.js";
import { loadControls } from "./runtime.js";

// WALLET ADMIN: the bot creates its own wallets and moves funds between them and the treasury.
// Locked until ALLOW_WALLET_ADMIN=yes, TREASURY_SECRET_KEY and WALLET_ENCRYPTION_KEY are set.
// Funding is capped per transfer (FUND_MAX_SOL, FUND_MAX_USDC). Sweeps always go back to the treasury, never anywhere else.

export function walletAdminStatus() {
  const missing: string[] = [];
  if (process.env.ALLOW_WALLET_ADMIN !== "yes") missing.push("ALLOW_WALLET_ADMIN=yes");
  if (!process.env.TREASURY_SECRET_KEY) missing.push("TREASURY_SECRET_KEY");
  if (!keystoreReady()) missing.push("WALLET_ENCRYPTION_KEY (16+ characters)");
  return { enabled: missing.length === 0, missing, maxSol: CONFIG.walletAdmin.maxSol, maxUsdc: CONFIG.walletAdmin.maxUsdc, maxWallets: CONFIG.walletAdmin.maxWallets };
}
const assertEnabled = () => { const s = walletAdminStatus(); if (!s.enabled) throw new Error(`wallet admin is locked, missing: ${s.missing.join(", ")}`); if (CONFIG.killSwitch) throw new Error("KILL_SWITCH is on"); };

// ---------- history ----------
export type TransferRecord = { time: string; kind: "create" | "fund" | "sweep"; wallet: string; walletName: string; sol?: number; usdc?: number; signature?: string; status: "ok" | "failed"; error?: string };
const histFile = () => join(CONFIG.dataDir, "transfers.json");
export const loadTransfers = (): TransferRecord[] => (existsSync(histFile()) ? JSON.parse(readFileSync(histFile(), "utf8")) : []);
function record(r: TransferRecord) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  const all = loadTransfers(); all.push(r); writeFileSync(histFile(), JSON.stringify(all.slice(-200), null, 2));
  log(`wallet.${r.kind}.${r.status}`, { wallet: r.walletName, sol: r.sol, usdc: r.usdc, signature: r.signature, error: r.error });
}

let busy = false;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new Error("another wallet operation is running");
  busy = true;
  try { return await fn(); } finally { busy = false; }
}

// ---------- create ----------
export async function createWallet(name: string, role: "trading" | "test") {
  assertEnabled();
  if (role !== "trading" && role !== "test") throw new Error("role must be trading or test");
  if (role === "trading" && CONFIG.walletSecret) throw new Error("WALLET_SECRET_KEY is set in Railway, so that is the trading wallet. Remove it to let the bot use its own.");
  const { Keypair } = await import("@solana/web3.js");
  const kp = Keypair.generate();
  const w = addWallet(name, role, kp.publicKey.toBase58(), kp.secretKey);
  record({ time: new Date().toISOString(), kind: "create", wallet: w.id, walletName: w.name, status: "ok" });
  return w;
}

// ---------- fund: treasury -> wallet ----------
export async function fundWallet(id: string, sol: number, usdc: number) {
  assertEnabled();
  const A = CONFIG.walletAdmin;
  if (!(sol >= 0 && sol <= A.maxSol) || !(usdc >= 0 && usdc <= A.maxUsdc) || sol + usdc === 0) throw new Error(`amounts must be within 0 to ${A.maxSol} SOL and 0 to ${A.maxUsdc} USDC`);
  const target = listWallets().find((w) => w.id === id);
  if (!target) throw new Error(`unknown wallet ${id}`);
  return exclusive(async () => {
    const rec: TransferRecord = { time: new Date().toISOString(), kind: "fund", wallet: id, walletName: target.name, sol, usdc, status: "failed" };
    try {
      const from = await treasuryKeypair();
      const to = (await target.getKeypair()).publicKey;
      rec.signature = await send(from, to, sol, usdc);
      rec.status = "ok";
    } catch (e) { rec.error = (e as Error).message.slice(0, 300); }
    record(rec);
    if (rec.status !== "ok") throw new Error(rec.error);
    return rec;
  });
}

// ---------- sweep: wallet -> treasury (all USDC, SOL minus fees) ----------
export async function sweepWallet(id: string, remove = false) {
  assertEnabled();
  const w = listWallets().find((x) => x.id === id);
  if (!w) throw new Error(`unknown wallet ${id}`);
  const c = loadControls();
  if (w.role === "trading" && c.trader.enabled && c.trader.mode === "live") throw new Error("the trading agent is live: switch it off or to Paper before sweeping its wallet");
  return exclusive(async () => {
    const rec: TransferRecord = { time: new Date().toISOString(), kind: "sweep", wallet: id, walletName: w.name, status: "failed" };
    try {
      const kp = await keypairFor(id);
      const treasury = (await treasuryKeypair()).publicKey;
      const b = await balancesOf(kp.publicKey.toBase58());
      const others = Object.entries(b).filter(([s, v]) => s !== "SOL" && s !== "USDC" && v > 0).map(([s]) => s);
      if (others.length) throw new Error(`swap ${others.join(", ")} back to USDC first (test swap panel), then sweep`);
      const sol = Math.max(0, Math.floor((b.SOL - 0.003) * 1e9) / 1e9); // leave enough for this transaction's fee and the token account rent refund
      rec.usdc = b.USDC; rec.sol = sol;
      if (b.USDC <= 0 && sol <= 0) throw new Error("nothing to sweep");
      rec.signature = await send(kp, treasury, sol, b.USDC);
      rec.status = "ok";
      if (remove && w.source === "bot") removeWallet(id);
    } catch (e) { rec.error = (e as Error).message.slice(0, 300); }
    record(rec);
    if (rec.status !== "ok") throw new Error(rec.error);
    return rec;
  });
}

// One transaction: optional SOL transfer + optional USDC transfer (creates the recipient's USDC account if needed)
async function send(from: import("@solana/web3.js").Keypair, to: import("@solana/web3.js").PublicKey, sol: number, usdc: number): Promise<string> {
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const conn = new web3.Connection(CONFIG.solanaRpc, "confirmed");
  const tx = new web3.Transaction();
  if (usdc > 0) {
    const mint = new web3.PublicKey(TOKENS.USDC.mint);
    const srcAta = spl.getAssociatedTokenAddressSync(mint, from.publicKey);
    const dstAta = spl.getAssociatedTokenAddressSync(mint, to);
    tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dstAta, to, mint));
    tx.add(spl.createTransferCheckedInstruction(srcAta, mint, dstAta, from.publicKey, BigInt(Math.floor(usdc * 1e6)), 6));
  }
  if (sol > 0) tx.add(web3.SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.floor(sol * 1e9) }));
  return web3.sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
}

// ---------- overview for the dashboard (public info only, cached) ----------
let cache: { at: number; data: any } | null = null;
export async function walletOverview() {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  const status = walletAdminStatus();
  let treasury: any = null;
  if (process.env.TREASURY_SECRET_KEY) {
    try { const a = (await treasuryKeypair()).publicKey.toBase58(); treasury = { address: a, ...(await balancesOf(a).catch(() => ({}))) }; }
    catch (e) { treasury = { address: "invalid key", error: (e as Error).message }; }
  }
  const wallets = [];
  for (const w of listWallets()) {
    try { const a = (await w.getKeypair()).publicKey.toBase58(); wallets.push({ id: w.id, name: w.name, role: w.role, source: w.source, address: a, balances: await balancesOf(a).catch(() => null) }); }
    catch { wallets.push({ id: w.id, name: w.name, role: w.role, source: w.source, address: "invalid key", balances: null }); }
  }
  const data = { ...status, treasury, wallets, history: loadTransfers().slice(-15).reverse(), botWallets: keystoreReady() ? storedWallets().length : 0 };
  cache = { at: Date.now(), data };
  return data;
}
export const clearWalletCache = () => { cache = null; };
