// solve.js — a fast drop-in for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// run(input) returns, for input {text, header}, exactly the {columns, rows, errors} csv-reader 1.0.0
// returns: the same broken-row policy (BOM dropped, LF/CRLF records, stray_cr, quoted fields with ""
// escapes and CRLF/CR read as LF, quote_junk appended after a closing quote, an unterminated quote read
// again as unquoted, short_row padding and long_row cutting to the first record's width, errors in the
// order met with each record's start line and row index).
//
// Where the reference builds every field a character at a time through helper closures, this reader is
// one inlined pass: state in locals, fields cut out with single slices (joined only where a stray CR or
// an escape forces a rebuild). An unquoted field is found by a native indexOf(',') jump when no line
// break or CR intervenes; a quoted field jumps between quotes with indexOf, converting CRs and counting
// lines per segment. Monotonic next-CR/next-LF caches keep every native search together linear in the text.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // Monotonic caches: the first '\r' / '\n' at or after some earlier pos (-1: none to the end). pos only
  // moves forward (the unterminated-quote re-read drops them), so a cache is refreshed exactly when pos
  // passes it, and all native searches together stay linear in the text.
  let nextCR = -2;
  let nextLF = -2;

  // Appends one quoted segment [a, b) to parts, reading each CRLF or lone CR in it as LF and counting
  // every LF, CRLF and lone CR in it as a line.
  function pushSegment(parts, a, b) {
    if (nextCR < a) nextCR = text.indexOf('\r', a);
    if (nextCR === -1 || nextCR >= b) {
      parts.push(text.slice(a, b));
      if (nextLF < a) nextLF = text.indexOf('\n', a);
      while (nextLF !== -1 && nextLF < b) { line += 1; nextLF = text.indexOf('\n', nextLF + 1); }
      return;
    }
    let s = a;
    let j = a;
    while (j < b) {
      const c = text.charCodeAt(j);
      if (c === 13) {
        parts.push(text.slice(s, j), '\n');
        line += 1;
        j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
        s = j;
        continue;
      }
      if (c === 10) line += 1;
      j += 1;
    }
    parts.push(text.slice(s, b));
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;

    for (;;) {
      let value;
      let ended;
      let prefix = '';
      let junkCheck = false;
      let needUnquoted = true;

      if (text.charCodeAt(pos) === 34) {
        // A quoted field: runs to the next quote that is not doubled, "" inside it one quote, each
        // CRLF or lone CR inside it read as LF.
        quoted = true;
        const open = pos;
        const openLine = line;
        let i = pos + 1;
        let segStart = i;
        let parts = null;
        let closePos = -1;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            if (parts === null) parts = [];
            pushSegment(parts, segStart, q);
            parts.push('"');
            i = q + 2;
            segStart = i;
            continue;
          }
          closePos = q;
          break;
        }
        if (closePos === -1) {
          // The quote never closes: it is a literal character, and the text after it is read again as
          // unquoted. pos moves back, so the forward-only caches are dropped.
          pos = open + 1;
          line = openLine;
          nextCR = -2;
          nextLF = -2;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          prefix = '"';
        } else {
          if (parts === null) {
            if (nextCR < segStart) nextCR = text.indexOf('\r', segStart);
            if (nextCR === -1 || nextCR >= closePos) {
              value = text.slice(segStart, closePos);
              if (nextLF < segStart) nextLF = text.indexOf('\n', segStart);
              while (nextLF !== -1 && nextLF < closePos) { line += 1; nextLF = text.indexOf('\n', nextLF + 1); }
            } else {
              parts = [];
              pushSegment(parts, segStart, closePos);
              value = parts.join('');
            }
          } else {
            pushSegment(parts, segStart, closePos);
            value = parts.join('');
          }
          i = closePos + 1; // past the closing quote
          if (i >= len) { ended = END; pos = i; needUnquoted = false; }
          else {
            const c = text.charCodeAt(i);
            if (c === 44) { ended = COMMA; pos = i + 1; needUnquoted = false; }
            else if (c === 10) { ended = LINE_BREAK; pos = i + 1; line += 1; needUnquoted = false; }
            else if (c === 13 && text.charCodeAt(i + 1) === 10) { ended = LINE_BREAK; pos = i + 2; line += 1; needUnquoted = false; }
            else {
              // What follows the closing quote is appended as it stands (quote_junk, when the field ends).
              pos = i;
              prefix = value;
              junkCheck = true;
            }
          }
        }
      } else {
        quoted = false;
      }

      if (needUnquoted) {
        // Unquoted characters onto `prefix`, up to the next comma or line break: a CR not followed by
        // LF is dropped (stray_cr). `added` counts the characters kept by this read.
        let added = 0;
        let done = false;
        if (prefix === '') {
          // Fast path: the next comma comes before any line break or CR.
          const comma = text.indexOf(',', pos);
          if (comma !== -1) {
            if (nextLF < pos) nextLF = text.indexOf('\n', pos);
            if (nextCR < pos) nextCR = text.indexOf('\r', pos);
            if ((nextLF === -1 || nextLF > comma) && (nextCR === -1 || nextCR > comma)) {
              value = text.slice(pos, comma);
              added = comma - pos;
              pos = comma + 1;
              ended = COMMA;
              done = true;
            }
          }
        }
        if (!done) {
          let i = pos;
          let segStart = pos;
          let parts = null;
          ended = END;
          for (;;) {
            if (i >= len) break;
            const c = text.charCodeAt(i);
            if (c === 44) { ended = COMMA; break; } // ,
            if (c === 10) { ended = LINE_BREAK; break; } // LF
            if (c === 13) { // CR
              if (text.charCodeAt(i + 1) === 10) { ended = LINE_BREAK; break; }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              if (parts === null) parts = [];
              parts.push(text.slice(segStart, i));
              added += i - segStart;
              i += 1;
              segStart = i;
              continue;
            }
            i += 1;
          }
          added += i - segStart;
          let tail;
          if (parts === null) tail = text.slice(segStart, i);
          else { parts.push(text.slice(segStart, i)); tail = parts.join(''); }
          value = prefix === '' ? tail : prefix + tail;
          if (ended === COMMA) pos = i + 1;
          else if (ended === LINE_BREAK) { line += 1; pos = text.charCodeAt(i) === 10 ? i + 1 : i + 2; }
          else pos = i;
        }
        if (junkCheck && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }

      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
