export type OpeningBracket = "{" | "(";
export type ClosingBracket = "}" | ")";
interface Bracket {
  readonly character: OpeningBracket | ClosingBracket;
  readonly column: number;
}
type Conditional = "if" | "branch" | "endif";
type Quote = '"' | "'" | "`";

const C_LIKE = new Set(["c", "cpp", "cuda-cpp", "objective-c", "objective-cpp"]);
const HASH_COMMENT = new Set(["python", "ruby", "shellscript", "yaml", "toml", "r", "perl", "powershell", "dockerfile", "makefile", "cmake", "elixir"]);
const DASH_COMMENT = new Set(["lua", "sql", "haskell", "ada"]);
const TRIPLE_STRING = new Set(["python", "toml", "java", "kotlin", "scala", "swift", "groovy", "dart"]);

const DIRECTIVE = /^#\s*([a-z_]+)/;
const CPP_RAW_STRING = /^(?:u8|[uUL])?R"([^\s()\\]{0,16})\(/;
const RUST_RAW_STRING = /^(?:b|c)?r(#{0,255})"/;
const RUST_CHARACTER = /^'(?:[^'\\\r\n]|\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\r\n]))'/u;
const C_NUMBER = /^\d(?:[\w.]|'[\w])*/;

export class BraceLexer {
  private readonly isRust: boolean;
  private readonly isCLike: boolean;
  private blockCommentDepth = 0;
  private rawCloser: string | undefined;
  private quote: Quote | undefined;
  private isContinuedLineComment = false;
  private isContinuedDirective = false;

  constructor(private readonly language: string) {
    this.isRust = language === "rust";
    this.isCLike = C_LIKE.has(language);
  }

  scanLine(line: string): readonly Bracket[] | Conditional {
    if (this.isContinuedLineComment) {
      this.isContinuedLineComment = this.hasLineSplice(line);
      this.isContinuedDirective &&= this.isContinuedLineComment;
      return [];
    }

    let isDirective = this.isContinuedDirective;
    let canStartDirective = this.isCLike && !isDirective && !this.rawCloser && !this.quote;
    let conditional: Conditional | undefined;
    const brackets: Bracket[] = [];
    let column = this.skipNonCode(line, 0);
    while (column < line.length) {
      const character = line[column];
      const pair = line.slice(column, column + 2);
      if (this.isLineComment(pair, character)) {
        this.isContinuedLineComment = this.isCLike && this.hasLineSplice(line);
        break;
      }
      if (pair === "/*") {
        this.blockCommentDepth = 1;
        column = this.skipNonCode(line, column + 2);
        continue;
      }
      if (canStartDirective && /\s/.test(character)) {
        column++;
        continue;
      }
      if (canStartDirective && character === "#") {
        isDirective = true;
        conditional = this.getConditional(DIRECTIVE.exec(line.slice(column))?.[1]);
      }
      canStartDirective = false;
      const rawContentStart = this.tryStartRawString(line, column);
      if (rawContentStart !== undefined) {
        column = this.skipNonCode(line, rawContentStart);
        continue;
      }
      if (character === '"' || (character === "'" && this.isCharacterLiteral(line, column)) ||
          (character === "`" && this.language !== "rust" && !this.isCLike)) {
        this.quote = character;
        column = this.skipNonCode(line, column + 1);
        continue;
      }
      if (this.isCLike && character >= "0" && character <= "9") {
        const number = C_NUMBER.exec(line.slice(column));
        column += number?.[0].length ?? 1;
        continue;
      }
      if (!isDirective && (character === "{" || character === "}" || character === "(" || character === ")")) {
        brackets.push({ character, column });
      }
      column++;
    }
    this.isContinuedDirective = isDirective && (this.blockCommentDepth > 0 || !!this.rawCloser || this.hasLineSplice(line));
    return conditional ?? brackets;
  }

  private isLineComment(pair: string, character: string): boolean {
    const hasHashComment = HASH_COMMENT.has(this.language);
    return (pair === "//" && !hasHashComment) || (character === "#" && hasHashComment) ||
      (pair === "--" && DASH_COMMENT.has(this.language));
  }

  private skipNonCode(line: string, column: number): number {
    if (this.blockCommentDepth > 0) {
      return this.skipBlockComment(line, column);
    }
    if (this.rawCloser) {
      const closeColumn = line.indexOf(this.rawCloser, column);
      if (closeColumn === -1) {
        return line.length;
      }
      const nextColumn = closeColumn + this.rawCloser.length;
      this.rawCloser = undefined;
      return nextColumn;
    }
    if (this.quote) {
      return this.skipQuotedLiteral(line, column);
    }
    return column;
  }

  private skipBlockComment(line: string, column: number): number {
    while (column < line.length && this.blockCommentDepth > 0) {
      const pair = line.slice(column, column + 2);
      if (pair === "*/") {
        this.blockCommentDepth--;
        column += 2;
      } else if (this.isRust && pair === "/*") {
        this.blockCommentDepth++;
        column += 2;
      } else {
        column++;
      }
    }
    return column;
  }

  private skipQuotedLiteral(line: string, column: number): number {
    while (column < line.length) {
      const character = line[column++];
      if (character === "\\") {
        column++;
      } else if (character === this.quote) {
        this.quote = undefined;
        return column;
      }
    }
    if (!this.isRust && this.quote !== "`" && !this.hasLineSplice(line)) {
      this.quote = undefined;
    }
    return line.length;
  }

  private tryStartRawString(line: string, column: number): number | undefined {
    const character = line[column];
    const triple = line.slice(column, column + 3);
    if (TRIPLE_STRING.has(this.language) && (triple === '\"\"\"' || triple === "'''")) {
      this.rawCloser = triple;
      return column + 3;
    }
    if (!this.isRust && !this.isCLike) {
      return undefined;
    }
    const prefixes = this.isRust ? "rbc" : "RuUL";
    if (!prefixes.includes(character) || (column > 0 && /[\w\p{ID_Continue}]/u.test(line[column - 1]))) {
      return undefined;
    }
    const opener = (this.isRust ? RUST_RAW_STRING : CPP_RAW_STRING).exec(line.slice(column));
    if (!opener) {
      return undefined;
    }
    this.rawCloser = this.isRust ? `"${opener[1]}` : `)${opener[1]}"`;
    return column + opener[0].length;
  }

  private isCharacterLiteral(line: string, column: number): boolean {
    return !this.isRust || RUST_CHARACTER.test(line.slice(column));
  }

  private hasLineSplice(line: string): boolean {
    return line.trimEnd().endsWith("\\");
  }

  private getConditional(directive: string | undefined): Conditional | undefined {
    switch (directive) {
      case "if":
      case "ifdef":
      case "ifndef":
        return "if";
      case "else":
      case "elif":
      case "elifdef":
      case "elifndef":
        return "branch";
      case "endif":
        return "endif";
      default:
        return undefined;
    }
  }
}
