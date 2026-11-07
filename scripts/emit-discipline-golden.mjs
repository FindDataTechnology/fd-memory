// Emit the shared discipline golden used by BOTH sides of the cross-language
// pin (add-yongyi-connect-frameworks D4): the TypeScript platform discipline
// text is the single source, the Python package embeds the same bytes, and
// each side's test compares against this fixture. Never hand-edit the fixture —
// change discipline-text.ts and re-run this script.
//
//   npm run build && node scripts/emit-discipline-golden.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { platformDisciplineText } from "../dist/connect/discipline-text.js";

const out = "python/tests/goldens/discipline-platform.txt";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, platformDisciplineText);
console.log(`wrote ${out} (${Buffer.byteLength(platformDisciplineText)} bytes)`);
