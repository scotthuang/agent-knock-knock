import assert from "node:assert/strict";
import test from "node:test";
import { desktopFinalAnswer, desktopDisplayNotice } from "../src/desktop-final-answer.js";
import { projectDesktopAnswerItem } from "../src/desktop-snapshot-details.js";
import type { DesktopTurn, DesktopTurnItem } from "../src/desktop-types.js";

const final: DesktopTurnItem = { type: "agentMessage", id: "final", phase: "final_answer", text: "fixture reply" };
function project(moderation: unknown, originalRequester = true) {
  const turn: DesktopTurn = { status: "completed", turnId: "exact", itemsComplete: true, items: [
    { ...final, id: "progress", phase: "commentary", text: "progress only" },
    { ...final, id: "draft", phase: null, text: "older unphased message" },
    projectDesktopAnswerItem(final, moderation)
  ] };
  return desktopFinalAnswer(turn, originalRequester);
}

test("Desktop final results keep ordinary messages, and honor the native show audience and contact instruction", () => {
  for (const moderation of [undefined, null, { moderated: false, display: null }]) {
    assert.deepEqual(project(moderation, false), { final_text: "fixture reply" });
  }
  for (const trustedContacts of ["check", "skip"] as const) {
    const display = { version: 1, mode: "show", trustedContacts } as const;
    assert.deepEqual(project({ moderated: true, display }), { final_text: "fixture reply", final_text_display: [display],
      ...(trustedContacts === "check" ? { trusted_contacts_check_status: "not_performed_by_akk" } : {}) });
    assert.equal(project({ moderated: true, display }, false).final_text, "");
  }
});

test("Desktop hides the original and earlier unphased text when presentation requires the native client", () => {
  const cases = [
    [{ version: 1, mode: "hide", replacement: { kind: "wellbeingPromptHelpline" } }, "hide", /replacement/],
    [{ version: 1, mode: "block", reason: { kind: "protection", protectionType: "PRIVATE" } }, "block", /blocked/],
    [{ version: 1, mode: "block", reason: { kind: "cyber", trustedAccess: true } }, "block", /blocked/],
    [{ version: 1, mode: "show", trustedContacts: "check", annotation: { kind: "wellbeingHelpline", subject: "answer" } },
      "desktop_only", /annotation/],
    [null, "unsupported", /native presentation/],
    [{ version: 2, mode: "show", trustedContacts: "skip" }, "unsupported", /native presentation/],
    [{ version: 1, mode: "show", trustedContacts: "PRIVATE" }, "unsupported", /native presentation/],
    [{ version: 1, mode: "show", trustedContacts: "skip", extraRestriction: true }, "unsupported", /native presentation/],
    [{ version: 1, mode: "show", trustedContacts: "skip", annotation: { kind: "PRIVATE" } }, "unsupported", /native presentation/],
    [{ version: 1, mode: "hide", replacement: { kind: "PRIVATE" } }, "unsupported", /native presentation/]
  ] as const;
  for (const [display, mode, notice] of cases) {
    const result = project({ moderated: true, display });
    assert.equal(result.final_text, "");
    assert.equal(result.final_text_display?.[0].mode, mode);
    assert.match(desktopDisplayNotice(result.final_text_display!), notice);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|fixture reply|older unphased|progress only/);
  }
  assert.equal(project({ moderated: "false", display: null }).final_text, "");
});
