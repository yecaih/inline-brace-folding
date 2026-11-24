import * as vscode from "vscode";

type RangeSpec = readonly [start: number, end: number, kind?: vscode.FoldingRangeKind];

const CPP_RANGES: readonly RangeSpec[] = [[0, 1, vscode.FoldingRangeKind.Comment], [4, 7, vscode.FoldingRangeKind.Region], [5, 6]];
const RUST_RANGES: readonly RangeSpec[] = [[0, 1, vscode.FoldingRangeKind.Imports], [3, 11], [4, 6], [8, 9]];

export function activate(context: vscode.ExtensionContext) {
  const isClangd = context.extension.id.endsWith(".vscode-clangd");
  const language = isClangd ? "cpp" : "rust";
  const selector = { language, scheme: "file" };
  const refresh = new vscode.EventEmitter<void>();
  const overrides = new Map<string, readonly RangeSpec[]>();
  const provider: vscode.FoldingRangeProvider = {
    onDidChangeFoldingRanges: refresh.event,
    provideFoldingRanges: document => {
      const ranges = overrides.get(document.uri.path) ??
        (document.uri.path.endsWith("/empty.cpp") ? [] : isClangd ? CPP_RANGES : RUST_RANGES);
      return ranges.map(([start, end, kind]) => new vscode.FoldingRange(start, end, kind));
    },
  };
  const client = {
    getFeature(method: string) {
      return method === "textDocument/foldingRange" ? {
        getProvider: (document: vscode.TextDocument) => vscode.languages.match(selector, document) ? { provider } : undefined,
      } : undefined;
    },
  };
  context.subscriptions.push(refresh, vscode.languages.registerFoldingRangeProvider(selector, provider));

  return {
    ...isClangd ? { getApi: (version: 1) => version === 1 ? { languageClient: client } : undefined } : { client },
    setRanges(uri: vscode.Uri, ranges: readonly RangeSpec[]) {
      overrides.set(uri.path, ranges);
      refresh.fire();
    },
  };
}
