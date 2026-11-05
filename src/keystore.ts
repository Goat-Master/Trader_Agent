import { writeJsonAtomic, readJson, backupNow, storageProblem as sp } from "./persist.js";
import { join } from "node:path";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { CONFIG } from "./config.js";

// Encrypted store for wallets the bot creates itself. Lives on the Railway volume (DATA_DIR).
// Keys are encrypted with AES-256-GCM using WALLET_ENCRYPTION_KEY (a passphrase only Railway knows).
// Without that passphrase the file is useless, and without the file the keys are gone, so the volume matters.

export type StoredWallet = { id: string; name: string; role: "trading" | "test"; address: string; iv: string; tag: string; data: string; createdAt: string };
type KeystoreFile = { version: 1; salt: string; wallets: StoredWallet[] };

const file = () => join(CONFIG.dataDir, "keystore.json");

export const keystoreReady = () => (process.env.WALLET_ENCRYPTION_KEY || "").length >= 16;

export const storageProblem = sp;

function load(): KeystoreFile {
  return readJson<KeystoreFile>(file(), { version: 1, salt: randomBytes(16).toString("hex"), wallets: [] }, true);
}
function save(k: KeystoreFile) {
  writeJsonAtomic(file(), k, 0o600);
  backupNow("keystore.json");
}
function key(salt: string) {
  if (!keystoreReady()) throw new Error("set WALLET_ENCRYPTION_KEY (16+ characters) in Railway first");
  return scryptSync(process.env.WALLET_ENCRYPTION_KEY!, Buffer.from(salt, "hex"), 32);
}

export function storedWallets(): Omit<StoredWallet, "iv" | "tag" | "data">[] {
  return load().wallets.map(({ iv, tag, data, ...pub }) => pub);
}

export function addWallet(name: string, role: "trading" | "test", address: string, secret: Uint8Array) {
  const k = load();
  if (role === "trading" && k.wallets.some((w) => w.role === "trading")) throw new Error("a trading wallet already exists");
  if (k.wallets.filter((w) => w.role === "test").length >= CONFIG.walletAdmin.maxWallets && role === "test") throw new Error(`limit of ${CONFIG.walletAdmin.maxWallets} test wallets reached`);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(k.salt), iv);
  const data = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  const id = role === "trading" ? "trading" : `bot${Date.now().toString(36)}`;
  const w: StoredWallet = { id, name: name.slice(0, 40) || (role === "trading" ? "Trading wallet" : "Test wallet"), role, address, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("hex"), createdAt: new Date().toISOString() };
  k.wallets.push(w);
  save(k);
  return { id: w.id, name: w.name, role: w.role, address: w.address };
}

export function secretOf(id: string): Uint8Array {
  const k = load();
  const w = k.wallets.find((x) => x.id === id);
  if (!w) throw new Error(`unknown wallet ${id}`);
  const d = createDecipheriv("aes-256-gcm", key(k.salt), Buffer.from(w.iv, "hex"));
  d.setAuthTag(Buffer.from(w.tag, "hex"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(w.data, "hex")), d.final()]));
}

export function removeWallet(id: string) {
  const k = load();
  k.wallets = k.wallets.filter((w) => w.id !== id);
  save(k);
}
