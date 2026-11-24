import assert from "node:assert/strict";
import { test } from "node:test";
import { scanBraceFolds } from "../braceFolds";
import { mergeFoldRanges } from "../foldAdaptation";

test("brackets win over shorter same-line ranges even when the engine reports nothing", () => {
  const brackets = scanBraceFolds("run(\n  work()\n);\nint next;", "cpp");
  for (const source of [[], [{ start: 0, end: 1 }]]) {
    assert.deepEqual(mergeFoldRanges(brackets, source, 4), [{ start: 0, end: 2 }]);
  }
});

test("the source's duplicate Allman range is replaced by the local header range", () => {
  const brackets = scanBraceFolds("void run()\n{\n  work();\n}\nint next;", "cpp");
  assert.deepEqual(mergeFoldRanges(brackets, [{ start: 1, end: 2 }], 5), [{ start: 0, end: 3 }]);
});

test("non-conflicting language ranges preserve boundaries and kinds", () => {
  const brackets = scanBraceFolds("void run() {\n// one\n// two\n}\n\n// three\n// four", "cpp");
  const inside = { start: 1, end: 2, kind: 1 };
  const after = { start: 5, end: 6, kind: 1 };
  const merged = mergeFoldRanges(brackets, [inside, after], 7);
  assert.deepEqual(merged, [{ start: 0, end: 3 }, inside, after]);
  assert.equal(merged[1], inside);
  assert.equal(merged[2], after);
});

test("crossing and same-line supplemental ranges cannot displace local brackets", () => {
  const brackets = scanBraceFolds("\n\nrun(\n  work()\n);\nnext();\n", "javascript");
  const local = { start: 2, end: 4 };
  for (const crossing of [{ start: 1, end: 2 }, { start: 1, end: 3 }, { start: 3, end: 5 }, { start: 4, end: 5 }]) {
    assert.deepEqual(mergeFoldRanges(brackets, [crossing], 7), [local]);
  }
  const enclosing = { start: 1, end: 4 };
  const nested = { start: 3, end: 4 };
  assert.deepEqual(mergeFoldRanges(brackets, [nested, enclosing], 7), [enclosing, local, nested]);
});

test("invalid supplemental ranges are ignored", () => {
  assert.deepEqual(mergeFoldRanges(new Map(), [{ start: -1, end: 1 }, { start: 2, end: 2 }, { start: 1, end: 4 }], 4), []);
});
