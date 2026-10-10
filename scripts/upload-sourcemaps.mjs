import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// BuildKit secrets stay out of image layers and Docker build arguments.
const secretPath = "/run/secrets/sentry_auth_token";
const token = process.env.SENTRY_AUTH_TOKEN?.trim() || (existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "");
if (!token) {
  console.log("Sentry source-map upload skipped: no build token configured.");
  process.exit(0);
}
const required = ["SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_RELEASE"];
const missing = required.filter(key => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Sentry source-map upload requires ${missing.join(", ")}.`);
  process.exit(1);
}
const directory = process.env.SENTRY_SOURCEMAP_DIR || "dist/src";
const prefix = process.env.SENTRY_SOURCEMAP_URL_PREFIX || "app:///dist/src";
const cli = fileURLToPath(new URL("../node_modules/@sentry/cli/bin/sentry-cli", import.meta.url));
const environment = { ...process.env, SENTRY_AUTH_TOKEN: token };
for (const args of [
  ["sourcemaps", "inject", directory],
  ["sourcemaps", "upload", "--org", process.env.SENTRY_ORG, "--project", process.env.SENTRY_PROJECT,
    "--release", process.env.SENTRY_RELEASE, "--url-prefix", prefix, directory]
]) {
  const result = spawnSync(process.execPath, [cli, ...args], { env: environment, stdio: "inherit" });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
