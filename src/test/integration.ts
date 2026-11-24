import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { scanBraceFolds } from "../braceFolds";
import { BraceVisibility } from "../braceVisibility";

const FIXTURES = [
  { language: "c", text: "void run() {\n  work();\n}\nint next;", endLine: 2 },
  { language: "cpp", text: "void run()\n{\n  work();\n}\nint next;", endLine: 3 },
  { language: "rust", text: "fn run() {\n    work();\n}\nfn next() {}", endLine: 2 },
] as const;

export async function run(): Promise<void> {
  const sandbox = process.env.INLINE_BRACE_TEST_DIR;
  assert.ok(sandbox, "Run with npm run test:vscode in an isolated profile");
  try {
    const passed = await verifyFolding(sandbox);
    await writeFile(join(sandbox, "report.json"), JSON.stringify({ passed }));
  } catch (error) {
    await writeFile(join(sandbox, "report.json"), JSON.stringify({ error: String(error) }));
    throw error;
  }
}

async function verifyFolding(sandbox: string): Promise<string[]> {
  const extension = vscode.extensions.getExtension("flamekm.inline-brace-folding");
  assert.ok(extension);
  await extension.activate();

  const passed: string[] = [];
  const plaintext = vscode.workspace.getConfiguration("editor", { languageId: "plaintext" });
  assert.equal(plaintext.get("foldingHighlight"), true, "Other languages retain the native fold highlight");
  for (const { language, text, endLine } of FIXTURES) {
    const config = vscode.workspace.getConfiguration("editor", { languageId: language });
    assert.equal(config.get("foldingHighlight"), false, `[${language}] whole-line folding highlight is disabled`);
    const editor = await showDocument(language, text);
    await vscode.commands.executeCommand("editor.fold", { selectionLines: [0] });
    await waitForLineVisibility(editor, endLine + 1, true);
    await waitForLineVisibility(editor, endLine, false);
    await waitForLineVisibility(editor, 0, true);

    await vscode.commands.executeCommand("editor.unfold", { selectionLines: [0] });
    await waitForLineVisibility(editor, endLine, true);
    assert.equal(editor.document.getText(), text);
    passed.push(`PASS ${language}: native fold and unfold, no whole-line highlight, document unchanged`);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }

  const text = "void run() {\n  if (flag) {\n    work();\n  } else {\n    stop();\n  }\n}\nint next;";
  const editor = await showDocument("cpp", text);
  await vscode.commands.executeCommand("editor.fold", { selectionLines: [1, 3] });
  await waitForLineVisibility(editor, 2, false);
  await waitForLineVisibility(editor, 3, true);
  await waitForLineVisibility(editor, 5, false);
  await waitForLineVisibility(editor, 6, true);
  assert.equal(editor.document.getText(), text);
  passed.push("PASS C++: shared else line remains visible");
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

  for (const suffix of ["\n", ""]) {
    await verifyTerminalFold(suffix);
  }
  passed.push("PASS C++: both physical EOF and one final newline hide the closing row");
  await verifyAnyLanguage(extension.id);
  passed.push("PASS TypeScript, Python and plaintext: selected provider folds multiline parentheses and braces");
  await verifyDefaultProvider(extension.id);
  passed.push("PASS C++: the documented setting selects this provider when another provider matches");
  await verifyClangd(sandbox, extension.id);
  passed.push("PASS clangd adapter: local brackets win, comments and non-bracket if ranges remain");
  await verifyRustAnalyzer(sandbox, extension.id);
  passed.push("PASS rust-analyzer adapter: parentheses include the closing row, imports and refresh remain");
  return passed;
}

async function verifyTerminalFold(suffix: string): Promise<void> {
  const text = "int main() {\n  work();\n  return 0;\n}" + suffix;
  const editor = await showDocument("cpp", text);
  const closingLine = 3;
  const folds = scanBraceFolds(text, "cpp");
  const visibility = new BraceVisibility(folds, closingLine);
  assert.deepEqual(visibility.observe(editor.visibleRanges, false), []);
  let previews: ReturnType<BraceVisibility["observe"]> = [];
  const listener = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
    if (event.textEditor === editor) {
      previews = visibility.observe(event.visibleRanges, true);
    }
  });
  try {
    await vscode.commands.executeCommand("editor.fold", { selectionLines: [0] });
    await waitForLineVisibility(editor, closingLine, false);
    assert.deepEqual(previews, [folds.get(0)], "The terminal fold must show an inline preview");

    await vscode.commands.executeCommand("editor.unfold", { selectionLines: [0] });
    await waitForLineVisibility(editor, closingLine, true);
    assert.deepEqual(previews, [], "Unfolding must clear the inline preview");
    assert.equal(editor.document.getText(), text);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  } finally {
    listener.dispose();
  }
}

async function verifyAnyLanguage(extensionId: string): Promise<void> {
  for (const language of ["typescript", "python", "plaintext"]) {
    await withDefaultProvider(language, extensionId, async () => {
      const text = "call(\n  one,\n  two,\n)\nx = {\n  \"one\": 1\n}\nnext()";
      const editor = await showDocument(language, text);
      assert.deepEqual(await getRanges(editor.document), [[0, 3, undefined], [4, 6, undefined]]);
      await verifyNativeFold(editor, 0, 3);
      await verifyNativeFold(editor, 4, 6);
      assert.equal(editor.document.getText(), text);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    });
  }
}

async function verifyDefaultProvider(extensionId: string): Promise<void> {
  const fixture = vscode.extensions.getExtension("local.competing-folds");
  assert.ok(fixture, "The competing folding provider fixture was not loaded");
  await fixture.activate();

  const { language, text, endLine } = FIXTURES[1];
  const original = await showDocument(language, text);
  await vscode.commands.executeCommand("editor.fold", { selectionLines: [0] });
  await waitForLineVisibility(original, 1, false);
  await waitForLineVisibility(original, endLine, true);
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

  const config = vscode.workspace.getConfiguration("editor", { languageId: language });
  try {
    await config.update("defaultFoldingRangeProvider", extensionId, vscode.ConfigurationTarget.Global, true);
    const editor = await showDocument(language, text);
    await vscode.commands.executeCommand("editor.fold", { selectionLines: [0] });
    await waitForLineVisibility(editor, endLine + 1, true);
    await waitForLineVisibility(editor, endLine, false);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  } finally {
    await config.update("defaultFoldingRangeProvider", undefined, vscode.ConfigurationTarget.Global, true);
  }
}

async function verifyClangd(sandbox: string, extensionId: string): Promise<void> {
  const text = [
    "// first", "// second", "", "void run()", "{", "  if (flag &&", "      other)", "    work();", "}",
    "void local_only() {", "  work();", "}", "int next;",
  ].join("\n");
  await withDefaultProvider("cpp", extensionId, async () => {
    const editor = await showFile(sandbox, "provider.cpp", text);
    assert.deepEqual(await getRanges(editor.document), [
      [0, 1, vscode.FoldingRangeKind.Comment], [3, 8, undefined], [5, 6, undefined], [9, 11, undefined],
    ]);
    await verifyNativeFold(editor, 5, 6);
    await verifyNativeFold(editor, 3, 8);
    assert.equal(editor.document.getText(), text);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

    const empty = await showFile(sandbox, "empty.cpp", text);
    assert.deepEqual(await getRanges(empty.document), [[3, 8, undefined], [9, 11, undefined]],
      "An empty language result cannot remove bracket folds");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });
}

async function verifyRustAnalyzer(sandbox: string, extensionId: string): Promise<void> {
  const text = [
    "use foo;", "use bar;", "", "fn run() {", "    work(", "        first,", "        second,", "    );",
    "    let callback = || {", "        1", "    };", "}", "fn next() {}",
  ].join("\n");
  await withDefaultProvider("rust", extensionId, async () => {
    const editor = await showFile(sandbox, "provider.rs", text);
    assert.deepEqual(await getRanges(editor.document), [
      [0, 1, vscode.FoldingRangeKind.Imports], [3, 11, undefined], [4, 7, undefined], [8, 10, undefined],
    ]);
    await verifyNativeFold(editor, 4, 7);
    await verifyNativeFold(editor, 8, 10);

    const source = vscode.extensions.getExtension<ReturnType<typeof import("./languageProvider").activate>>(
      "rust-lang.rust-analyzer",
    );
    assert.ok(source?.isActive);
    source.exports.setRanges(editor.document.uri, [[5, 6]]);
    const deadlineMs = Date.now() + 4_000;
    do {
      await vscode.commands.executeCommand("editor.fold", { selectionLines: [5] });
      if (!isLineVisible(editor, 6)) {
        break;
      }
      await delay(20);
    } while (Date.now() < deadlineMs);
    assert.equal(isLineVisible(editor, 6), false, "Language provider refresh must add its new supplemental fold");
    assert.equal(isLineVisible(editor, 7), true, "The supplemental fold uses its original end");
    assert.equal(editor.document.getText(), text);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });
}

async function withDefaultProvider(language: string, extensionId: string, verify: () => Promise<void>): Promise<void> {
  const config = vscode.workspace.getConfiguration("editor", { languageId: language });
  try {
    await config.update("defaultFoldingRangeProvider", extensionId, vscode.ConfigurationTarget.Global, true);
    await verify();
  } finally {
    await config.update("defaultFoldingRangeProvider", undefined, vscode.ConfigurationTarget.Global, true);
  }
}

async function showFile(sandbox: string, name: string, text: string): Promise<vscode.TextEditor> {
  const path = join(sandbox, name);
  await writeFile(path, text);
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
  await waitForLineVisibility(editor, editor.document.lineCount - 1, true);
  return editor;
}

async function getRanges(document: vscode.TextDocument) {
  const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", document.uri);
  return ranges?.map(({ start, end, kind }) => [start, end, kind]);
}

async function verifyNativeFold(editor: vscode.TextEditor, startLine: number, endLine: number): Promise<void> {
  await vscode.commands.executeCommand("editor.fold", { selectionLines: [startLine] });
  await waitForLineVisibility(editor, endLine, false);
  await waitForLineVisibility(editor, endLine + 1, true);
  await vscode.commands.executeCommand("editor.unfold", { selectionLines: [startLine] });
  await waitForLineVisibility(editor, endLine, true);
}

async function showDocument(language: string, text: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language, content: text });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  await waitForLineVisibility(editor, document.lineCount - 1, true);
  const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
    "vscode.executeFoldingRangeProvider", document.uri,
  );
  assert.ok(ranges?.length, `No folding ranges for ${language}`);
  return editor;
}

async function waitForLineVisibility(
  editor: vscode.TextEditor,
  line: number,
  shouldBeVisible: boolean,
): Promise<void> {
  const deadlineMs = Date.now() + 4_000;
  do {
    if (isLineVisible(editor, line) === shouldBeVisible) {
      return;
    }
    await delay(20);
  } while (Date.now() < deadlineMs);
  assert.fail(`[${editor.document.languageId}] line ${line} visibility was not ${shouldBeVisible}`);
}

function isLineVisible(editor: vscode.TextEditor, line: number): boolean {
  return editor.visibleRanges.some(range => range.start.line <= line && line <= range.end.line);
}
