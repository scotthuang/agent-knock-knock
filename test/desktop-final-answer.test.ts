import assert from "node:assert/strict";
import test from "node:test";
import { desktopFinalAnswer, desktopDisplayNotice } from "../src/desktop-final-answer.js";
import { projectDesktopAnswerItem } from "../src/desktop-snapshot-details.js";
import type { DesktopTurn, DesktopTurnItem } from "../src/desktop-types.js";

const final: DesktopTurnItem = { type: "agentMessage", id: "final", phase: "final_answer", text: "fixture reply" };
const target = { hostId: "local", codexHome: "/fixture", threadId: "01234567-abcd-4321-9876-0123456789ab" };
function project(moderation: unknown) {
  const turn: DesktopTurn = { status: "completed", turnId: "exact", itemsComplete: true, items: [
    { ...final, id: "progress", phase: "commentary", text: "progress only" },
    { ...final, id: "draft", phase: null, text: "older unphased message" },
    projectDesktopAnswerItem(final, moderation)
  ] };
  return desktopFinalAnswer(turn, target);
}

test("Desktop final results keep ordinary messages, and honor the native show and contact instructions on explicit local reads", () => {
  for (const moderation of [undefined, null, { moderated: false, display: null }]) {
    assert.deepEqual(project(moderation), { final_text: "fixture reply" });
  }
  const skip = { version: 1, mode: "show", trustedContacts: "skip" } as const;
  assert.deepEqual(project({ moderated: true, display: skip }), { final_text: "fixture reply", final_text_display: [skip] });
});

test("a checked Desktop answer returns visible parts and the contact notice on a completed native turn", () => {
  const display = { version: 1, mode: "show", trustedContacts: "check" } as const;
  const result = project({ moderated: true, display });
  assert.equal(result.final_text, "fixture reply");
  assert.equal(result.desktop_url, `codex://threads/${target.threadId}`);
  assert.match(result.final_text_notice!, /Codex 要求检查可信联系人，AKK 未执行或核实这项检查。/u);
  assert.ok(result.final_text_notice!.includes(result.desktop_url!));
  assert.deepEqual(result.final_text_display, [{ ...display, hasAnswer: true }]);
  assert.equal(result.trusted_contacts_check_status, "not_performed_by_akk");
  const turn: DesktopTurn = { status: "completed", turnId: "turn", itemsComplete: true, items: [
    { ...final, answerDisplay: display }, { ...final, id: "sibling", text: "sibling fragment" },
    { ...final, id: "hidden", text: "PRIVATE segment", answerDisplay: { version: 1, mode: "block", reason: "protection" } }
  ] };
  const mixed = desktopFinalAnswer(turn, target);
  assert.equal(mixed.final_text, "fixture reply\n\nsibling fragment");
  assert.doesNotMatch(JSON.stringify(mixed), /PRIVATE/);
  for (const partial of [{ ...turn, itemsComplete: false }, { ...turn, status: "inProgress" as const }]) {
    assert.deepEqual(desktopFinalAnswer(partial, target), { final_text: "" });
  }
  for (const invalidTarget of [{ ...target, hostId: "remote" }, { ...target, threadId: target.threadId + "?override=1" }]) {
    assert.doesNotMatch(JSON.stringify(desktopFinalAnswer(turn, invalidTarget)), /codex:\/\//);
  }
  const empty = desktopFinalAnswer({ ...turn, items: [{ ...final, text: " ", answerDisplay: display }] }, target);
  assert.equal(empty.desktop_url, result.desktop_url);
  assert.equal(empty.final_text.trim(), "");
  assert.deepEqual(empty.final_text_display, [display]);
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
