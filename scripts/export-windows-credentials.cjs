const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  process.stderr.write("Usage: electron export-windows-credentials.cjs <gateway-credentials.json> <provider.env>\n");
  process.exit(2);
}

app.setPath("userData", path.dirname(path.resolve(inputPath)));

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows secure storage is unavailable.");
  }
  const file = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
  const lines = [
    "# Generated locally by RHZYCODE credential migration.",
    "# Keep this file private and do not commit it.",
  ];
  for (const [name, encoded] of Object.entries(file.credentials || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*_API_KEY$/.test(name) || typeof encoded !== "string") continue;
    const value = safeStorage.decryptString(Buffer.from(encoded, "base64"));
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${lines.join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(`Exported ${Math.max(0, lines.length - 2)} provider credential(s).\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
