// src/bundle.ts
// Core bundler: reads a set of ObjC frameworks from objcjs-types, transforms
// them to JXA camelCase style, and emits a single self-contained .d.ts file.
//
// The output file contains:
//   1. Struct/enum type declarations (interfaces, const enums)
//   2. Class declarations with JXA-style members (zero-arg → property, $ removed)
//   3. A `declare global { }` block with $, ObjC, Application, etc.
//
// Because everything lives in one file, there are no imports between types —
// classes reference each other by name.  The file is a module (has `export {}`),
// which is required for `declare global {}` to work.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { normalizeSelector } from './selector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- locate objcjs-types -----------------------------------------------

function getObjcjsRoot(): string {
    const p = path.resolve(__dirname, '..', 'node_modules', 'objcjs-types', 'dist');
    if (!fs.existsSync(p)) throw new Error(`objcjs-types not found at ${p}`);
    return p;
}

// ---- dependency resolution ---------------------------------------------

/** Scan a .d.ts source for `from '../FrameworkName/` cross-framework imports. */
function scanFrameworkDeps(source: string): string[] {
    const deps: string[] = [];
    for (const m of source.matchAll(/from ['"]\.\.\/(\w+)\//g)) {
        deps.push(m[1]);
    }
    return deps;
}

/**
 * Given a list of user-requested framework names, return the full set
 * (including transitive dependencies) in no particular order.
 */
export function resolveFrameworks(requested: string[]): string[] {
    const distRoot = getObjcjsRoot();
    const available = new Set(
        fs.readdirSync(distRoot, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name)
    );

    const needed = new Set<string>();

    function add(name: string) {
        if (needed.has(name) || !available.has(name)) return;
        needed.add(name);
        const dir = path.join(distRoot, name);
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.d.ts'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf-8');
            for (const dep of scanFrameworkDeps(src)) add(dep);
        }
    }

    for (const r of requested) add(r);
    return [...needed].sort();
}

// ---- TypeScript AST transform ------------------------------------------

interface FileDecls {
    classNames: string[];  // exported class names found in this file
    text: string;          // declaration text with imports stripped + selectors renamed
}

function transformFileToDecls(source: string, filename: string): FileDecls {
    const classNames: string[] = [];
    const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

    const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
        const { factory } = ctx;

        function visitType(node: ts.Node): ts.Node {
            if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) &&
                node.typeName.text === 'NobjcObject') {
                return factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
            }
            return ts.visitEachChild(node, visitType, ctx);
        }

        function applyType<T extends ts.TypeNode>(n: T | undefined): T | undefined {
            return n ? ts.visitNode(n, visitType) as T : undefined;
        }

        function transformMember(member: ts.ClassElement): ts.ClassElement {
            if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
                const newName = normalizeSelector(member.name.text);
                const retType = applyType(member.type) ??
                    factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);

                if (member.parameters.length === 0) {
                    return factory.createPropertyDeclaration(
                        member.modifiers,
                        factory.createIdentifier(newName),
                        undefined, retType, undefined
                    );
                }
                const params = member.parameters.map(p =>
                    factory.updateParameterDeclaration(p, p.modifiers, p.dotDotDotToken,
                        p.name, p.questionToken, applyType(p.type), p.initializer)
                );
                return factory.updateMethodDeclaration(member, member.modifiers,
                    member.asteriskToken, factory.createIdentifier(newName),
                    member.questionToken, member.typeParameters, params, retType, member.body);
            }
            if (ts.isPropertyDeclaration(member)) {
                const newType = applyType(member.type);
                if (newType !== member.type)
                    return factory.updatePropertyDeclaration(member, member.modifiers,
                        member.name, member.questionToken ?? member.exclamationToken,
                        newType, member.initializer);
            }
            return member;
        }

        return (sf) => {
            const stmts: ts.Statement[] = [];
            for (const stmt of sf.statements) {
                // Drop all import declarations (types resolved by name in single file)
                if (ts.isImportDeclaration(stmt)) continue;

                if (ts.isClassDeclaration(stmt)) {
                    const name = stmt.name?.text ?? '';
                    if (name) classNames.push(name);
                    stmts.push(factory.updateClassDeclaration(stmt, stmt.modifiers,
                        stmt.name, stmt.typeParameters, stmt.heritageClauses,
                        stmt.members.map(transformMember)));
                    continue;
                }
                stmts.push(stmt as ts.Statement);
            }
            return factory.updateSourceFile(sf, stmts);
        };
    };

    const result = ts.transform(sf, [transformer]);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
    const text = printer.printFile(result.transformed[0] as ts.SourceFile);
    result.dispose();
    return { classNames, text };
}

// ---- JXA Application overloads (from @jxa/types) -----------------------

const JXA_APPS = [
    'Calendar', 'Contacts', 'Finder', 'FontBook', 'iTunes',
    'Keynote', 'Mail', 'Messages', 'Notes', 'Numbers', 'Pages',
    'Photos', 'QuickTimePlayer', 'Reminders', 'Safari',
    'ScriptEditor', 'SystemEvents', 'Terminal', 'TextEdit',
] as const;

// ---- main bundler ------------------------------------------------------

export interface BundleOptions {
    /** Framework names to include (transitive deps resolved automatically). */
    frameworks: string[];
    /** Include ALL 153 frameworks. Overrides `frameworks`. */
    all?: boolean;
}

export interface BundleResult {
    dts: string;
    warnings: string[];
}

export function bundle(opts: BundleOptions): BundleResult {
    const distRoot = getObjcjsRoot();
    const warnings: string[] = [];

    const frameworkNames = opts.all
        ? fs.readdirSync(distRoot, { withFileTypes: true })
            .filter(e => e.isDirectory() && e.name !== 'structs' && e.name !== 'delegates')
            .map(e => e.name)
        : resolveFrameworks(opts.frameworks);

    const lines: string[] = [];
    lines.push('// Generated by @devscholar/node-with-jxa-generator');
    lines.push(`// Frameworks: ${frameworkNames.sort().join(', ')}`);
    lines.push('// Do not edit — regenerate with: node-with-jxa-generator');
    lines.push('');

    // ---- structs (always included, no ObjC imports) --------------------
    const structsDir = path.join(distRoot, 'structs');
    if (fs.existsSync(structsDir)) {
        lines.push('// ---- Structs ----');
        for (const f of fs.readdirSync(structsDir).filter(f => f.endsWith('.d.ts') && f !== 'index.d.ts')) {
            let src = fs.readFileSync(path.join(structsDir, f), 'utf-8');
            src = src.replace(/import type \{[^}]+\} from ['"][^'"]+['"];\n?/g, '');
            lines.push(src.trim());
        }
        lines.push('');
    }

    // ---- framework class declarations ----------------------------------
    const allClasses: Array<{ key: string; className: string; framework: string }> = [];

    for (const fw of frameworkNames.sort()) {
        const dir = path.join(distRoot, fw);
        if (!fs.existsSync(dir)) { warnings.push(`Framework not found: ${fw}`); continue; }

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.d.ts') && f !== 'index.d.ts');
        if (files.length === 0) continue;

        lines.push(`// ---- ${fw} ----`);
        for (const f of files) {
            const src = fs.readFileSync(path.join(dir, f), 'utf-8');
            const { classNames, text } = transformFileToDecls(src, f);
            lines.push(text.trim());
            for (const className of classNames) {
                const key = className.startsWith('_') ? className.slice(1) : className;
                allClasses.push({ key, className, framework: fw });
            }
        }
        lines.push('');
    }

    // ---- globals -------------------------------------------------------
    lines.push('// ---- JXA Globals ----');
    lines.push('export {};'); // make this a module so declare global works
    lines.push('');
    lines.push('declare global {');
    lines.push('');
    lines.push('  interface ObjCSubclassSpec {');
    lines.push('    name: string;');
    lines.push('    superclass?: string;');
    lines.push('    protocols?: string[];');
    lines.push('    properties?: Record<string, { type: string; attrs?: string }>;');
    lines.push('    methods?: Record<string, { types: string; implementation(...args: any[]): any }>;');
    lines.push('  }');
    lines.push('');
    lines.push('  const ObjC: {');
    lines.push('    import(framework: string): void;');
    lines.push('    bindFunction(name: string, signature: [string, ...string[]]): void;');
    lines.push('    registerSubclass(spec: ObjCSubclassSpec): void;');
    lines.push('    unwrap<T = any>(value: any): T;');
    lines.push('    deepUnwrap<T = any>(value: any): T;');
    lines.push('    wrap<T = any>(value: T): any;');
    lines.push('    cast<T = any>(value: any, cls: any): T;');
    lines.push('  };');
    lines.push('');
    lines.push('  function Path(posixPath: string): any;');
    lines.push('  function delay(seconds: number): void;');
    lines.push('  function Ref(): any[];');
    lines.push('');

    for (const app of JXA_APPS) {
        lines.push(`  function Application(name: '${app}'): import('@jxa/types').${app}.Application;`);
    }
    lines.push('  function Application(name: string): any;');
    lines.push('');

    lines.push('  const $: {');
    for (const { key, className, framework } of allClasses) {
        lines.push(`    /** ${framework} */ ${key}: typeof ${className};`);
    }
    lines.push('    NSMakeRect(x: number, y: number, width: number, height: number): CGRect;');
    lines.push('    NSMakeSize(width: number, height: number): CGSize;');
    lines.push('    NSMakePoint(x: number, y: number): CGPoint;');
    lines.push('    NSMakeRange(location: number, length: number): NSRange;');
    lines.push('    [name: string]: any;');
    lines.push('  };');
    lines.push('');
    lines.push('}');

    return { dts: lines.join('\n'), warnings };
}
