import type { BraceFold } from "./braceFolds";

interface VisiblePosition {
  readonly line: number;
  readonly character: number;
}

export interface VisibleRange {
  readonly start: VisiblePosition;
  readonly end: VisiblePosition;
}

export class BraceVisibility {
  private previousRanges: readonly VisibleRange[] = [];
  private inferredTailFold?: BraceFold;

  constructor(
    private readonly folds: ReadonlyMap<number, BraceFold>,
    private readonly lastContentLine?: number,
  ) {}

  observe(
    visibleRanges: readonly VisibleRange[],
    isVisibilityEvent: boolean,
    tailFolds = this.folds,
  ): readonly BraceFold[] {
    const previews: BraceFold[] = [];
    for (let i = 1; i < visibleRanges.length; i++) {
      const startLine = visibleRanges[i - 1].end.line;
      const endLine = visibleRanges[i].start.line - 1;
      if (startLine < endLine) {
        const brace = this.folds.get(startLine);
        previews.push(brace?.endLine === endLine ? brace : { startLine, endLine });
      }
    }
    this.inferredTailFold = this.getInferredTailFold(visibleRanges, isVisibilityEvent, tailFolds);
    if (this.inferredTailFold) {
      previews.push(this.inferredTailFold);
    }
    this.previousRanges = visibleRanges;
    return previews;
  }

  private getInferredTailFold(
    visibleRanges: readonly VisibleRange[],
    isVisibilityEvent: boolean,
    tailFolds: ReadonlyMap<number, BraceFold>,
  ): BraceFold | undefined {
    const lastVisible = visibleRanges.at(-1);
    if (!lastVisible || this.lastContentLine === undefined) {
      return undefined;
    }
    const fold = tailFolds.get(lastVisible.end.line);
    if (!fold || fold.endLine !== this.lastContentLine) {
      return undefined;
    }
    const openingColumn = fold.preview?.openingColumn;
    if (openingColumn !== undefined && lastVisible.end.character <= openingColumn) {
      return undefined;
    }
    const previousFold = this.inferredTailFold;
    if (previousFold?.startLine === fold.startLine && previousFold.endLine === fold.endLine) {
      return fold;
    }

    // At EOF there may be no visible suffix. Infer folding only after multiple rows disappear.
    const previousTail = this.previousRanges.at(-1);
    const hasLostMultipleRows = previousTail && previousTail.end.line - fold.startLine > 1;
    return isVisibilityEvent && hasLostMultipleRows && this.hasSameViewportTop(visibleRanges[0].start) &&
      this.hasNoNewVisibleLines(visibleRanges) ? fold : undefined;
  }

  private hasSameViewportTop(currentTop: VisiblePosition): boolean {
    const previousTop = this.previousRanges[0]?.start;
    return previousTop?.line === currentTop.line && previousTop.character === currentTop.character;
  }

  private hasNoNewVisibleLines(visibleRanges: readonly VisibleRange[]): boolean {
    let previousIndex = 0;
    for (const range of visibleRanges) {
      while (previousIndex < this.previousRanges.length &&
             this.previousRanges[previousIndex].end.line < range.start.line) {
        previousIndex++;
      }
      const previous = this.previousRanges[previousIndex];
      if (!previous || previous.start.line > range.start.line || previous.end.line < range.end.line) {
        return false;
      }
    }
    return true;
  }
}
