import type { DesktopFinalDisplay, DesktopTurn } from "./desktop-types.js";

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

export function desktopDisplayFields(displays?: DesktopFinalDisplay[]): {
  final_text_display?: DesktopFinalDisplay[]; trusted_contacts_check_status?: "not_performed_by_akk";
} {
  if (!displays?.length) return {};
  return { final_text_display: displays, ...(displays.some(display => "trustedContacts" in display && display.trustedContacts === "check")
    ? { trusted_contacts_check_status: "not_performed_by_akk" } : {}) };
}

export function desktopFinalAnswer(turn: DesktopTurn, originalRequester: boolean) {
  const messages = turn.items.filter(item => item.type === "agentMessage" && item.delivery !== "async" && !item.questions?.length);
  const finals = messages.filter(item => item.phase === "final_answer");
  // A directed or hidden final still takes precedence over older, unphased messages.
  const items = finals.length ? finals : messages.filter(item => item.phase == null && !item.answerDisplay);
  const text: string[] = [], displays: DesktopFinalDisplay[] = [];
  for (const item of items) {
    const display = item.answerDisplay;
    if (display) {
      const bound = originalRequester && turn.itemsComplete &&
        (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted");
      const visible: DesktopFinalDisplay = bound ? display : { mode: "desktop_only", reason: "original_requester_required" };
      displays.push(visible);
      if (visible.mode !== "show") continue;
    }
    if (item.text) text.push(item.text);
  }
  return { final_text: text.join("\n\n"), ...desktopDisplayFields(displays) };
}

/** Plain-text callbacks cannot run Chat's account features. Keep the native requirement visible with the result. */
export function desktopDisplayNotice(displays: readonly DesktopFinalDisplay[]): string {
  const notes = new Set<string>();
  for (const display of displays) {
    if ("trustedContacts" in display && display.trustedContacts === "check") {
      notes.add("Codex requested a trusted-contact check. AKK cannot perform or verify it; this reply is for the original requester.");
    }
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
