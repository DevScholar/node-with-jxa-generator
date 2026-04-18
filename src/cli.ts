// src/cli.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bundle, resolveFrameworks } from './bundle.js';

function printHelp() {
    console.log(`
Usage:
  node-with-jxa-generator -f <frameworks...> -t <output.d.ts>
  node-with-jxa-generator --all -t <output.d.ts>

Required:
  -f, --framework <name...>   One or more framework names (e.g. Foundation AppKit)
  -t, --typedefs  <path>      Output .d.ts file path

Options:
  --all                       Include all 153 frameworks (large output, ~20 MB)
  --list                      List all available framework names and exit
  --nowarn                    Suppress warnings
  -h, --help                  Show this help

Examples:
  node-with-jxa-generator -f Foundation -t ./types/foundation.d.ts
  node-with-jxa-generator -f Foundation AppKit -t ./types/cocoa.d.ts
  node-with-jxa-generator --all -t ./types/jxa-all.d.ts
`.trim());
}

function parseArgs(argv: string[]) {
    const args = argv.slice(2);
    const frameworks: string[] = [];
    let output = '';
    let all = false;
    let list = false;
    let nowarn = false;
    let help = false;

    function expectValue(flag: string, next: string | undefined): string {
        if (next === undefined || next.startsWith('-')) {
            throw new Error(`${flag} requires a value, got ${next === undefined ? 'end of args' : `"${next}"`}`);
        }
        return next;
    }

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-h' || a === '--help') { help = true; }
        else if (a === '--all') { all = true; }
        else if (a === '--list') { list = true; }
        else if (a === '--nowarn') { nowarn = true; }
        else if (a === '-t' || a === '--typedefs') { output = expectValue(a, args[++i]); }
        else if (a === '-f' || a === '--framework') {
            // consume all following non-flag tokens as framework names
            while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                frameworks.push(args[++i]);
            }
            if (frameworks.length === 0) {
                throw new Error(`${a} requires at least one framework name`);
            }
        } else if (a === '--') {
            // explicit positional separator: treat the rest as framework names
            for (let j = i + 1; j < args.length; j++) frameworks.push(args[j]);
            break;
        } else if (!a.startsWith('-')) {
            // bare positional: framework name
            frameworks.push(a);
        } else {
            throw new Error(`Unknown flag: ${a}`);
        }
    }
    return { frameworks, output, all, list, nowarn, help };
}

async function main() {
    const { frameworks, output, all, list, nowarn, help } = parseArgs(process.argv);

    if (help) { printHelp(); process.exit(0); }

    if (list) {
        const resolved = resolveFrameworks(['Foundation']); // just to init
        // list all by scanning dist
        const { bundle: _b, ...rest } = await import('./bundle.js');
        // Re-use resolveFrameworks with a dummy to get distRoot
        // Simpler: just print from resolveFrameworks([]) which returns []
        // Instead replicate the dir scan here
        const distRoot = path.resolve(
            new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
            '..', '..', 'node_modules', 'objcjs-types', 'dist'
        );
        const names = fs.readdirSync(distRoot, { withFileTypes: true })
            .filter(e => e.isDirectory() && e.name !== 'structs' && e.name !== 'delegates')
            .map(e => e.name).sort();
        console.log(names.join('\n'));
        process.exit(0);
    }

    if (!all && frameworks.length === 0) {
        console.error('Error: specify frameworks with -f, or use --all\n');
        printHelp();
        process.exit(1);
    }

    if (!output) {
        console.error('Error: specify output file with -t\n');
        printHelp();
        process.exit(1);
    }

    const resolved = all ? [] : resolveFrameworks(frameworks);
    const label = all ? 'all frameworks' : `${resolved.length} frameworks (${frameworks.join(', ')} + deps)`;
    console.log(`Generating types for ${label}…`);

    const { dts, warnings } = bundle({ frameworks, all });

    if (!nowarn) for (const w of warnings) console.warn('warn:', w);

    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, dts, 'utf-8');

    const kb = Math.round(Buffer.byteLength(dts, 'utf-8') / 1024);
    console.log(`Wrote ${output} (${kb} KB)`);
}

main().catch(e => {
    console.error('Error:', e?.message ?? String(e));
    process.exit(1);
});
