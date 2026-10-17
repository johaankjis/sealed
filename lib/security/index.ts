/**
 * lib/security — reusable security primitives for Sealed.
 *
 * Exposes:
 * - AggregateOnlyOutputPolicy  (contracts/results.ts OutputPolicy)
 * - validateGeneratedCode      (static checks on Python before sandboxing)
 * - validateQuestion           (buyer input hygiene at the API boundary)
 * - canExecuteJob              (payment-verified execution gate)
 * - redactExecutionOutput      (scrubs unvalidated execution output)
 */
export {
  AggregateOnlyOutputPolicy,
  DEFAULT_OUTPUT_POLICY_OPTIONS,
  type AggregateOnlyPolicyOptions,
} from "./output-policy";
export {
  ALLOWED_PYTHON_MODULES,
  validateGeneratedCode,
  type CodePolicyDecision,
  type CodePolicyViolation,
} from "./code-policy";
export {
  DEFAULT_QUESTION_POLICY_OPTIONS,
  validateQuestion,
  type QuestionPolicyOptions,
  type QuestionValidation,
} from "./query-policy";
export { canExecuteJob, type ExecutionGateDecision } from "./execution-gate";
export {
  DEFAULT_REDACTION_OPTIONS,
  redactExecutionOutput,
  type RedactionOptions,
} from "./redaction";
