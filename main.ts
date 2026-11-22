// The harness runs `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json:
// a JSON array of the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Driver choices measured on fresh processes (the heat times fresh processes):
// - flags.js is imported first, so the V8 flags are set before solve.js loads (see flags.js);
// - cases.json is read as a Buffer and decoded with toString('utf8'): readFileSync(path, 'utf8')
//   takes a much slower path in Node for a file this size;
// - answers are written with writeSync(fd, string, 'utf8') directly: building a Buffer from each
//   answer string first (Buffer.from + writeSync loop) costs an extra encode/copy pass.

import './flags.js';
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { run } from './solve.js';

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
for (let i = 0; i < 600; i++) {
  warmRows += (run({ text: WARM_TEXTS[i % WARM_TEXTS.length]!, header: i % 2 === 0 }) as { rows: unknown[] }).rows.length;
}
if (warmRows === 0) throw new Error('warm-up read no rows');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(INPUT_DIR + '/cases.json').toString('utf8')) as { id: string; input: unknown }[];

// Stream the answers out case by case — the same bytes as JSON.stringify of the whole array
// ('[' + the answers joined by ',' + ']') — releasing each case's input and answer as soon as it
// is written, so the live heap stays small while the later cases run.
const fd = openSync(OUTPUT_DIR + '/answers.json', 'w');
try {
  writeSync(fd, '[', 'utf8');
  for (let i = 0; i < cases.length; i++) {
    writeSync(fd, (i > 0 ? ',' : '') + JSON.stringify(run(cases[i]!.input)), 'utf8');
    (cases as unknown[])[i] = null;
  }
  writeSync(fd, ']', 'utf8');
} finally {
  closeSync(fd);
}
