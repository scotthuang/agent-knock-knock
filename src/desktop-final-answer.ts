import type { DesktopTaskRecord } from "./desktop-state-store.js";
import type { DesktopFinalDisplay, DesktopThreadIdentity, DesktopTurn } from "./desktop-types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function showDisplay(display: Record<string, unknown>): DesktopFinalDisplay {
  const { trustedContacts, annotation } = display;
  if (!only(display, ["version", "mode", "trustedContacts", "annotation"]) ||
    (trustedContacts !== "check" && trustedContacts !== "skip")) return { mode: "unsupported" };
  if (!Object.hasOwn(display, "annotation")) return { version: 1, mode: "show", trustedContacts };
  if (record(annotation) && only(annotation, ["kind", "subject"]) && annotation.kind === "wellbeingHelpline" &&
    (annotation.subject === "prompt" || annotation.subject === "answer")) {
    return { version: 1, mode: "desktop_only", reason: "wellbeingHelpline", subject: annotation.subject, trustedContacts };
  }
  return { mode: "unsupported" };
}

function blockDisplay(display: Record<string, unknown>): DesktopFinalDisplay {
  const reason = display.reason;
  if (!only(display, ["version", "mode", "reason"]) || !record(reason)) return { mode: "unsupported" };
  if (reason.kind === "protection" && only(reason, ["kind", "protectionType"]) && typeof reason.protectionType === "string") {
    return { version: 1, mode: "block", reason: "protection" };
  }
  if (reason.kind === "cyber" && only(reason, ["kind", "trustedAccess"]) &&
    (!Object.hasOwn(reason, "trustedAccess") || typeof reason.trustedAccess === "boolean")) {
    return { version: 1, mode: "block", reason: "cyber" };
  }
  return { mode: "unsupported" };
}

/** Interpret the recovered-answer contract only. Ordinary commentary and interaction prompts have separate rules. */
export function desktopAnswerDisplay(moderation: unknown): DesktopFinalDisplay | undefined {
  if (moderation == null) return undefined;
  if (!record(moderation) || typeof moderation.moderated !== "boolean" || !only(moderation, ["moderated", "display"])) {
    return { mode: "unsupported" };
  }
  const display = moderation.display;
  if (display === null && !moderation.moderated) return undefined;
  if (!record(display) || display.version !== 1) return { mode: "unsupported" };
  if (display.mode === "show") return showDisplay(display);
  if (display.mode === "block") return blockDisplay(display);
  if (display.mode === "hide" && only(display, ["version", "mode", "replacement"]) && record(display.replacement) &&
    only(display.replacement, ["kind"]) && display.replacement.kind === "wellbeingPromptHelpline") {
    return { version: 1, mode: "hide", replacement: "wellbeingPromptHelpline" };
  }
  return { mode: "unsupported" };
}

function requiresContactCheck(display: DesktopFinalDisplay): boolean {
  return "trustedContacts" in display && display.trustedContacts === "check";
}

export function desktopRequiresContactCheck(displays?: readonly DesktopFinalDisplay[]): boolean {
  return displays?.some(requiresContactCheck) ?? false;
}

function desktopThreadUrl(target?: DesktopThreadIdentity): string | undefined {
  // The deep-link scheme takes only a local native thread UUID, not a host, path or turn selector.
  if (target?.hostId === "local" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(target.threadId)) {
    return `codex://threads/${target.threadId}`;
  }
  return undefined;
}

export function desktopDisplayFields(displays?: DesktopFinalDisplay[], target?: DesktopThreadIdentity): {
  final_text_display?: DesktopFinalDisplay[]; trusted_contacts_check_status?: "not_performed_by_akk";
  final_text_notice?: string; desktop_url?: string;
} {
  if (!displays?.length) return {};
  if (!desktopRequiresContactCheck(displays)) return { final_text_display: displays };
  const url = desktopThreadUrl(target);
  return { final_text_display: displays, trusted_contacts_check_status: "not_performed_by_akk",
    final_text_notice: desktopDisplayNotice(displays, target), ...(url ? { desktop_url: url } : {}) };
}

export function desktopFinalAnswer(turn: DesktopTurn, originalRequester: boolean, target?: DesktopThreadIdentity) {
  const messages = turn.items.filter(item => item.type === "agentMessage" && item.delivery !== "async" && !item.questions?.length);
  const finals = messages.filter(item => item.phase === "final_answer");
  // A directed or hidden final still takes precedence over older, unphased messages.
  const items = finals.length ? finals : messages.filter(item => item.phase == null && !item.answerDisplay);
  const bound = originalRequester && turn.itemsComplete &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted");
  if (!bound && items.some(item => item.answerDisplay)) {
    return { final_text: "", ...desktopDisplayFields([{ mode: "desktop_only", reason: "original_requester_required" }]) };
  }
  const text: string[] = [], displays: DesktopFinalDisplay[] = [];
  for (const item of items) {
    const display = item.answerDisplay;
    if (display) {
      displays.push(display.mode === "show" && display.trustedContacts === "check" && (item.hasDesktopAnswer || item.text?.trim())
        ? { ...display, hasAnswer: true } : display);
      if (display.mode !== "show") continue;
    }
    if (item.text) text.push(item.text);
  }
  return { final_text: text.join("\n\n"), ...desktopDisplayFields(displays, target) };
}

/** Preserve the native contact instruction in plain text as well as structured receipts. */
export function desktopDisplayNotice(displays: readonly DesktopFinalDisplay[], target?: DesktopThreadIdentity): string {
  const notes = new Set<string>();
  if (desktopRequiresContactCheck(displays)) {
    notes.add("Codex 要求检查可信联系人，AKK 未执行或核实这项检查。");
    const url = desktopThreadUrl(target);
    notes.add(`Open the original conversation in Codex Desktop${url ? `: ${url}` : "."}`);
  }
  for (const display of displays) {
    switch (display.mode) {
      case "hide": notes.add("Open Codex Desktop to view the native replacement and support resources."); break;
      case "block": notes.add("Codex blocked display of this answer."); break;
      case "desktop_only":
        notes.add(display.reason === "wellbeingHelpline" ? "Open Codex Desktop for this answer with its required support annotation."
          : "This answer is available to the original requester through its exact task.");
        break;
      case "unsupported": notes.add("Open Codex Desktop to view this answer with its native presentation."); break;
    }
  }
  return [...notes].join("\n");
}

/** Legacy outboxes may be the only copy of the directive. Their preformatted body cannot safely be split. */
export function desktopCachedCheckDisplays(task: DesktopTaskRecord): DesktopFinalDisplay[] | undefined {
  const recorded = task.final_text_display;
  if (desktopRequiresContactCheck(recorded)) return recorded;
  const settled = task.notifications.find(note => note.id === `${task.id}:settled` && note.envelope.event.type === "desktop_watch.settled");
  const metadata = settled?.envelope.event.metadata;
  const cached = metadata?.final_text_display;
  if (metadata?.trusted_contacts_check_status !== "not_performed_by_akk" &&
      !(Array.isArray(cached) && cached.some(display => display?.trustedContacts === "check"))) return undefined;
  // A later exact read may give a stronger native restriction. Retain it without falling back to cached text.
  if (recorded?.some(display => display.mode !== "show")) return recorded;
  return [{ version: 1, mode: "show", trustedContacts: "check" }];
}
