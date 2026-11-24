import * as vscode from "vscode";
import { scanBraceFolds, type BraceFold } from "./braceFolds";
import { BraceVisibility } from "./braceVisibility";
import { mergeFoldRanges } from "./foldAdaptation";
import { LanguageFoldingSources } from "./languageFolding";

const LEGACY_LANGUAGES = new Set(["c", "cpp", "rust"]);
const PROVIDER_SETTING = "editor.defaultFoldingRangeProvider";
const NATIVE_PLACEHOLDER_WIDTH = "calc(1ch + 0.5em)";
const NATIVE_ELLIPSIS_INSET = "0.2em";
const BRACE_WIDTH = "1ch";
const PLACEHOLDER_FOREGROUND = new vscode.ThemeColor("editor.foreground");
const PLACEHOLDER_BACKGROUND = new vscode.ThemeColor("inlineBraceFolding.placeholderBackground");

interface FoldSnapshot {
  readonly version: number;
  readonly language: string;
  readonly folds: ReadonlyMap<number, BraceFold>;
  readonly lastContentLine: number;
  tailFolds?: ReadonlyMap<number, BraceFold>;
}

interface EditorVisibility {
  readonly snapshot: FoldSnapshot;
  readonly tracker: BraceVisibility;
}

export function activate(context: vscode.ExtensionContext): void {
  const folding = new InlineBraceFolding(context.extension.id);
  context.subscriptions.push(
    folding,
    vscode.languages.registerFoldingRangeProvider({ language: "*" }, folding),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(PROVIDER_SETTING)) {
        vscode.window.visibleTextEditors.forEach(editor => folding.render(editor));
      }
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(({ textEditor }) => folding.render(textEditor, true)),
    vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(editor => folding.render(editor))),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (contentChanges.length === 0) {
        return;
      }
      vscode.window.visibleTextEditors
        .filter(editor => editor.document === document)
        .forEach(editor => folding.render(editor));
    }),
  );
  vscode.window.visibleTextEditors.forEach(editor => folding.render(editor));
}

class InlineBraceFolding implements vscode.FoldingRangeProvider, vscode.Disposable {
  private readonly sources = new LanguageFoldingSources();
  readonly onDidChangeFoldingRanges = this.sources.onDidChangeFoldingRanges;
  private readonly snapshots = new WeakMap<vscode.TextDocument, FoldSnapshot>();
  private readonly editorVisibility = new WeakMap<vscode.TextEditor, EditorVisibility>();
  private readonly decoratedEditors = new WeakSet<vscode.TextEditor>();
  private readonly openingBrace = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    color: "transparent",
    backgroundColor: PLACEHOLDER_BACKGROUND,
    before: {
      color: PLACEHOLDER_FOREGROUND,
      width: BRACE_WIDTH,
      margin: `0 calc(-1 * ${BRACE_WIDTH}) 0 0`,
    },
  });
  private readonly placeholder = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    // Cancel out the attachments' advance so the overlay leaves the native click target in place.
    before: {
      color: PLACEHOLDER_FOREGROUND,
      backgroundColor: PLACEHOLDER_BACKGROUND,
      width: NATIVE_PLACEHOLDER_WIDTH,
      margin: `0 calc(-1 * ${NATIVE_PLACEHOLDER_WIDTH}) 0 0`,
    },
    after: {
      color: PLACEHOLDER_FOREGROUND,
      backgroundColor: PLACEHOLDER_BACKGROUND,
    },
  });
  private readonly ellipsisFallback = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    // Paint the same glyph under the native one, even when its theme color is transparent.
    after: {
      contentText: "⋯",
      color: PLACEHOLDER_FOREGROUND,
      fontWeight: "600",
      width: "0",
      margin: `0 calc(-1 * ${NATIVE_ELLIPSIS_INSET}) 0 ${NATIVE_ELLIPSIS_INSET}`,
    },
  });

  constructor(private readonly extensionId: string) {}

  async provideFoldingRanges(
    document: vscode.TextDocument,
    context: vscode.FoldingContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.FoldingRange[] | undefined> {
    const isSelected = this.isSelectedProvider(document);
    if (token.isCancellationRequested || (!isSelected && !LEGACY_LANGUAGES.has(document.languageId))) {
      return undefined;
    }
    const snapshot = this.getSnapshot(document);
    if (!snapshot) {
      return undefined;
    }

    const source = await this.sources.getProvider(document, token);
    const supplemental = isSelected && source ? await this.requestRanges(source, document, context, token) : undefined;
    if (token.isCancellationRequested || document.isClosed || document.version !== snapshot.version ||
        document.languageId !== snapshot.language || isSelected !== this.isSelectedProvider(document)) {
      return undefined;
    }
    if (!isSelected && source) {
      snapshot.tailFolds = undefined;
      return undefined;
    }
    const ranges = mergeFoldRanges(snapshot.folds, supplemental ?? [], document.lineCount);
    snapshot.tailFolds = getTailFolds(ranges, snapshot);
    return isSelected || ranges.length ? ranges : undefined;
  }

  render(editor: vscode.TextEditor, isVisibilityEvent = false): void {
    const document = editor.document;
    const isEnabled = this.isSelectedProvider(document) || LEGACY_LANGUAGES.has(document.languageId);
    const snapshot = isEnabled && !isDiffEditor(editor) ? this.getSnapshot(document) : undefined;
    const previews = snapshot && this.observeVisibility(editor, snapshot, isVisibilityEvent);
    if (!previews?.length) {
      if (this.decoratedEditors.delete(editor)) {
        editor.setDecorations(this.openingBrace, []);
        editor.setDecorations(this.placeholder, []);
        editor.setDecorations(this.ellipsisFallback, []);
      }
      return;
    }

    const openingBraces: vscode.DecorationOptions[] = [];
    const placeholders: vscode.DecorationOptions[] = [];
    for (const { startLine, preview } of previews) {
      const line = document.lineAt(startLine);
      const end = line.range.end;
      if (preview?.openingColumn !== undefined) {
        openingBraces.push({
          range: new vscode.Range(end.with({ character: preview.openingColumn }), end),
          renderOptions: { before: { contentText: line.text.charAt(preview.openingColumn) } },
        });
      }
      placeholders.push({
        range: new vscode.Range(end, end),
        renderOptions: {
          before: preview && preview.openingColumn === undefined ? {
            contentText: "{",
            width: `calc(${BRACE_WIDTH} + ${NATIVE_PLACEHOLDER_WIDTH})`,
            margin: `0 calc(-1 * ${NATIVE_PLACEHOLDER_WIDTH}) 0 ${BRACE_WIDTH}`,
          } : { contentText: "\u00a0" },
          after: preview ? {
            contentText: preview.closing,
            width: BRACE_WIDTH,
            margin: `0 calc(-1 * (${NATIVE_PLACEHOLDER_WIDTH} + ${BRACE_WIDTH})) 0 ${NATIVE_PLACEHOLDER_WIDTH}`,
          } : undefined,
        },
      });
    }
    editor.setDecorations(this.openingBrace, openingBraces);
    editor.setDecorations(this.placeholder, placeholders);
    editor.setDecorations(this.ellipsisFallback, placeholders.map(placeholder => placeholder.range));
    this.decoratedEditors.add(editor);
  }

  dispose(): void {
    this.sources.dispose();
    this.openingBrace.dispose();
    this.placeholder.dispose();
    this.ellipsisFallback.dispose();
  }

  private isSelectedProvider(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration("editor", document)
      .get<string>("defaultFoldingRangeProvider") === this.extensionId;
  }

  private async requestRanges(
    source: vscode.FoldingRangeProvider,
    document: vscode.TextDocument,
    context: vscode.FoldingContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.FoldingRange[] | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }
    try {
      return (await source.provideFoldingRanges(document, context, token)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private observeVisibility(
    editor: vscode.TextEditor,
    snapshot: FoldSnapshot,
    isVisibilityEvent: boolean,
  ): readonly BraceFold[] {
    const cached = this.editorVisibility.get(editor);
    const tracker = cached?.snapshot === snapshot
      ? cached.tracker
      : new BraceVisibility(snapshot.folds, snapshot.lastContentLine);
    if (cached?.tracker !== tracker) {
      this.editorVisibility.set(editor, { snapshot, tracker });
    }
    return tracker.observe(editor.visibleRanges, isVisibilityEvent, snapshot.tailFolds);
  }

  private getSnapshot(document: vscode.TextDocument): FoldSnapshot | undefined {
    const language = document.languageId;
    if (document.isClosed) {
      return undefined;
    }
    const cached = this.snapshots.get(document);
    if (cached?.version === document.version && cached.language === language) {
      return cached;
    }
    const lastLine = document.lineCount - 1;
    const snapshot = {
      version: document.version,
      language,
      folds: scanBraceFolds(document.getText(), language),
      lastContentLine: document.lineAt(lastLine).text.length === 0 ? lastLine - 1 : lastLine,
    };
    this.snapshots.set(document, snapshot);
    return snapshot;
  }
}

function isDiffEditor(editor: vscode.TextEditor): boolean {
  return vscode.window.tabGroups.all.some(group =>
    group.viewColumn === editor.viewColumn && group.activeTab?.input instanceof vscode.TabInputTextDiff,
  );
}

function getTailFolds(ranges: readonly vscode.FoldingRange[], snapshot: FoldSnapshot): ReadonlyMap<number, BraceFold> {
  const folds = new Map<number, BraceFold>();
  const { lastContentLine } = snapshot;
  for (const { start, end } of ranges) {
    if (end !== lastContentLine || start >= end) {
      continue;
    }
    const brace = snapshot.folds.get(start);
    folds.set(start, brace?.endLine === end ? brace : { startLine: start, endLine: end });
  }
  // An alternate endpoint at the same start makes a missing visible suffix ambiguous.
  for (const { start, end } of ranges) {
    if (end !== lastContentLine) {
      folds.delete(start);
    }
  }
  return folds;
}
