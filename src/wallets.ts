import { CONFIG } from "./config.js";

// Wallets the service can sign with. Secrets stay in this file and hermes.ts; nothing here is ever sent to an AI or the dashboard.
//   Agent wallet:  WALLET_SECRET_KEY (+ WALLET_ADDRESS)
//   Test wallets:  TEST_WALLET_1 ... TEST_WALLET_10, optional names in TEST_WALLET_1_NAME ...
// Keys can be a JSON array ([12,34,...], solana-keygen format) or a base58 string (Phantom / Solflare export).

export type WalletRef = { id: string; name: string; secret: string };

export function listWallets(): WalletRef[] {
  const out: WalletRef[] = [];
  if (CONFIG.walletSecret) out.push({ id: "agent", name: "Agent wallet", secret: CONFIG.walletSecret });
  for (let i = 1; i <= 10; i++) {
    const secret = process.env[`TEST_WALLET_${i}`];
    if (secret) out.push({ id: `test${i}`, name: process.env[`TEST_WALLET_${i}_NAME`] || `Test wallet ${i}`, secret });
  }
  return out;
}

export async function keypairFor(id: string) {
  const w = listWallets().find((x) => x.id === id);
  if (!w) throw new Error(`unknown wallet ${id}`);
  return keypairFromSecret(w.secret);
}

export async function keypairFromSecret(secret: string) {
  const { Keypair } = await import("@solana/web3.js");
  const s = secret.trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : base58Decode(s);
  if (bytes.length !== 64) throw new Error("wallet secret must be a 64-byte key (JSON array or base58)");
  return Keypair.fromSecretKey(bytes);
}

// Public info only, for the dashboard
export async function publicWallets() {
  const out: { id: string; name: string; address: string }[] = [];
  for (const w of listWallets()) {
    try { out.push({ id: w.id, name: w.name, address: (await keypairFromSecret(w.secret)).publicKey.toBase58() }); }
    catch { out.push({ id: w.id, name: w.name, address: "invalid key" }); }
  }
  return out;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
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
