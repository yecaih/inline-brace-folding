import { BraceLexer, type OpeningBracket } from "./braceLexer";

export interface BraceFold {
  readonly startLine: number;
  readonly endLine: number;
  readonly preview?: {
    readonly openingColumn?: number;
    readonly closing: string;
  };
}

interface OpenBrace {
  readonly character: OpeningBracket;
  readonly line: number;
  readonly column: number;
}

interface ConditionalBranch {
  readonly openBraceCount: number;
  hasAmbiguousBalance: boolean;
}

const CLOSING_LINE = /^[})]\s*(?:[)\]]\s*)*[,;]?$/;
const ALLMAN_HEADER = /(?:\)$|\b(?:else|do|try|unsafe|loop|const)$)/;

export function scanBraceFolds(text: string, language: string): ReadonlyMap<number, BraceFold> {
  const lines = text.split(/\r\n|\r|\n/);
  return new BraceFoldScanner(lines, language).scan();
}

class BraceFoldScanner {
  private readonly lexer: BraceLexer;
  private readonly openBraces: OpenBrace[] = [];
  private readonly conditionals: ConditionalBranch[] = [];
  private readonly folds = new Map<number, BraceFold>();

  constructor(
    private readonly lines: readonly string[],
    language: string,
  ) {
    this.lexer = new BraceLexer(language);
  }

  scan(): ReadonlyMap<number, BraceFold> {
    this.lines.forEach((line, lineNumber) => this.scanLine(line, lineNumber));
    return this.folds;
  }

  private scanLine(line: string, lineNumber: number): void {
    const tokens = this.lexer.scanLine(line);
    if (tokens === "if") {
      this.conditionals.push({ openBraceCount: this.openBraces.length, hasAmbiguousBalance: false });
      return;
    }
    if (tokens === "branch" || tokens === "endif") {
      this.finishConditionalBranch(tokens === "endif");
      return;
    }
    for (const brace of tokens) {
      if (brace.character === "{" || brace.character === "(") {
        this.openBraces.push({ character: brace.character, line: lineNumber, column: brace.column });
      } else {
        this.closeBrace(brace.character === "}" ? "{" : "(", lineNumber, brace.column);
      }
    }
  }

  private closeBrace(expected: OpeningBracket, closingLine: number, closingColumn: number): void {
    const branch = this.conditionals.at(-1);
    if (branch && this.openBraces.length <= branch.openBraceCount) {
      branch.hasAmbiguousBalance = true;
      return;
    }
    const opening = this.openBraces.pop();
    if (!opening) {
      return;
    }
    if (opening.character !== expected) {
      this.openBraces.length = branch?.openBraceCount ?? 0;
      if (branch) {
        branch.hasAmbiguousBalance = true;
      }
      return;
    }
    if (opening.line === closingLine) {
      return;
    }
    const fold = this.getFold(opening, closingLine, closingColumn);
    const existing = this.folds.get(fold.startLine);
    if (fold.startLine < fold.endLine && (!existing || fold.endLine > existing.endLine)) {
      this.folds.set(fold.startLine, fold);
    }
  }

  private finishConditionalBranch(isEnd: boolean): void {
    const branch = this.conditionals.at(-1);
    if (!branch) {
      this.openBraces.length = 0;
      return;
    }
    branch.hasAmbiguousBalance ||= this.openBraces.length !== branch.openBraceCount;
    this.openBraces.length = branch.openBraceCount;
    if (!isEnd) {
      return;
    }
    this.conditionals.pop();
    if (branch.hasAmbiguousBalance) {
      const enclosingBranch = this.conditionals.at(-1);
      this.openBraces.length = enclosingBranch?.openBraceCount ?? 0;
      if (enclosingBranch) {
        enclosingBranch.hasAmbiguousBalance = true;
      }
    }
  }

  private getFold(opening: OpenBrace, closingLine: number, closingColumn: number): BraceFold {
    const rawClosingLine = this.lines[closingLine];
    const closingLineText = rawClosingLine.trim();
    const openingSuffix = this.lines[opening.line].slice(opening.column + 1).trim();
    if (openingSuffix || rawClosingLine.slice(0, closingColumn).trim() || !CLOSING_LINE.test(closingLineText)) {
      return { startLine: opening.line, endLine: closingLine - 1 };
    }
    const closing = closingLineText.replace(/\s/g, "");
    if (opening.character === "{" && this.isAllmanOpening(opening.line)) {
      return { startLine: opening.line - 1, endLine: closingLine, preview: { closing } };
    }
    return {
      startLine: opening.line,
      endLine: closingLine,
      preview: { openingColumn: opening.column, closing },
    };
  }

  private isAllmanOpening(line: number): boolean {
    if (line === 0 || this.lines[line].trim() !== "{") {
      return false;
    }
    const header = this.lines[line - 1].trim();
    return !/^(?:[#/*]|\{)/.test(header) && !/\/\/|\/\*|\*\//.test(header) && ALLMAN_HEADER.test(header);
  }
}
