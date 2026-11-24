import assert from "node:assert/strict";
import { test } from "node:test";
import { scanBraceFolds } from "../braceFolds";

function scanLines(language: string, ...lines: string[]) {
  return scanBraceFolds(lines.join("\n"), language);
}

test("C, C++ and Rust include the closing line while preserving nested fold starts", () => {
  for (const language of ["c", "cpp", "rust"] as const) {
    const folds = scanLines(language, "outer {", "  inner {", "    work();", "  }", "}", "");
    assert.equal(folds.size, 2);
    assert.deepEqual(folds.get(0), { startLine: 0, endLine: 4, preview: { openingColumn: 6, closing: "}" } });
    assert.deepEqual(folds.get(1), { startLine: 1, endLine: 3, preview: { openingColumn: 8, closing: "}" } });
  }
});

test("an Allman function folds onto the header and keeps a struct's closing punctuation", () => {
  const allman = scanLines("cpp", "void run()", "{", "  work();", "}", "");
  assert.deepEqual(allman.get(0), {
    startLine: 0, endLine: 3, preview: { closing: "}" },
  });
  const aggregate = scanLines("cpp", "struct Value {", "  int count;", "} \t;", "");
  assert.equal(aggregate.get(0)?.preview?.closing, "};");
});

test("a standalone block is not attached to the preceding statement", () => {
  const folds = scanLines("c", "work();", "{", "  work();", "}", "");
  assert.equal(folds.has(0), false);
  assert.equal(folds.get(1)?.preview?.openingColumn, 0);
});

test("a shared else line stays visible and the else block can fold independently", () => {
  const folds = scanLines("rust", "if flag {", "  run();", "} else {", "  stop();", "}", "");
  assert.deepEqual(folds.get(0), { startLine: 0, endLine: 1 });
  assert.deepEqual(folds.get(2), { startLine: 2, endLine: 4, preview: { openingColumn: 7, closing: "}" } });
});

test("non-punctuation on a closing line is not moved or obscured", () => {
  for (const line of ["} while (running);", "} // keep this comment", "  run(); }", "}}"]) {
    const folds = scanLines("cpp", "do {", "  run();", line, "");
    assert.deepEqual(folds.get(0), { startLine: 0, endLine: 1 });
  }
});

test("the preview starts at the real opening brace and ignores trailing whitespace", () => {
  const header = 'if ready("📦 {") { \t';
  const folds = scanLines("rust", header, "  work();", "}", "");
  assert.equal(folds.get(0)?.preview?.openingColumn, header.lastIndexOf("{"));
});

test("comments or code after the opening brace do not become part of the preview", () => {
  for (const suffix of [" // keep this comment {", " /* } */", " work();"]) {
    const folds = scanLines("cpp", "void run() {" + suffix, "  work();", "}", "");
    assert.deepEqual(folds.get(0), { startLine: 0, endLine: 1 });
  }
});

test("a closing brace at physical EOF is included", () => {
  const folds = scanLines("c", "void run() {", "  work();", "}");
  assert.deepEqual(folds.get(0), { startLine: 0, endLine: 2, preview: { openingColumn: 11, closing: "}" } });
});

test("multiline parentheses fold through their closing line and preserve a semicolon", () => {
  const folds = scanLines("typescript", "run(", "  first,", "  second,", ");", "done();");
  assert.deepEqual([...folds.values()], [{
    startLine: 0, endLine: 3, preview: { openingColumn: 3, closing: ");" },
  }]);
});

test("a close sharing a line with an opening block stays visible", () => {
  const folds = scanLines("java", "if (", "  first &&", "  second", ") {", "  work();", "}", "");
  assert.deepEqual(folds.get(0), { startLine: 0, endLine: 2 });
  assert.deepEqual(folds.get(3), { startLine: 3, endLine: 5, preview: { openingColumn: 2, closing: "}" } });
});

test("Python ignores comments and triple-quoted strings but not floor division", () => {
  const folds = scanLines("python", 'text = """{(', "unmatched", '"""', "work( # (", "  x // (",
    "    2", "  )", ")", "done()");
  assert.deepEqual([...folds.values()], [
    { startLine: 4, endLine: 6, preview: { openingColumn: 7, closing: ")" } },
    { startLine: 3, endLine: 6 },
  ]);
});

test("mismatched delimiters are never treated as pairs", () => {
  assert.equal(scanLines("plaintext", "call(", "  value", "}").size, 0);
});

test("C treats comments, quoted delimiters and continued macros as non-code", () => {
  const folds = scanLines("c",
    'void run() {',
    '  char brace = \'{\'; const char *text = "\\"}";',
    '  /* } */ // { \\',
    '  }',
    '#define OPENING \\',
    '  { \\',
    '  {',
    '  work();',
    '}',
    '',
  );
  assert.deepEqual([...folds.values()], [{
    startLine: 0, endLine: 8, preview: { openingColumn: 11, closing: "}" },
  }]);
});

test("C++ ignores braces inside a block comment that starts in a directive", () => {
  const folds = scanLines("cpp", "#define VALUE /*", "{", "not code", "}", "*/ 42", "int next;");
  assert.equal(folds.size, 0);
});

test("C treats a leading comment before a conditional directive as whitespace", () => {
  const folds = scanLines("c", "/* feature */ #if FIRST", "void first() {",
    "#else", "void second() {", "#endif", "  work();", "}", "");
  assert.equal(folds.size, 0);
});

test("C++ ignores braces in custom-delimited raw strings and parses digit separators", () => {
  const folds = scanLines("cpp",
    'void run() {',
    '  auto text = u8R"tag(',
    '  }" {',
    '  )tag";',
    "  auto number = 1'024;",
    '}',
    '',
  );
  assert.deepEqual([...folds.values()], [{
    startLine: 0, endLine: 5, preview: { openingColumn: 11, closing: "}" },
  }]);
});

test("Rust distinguishes lifetimes, quoted braces, raw strings and nested comments", () => {
  const folds = scanLines("rust",
    "fn run<'a>(input: &'a str) {",
    "  let brace = '\\u{007D}';",
    '  let text = br###"',
    '  }"# {',
    '  "###;',
    '  /* { /* nested */ }',
    '     } */',
    '  let closure = |value| {',
    '    value',
    '  };',
    '}',
    '',
  );
  assert.equal(folds.size, 2);
  assert.equal(folds.get(0)?.endLine, 10);
  assert.deepEqual(folds.get(7), { startLine: 7, endLine: 9, preview: { openingColumn: 24, closing: "};" } });
});

test("C preprocessor branches do not pair braces across alternatives", () => {
  const folds = scanLines("c",
    "#if FIRST",
    "void first() {",
    "#else",
    "void second() {",
    "#endif",
    "  work();",
    "}",
    "void third() {",
    "#if FLAG",
    "  if (flag) {",
    "    work();",
    "  }",
    "#endif",
    "}",
    "",
  );
  assert.equal(folds.size, 2);
  assert.equal(folds.get(7)?.endLine, 13);
  assert.equal(folds.get(9)?.endLine, 11);
});

test("single-line blocks and unclosed braces do not create folding ranges", () => {
  const folds = scanLines("c", "void run() {", "  if (flag) { run(); }", "  work();", "");
  assert.equal(folds.size, 0);
});

