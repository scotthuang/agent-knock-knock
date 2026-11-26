import test from "node:test";
import assert from "node:assert/strict";
import { verifyDesktopMappedExecutables } from "../src/desktop-lsof.js";

const writer = { pid: 41, dev: 0x1an, ino: 701n };
const helper = { pid: 42, dev: 0x1an, ino: 702n };

test("each process can prove its mapped executable among other text mappings", () => {
  const output = [
    "p42", "ftxt", "D0x1a", "i702",
    "p41", "ftxt", "D0x1a", "i702", "ftxt", "D0x1a", "i701",
  ].join("\n");
  verifyDesktopMappedExecutables(output, [writer, helper]);
});

test("two processes using one executable must both have matching text mappings", () => {
  const expected = [writer, { ...writer, pid: helper.pid }];
  const firstProcess = "p41\nftxt\nD0x1a\ni701\n";
  assert.throws(() => verifyDesktopMappedExecutables(firstProcess, expected));
  verifyDesktopMappedExecutables(firstProcess + "p42\nftxt\nD0x1a\ni701\n", expected);
});

test("proof must come from one text mapping under its own process", () => {
  const mismatches = [
    ["wrong process", "p42\nftxt\nD0x1a\ni701\np41\nftxt\nD0x1a\ni702"],
    ["different mapped files", "p41\nftxt\nD0x1a\ni702\nftxt\nD0x1b\ni701"],
    ["ordinary file descriptor", "p41\nf7\nD0x1a\ni701"],
    ["incomplete text mapping", "p41\nftxt\nD0x1a"],
  ];
  for (const [reason, output] of mismatches) {
    assert.throws(() => verifyDesktopMappedExecutables(output, [writer]), reason);
  }
});
