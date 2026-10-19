export type TextRange = { start: number; end: number };

type Token = { value: string; start: number; end: number };
const words = new Intl.Segmenter("zh", { granularity: "word" });
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

function tokenize(text: string): Token[] {
  const result: Token[] = [];
  for (const { segment, index } of words.segment(text)) {
    const parts = /\p{Script=Han}/u.test(segment) ? graphemes.segment(segment) : [{ segment, index: 0 }];
    for (const part of parts) result.push({ value: part.segment, start: index + part.index, end: index + part.index + part.segment.length });
  }
  return result;
}

function ranges(tokens: Token[], changed: boolean[]): TextRange[] {
  const result: TextRange[] = [];
  for (let index = 0; index < tokens.length;) {
    if (!changed[index]) { index++; continue; }
    const start = tokens[index]!.start;
    let end = tokens[index]!.end;
    while (changed[++index]) end = tokens[index]!.end;
    if (start < end) result.push({ start, end });
  }
  return result;
}

function markAccidentalSingleCharacterMatches(oldTokens: Token[], newTokens: Token[], oldChanged: boolean[], newChanged: boolean[]): void {
  const oldEqual = oldChanged.flatMap((changed, index) => changed ? [] : [index]);
  const newEqual = newChanged.flatMap((changed, index) => changed ? [] : [index]);
  const originalOld = oldChanged.slice();
  const originalNew = newChanged.slice();
  for (let index = 0; index < Math.min(oldEqual.length, newEqual.length); index++) {
    const oldIndex = oldEqual[index]!;
    const newIndex = newEqual[index]!;
    const character = oldTokens[oldIndex]!.value;
    if (character !== newTokens[newIndex]!.value || !/^\p{Script=Han}$/u.test(character)) continue;
    const isolatedOld = originalOld[oldIndex - 1] === true && originalOld[oldIndex + 1] === true;
    const isolatedNew = originalNew[newIndex - 1] === true && originalNew[newIndex + 1] === true;
    const oldTouchesChange = originalOld[oldIndex - 1] === true || originalOld[oldIndex + 1] === true;
    const newTouchesChange = originalNew[newIndex - 1] === true || originalNew[newIndex + 1] === true;
    if ((isolatedOld && !isolatedNew && newTouchesChange) || (isolatedNew && !isolatedOld && oldTouchesChange)) {
      oldChanged[oldIndex] = true;
      newChanged[newIndex] = true;
    }
  }
}

/** 类似 Git 的 Myers 最短编辑路径，保留公共前后文，返回原文 UTF-16 范围以映射到 DOM Range。 */
export function changedTextRanges(before: string, after: string): { before: TextRange[]; after: TextRange[] } {
  const oldTokens = tokenize(before);
  const newTokens = tokenize(after);
  const oldChanged = Array(oldTokens.length).fill(false) as boolean[];
  const newChanged = Array(newTokens.length).fill(false) as boolean[];
  let start = 0;
  while (start < Math.min(oldTokens.length, newTokens.length) && oldTokens[start]!.value === newTokens[start]!.value) start++;
  let oldEnd = oldTokens.length;
  let newEnd = newTokens.length;
  while (oldEnd > start && newEnd > start && oldTokens[oldEnd - 1]!.value === newTokens[newEnd - 1]!.value) { oldEnd--; newEnd--; }
  const left = oldTokens.slice(start, oldEnd);
  const right = newTokens.slice(start, newEnd);

  if (left.length && right.length) {
    const trace: Map<number, number>[] = [];
    const furthest = new Map<number, number>([[1, 0]]);
    let distance = 0;
    let found = false;
    // 大片重写时直接标记剩余片段，避免差异计算拖慢版本页。
    const limit = Math.min(left.length + right.length, 300);
    for (; distance <= limit && !found; distance++) {
      trace.push(new Map(furthest));
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        const down = diagonal === -distance || (diagonal !== distance && (furthest.get(diagonal - 1) ?? -1) < (furthest.get(diagonal + 1) ?? -1));
        let x = down ? furthest.get(diagonal + 1) ?? 0 : (furthest.get(diagonal - 1) ?? 0) + 1;
        let y = x - diagonal;
        while (x < left.length && y < right.length && left[x]!.value === right[y]!.value) { x++; y++; }
        furthest.set(diagonal, x);
        if (x >= left.length && y >= right.length) { found = true; break; }
      }
    }
    if (found) {
      let x = left.length;
      let y = right.length;
      for (let depth = trace.length - 1; depth > 0; depth--) {
        const previous = trace[depth]!;
        const diagonal = x - y;
        const down = diagonal === -depth || (diagonal !== depth && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1));
        const prevDiagonal = down ? diagonal + 1 : diagonal - 1;
        const prevX = previous.get(prevDiagonal) ?? 0;
        const prevY = prevX - prevDiagonal;
        while (x > prevX && y > prevY) { x--; y--; }
        if (down) newChanged[start + --y] = true;
        else oldChanged[start + --x] = true;
      }
    } else {
      oldChanged.fill(true, start, oldEnd);
      newChanged.fill(true, start, newEnd);
    }
  } else {
    oldChanged.fill(true, start, oldEnd);
    newChanged.fill(true, start, newEnd);
  }

  markAccidentalSingleCharacterMatches(oldTokens, newTokens, oldChanged, newChanged);
  return { before: ranges(oldTokens, oldChanged), after: ranges(newTokens, newChanged) };
}
