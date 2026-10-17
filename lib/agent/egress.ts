import type { CreateOSSandbox } from "../sandbox/createos";

// Shared by server.ts and the live smoke test; no app or payment imports.

export const PROBE_HOST = process.env.SEALED_EGRESS_PROBE_HOST ?? "1.1.1.1";
const PROBE_SCRIPT = [
  "import socket",
  "try:",
  `    socket.create_connection((${JSON.stringify(PROBE_HOST)}, 443), timeout=5).close()`,
  "    print('OPEN')",
  "except OSError:",
  "    print('BLOCKED')",
].join("\n");

/**
 * Empirical egress check run inside each sandbox before data or code is
 * uploaded: a connection to a host outside the allowlist must fail. This is
 * evidence for one destination, not a proof of zero egress.
 */
export async function verifyEgressBlocked(sandbox: CreateOSSandbox): Promise<void> {
  const { result } = await sandbox.runCommand("python3", ["-I", "-c", PROBE_SCRIPT], {
    timeoutMs: 20_000,
    retry: false,
  });
  if (result.exit_code !== 0 || result.stdout.trim() !== "BLOCKED") {
    throw new Error("Sandbox egress probe was not blocked");
  }
}
