const { spawnSync } = require("node:child_process");
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const extensionPath = resolve(__dirname, "..");
const testRoot = join(extensionPath, ".vscode-test");
mkdirSync(testRoot, { recursive: true });
const sandbox = mkdtempSync(join(testRoot, "integration-"));

try {
  const extensions = join(sandbox, "extensions");
  installFixture(extensions, "local", "competing-folds", "competingProvider");
  installFixture(extensions, "llvm-vs-code-extensions", "vscode-clangd", "languageProvider");
  installFixture(extensions, "rust-lang", "rust-analyzer", "languageProvider");

  const result = spawnSync(process.env.VSCODE_TEST_BINARY ?? "code", [
    "--user-data-dir", join(sandbox, "profile"),
    "--extensions-dir", extensions,
    "--new-window",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--extensionDevelopmentPath=" + extensionPath,
    "--extensionTestsPath=" + join(extensionPath, "out", "test", "integration.js"),
    "--wait",
  ], {
    env: { ...process.env, INLINE_BRACE_TEST_DIR: sandbox },
    stdio: "inherit",
    timeout: 45_000,
  });
  if (result.error) {
    throw result.error;
  }
  const report = JSON.parse(readFileSync(join(sandbox, "report.json"), "utf8"));
  if (report.error) {
    throw new Error(report.error);
  }
  process.exitCode = result.status ?? 1;
  process.stdout.write(report.passed.join("\n") + "\n");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

function installFixture(extensions, publisher, name, entry) {
  const directory = join(extensions, `${publisher}.${name}-0.0.1`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    publisher,
    name,
    version: "0.0.1",
    engines: { vscode: "^1.99.0" },
    main: "./extension.js",
  }));
  copyFileSync(join(extensionPath, "out", "test", entry + ".js"), join(directory, "extension.js"));
}
