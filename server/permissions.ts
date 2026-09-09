import type {
  ProviderEvent,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import type { DeepReadonly } from "@muse-code/sdk/dist/src/fold/session-fold.js";
import { MspError, type PendingApproval } from "@muse-code/sdk";
import type { MSP } from "./msp.js";

const allowed = new Set([
  "approved",
  "approvedForSession",
  "approvedPolicyAmendment",
]);
const denied = new Set(["denied", "deniedPolicyAmendment", "abort"]);
// Muse already settled or restaged the approval between fold and decide.
const benignDenyRaces = new Set([
  "approvalNotFound",
  "approvalAlreadyResolved",
  "approvalRequirementStale",
]);
type Approval = DeepReadonly<MSP.ApprovalRequestParams>;
export class PermissionBroker {
  private pending = new Map<
    string,
    { approval: Approval; signature: string; submitting: boolean }
  >();
  constructor(
    private sessionId: string,
    private emit: (event: ProviderEvent) => void,
  ) {}
  reconcile(approvals: readonly DeepReadonly<PendingApproval>[]) {
    const current = new Set<string>();
    for (const pending of approvals) {
      const approval: Approval = {
        ...pending.requested,
        ...pending.latestUpdate,
      };
      const id = `${approval.approvalId}:${approval.currentRequirementId.sourceIndex}`;
      current.add(id);
      const signature = JSON.stringify(approval);
      const previous = this.pending.get(id);
      if (previous?.signature === signature) continue;
      this.pending.set(id, { approval, signature, submitting: false });
      this.publish(id, approval);
    }
    for (const id of this.pending.keys())
      if (!current.has(id)) {
        this.pending.delete(id);
        this.emit({
          type: "session.permission_resolved",
          sessionId: this.sessionId,
          permissionId: id,
        });
      }
  }
  private publish(id: string, approval: Approval) {
    this.emit({
      type: "session.permission",
      sessionId: this.sessionId,
      request: {
        id,
        name: approval.toolName,
        kind: "tool",
        title: `Muse: ${approval.toolName}`,
        description:
          approval.subject.command ??
          approval.subject.path ??
          approval.subject.host ??
          `Permission for ${approval.subject.kind}`,
        input: {
          rawArgs: approval.rawArgs,
          subject: JSON.parse(JSON.stringify(approval.subject)),
        },
        actions: approval.availableChoices
          .filter(
            (c) =>
              allowed.has(String(c.decision)) || denied.has(String(c.decision)),
          )
          .map((c) => ({
            id: c.choiceId,
            label: c.rulePreview ? `${c.label}: ${c.rulePreview}` : c.label,
            behavior: allowed.has(String(c.decision)) ? "allow" : "deny",
          })),
      },
    });
  }
  async resolve(
    id: string,
    response: ProviderPermissionResponse,
    decide: (
      params: Omit<MSP.ApprovalDecideParams, "commandId" | "sessionId">,
    ) => Promise<unknown>,
  ) {
    const entry = this.pending.get(id);
    if (!entry)
      throw new Error("Permission expired or belongs to another session");
    if (entry.submitting) return;
    // An explicit selectedActionId must name an offered choice. Without one
    // (e.g. `paseo permit allow|deny`), fall back to the server-offered
    // once-scoped choice matching the behavior. Never widen scope (session,
    // persistent, policy amendment) or invent a choice Muse did not offer.
    const choice = response.selectedActionId
      ? entry.approval.availableChoices.find(
          (c) => c.choiceId === response.selectedActionId,
        )
      : entry.approval.availableChoices.find(
          (c) =>
            c.scope === "once" &&
            c.decision ===
              (response.behavior === "allow" ? "approved" : "denied"),
        );
    if (
      !choice ||
      (response.behavior === "allow"
        ? !allowed.has(String(choice.decision))
        : !denied.has(String(choice.decision)))
    )
      throw new Error("Select one of Muse’s offered permission choices");
    entry.submitting = true;
    try {
      await decide({
        approvalId: entry.approval.approvalId,
        choiceId: choice.choiceId,
        requirementId: { ...entry.approval.currentRequirementId },
        ...(response.behavior === "deny" &&
        choice.acceptsFeedback &&
        response.message
          ? { feedback: response.message }
          : {}),
      });
      // The ack is admission only. Resolution/update on the fold removes this UI.
    } catch (error) {
      entry.submitting = false;
      throw error;
    }
  }
  /**
   * Deny every pending approval with Muse's offered once-scoped denial. Used
   * when a human message supersedes the blocked step (clearPendingPermissions).
   * Approvals without such a choice are left alone; benign races where Muse
   * has already resolved or restaged the approval are ignored.
   */
  async denyAll(
    decide: (
      params: Omit<MSP.ApprovalDecideParams, "commandId" | "sessionId">,
    ) => Promise<unknown>,
  ) {
    let failure: unknown;
    for (const entry of this.pending.values()) {
      if (entry.submitting) continue;
      const choice = entry.approval.availableChoices.find(
        (c) => c.scope === "once" && c.decision === "denied",
      );
      if (!choice) continue;
      entry.submitting = true;
      try {
        await decide({
          approvalId: entry.approval.approvalId,
          choiceId: choice.choiceId,
          requirementId: { ...entry.approval.currentRequirementId },
          ...(choice.acceptsFeedback
            ? { feedback: "Superseded by a new user message" }
            : {}),
        });
      } catch (error) {
        entry.submitting = false;
        if (
          error instanceof MspError &&
          benignDenyRaces.has(String(error.kind))
        )
          continue;
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }
  clear() {
    for (const id of this.pending.keys())
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.sessionId,
        permissionId: id,
      });
    this.pending.clear();
  }
}
