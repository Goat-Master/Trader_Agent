import { CONFIG } from "./config.js";
import { storedWallets, secretOf, keystoreReady } from "./keystore.js";

// Wallets the service can sign with. Secrets never leave this file, keystore.ts, hermes.ts and transfers.ts:
// nothing here is sent to an AI or the dashboard.
//   Treasury:        TREASURY_SECRET_KEY              funding source for the other wallets
//   Trading wallet:  WALLET_SECRET_KEY, or one the bot created (role "trading")
//   Test wallets:    TEST_WALLET_1 ... TEST_WALLET_10, or ones the bot created (role "test")
// Env keys can be a JSON array ([12,34,...]) or base58 (Phantom / Solflare export).

type Keypair = import("@solana/web3.js").Keypair;
export type WalletRef = { id: string; name: string; role: "trading" | "test"; source: "env" | "bot"; getKeypair: () => Promise<Keypair> };

export function listWallets(): WalletRef[] {
  const out: WalletRef[] = [];
  if (CONFIG.walletSecret) out.push({ id: "agent", name: "Trading wallet (Railway)", role: "trading", source: "env", getKeypair: () => keypairFromSecret(CONFIG.walletSecret) });
  for (let i = 1; i <= 10; i++) {
    const secret = process.env[`TEST_WALLET_${i}`];
    if (secret) out.push({ id: `test${i}`, name: process.env[`TEST_WALLET_${i}_NAME`] || `Test wallet ${i}`, role: "test", source: "env", getKeypair: () => keypairFromSecret(secret) });
  }
  if (keystoreReady()) {
    for (const w of storedWallets()) {
      if (w.role === "trading" && CONFIG.walletSecret) continue; // the Railway trading key takes priority
      out.push({ id: w.id, name: w.name, role: w.role, source: "bot", getKeypair: async () => keypairFromBytes(secretOf(w.id)) });
    }
  }
  return out;
}

export const tradingWalletRef = () => listWallets().find((w) => w.role === "trading") ?? null;

// The trading wallet's address without decrypting anything (for prerequisites and balances)
export function tradingAddressSync(): string {
  if (CONFIG.walletSecret) return CONFIG.walletAddress;
  if (!keystoreReady()) return "";
  return storedWallets().find((w) => w.role === "trading")?.address ?? "";
}

export async function tradingKeypair() {
  const w = tradingWalletRef();
  if (!w) throw new Error("no trading wallet: set WALLET_SECRET_KEY or create one on the dashboard");
  return w.getKeypair();
}

export async function keypairFor(id: string) {
  const w = listWallets().find((x) => x.id === id);
  if (!w) throw new Error(`unknown wallet ${id}`);
  return w.getKeypair();
}

export async function treasuryKeypair() {
  const s = process.env.TREASURY_SECRET_KEY;
  if (!s) throw new Error("set TREASURY_SECRET_KEY in Railway first");
  return keypairFromSecret(s);
}

export async function keypairFromSecret(secret: string) {
  const s = secret.trim();
  return keypairFromBytes(s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : base58Decode(s));
}

async function keypairFromBytes(bytes: Uint8Array) {
  const { Keypair } = await import("@solana/web3.js");
  if (bytes.length !== 64) throw new Error("wallet secret must be a 64-byte key (JSON array or base58)");
  return Keypair.fromSecretKey(bytes);
}

// Public info only, for the dashboard
export async function publicWallets() {
  const out: { id: string; name: string; role: string; source: string; address: string }[] = [];
  for (const w of listWallets()) {
    try { out.push({ id: w.id, name: w.name, role: w.role, source: w.source, address: (await w.getKeypair()).publicKey.toBase58() }); }
    catch { out.push({ id: w.id, name: w.name, role: w.role, source: w.source, address: "invalid key" }); }
  }
  return out;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("invalid base58 character in wallet secret");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === "1") bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}
