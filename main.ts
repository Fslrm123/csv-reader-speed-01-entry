// The harness runs `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json:
// a JSON array of the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported so all of its work runs under them (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags the same way):
// - --no-incremental-marking, as the house baseline runs;
// - --no-turbofan --no-concurrent-recompilation: every timed run is a fresh process, and on this
//   workload TurboFan's repeated speculative recompilations of the reader (deopt cycles on one large
//   function, each compile tens of milliseconds of CPU on a background thread) cost more than its
//   peak speed saves before the process ends. Maglev compiles the reader once, quickly, during the
//   warm-up below — synchronously, on this thread — and then runs every case at a steady speed.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbofan --no-concurrent-recompilation');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

// Warm-up: run the reader over small inputs that exercise every path it has (quoted fields and ""
// escapes, multi-line notes with lone CRs, stray CRs, quote junk, short and long rows, blank lines,
// an unterminated quote, BOM, CRLF and LF) so its code is compiled and its type feedback collected
// before the real cases run. The answers are discarded; run() is pure.
const WARM_TEXTS = [
  '\uFEFFh1,h2,h3,h4\r\n123,"phrase, with comma",2024-01-15,CODE-42\r\n"say ""hi"" now",word,"multi\nline\rnote",x\r\nshort,row\r\na,b,c,d,extra,fields\r\nstray\rcr,field,"quoted"junk,last\r\n"needless",plain,éclair,東京\r\n\r\nlast,one,here,ok',
  'a,b,c\n"x\ny",2,3\n"unterminated field\nstill going,more\nlast,line',
  'only\n"a""b""c",d\n\r\re,f\ng,"h\ri",j',
];
let warmRows = 0;
for (let i = 0; i < 300; i++) {
  warmRows += (run({ text: WARM_TEXTS[i % WARM_TEXTS.length]!, header: i % 2 === 0 }) as { rows: unknown[] }).rows.length;
}
if (warmRows === 0) throw new Error('warm-up read no rows');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

// Stream the answers out case by case — the same bytes as JSON.stringify of the whole array
// ('[' + the answers joined by ',' + ']') — releasing each case's input and answer as soon as it
// is written, so the live heap stays small while the later cases run.
function writeAll(fd: number, s: string) {
  const buf = Buffer.from(s, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
try {
  writeAll(fd, '[');
  for (let i = 0; i < cases.length; i++) {
    writeAll(fd, (i > 0 ? ',' : '') + JSON.stringify(run(cases[i]!.input)));
    (cases as unknown[])[i] = null;
  }
  writeAll(fd, ']');
} finally {
  closeSync(fd);
}
