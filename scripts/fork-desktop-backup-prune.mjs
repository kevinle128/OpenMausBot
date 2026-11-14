// Plans which published desktop versions to delete from the update feed
// folder so that only the newest few stay. A version owns a folder
// `<version>/` and the root files `OpenMausBot-<version>-arm64.*`. Nothing else
// is ever named: latest-mac.yml and any stray file are left alone, and the
// current version must be among the kept ones or nothing is deleted.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+\.mf\.\d+|-mf\.\d+)`;
const FOLDER = new RegExp(`^(${VERSION})/$`);
const ROOT_FILE = new RegExp(`^OpenMausBot-(${VERSION})-arm64\\.(?:dmg|zip)(?:\\.blockmap)?$`);

function parseVersion(name) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(name);
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

// Semver precedence: 0.1.158-mf.10 is newer than 0.1.158-mf.9.
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i += 1) {
    const order = compareIdentifiers(a.pre[i], b.pre[i]);
    if (order !== 0) return order;
  }
  return a.pre.length - b.pre.length;
}

// `aws s3 ls s3://bucket/prefix/` prints folders as "PRE <name>/" and files
// as "<date> <time> <size> <name>".
export function parseListing(text) {
  const keys = [];
  for (const line of text.split("\n")) {
    const folder = /^\s*PRE (.+\/)$/.exec(line);
    if (folder) keys.push(folder[1]);
    const file = /^\S+\s+\S+\s+\d+ (.+)$/.exec(line);
    if (file) keys.push(file[1]);
  }
  return keys;
}

export function planPrune({ keys, keep, current }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a positive integer, got ${keep}`);
  const owner = new Map();
  const ignored = [];
  for (const key of keys) {
    const version = (FOLDER.exec(key) ?? ROOT_FILE.exec(key))?.[1];
    if (version) owner.set(key, version);
    else ignored.push(key);
  }
  const versions = [...new Set(owner.values())].sort((a, b) => compareVersions(b, a));
  const kept = versions.slice(0, keep);
  const nothing = (reason) => ({ kept: versions, removed: [], ignored, reason });
  if (versions.length <= keep) return nothing(`only ${versions.length} versions, keeping all`);
  if (current && !kept.includes(current)) {
    return nothing(`${current} is not among the ${keep} newest versions, deleting nothing`);
  }
  const removed = [...owner].filter(([, version]) => !kept.includes(version)).map(([key]) => key);
  return { kept, removed, ignored, reason: null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      listing: { type: "string" },
      keep: { type: "string" },
      current: { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.listing || !values.keep || !values.out) {
    console.error(
      "Usage: node scripts/fork-desktop-backup-prune.mjs --listing <file> --keep <n> --out <file> --current <version> [--dry-run]",
    );
    process.exit(2);
  }
  if (!values.current && !values["dry-run"]) {
    console.error("--current is required unless --dry-run is set; nothing is planned.");
    process.exit(2);
  }
  const plan = planPrune({
    keys: parseListing(readFileSync(values.listing, "utf8")),
    keep: Number(values.keep),
    current: values.current,
  });
  console.log(`Prune plan (keep the ${values.keep} newest versions):`);
  console.log(`  keep versions: ${plan.kept.join(", ") || "none"}`);
  console.log(`  delete: ${plan.removed.join(", ") || "none"}`);
  console.log(`  left alone: ${plan.ignored.join(", ") || "none"}`);
  if (plan.reason) console.log(`  ${plan.reason}`);
  writeFileSync(values.out, plan.removed.map((key) => `${key}\n`).join(""));
}
