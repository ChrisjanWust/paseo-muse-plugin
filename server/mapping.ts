import type {
  ProviderContent,
  ProviderModel,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { SessionFoldView } from "@muse-code/sdk";
import type { DeepReadonly } from "@muse-code/sdk/dist/src/fold/session-fold.js";
import type { MSP } from "./msp.js";

export function modelCatalog(result: MSP.ModelListResult): ProviderModel[] {
  return result.models.map((m) => ({
    id: m.modelId,
    label: m.displayLabel,
    description: m.description ?? undefined,
    isDefault: m.isDefault,
    contextWindowMaxTokens: m.contextLimit ?? undefined,
    metadata: { providerId: m.providerId, catalogSource: result.source },
  }));
}
export function toMuseInput(content: ProviderContent[]): MSP.TurnInputPart[] {
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(part.mimeType))
        throw new Error(`Unsupported image type: ${part.mimeType}`);
      if (
        !part.data ||
        part.data.length > 28_000_000 ||
        part.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)
      )
        throw new Error("Image must contain valid base64 (maximum 21MB)");
      return { type: "image", mediaType: part.mimeType, base64Data: part.data };
    }
    if (part.type === "uploaded_file")
      throw new Error(
        "Muse MSP has no file attachment input. Paste text or ask Muse to read a workspace-relative file.",
      );
    // These are user-supplied context objects, not instructions or filesystem reads.
    return {
      type: "text",
      text: `Attached ${part.type} context:\n${JSON.stringify(part, null, 2)}`,
    };
  });
}
export function displayText(content: ProviderContent[]): string {
  return content
    .map((p) =>
      p.type === "text"
        ? p.text
        : p.type === "image"
          ? "[Image]"
          : `[${p.type} attachment]`,
    )
    .join("\n");
}
function argsOf(item: DeepReadonly<MSP.Item>): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(item.args ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
export function toolDetail(
  item: DeepReadonly<MSP.Item>,
  output: string,
): ProviderToolCallDetail {
  const args = argsOf(item);
  const str = (...keys: string[]) =>
    keys.map((k) => args[k]).find((v): v is string => typeof v === "string");
  const tool = (item.tool ?? "").toLowerCase();
  if (item.kind === "subagent" || item.kind === "reminderChild")
    return {
      type: "sub_agent",
      description: item.objective ?? item.fallbackText,
      subAgentType: item.role,
      log: item.result ? JSON.stringify(item.result) : output,
    };
  if (
    item.kind === "userShell" ||
    /^(shell|bash|exec_command|run_command)$/.test(tool)
  )
    return {
      type: "shell",
      command: item.commandText ?? str("command", "cmd") ?? item.args ?? "",
      output,
      exitCode: item.exitCode,
    };
  const filePath = str("file_path", "filePath", "path");
  if (/^(read|read_file|view_file)$/.test(tool) && filePath)
    return { type: "read", filePath, content: output };
  if (/^(edit|edit_file|str_replace)$/.test(tool) && filePath)
    return {
      type: "edit",
      filePath,
      oldString: str("old_string", "oldString", "old_str"),
      newString: str("new_string", "newString", "new_str"),
    };
  if (/^(write|write_file|create_file)$/.test(tool) && filePath)
    return { type: "write", filePath, content: str("content", "text") };
  if (/^(search|grep|glob|web_search)$/.test(tool))
    return {
      type: "search",
      query: str("query", "pattern") ?? "",
      content: output,
    };
  return { type: "unknown", input: item.args ?? null, output };
}
export function projectItem(
  item: DeepReadonly<MSP.Item>,
  fold: SessionFoldView,
  museSessionId: string,
  clientMessageId?: string,
): ProviderTimelineItem {
  const id =
    item.kind === "userMessage" && item.commandId
      ? `muse:${museSessionId}:user:${item.commandId}`
      : `muse:${museSessionId}:${item.itemId}`;
  const streamed = (field: string, fallback: string) =>
    item.status === "inProgress"
      ? (fold.items.accumulated(item.itemId, field) ?? fallback)
      : fallback;
  switch (item.kind) {
    case "userMessage":
      return {
        id,
        type: "user_message",
        text: item.displayText ?? item.text ?? "",
        clientMessageId,
      };
    case "agentMessage":
      return {
        id,
        type: "assistant_message",
        text: streamed("text", item.text ?? ""),
      };
    case "reasoning": {
      const indices = new Set((item.summary ?? []).map((_, i) => i));
      for (const f of fold.items.accumulatedFields(item.itemId))
        if (/^summary\.\d+$/.test(f)) indices.add(Number(f.slice(8)));
      return {
        id,
        type: "reasoning",
        text:
          [...indices]
            .sort((a, b) => a - b)
            .map((i) => streamed(`summary.${i}`, item.summary?.[i] ?? ""))
            .join("\n") ||
          item.text ||
          "",
      };
    }
    case "compaction":
      return {
        id,
        type: "compaction",
        status: item.status === "inProgress" ? "loading" : "completed",
        preTokens: item.tokensBefore,
      };
    case "toolCall":
    case "userShell":
    case "subagent":
    case "reminderChild": {
      const failed = !["inProgress", "completed", "cancelled"].includes(
        String(item.status),
      );
      return {
        id,
        type: "tool_call",
        callId: item.callId ?? item.itemId,
        name: item.tool ?? String(item.kind),
        detail: toolDetail(item, streamed("output", item.visibleOutput ?? "")),
        metadata: {
          museItemKind: item.kind,
          ...(item.subagentId ? { subagentId: item.subagentId } : {}),
        },
        ...(failed
          ? {
              status: "failed",
              error: item.failureReason ?? `Muse tool status: ${item.status}`,
            }
          : {
              status:
                item.status === "inProgress"
                  ? "running"
                  : item.status === "cancelled"
                    ? "canceled"
                    : "completed",
              error: null,
            }),
      };
    }
    default:
      return {
        id,
        type: "notification",
        level: "info",
        message: `${item.kind} (${item.status}): ${item.fallbackText ?? item.message ?? ""}`,
      };
  }
}
