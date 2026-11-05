import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, copyFileSync, rmSync, statSync, fsyncSync, openSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG } from "./config.js";

// DATA SAFETY
// 1. storageProblem(): on Railway, data must live on an attached volume. Without one, the agents pause.
// 2. writeJsonAtomic(): write to a temp file, flush, then rename, so a crash mid-save never leaves a half-written file.
// 3. dailyBackup(): copies every data file to DATA_DIR/backups/YYYY-MM-DD, keeps BACKUP_DAYS days.
// 4. exportBundle() / restoreBundle(): download a full copy from the dashboard, and put it back if ever needed.

export function storageProblem(): string | null {
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  if (!onRailway) return null;
  const mount = (process.env.RAILWAY_VOLUME_MOUNT_PATH || "").replace(/\/$/, "");
  if (!mount) return "No Railway volume is attached, so all data would be wiped on the next deploy. Attach a volume at /data and set DATA_DIR=/data.";
  const dir = CONFIG.dataDir.replace(/\/$/, "");
  if (!(dir === mount || dir.startsWith(mount + "/"))) return `DATA_DIR (${CONFIG.dataDir}) is not on the volume (${mount}). Set DATA_DIR=${mount}.`;
  return null;
}

export function writeJsonAtomic(path: string, data: unknown, mode?: number) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, path);
}

// strict = never start from empty if the file is damaged and no backup exists (trading ledgers, wallet keys)
export function readJson<T>(path: string, fallback: T, strict = false): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch {
    // Damaged file: keep it for inspection and recover from the latest backup
    const bad = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, bad); } catch {}
    const restored = latestBackupOf(basename(path));
    if (restored) { copyFileSync(restored, path); return JSON.parse(readFileSync(path, "utf8")) as T; }
    if (strict) { try { renameSync(bad, path); } catch {} throw new Error(`${basename(path)} is damaged and there is no backup: the agent stopped instead of starting from empty. Restore a backup from the dashboard.`); }
    return fallback;
  }
}

const backupsDir = () => join(CONFIG.dataDir, "backups");
const dataFiles = () => existsSync(CONFIG.dataDir) ? readdirSync(CONFIG.dataDir).filter((f) => f.endsWith(".json") && !f.includes(".tmp-") && !f.includes(".corrupt-")) : [];

function latestBackupOf(name: string): string | null {
  if (!existsSync(backupsDir())) return null;
  for (const d of readdirSync(backupsDir()).sort().reverse()) {
    const p = join(backupsDir(), d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// One backup folder per day. Runs after each cycle: creates today's folder and adds any file it is still missing.
export function dailyBackup(): string | null {
  if (storageProblem()) return null;
  const files = dataFiles();
  if (!files.length) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(backupsDir(), day);
  const missing = files.filter((f) => !existsSync(join(dir, f)));
  if (!missing.length) return null;
  mkdirSync(dir, { recursive: true });
  for (const f of missing) copyFileSync(join(CONFIG.dataDir, f), join(dir, f));
  const keep = CONFIG.backupDays;
  const days = readdirSync(backupsDir()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - keep))) rmSync(join(backupsDir(), old), { recursive: true, force: true });
  return dir;
}

// Copy one file into today's backup right away (used for the wallet keystore on every change)
export function backupNow(name: string) {
  if (storageProblem()) return;
  const src = join(CONFIG.dataDir, name);
  if (!existsSync(src)) return;
  const dir = join(backupsDir(), new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, name));
}

export function backupInfo() {
  const days = existsSync(backupsDir()) ? readdirSync(backupsDir()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  return { count: days.length, latest: days.at(-1) ?? null, files: dataFiles().map((f) => ({ name: f, bytes: statSync(join(CONFIG.dataDir, f)).size })) };
}

// Full copy of every data file. The keystore stays encrypted: it is useless without WALLET_ENCRYPTION_KEY.
export function exportBundle() {
  const files: Record<string, unknown> = {};
  for (const f of dataFiles()) files[f] = JSON.parse(readFileSync(join(CONFIG.dataDir, f), "utf8"));
  return { kind: "swapio-agent-backup", version: 1, createdAt: new Date().toISOString(), files };
}

const RESTORABLE = /^(state\.(paper|live)|outbox|controls|keystore|transfers|testswaps)\.json$/;

export function restoreBundle(bundle: any) {
  if (bundle?.kind !== "swapio-agent-backup" || typeof bundle.files !== "object") throw new Error("not a backup file from this agent");
  const names = Object.keys(bundle.files).filter((n) => RESTORABLE.test(n));
  if (!names.length) throw new Error("backup contains no restorable files");
  // Safety copy of the current data before overwriting anything
  const safety = join(backupsDir(), `before-restore-${Date.now()}`);
  mkdirSync(safety, { recursive: true });
  for (const f of dataFiles()) copyFileSync(join(CONFIG.dataDir, f), join(safety, f));
  // Never drop wallets: merge keystores so a restore can only add keys, not remove them
  const ksPath = join(CONFIG.dataDir, "keystore.json");
  if (bundle.files["keystore.json"] && existsSync(ksPath)) {
    const cur = JSON.parse(readFileSync(ksPath, "utf8"));
    const inc = bundle.files["keystore.json"];
    if (cur.salt !== inc.salt) throw new Error("the backup's keystore uses a different encryption salt: restore it on a fresh volume, or ask a dev to merge it");
    const ids = new Set(cur.wallets.map((w: any) => w.id));
    bundle.files["keystore.json"] = { ...cur, wallets: [...cur.wallets, ...inc.wallets.filter((w: any) => !ids.has(w.id))] };
  }
  for (const n of names) writeJsonAtomic(join(CONFIG.dataDir, n), bundle.files[n], n === "keystore.json" ? 0o600 : undefined);
  return { restored: names, safetyCopy: safety };
}
