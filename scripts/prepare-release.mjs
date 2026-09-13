import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entries = [
  ".github/workflows/pages.yml",
  ".gitignore",
  "index.html",
  "package.json",
  "package-lock.json",
  "playwright.config.ts",
  "README.md",
  "PRIVACY.md",
  "start.bat",
  "start.ps1",
  "tsconfig.json",
  "vite.config.ts",
  "scripts/serve.mjs",
  "scripts/prepare-onboarding-art.py",
  "scripts/prepare-release.mjs",
  "src",
  "tests",
  "e2e",
  "public",
];
const extensions = new Set([
  ".ts", ".tsx", ".css", ".svg", ".webp", ".png", ".jpg", ".jpeg", ".woff2",
]);
const credentialNames = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_BASE_URL",
];
const knownValues = credentialNames
  .map((name) => [name, process.env[name]])
  .filter(([, value]) => value && value.length >= 8);
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["api-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["google-key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["personal-path", /[A-Z]:[\\/]Users[\\/][^\s\\/]+[\\/]/i],
];
const files = [];
async function collect(relative, exact = false) {
  const path = join(root, relative);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error(`Release refuses symbolic links: ${relative}`);
  if (info.isDirectory()) {
    const children = (await readdir(path)).sort();
    for (const child of children) {
      if (child.startsWith(".") || /^(?:private|secrets?|backups?)$|^此间-完整备份-|\.log$/i.test(child))
        throw Error(`Review unexpected release entry: ${relative}/${child}`);
      await collect(`${relative}/${child}`);
    }
  } else if (info.isFile()) {
    if (!exact && !extensions.has(extname(relative)))
      throw Error(`Review unexpected file type: ${relative}`);
    files.push(relative);
  } else throw Error(`Unsupported release entry: ${relative}`);
}
for (const entry of entries) await collect(entry, true);

const findings = [];
const manifest = [];
for (const relative of files.sort()) {
  const bytes = await readFile(join(root, relative));
  for (const [name, value] of knownValues) {
    if (bytes.includes(Buffer.from(value))) findings.push({ file: relative, kind: name });
  }
  const content = bytes.toString("utf8");
  for (const [kind, pattern] of patterns) {
    if (pattern.test(content)) findings.push({ file: relative, kind });
  }
  manifest.push({
    file: relative,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
if (findings.length) {
  console.error(JSON.stringify({ status: "blocked", findings }, null, 2));
  process.exit(1);
}

const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const release = join(root, "work", "github-release", stamp);
const source = join(release, "source");
await mkdir(source, { recursive: true });
for (const relative of files) {
  const destination = join(source, relative);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, relative), destination);
  const copied = await readFile(destination);
  const expected = manifest.find((entry) => entry.file === relative);
  if (createHash("sha256").update(copied).digest("hex") !== expected.sha256)
    throw Error(`File changed during preparation; do not publish this snapshot: ${relative}`);
}
const report = {
  created: new Date().toISOString(),
  source: "source",
  status: "prepared-locally-not-published",
  secretScan: { findings: 0, patterns: patterns.map(([name]) => name), knownValueCount: knownValues.length },
  excluded: ["outputs/", "work/", "node_modules/", "dist/", "test-results/", "playwright-report/", ".env*", "backups/", "backup/"],
  files: manifest,
};
await writeFile(join(release, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ source, files: files.length, bytes: manifest.reduce((sum, f) => sum + f.bytes, 0), findings: 0 }, null, 2));
