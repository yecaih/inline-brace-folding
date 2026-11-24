import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider({ language: "cpp" }, {
    provideFoldingRanges: () => [new vscode.FoldingRange(0, 1)],
  }));
}
