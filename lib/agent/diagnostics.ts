// Redacted failure codes for operator logs. Only short machine tokens leave
// here: error codes, class names, HTTP statuses and variable names. Never
// error messages, stdout/stderr, generated code, dataset contents, URLs or
// credentials.

const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

function token(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

/**
 * Best-effort safe code for any thrown value, for example:
 * `SHARED_EGRESS_UNVERIFIED` (SandboxError), `CONFIG:CREATEOS_SANDBOX_API_KEY`,
 * `AuthenticationError:401` (Anthropic), `CreateosSandboxAuthError:401`.
 */
export function diagnosticCode(err: unknown): string {
  if (!err || typeof err !== "object") return "UNKNOWN";
  const e = err as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; variable?: unknown };
  const name = token(e.name);

  if (name === "ConfigError" && typeof e.variable === "string") {
    const variable = token(e.variable.split(/\s/)[0]);
    return variable ? `CONFIG:${variable}` : "CONFIG";
  }
  // Fixed codes from lib/sandbox, lib/payments and the orchestrator.
  const code = token(e.code);
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (code && /^[A-Z0-9_]+$/.test(code) && !status) return code;
  // SDK errors: class name plus HTTP status (and provider code when stable).
  if (name) return [name, status, code].filter((part) => part !== undefined).join(":");
  return code ?? "UNKNOWN";
}

type SharedClient = import("../sandbox/single").SingleSandboxConfig["client"];
type AttachedBox = Awaited<ReturnType<SharedClient["getSandbox"]>>;

/** Classifies a trusted remote script by marker; never inspects generated code. */
function commandKind(args: string[]): string {
  const script = args[2] ?? "";
  if (script.includes('print("BLOCKED")')) return "egress_probe";
  if (script.includes("sealed-shared.lock") && script.includes("os.mkdir")) return "lease";
  if (script.includes("subprocess.Popen")) return "supervisor";
  if (script.includes("shutil.rmtree")) return "cleanup";
  return "other";
}

export type SdkDiagnostic =
  | { op: "attach" | "egress_readback" | "upload" | "command"; outcome: "error"; code: string; kind?: string; file?: string }
  | { op: "attach"; outcome: "ok"; status: string; ingress: boolean }
  | { op: "command"; outcome: "exit"; kind: string; exit: number };

/**
 * Wraps the CreateOS client given to SingleSandboxRuntime so failures report
 * which provider call failed. single.ts maps every SDK error to a fixed code
 * (e.g. SHARED_PREPARATION_FAILED); this recovers the stage without changing
 * its checks or behavior. Only error classes, HTTP statuses, exit codes, file
 * basenames and booleans are reported.
 */
export function withSharedSandboxDiagnostics(
  client: SharedClient,
  log: (entry: SdkDiagnostic) => void
): SharedClient {
  return {
    async getSandbox(id, options) {
      let box: AttachedBox;
      try {
        box = await client.getSandbox(id, options);
      } catch (err) {
        log({ op: "attach", outcome: "error", code: diagnosticCode(err) });
        throw err;
      }
      log({
        op: "attach",
        outcome: "ok",
        status: token(box.data?.status) ?? "unknown",
        ingress: box.data?.ingress_enabled === true,
      });
      return {
        id: box.id,
        data: box.data,
        async getEgress(opts) {
          try {
            return await box.getEgress(opts);
          } catch (err) {
            log({ op: "egress_readback", outcome: "error", code: diagnosticCode(err) });
            throw err;
          }
        },
        files: {
          async upload(path, data, opts) {
            try {
              return await box.files.upload(path, data, opts);
            } catch (err) {
              const file = token(path.split("/").pop());
              log({ op: "upload", outcome: "error", code: diagnosticCode(err), ...(file ? { file } : {}) });
              throw err;
            }
          },
        },
        async runCommand(cmd, args, opts) {
          const kind = commandKind(args);
          try {
            const response = await box.runCommand(cmd, args, opts);
            if (response.result.exit_code !== 0 || response.result.error) {
              log({ op: "command", outcome: "exit", kind, exit: response.result.exit_code });
            }
            return response;
          } catch (err) {
            log({ op: "command", outcome: "error", code: diagnosticCode(err), kind });
            throw err;
          }
        },
      };
    },
  };
}
