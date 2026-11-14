// Refuses to publish an update feed that would mislead an installed app.
// Reads latest-mac.yml and recomputes sha512 and size of every file it names
// from the bytes in the release folder. The feed is the last file uploaded, so
// this runs before any upload and a bad feed never reaches the CDN.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// latest-mac.yml has the fixed shape electron-builder writes: top-level
// scalars plus a `files:` list of url/sha512/size entries. A line parser keeps
// the check free of dependencies, so the publish job needs no install step.
function parseFeed(text) {
  const feed = { files: [] };
  let current = null;
  for (const line of text.split("\n")) {
    const item = /^  - url: (.+)$/.exec(line);
    if (item) {
      current = { url: item[1].trim() };
      feed.files.push(current);
      continue;
    }
    const field = /^    (sha512|size): (.+)$/.exec(line);
    if (field && current) {
      current[field[1]] = field[1] === "size" ? Number(field[2]) : field[2].trim();
      continue;
    }
    const scalar = /^(version|path|sha512): (.+)$/.exec(line);
    if (scalar) {
      feed[scalar[1]] = scalar[2].trim().replace(/^['"]|['"]$/g, "");
      current = null;
    }
  }
  return feed;
}

const sha512Base64 = (file) => createHash("sha512").update(readFileSync(file)).digest("base64");

/** Returns the list of problems; an empty list means the feed matches the files. */
export function checkFeed({ feedPath, version, dir }) {
  const problems = [];
  const feed = parseFeed(readFileSync(feedPath, "utf8"));

  if (feed.version !== version) {
    problems.push(`version is ${JSON.stringify(feed.version)}, expected ${JSON.stringify(version)}`);
  }
  const { files } = feed;
  if (files.length === 0) problems.push("the file list is empty");

  const onDisk = new Set(readdirSync(dir));
  const names = [...files.map((file) => file?.url), feed.path];
  for (const name of names) {
    if (typeof name !== "string" || name === "") {
      problems.push(`an entry has no file name: ${JSON.stringify(name)}`);
      continue;
    }
    if (name.includes("/") || /\s/.test(name)) {
      problems.push(`file name has a slash or whitespace: ${JSON.stringify(name)}`);
    } else if (!onDisk.has(name)) {
      problems.push(`file is missing from ${dir}: ${name}`);
    }
    if (!/-arm64\./.test(name)) problems.push(`not an arm64 file: ${name}`);
  }

  for (const file of files) {
    const name = file?.url;
    if (typeof name !== "string" || name.includes("/") || !onDisk.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).size !== file.size) {
      problems.push(`size mismatch for ${name}: feed ${file.size}, disk ${statSync(path).size}`);
    }
    if (sha512Base64(path) !== file.sha512) problems.push(`sha512 mismatch for ${name}`);
  }
  // The top-level path/sha512 is the legacy fallback and names the first file.
  if (typeof feed.path === "string" && onDisk.has(feed.path) && feed.sha512 !== sha512Base64(join(dir, feed.path))) {
    problems.push(`top-level sha512 does not match ${feed.path}`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { feed: { type: "string" }, version: { type: "string" }, dir: { type: "string" } },
  });
  if (!values.feed || !values.version || !values.dir) {
    console.error("Usage: node scripts/fork-feed-check.mjs --feed <latest-mac.yml> --version <version> --dir <folder>");
    process.exit(2);
  }
  const problems = checkFeed({ feedPath: values.feed, version: values.version, dir: values.dir });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`feed check: ${problem}`);
    process.exit(1);
  }
  console.log(`feed check: ${values.feed} matches the files in ${values.dir} for ${values.version}`);
}
