import * as vscode from "vscode";

const CLANGD = "llvm-vs-code-extensions.vscode-clangd";
const RUST_ANALYZER = "rust-lang.rust-analyzer";

interface FoldingClient {
  getFeature(method: "textDocument/foldingRange"): {
    getProvider(document: vscode.TextDocument): { provider: vscode.FoldingRangeProvider } | undefined;
  } | undefined;
}

interface LanguageExtension {
  getApi?(version: 1): { languageClient?: FoldingClient };
  readonly client?: FoldingClient;
}

interface SourceRefresh {
  readonly client: FoldingClient;
  readonly subscriptions: Map<vscode.FoldingRangeProvider, vscode.Disposable>;
}

export class LanguageFoldingSources implements vscode.Disposable {
  private readonly refresh = new vscode.EventEmitter<void>();
  private readonly sources = new Map<string, SourceRefresh>();
  readonly onDidChangeFoldingRanges = this.refresh.event;

  async getProvider(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.FoldingRangeProvider | undefined> {
    const id = getSourceId(document.languageId);
    if (!id || token.isCancellationRequested) {
      return undefined;
    }
    const extension = vscode.extensions.getExtension<LanguageExtension>(id);
    if (!extension) {
      return undefined;
    }
    try {
      const api = extension.isActive ? extension.exports : await extension.activate();
      if (token.isCancellationRequested) {
        return undefined;
      }
      const client = id === CLANGD ? api?.getApi?.(1)?.languageClient : api?.client;
      const provider = client?.getFeature?.("textDocument/foldingRange")?.getProvider(document)?.provider;
      if (client && provider) {
        this.observeRefresh(id, client, provider);
      }
      return provider;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    for (const source of this.sources.values()) {
      source.subscriptions.forEach(subscription => subscription.dispose());
    }
    this.sources.clear();
    this.refresh.dispose();
  }

  private observeRefresh(id: string, client: FoldingClient, provider: vscode.FoldingRangeProvider): void {
    const previous = this.sources.get(id);
    if (previous?.client !== client) {
      previous?.subscriptions.forEach(subscription => subscription.dispose());
    }
    const source = previous?.client === client ? previous : { client, subscriptions: new Map() };
    if (!source.subscriptions.has(provider) && provider.onDidChangeFoldingRanges) {
      source.subscriptions.set(provider, provider.onDidChangeFoldingRanges(() => this.refresh.fire()));
    }
    this.sources.set(id, source);
  }
}

function getSourceId(language: string): string | undefined {
  if (language === "rust") {
    return RUST_ANALYZER;
  }
  return language === "c" || language === "cpp" ? CLANGD : undefined;
}
