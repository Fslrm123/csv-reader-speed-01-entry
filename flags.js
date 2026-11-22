// V8 flags, set before solve.js is imported so all of its work runs under them (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags the same way):
// - --no-incremental-marking, as the house baseline runs;
// - --no-turbofan --no-concurrent-recompilation: every timed run is a fresh process, and on this
//   workload TurboFan's repeated speculative recompilations of the reader (deopt cycles on one large
//   function, each compile tens of milliseconds of CPU on a background thread) cost more than its
//   peak speed saves before the process ends. Maglev compiles the reader once, quickly, during the
//   warm-up in main.ts — synchronously, on this thread — and then runs every case at a steady speed.
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbofan --no-concurrent-recompilation');
