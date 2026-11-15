// Generates a throw-away self-signed certificate (localhost / 127.0.0.1) for
// the TLS and HTTP/2 tests. Skipped gracefully when openssl is unavailable.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  if (process.env.TEST_CERT_DIR) return () => undefined;
  const dir = mkdtempSync(join(tmpdir(), "gae-certs-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    process.env.TEST_CERT_DIR = dir;
  } catch {
    // openssl missing: TLS tests skip themselves.
  }
  return () => rmSync(dir, { recursive: true, force: true });
}
