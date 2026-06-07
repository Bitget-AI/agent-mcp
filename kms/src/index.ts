// Entry point for the Spug `publish-npm` Make target.
//
// Run from the `kms/` directory (Makefile sets cwd):
//   pnpm run kms-run
//
// Effect:
//   - Decrypts the encrypted npm token in `./src/token.ts` via KMS.
//   - Writes a `.npmrc` (mode 0600) in the current directory containing
//     the plaintext token and the public npm registry URL.
//   - Caller (Makefile) copies that `.npmrc` next to `package.json` for
//     `npm publish`, then scrubs both copies.

import { writeFile } from "node:fs/promises";
import { decryptToken } from "./kms.js";
import { TOKEN } from "./token.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatField(name: string, value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return `${name}: ${value}`;
  }
  return null;
}

function collectErrorLines(err: unknown, label: string): string[] {
  const lines: string[] = [];
  const record = isRecord(err) ? err : null;

  if (err instanceof Error) {
    lines.push(`${label}.name: ${err.name}`);
    lines.push(`${label}.message: ${err.message}`);
  } else {
    lines.push(`${label}.value: ${String(err)}`);
  }

  if (!record) {
    return lines;
  }

  for (const field of ["$fault", "code", "Code", "statusCode"]) {
    const formatted = formatField(`${label}.${field}`, record[field]);
    if (formatted) {
      lines.push(formatted);
    }
  }

  const metadata = record.$metadata;
  if (isRecord(metadata)) {
    for (const field of [
      "httpStatusCode",
      "requestId",
      "extendedRequestId",
      "cfId",
      "attempts",
      "totalRetryDelay",
    ]) {
      const formatted = formatField(`${label}.$metadata.${field}`, metadata[field]);
      if (formatted) {
        lines.push(formatted);
      }
    }
  }

  if ("cause" in record && record.cause !== undefined) {
    lines.push(...collectErrorLines(record.cause, `${label}.cause`));
  }

  return lines;
}

async function main(): Promise<void> {
  if (TOKEN.startsWith("kms#PLACEHOLDER")) {
    throw new Error(
      "Encrypted npm token in kms/src/token.ts is the placeholder. " +
        "Request a real one from @Evan Zhe -> @Sec Ma and replace it " +
        "before running publish.",
    );
  }

  const plaintext = await decryptToken(TOKEN);
  const npmrc =
    "registry=https://registry.npmjs.org/\n" +
    `//registry.npmjs.org/:_authToken=${plaintext}\n` +
    "always-auth=true\n";

  await writeFile(".npmrc", npmrc, { mode: 0o600 });
  console.log("Wrote kms/.npmrc");
}

main().catch((err: unknown) => {
  console.error("KMS npm token decryption failed.");
  for (const line of collectErrorLines(err, "error")) {
    console.error(line);
  }
  process.exit(1);
});
