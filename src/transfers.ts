import { writeJsonAtomic, readJson } from "./persist.js";
import { join } from "node:path";
import { CONFIG, TOKENS } from "./config.js";
import { log } from "./store.js";
import { addWallet, storedWallets, keystoreReady, removeWallet, storageProblem } from "./keystore.js";
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
  const storage = storageProblem();
  if (storage) missing.push(storage);
  return { enabled: missing.length === 0, missing, maxSol: CONFIG.walletAdmin.maxSol, maxUsdc: CONFIG.walletAdmin.maxUsdc, maxWallets: CONFIG.walletAdmin.maxWallets };
}
const assertEnabled = () => { const s = walletAdminStatus(); if (!s.enabled) throw new Error(`wallet admin is locked, missing: ${s.missing.join(", ")}`); if (CONFIG.killSwitch) throw new Error("KILL_SWITCH is on"); };

// ---------- history ----------
export type TransferRecord = { time: string; kind: "create" | "fund" | "sweep" | "delete"; wallet: string; walletName: string; sol?: number; usdc?: number; signature?: string; status: "ok" | "failed"; error?: string };
const histFile = () => join(CONFIG.dataDir, "transfers.json");
export const loadTransfers = (): TransferRecord[] => readJson<TransferRecord[]>(histFile(), []);
function record(r: TransferRecord) {
  const all = loadTransfers(); all.push(r); writeJsonAtomic(histFile(), all.slice(-200));
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
  // Shown once, so you can keep an offline backup (password manager). Never stored in plain text or logged.
  return { ...w, backupKey: base58Encode(kp.secretKey) };
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
      // Check the treasury first, so a short balance gives a clear message instead of a simulation log.
      // SOL needed: the amount sent + the fee + up to 0.00204 SOL to open the new wallet's USDC account.
      const tb = await balancesOf(from.publicKey.toBase58());
      const solNeeded = sol + (usdc > 0 ? 0.00204 : 0) + 0.00001;
      if (usdc > tb.USDC) throw new Error(`treasury has ${tb.USDC.toFixed(2)} USDC, not enough to send ${usdc}`);
      if (tb.SOL < solNeeded) throw new Error(`treasury has ${tb.SOL.toFixed(4)} SOL, needs ${solNeeded.toFixed(4)} (amount + fee${usdc > 0 ? " + 0.002 to open the wallet's USDC account" : ""}). Top up the treasury or send less SOL`);
      if (sol > 0 && sol < 0.001) throw new Error("send at least 0.001 SOL, Solana's minimum for a new wallet");
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
  if (remove && w.source !== "bot") throw new Error("this wallet was added in Railway: sweep it, then remove its TEST_WALLET variable in Railway to delete it");
  return exclusive(async () => {
    const rec: TransferRecord = { time: new Date().toISOString(), kind: remove ? "delete" : "sweep", wallet: id, walletName: w.name, status: "failed" };
    try {
      const kp = await keypairFor(id);
      const treasury = (await treasuryKeypair()).publicKey;
      const b = await balancesOf(kp.publicKey.toBase58());
      const others = Object.entries(b).filter(([s, v]) => s !== "SOL" && s !== "USDC" && v > 0).map(([s]) => s);
      if (others.length) throw new Error(`swap ${others.join(", ")} back to USDC first (test swap panel), then sweep`);
      // Always empty the wallet completely: all USDC, its token accounts closed (rent back to the treasury), all SOL minus the fee
      const r = await closeOut(kp, treasury, remove);
      rec.usdc = r.usdc; rec.sol = r.sol; rec.signature = r.signature;
      rec.status = "ok";
      if (remove) removeWallet(id);
    } catch (e) { rec.error = (e as Error).message.slice(0, 300); }
    record(rec);
    if (rec.status !== "ok") throw new Error(rec.error);
    return { ...rec, removed: remove };
  });
}

// ---------- sweep several wallets, one after another ----------
export async function sweepMany(ids: string[], remove = false) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("select at least one wallet");
  if (ids.length > 20) throw new Error("select at most 20 wallets at a time");
  const results: { id: string; name: string; status: "ok" | "failed"; signature?: string; error?: string; removed?: boolean }[] = [];
  for (const id of [...new Set(ids.map(String))]) {
    const name = listWallets().find((x) => x.id === id)?.name ?? id;
    try {
      const w = listWallets().find((x) => x.id === id);
      const del = remove && w?.source === "bot";
      const r = await sweepWallet(id, del);
      results.push({ id, name, status: "ok", signature: r.signature, removed: del, ...(remove && !del ? { error: "swept; added in Railway, so remove its variable there to delete it" } : {}) });
    } catch (e) { results.push({ id, name, status: "failed", error: (e as Error).message.slice(0, 200) }); }
  }
  return { results, ok: results.filter((r) => r.status === "ok").length, failed: results.filter((r) => r.status === "failed").length };
}

// Empty a wallet completely before deleting it: send all USDC, close every token account (their rent goes
// to the treasury too) and send all SOL minus the fee. Leaves 0 SOL, so the wallet can be forgotten safely.
async function closeOut(from: import("@solana/web3.js").Keypair, to: import("@solana/web3.js").PublicKey, deleting = false) {
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const conn = new web3.Connection(CONFIG.solanaRpc, "confirmed");
  const usdcMint = new web3.PublicKey(TOKENS.USDC.mint);
  const dstAta = spl.getAssociatedTokenAddressSync(usdcMint, to);
  const accounts = await conn.getParsedTokenAccountsByOwner(from.publicKey, { programId: spl.TOKEN_PROGRAM_ID });
  const tx = new web3.Transaction();
  let usdcAtoms = 0n, needsDstAta = false;
  for (const a of accounts.value) {
    const info: any = a.account.data.parsed.info;
    const atoms = BigInt(info.tokenAmount.amount);
    if (atoms > 0n) {
      if (info.mint !== TOKENS.USDC.mint) throw new Error("the wallet still holds tokens other than USDC: swap them back to USDC first");
      if (!(await conn.getAccountInfo(dstAta))) { needsDstAta = true; tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dstAta, to, usdcMint)); }
      tx.add(spl.createTransferCheckedInstruction(a.pubkey, usdcMint, dstAta, from.publicKey, atoms, 6));
      usdcAtoms += atoms;
    }
    tx.add(spl.createCloseAccountInstruction(a.pubkey, to, from.publicKey));
  }
  const lamports = await conn.getBalance(from.publicKey);
  const rent = needsDstAta ? await conn.getMinimumBalanceForRentExemption(165) : 0;
  const solOut = lamports - 5000 - rent;
  if (solOut < 0 && needsDstAta) throw new Error("not enough SOL to open the treasury's USDC account: send the treasury a little USDC first");
  if (solOut > 0) tx.add(web3.SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: solOut }));
  if (!tx.instructions.length) return { signature: undefined, sol: 0, usdc: 0 }; // already empty: nothing to move
  if (lamports < 5000) {
    // Not even enough SOL for a fee. Only empty token accounts can be left: nothing of value, so deleting is fine.
    if (deleting && usdcAtoms === 0n) return { signature: undefined, sol: 0, usdc: 0 };
    throw new Error("the wallet has no SOL to pay the network fee: send it 0.001 SOL first");
  }
  const signature = await web3.sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
  return { signature, sol: Math.max(0, solOut) / 1e9, usdc: Number(usdcAtoms) / 1e6 };
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
  try { return await web3.sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" }); }
  catch (e: any) {
    // Shorten Solana's long simulation logs to the line that matters
    let logs: string[] = e?.logs ?? [];
    if (!logs.length && typeof e?.getLogs === "function") { try { logs = await e.getLogs(conn); } catch {} }
    const all = `${e?.message ?? e} ${logs.join(" ")}`;
    if (/insufficient lamports|insufficient funds|0x1\b/i.test(all)) throw new Error("not enough balance in the sending wallet (SOL for fees and account rent, or the USDC being sent)");
    const lines = logs.filter((l) => /failed|error/i.test(l)).slice(-2);
    throw new Error(lines.length ? lines.join(" | ") : String(e?.message ?? e).slice(0, 300));
  }
}

// ---------- overview for the dashboard (public info only, cached) ----------
let cache: { at: number; data: any } | null = null;
export async function walletOverview() {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  const status = walletAdminStatus();
  let treasury: any = null, failed = false;
  if (process.env.TREASURY_SECRET_KEY) {
    try { const a = (await treasuryKeypair()).publicKey.toBase58(); try { treasury = { address: a, ...(await balancesOf(a)) }; } catch (e) { failed = true; treasury = { address: a, balanceError: (e as Error).message.slice(0, 160) }; } }
    catch (e) { treasury = { address: "invalid key", error: (e as Error).message }; }
  }
  const wallets = [];
  for (const w of listWallets()) {
    try { const a = (await w.getKeypair()).publicKey.toBase58(); let balances = null, balanceError: string | undefined;
      try { balances = await balancesOf(a); } catch (e) { failed = true; balanceError = (e as Error).message.slice(0, 160); }
      wallets.push({ id: w.id, name: w.name, role: w.role, source: w.source, address: a, balances, balanceError }); }
    catch { wallets.push({ id: w.id, name: w.name, role: w.role, source: w.source, address: "invalid key", balances: null }); }
  }
  const data = { ...status, treasury, wallets, history: loadTransfers().slice(-15).reverse(), botWallets: keystoreReady() ? storedWallets().length : 0 };
  cache = { at: failed ? Date.now() - 45_000 : Date.now(), data }; // a failed lookup is retried after 15 seconds, a good one after 60
  return data;
}
export const clearWalletCache = () => { cache = null; };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}
