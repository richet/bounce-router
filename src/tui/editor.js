const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

function segments(input) {
  return [...segmenter.segment(input)].map(({segment, index}) => ({segment, index, end: index + segment.length}));
}

function cursor(input, offset) {
  const position = Math.max(0, Math.min(input.length, Number.isFinite(offset) ? offset : input.length));
  return segments(input).find(segment => segment.index < position && position < segment.end)?.index ?? position;
}

function previousSegment(input, offset) {
  const position = cursor(input, offset);
  return segments(input).filter(segment => segment.index < position).at(-1);
}

function nextSegment(input, offset) {
  const position = cursor(input, offset);
  return segments(input).find(segment => segment.end > position);
}

function replace(input, start, end, text) {
  return {input: input.slice(0, start) + text + input.slice(end), cursor: start + text.length};
}

function isWhitespace(segment) {
  return /^\s$/u.test(segment);
}

function isWord(segment) {
  return /^[\p{L}\p{N}_]/u.test(segment);
}

export function clampCursor(input, offset) {
  return cursor(input, offset);
}

export function insertText(input, offset, text) {
  const position = cursor(input, offset);
  return replace(input, position, position, text);
}

export function backspace(input, offset) {
  const position = cursor(input, offset);
  const segment = previousSegment(input, position);
  return segment ? replace(input, segment.index, position, '') : {input, cursor: position};
}

export function deleteForward(input, offset) {
  const position = cursor(input, offset);
  const segment = nextSegment(input, position);
  return segment ? replace(input, position, segment.end, '') : {input, cursor: position};
}

export function moveCursor(input, offset, direction) {
  const position = cursor(input, offset);
  if (direction === 'left') return previousSegment(input, position)?.index ?? 0;
  if (direction === 'right') return nextSegment(input, position)?.end ?? input.length;
  return position;
}

export function moveLineStart(input, offset) {
  const position = cursor(input, offset);
  return input.lastIndexOf('\n', position - 1) + 1;
}

export function moveLineEnd(input, offset) {
  const position = cursor(input, offset);
  const end = input.indexOf('\n', position);
  return end < 0 ? input.length : end;
}

function lineColumn(input, start, position) {
  return segments(input.slice(start, position)).length;
}

function lineOffset(input, start, end, column) {
  const line = segments(input.slice(start, end));
  return start + (line[column]?.index ?? end - start);
}

export function moveVertical(input, offset, direction, preferredColumn) {
  const position = cursor(input, offset);
  const start = moveLineStart(input, position);
  const end = moveLineEnd(input, position);
  const column = preferredColumn ?? lineColumn(input, start, position);
  if (direction === 'up') {
    if (!start) return {cursor: position, column};
    const previousEnd = start - 1;
    const previousStart = input.lastIndexOf('\n', previousEnd - 1) + 1;
    return {cursor: lineOffset(input, previousStart, previousEnd, column), column};
  }
  if (direction === 'down') {
    if (end === input.length) return {cursor: position, column};
    const nextStart = end + 1;
    const nextEnd = input.indexOf('\n', nextStart);
    return {cursor: lineOffset(input, nextStart, nextEnd < 0 ? input.length : nextEnd, column), column};
  }
  return {cursor: position, column};
}

export function moveWord(input, offset, direction) {
  const position = cursor(input, offset);
  const all = segments(input);
  if (direction === 'left') {
    let index = all.findLastIndex(segment => segment.index < position);
    while (index >= 0 && isWhitespace(all[index].segment)) index--;
    if (index < 0) return 0;
    if (!isWord(all[index].segment)) return all[index].index;
    while (index >= 0 && isWord(all[index].segment)) index--;
    return index < 0 ? 0 : all[index + 1].index;
  }
  let index = all.findIndex(segment => segment.end > position);
  if (index < 0) return input.length;
  if (isWhitespace(all[index].segment)) while (index < all.length && isWhitespace(all[index].segment)) index++;
  if (index >= all.length) return input.length;
  if (isWord(all[index].segment)) while (index < all.length && isWord(all[index].segment)) index++;
  else index++;
  return index >= all.length ? input.length : all[index].index;
}

export function deleteWordBackward(input, offset) {
  const position = cursor(input, offset);
  return replace(input, moveWord(input, position, 'left'), position, '');
}

export function deleteWordForward(input, offset) {
  const position = cursor(input, offset);
  return replace(input, position, moveWord(input, position, 'right'), '');
}
