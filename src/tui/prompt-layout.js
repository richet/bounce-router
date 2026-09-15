import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

export function promptLayout(text = '', cursor = text.length, width = 80, maxRows = 4) {
  const columns = Math.max(2, width);
  const position = Math.max(0, Math.min(text.length, cursor));
  const rows = [''];
  let cells = 0;
  let caretRow = 0;
  let caretOffset = 0;

  for (const {segment, index} of segmenter.segment(text)) {
    const size = stringWidth(segment);
    if (segment !== '\n' && cells + size > columns) {
      rows.push('');
      cells = 0;
    }
    if (position >= index && position < index + segment.length) {
      caretRow = rows.length - 1;
      caretOffset = rows.at(-1).length;
    }
    if (segment === '\n') {
      rows.push('');
      cells = 0;
    } else {
      rows[rows.length - 1] += segment;
      cells += size;
    }
  }
  if (position === text.length) {
    if (cells >= columns) rows.push('');
    caretRow = rows.length - 1;
    caretOffset = rows.at(-1).length;
  }
  const start = Math.max(0, caretRow - Math.max(1, maxRows) + 1);
  return rows.slice(start, start + Math.max(1, maxRows)).map((row, index) => {
    if (index + start !== caretRow) return {text: row};
    const caret = [...segmenter.segment(row.slice(caretOffset))][0]?.segment ?? ' ';
    return {before: row.slice(0, caretOffset), caret, atEnd: caretOffset === row.length, after: row.slice(caretOffset + caret.length)};
  });
}
