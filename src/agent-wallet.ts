import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

export function loadOrCreateAgentWallet(filename: string): Keypair {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });

  if (fs.existsSync(filename)) {
    const bytes = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((value) => !Number.isInteger(value))) {
      throw new Error(`Invalid agent keypair at ${filename}`);
    }
    assertPrivatePermissions(filename);
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  }

  const keypair = Keypair.generate();
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Array.from(keypair.secretKey)), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
  return keypair;
}

function assertPrivatePermissions(filename: string): void {
  if (process.platform === "win32") {
    return;
  }
  const mode = fs.statSync(filename).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Agent keypair ${filename} must not be readable by group or other users`);
  }
}
