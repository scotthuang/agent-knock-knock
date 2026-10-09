import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopConversationId, parseDesktopConversationId } from "../src/desktop-identity.js";

test("Desktop identity round-trips and separates homes, hosts and exact thread UUIDs", () => {
  const identity = { codexHome: "/fixture/codex", hostId: "local", threadId: "00000000-0000-7000-8000-000000000001" };
  const id = createDesktopConversationId(identity);
  assert.deepEqual(parseDesktopConversationId(id), identity);
  assert.equal(createDesktopConversationId({ ...identity, codexHome: "/fixture/./codex" }), id);
  for (const changed of [{ ...identity, codexHome: "/other/codex" }, { ...identity, hostId: "remote" },
    { ...identity, threadId: "00000000-0000-7000-8000-000000000002" }]) {
    assert.notEqual(createDesktopConversationId(changed), id);
  }
});

test("Desktop selectors reject malformed and noncanonical payloads before native lookup", () => {
  const encode = (value: unknown) => "desktop:v1:" + Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const value of ["terminal:v2:codex", "desktop:v1:%%%", encode(["relative", "local", "thread"]),
    encode(["/fixture/../codex", "local", "thread"]), encode(["/codex", "local", ""]),
    encode(["/codex", "invalid host", "thread"]), encode(["/codex\u0000", "local", "thread"]),
    encode(["/codex", "local", "thread", "extra"]), encode(["/codex", "local", "thread"]) + "="] ) {
    assert.throws(() => parseDesktopConversationId(value));
  }
});
