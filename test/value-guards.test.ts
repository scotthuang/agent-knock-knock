import test from "node:test";
import assert from "node:assert/strict";
import {
  isRecord,
  nonBlankString,
  recordValue
} from "../src/value-guards.js";

test("value guards preserve the shared record and string semantics", () => {
  const record = { value: 1 };
  assert.equal(isRecord(record), true);
  assert.equal(recordValue(record), record);
  for (const value of [null, undefined, [], "text", 1]) {
    assert.equal(isRecord(value), false);
    assert.equal(recordValue(value), undefined);
  }

  assert.equal(nonBlankString(" value "), " value ");
  for (const value of ["", "  ", null, 1]) {
    assert.equal(nonBlankString(value), undefined);
  }
});
