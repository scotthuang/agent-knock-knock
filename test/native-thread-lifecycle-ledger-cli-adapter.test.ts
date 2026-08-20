import test from "node:test";
import assert from "node:assert/strict";

import {
  createNativeThreadLifecycleLedgerCliAdapter
} from "../src/native-thread-lifecycle-ledger-cli-adapter.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";
import type { TerminalDispatchLedgerDocument } from
  "../src/terminal-dispatch-ledger-codec.js";

const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "akk:0.0",
  session: "akk",
  window: 0,
  pane: 0,
  panePid: 42,
  capabilities: ["send_keys"]
};

const lifecycle = (
  status: string = "prepared"
): TerminalDispatchLedgerDocument => ({
  kind: "lifecycle",
  generation_id: "transition-1",
  transition_id: "transition-1",
  status
});

function fixture(current?: TerminalDispatchLedgerDocument) {
  const events: string[] = [];
  let saved: TerminalDispatchLedgerDocument | undefined;
  const adapter = createNativeThreadLifecycleLedgerCliAdapter({
    repository: {
      load: () => {
        events.push("load");
        return current;
      },
      save: (_control, value) => {
        events.push("save");
        saved = value;
      }
    },
    authority: {
      ordinaryOwnerIsReleased: () => {
        events.push("owner");
        return true;
      }
    }
  });
  return { adapter, events, saved: () => saved };
}

test("lifecycle prepare preserves load-owner-save order and exact document", () => {
  const subject = fixture({ kind: "turn", status: "submitted" });
  const next = lifecycle();
  subject.adapter.save(CONTROL, next, { expectedTransitionId: null });
  assert.deepEqual(subject.events, ["load", "owner", "save"]);
  assert.equal(subject.saved(), next);
});

test("lifecycle CAS keeps lifecycle and status failures ahead of persistence", () => {
  const occupied = fixture(lifecycle("submitted"));
  assert.throws(
    () => occupied.adapter.save(CONTROL, lifecycle(), {
      expectedTransitionId: null
    }),
    /dispatch generation changed before lifecycle prepare/u
  );
  assert.deepEqual(occupied.events, ["load"]);

  const stale = fixture(lifecycle("verified"));
  assert.throws(
    () => stale.adapter.save(CONTROL, lifecycle("resolved"), {
      expectedTransitionId: "transition-1",
      expectedStatus: "submitted"
    }),
    /lifecycle status changed from submitted to verified/u
  );
  assert.deepEqual(stale.events, ["load"]);
});

test("invalid identity performs no getter and repository errors propagate", () => {
  const invalid = fixture();
  assert.throws(
    () => invalid.adapter.save(CONTROL, {
      kind: "lifecycle",
      generation_id: "left",
      transition_id: "right"
    }, { expectedTransitionId: null }),
    /requires one transition identity/u
  );
  assert.deepEqual(invalid.events, []);

  const failure = new Error("durable write failed");
  const adapter = createNativeThreadLifecycleLedgerCliAdapter({
    repository: {
      load: () => undefined,
      save: () => { throw failure; }
    },
    authority: { ordinaryOwnerIsReleased: () => false }
  });
  assert.throws(
    () => adapter.save(CONTROL, lifecycle(), {
      expectedTransitionId: null
    }),
    (error) => error === failure
  );
});
