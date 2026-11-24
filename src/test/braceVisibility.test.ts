import assert from "node:assert/strict";
import { test } from "node:test";
import { scanBraceFolds } from "../braceFolds";
import { BraceVisibility, type VisibleRange } from "../braceVisibility";

function visible(startLine: number, endLine: number, startCharacter = 0): VisibleRange {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: 12 } };
}

function tailFixture(suffix = "\n") {
  const header = "\nint main() {\n";
  const text = header + "  work();\n".repeat(34) + "}" + suffix;
  const folds = scanBraceFolds(text, "cpp");
  const terminalFold = folds.get(1);
  assert.ok(terminalFold);
  return { terminalFold, tracker: new BraceVisibility(folds, text.trimEnd().split("\n").length - 1) };
}

test("an exact visible gap shows the brace; other gaps show dots without a brace", () => {
  const folds = scanBraceFolds("void run() {\n  work();\n}\n\nint value;", "c");
  const tracker = new BraceVisibility(folds);
  const opener = visible(0, 0);
  assert.deepEqual(tracker.observe([opener, visible(3, 4)], true), [folds.get(0)]);
  assert.deepEqual(tracker.observe([opener], true), []);
  assert.deepEqual(tracker.observe([opener, visible(2, 4)], true), [{ startLine: 0, endLine: 1 }]);
  assert.deepEqual(tracker.observe([opener, visible(4, 4)], true), [{ startLine: 0, endLine: 3 }]);
  assert.deepEqual(tracker.observe([opener, visible(1, 4)], true), []);
  assert.deepEqual(tracker.observe([visible(0, 4)], true), []);
});

test("folding before the sole empty final line can omit the visible suffix", () => {
  const { terminalFold, tracker } = tailFixture();
  const open = [visible(0, 28)];
  const closed = [visible(0, 1)];
  assert.deepEqual(tracker.observe(open, false), []);
  assert.deepEqual(tracker.observe(closed, true), [terminalFold]);
  assert.deepEqual(tracker.observe([visible(1, 1)], true), [terminalFold]);
  assert.deepEqual(tracker.observe(closed, false), [terminalFold]);
  assert.deepEqual(tracker.observe(open, true), []);
});

test("folding at physical EOF without a newline shows the closing delimiter", () => {
  const { terminalFold, tracker } = tailFixture("");
  assert.deepEqual(tracker.observe([visible(0, 36)], false), []);
  assert.deepEqual(tracker.observe([visible(0, 1)], true), [terminalFold]);
  assert.deepEqual(tracker.observe([visible(0, 36)], true), []);
});

test("a tail opener at the viewport edge does not by itself imply folding", () => {
  const { tracker } = tailFixture();
  assert.deepEqual(tracker.observe([visible(0, 1)], true), []);
  assert.deepEqual(tracker.observe([visible(1, 28)], true), []);
  assert.deepEqual(tracker.observe([visible(0, 1)], true), []);
  assert.deepEqual(tracker.observe([visible(0, 28, 4)], true), []);
  assert.deepEqual(tracker.observe([visible(0, 1)], true), []);
});

test("unfolding an earlier block cannot be mistaken for folding the final block", () => {
  const text = "void earlier() {\n  work();\n}\nint main() {\n  work();\n  return 0;\n}\n";
  const folds = scanBraceFolds(text, "cpp");
  const tracker = new BraceVisibility(folds, 6);
  assert.deepEqual(tracker.observe([visible(0, 0), visible(3, 7)], false), [folds.get(0)]);
  assert.deepEqual(tracker.observe([visible(0, 3)], true), []);
});

test("a terminal K&R opener cropped before its brace is not eligible", () => {
  const { tracker } = tailFixture();
  assert.deepEqual(tracker.observe([visible(0, 28)], false), []);
  assert.deepEqual(tracker.observe([{ start: { line: 0, character: 0 }, end: { line: 1, character: 8 } }], true), []);
});

test("an ordinary redraw does not infer a terminal fold from an old viewport", () => {
  const { tracker } = tailFixture();
  assert.deepEqual(tracker.observe([visible(0, 28)], true), []);
  assert.deepEqual(tracker.observe([visible(0, 1)], false), []);
  assert.deepEqual(tracker.observe([visible(0, 1)], true), []);
});

test("a shorter native fold does not hide the actual closing brace", () => {
  const { tracker } = tailFixture();
  assert.deepEqual(tracker.observe([visible(0, 28)], false), []);
  assert.deepEqual(tracker.observe([visible(0, 1), visible(36, 36)], true), [{ startLine: 1, endLine: 35 }]);
});

test("a provider's terminal non-brace range can show dots with no visible suffix", () => {
  const tracker = new BraceVisibility(new Map(), 5);
  const fold = { startLine: 2, endLine: 5 };
  const ranges = new Map([[2, fold]]);
  assert.deepEqual(tracker.observe([visible(0, 5)], false, ranges), []);
  assert.deepEqual(tracker.observe([visible(0, 2)], true, ranges), [fold]);
  assert.deepEqual(tracker.observe([visible(0, 5)], true, ranges), []);
});

test("the trailing-gap fallback is not applied to blocks away from the final empty line", () => {
  const { tracker } = tailFixture("\nint next;");
  const folds = scanBraceFolds("int main() {\n  work();\n}\nint next;\n", "cpp");
  const interiorTracker = new BraceVisibility(folds, 3);
  assert.deepEqual(tracker.observe([visible(0, 28)], false), []);
  assert.deepEqual(tracker.observe([visible(0, 1)], true), []);
  assert.deepEqual(interiorTracker.observe([visible(0, 4)], false), []);
  assert.deepEqual(interiorTracker.observe([visible(0, 0)], true), []);
});
