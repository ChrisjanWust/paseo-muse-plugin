import { z } from "zod";
import type {
  ApprovalMode,
  ReasoningEffort,
} from "@muse-code/sdk/dist/src/msp.js";

export const approvalModes = [
  "promptUnmatched",
  "denyUnmatched",
  "onRequest",
  "allowAll",
] as const satisfies readonly ApprovalMode[];
export const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
] as const satisfies readonly ReasoningEffort[];
// Closed schema vocabularies: an upstream addition must be considered here.
type Exhaustive<T extends never> = T;
export type AllReasoningEfforts = Exhaustive<
  Exclude<ReasoningEffort, (typeof reasoningEfforts)[number]>
>;
export type AllApprovalModes = Exhaustive<
  Exclude<ApprovalMode, (typeof approvalModes)[number]>
>;
export const modeSchema = z.enum(approvalModes);
export const reasoningSchema = z.enum(reasoningEfforts);
export const optionsSchema = z
  .object({
    museBin: z.string().min(1).default("muse"),
    serveArgs: z.array(z.string()).default([]),
    schemaMismatch: z.enum(["fail", "warn"]).default("fail"),
    systemPromptStrategy: z
      .enum(["reject", "prepend-user-context"])
      .default("reject"),
    unsupportedMcpStrategy: z
      .enum(["reject", "use-muse-native-config"])
      .default("reject"),
    shutdownTimeoutMs: z.number().int().min(0).max(60000).default(5000),
    requestTimeoutMs: z.number().int().min(100).max(120000).default(30000),
  })
  .strict();
export type MuseOptions = z.infer<typeof optionsSchema>;
export const modes = [
  {
    id: "promptUnmatched",
    label: "Ask when needed",
    description: "Ask for unmatched tool actions",
  },
  {
    id: "denyUnmatched",
    label: "Deny unmatched",
    description: "Deny unmatched tool actions",
  },
  {
    id: "onRequest",
    label: "On request",
    description: "Ask when requested by Muse",
  },
  {
    id: "allowAll",
    label: "Allow all",
    description: "Approve all tool actions",
    isUnattended: true,
  },
];
export const thinkingOptions = reasoningEfforts.map((id) => ({
  id,
  label: id,
}));
export const persistenceSchema = z
  .object({
    version: z.literal(1),
    data: z
      .object({
        museSessionId: z.string().uuid(),
        schemaFingerprint: z.string().min(1),
      })
      .strict(),
  })
  .strict();
