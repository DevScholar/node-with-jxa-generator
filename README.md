# @devscholar/node-with-jxa-generator

TypeScript type definition generator for JXA (JavaScript for Automation), designed for use with [`@devscholar/node-with-jxa`](https://www.npmjs.com/package/@devscholar/node-with-jxa).

Reads the macOS Objective-C framework metadata from [`objcjs-types`](https://www.npmjs.com/package/objcjs-types) (pre-generated from Apple SDK headers) and emits a single `.d.ts` file in **JXA camelCase style** — so your editor gives you IntelliSense when writing JXA scripts through the node-with-jxa bridge.

**Platform:** runs anywhere Node.js runs (the generator itself is cross-platform); the generated types describe macOS APIs.

---

## Installation

```bash
npm install --save-dev @devscholar/node-with-jxa-generator
```

Or run without installing:

```bash
npx @devscholar/node-with-jxa-generator -f Foundation AppKit -t ./types/jxa.d.ts
```

---

## CLI Usage

```
node-with-jxa-generator -f <frameworks...> -t <output.d.ts>
```

### Required

| Flag | Alias | Description |
|------|-------|-------------|
| `--framework <name...>` | `-f` | One or more framework names (e.g. `Foundation AppKit`) |
| `--typedefs <path>` | `-t` | Output `.d.ts` file path |

### Options

| Flag | Description |
|------|-------------|
| `--all` | Include all 153 frameworks (~20 MB output). Overrides `-f`. |
| `--list` | List all available framework names and exit |
| `--nowarn` | Suppress warnings |
| `-h, --help` | Show help |

Transitive dependencies are resolved automatically — specifying `AppKit` will also pull in `Foundation`, `CoreGraphics`, and the other frameworks AppKit depends on.

### Examples

```bash
# Foundation only
node-with-jxa-generator -f Foundation -t ./types/foundation.d.ts

# Foundation + AppKit (resolves ~32 dependent frameworks automatically)
node-with-jxa-generator -f Foundation AppKit -t ./types/cocoa.d.ts

# Everything
node-with-jxa-generator --all -t ./types/jxa-all.d.ts

# See what frameworks are available
node-with-jxa-generator --list
```

---

## Using the Generated Types

### 1. Generate the types file

```bash
npx @devscholar/node-with-jxa-generator -f Foundation AppKit -t ./types/jxa.d.ts
```

### 2. Reference it in `tsconfig.json`

```json
{
  "compilerOptions": {
    "types": ["./types/jxa"]
  }
}
```

Or with a triple-slash reference in individual files:

```ts
/// <reference path="./types/jxa.d.ts" />
```

### 3. Write JXA with full IntelliSense

```typescript
import { $, importFramework, unwrap } from '@devscholar/node-with-jxa';

importFramework('AppKit');

// $.NSAlert — typed as typeof _NSAlert
const alert = $.NSAlert.alloc.init;          // _NSAlert
alert.setMessageText('Hello from Node.js');  // (value: _NSString) => void
alert.addButtonWithTitle('OK');
const response = unwrap<number>(alert.runModal);   // number

// NSString
const s = $.NSString.stringWithUTF8String('hello');  // _NSString | null
const len = s!.length;                               // number (zero-arg → property)

// NSMutableArray
const arr = $.NSMutableArray.alloc.init;
arr.addObject($.NSString.stringWithUTF8String('alpha'));
console.log(unwrap<number>(arr.count));    // number
```

---

## ObjC Naming Convention

JXA maps Objective-C selectors to camelCase by concatenating all selector parts:

| Objective-C | JXA (generated type) |
|-------------|---------------------|
| `alloc` | `alloc` (zero-arg → property) |
| `init` | `init` (zero-arg → property) |
| `count` | `count` (zero-arg → property) |
| `stringWithUTF8String:` | `stringWithUTF8String(s)` |
| `initWithContentRect:styleMask:backing:defer:` | `initWithContentRectStyleMaskBackingDefer(...)` |
| `setTitle:` | `setTitle(value)` |

Zero-argument ObjC methods are declared as **properties** (not functions) in the generated types, matching JXA's auto-invocation behaviour.

---

## Globals

The generated file also declares these JXA globals:

```typescript
declare global {
    // ObjC class namespace — access any loaded class here
    const $: { NSString: typeof _NSString; NSWindow: typeof _NSWindow; ... };

    // ObjC runtime utilities
    const ObjC: {
        import(framework: string): void;
        registerSubclass(spec: ObjCSubclassSpec): void;
        bindFunction(name: string, signature: [string, ...string[]]): void;
        unwrap<T>(value: any): T;
        deepUnwrap<T>(value: any): T;
    };

    // JXA built-ins
    function Application(name: 'Finder'): import('@jxa/types').Finder.Application;
    function Application(name: 'Safari'): import('@jxa/types').Safari.Application;
    // ... all well-known apps from @jxa/types ...
    function Application(name: string): any;

    function Path(posixPath: string): any;
    function delay(seconds: number): void;
    function Ref(): any[];
}
```

`Application()` overloads for well-known macOS apps (Finder, Safari, Mail, …) come from [`@jxa/types`](https://www.npmjs.com/package/@jxa/types), which you need as a peer dependency if you use those overloads:

```bash
npm install --save-dev @jxa/types
```

---

## Programmatic API

```typescript
import { bundle, resolveFrameworks } from '@devscholar/node-with-jxa-generator';

// Resolve transitive dependencies
const allFrameworks = resolveFrameworks(['AppKit']);
// → ['AppKit', 'Foundation', 'CoreGraphics', ...]

// Generate a .d.ts string
const { dts, warnings } = bundle({ frameworks: ['Foundation', 'AppKit'] });
// or: bundle({ all: true })  — all 153 frameworks

for (const w of warnings) console.warn(w);
fs.writeFileSync('./types/jxa.d.ts', dts);
```

### `bundle(options)`

| Option | Type | Description |
|--------|------|-------------|
| `frameworks` | `string[]` | Framework names to include (transitive deps auto-resolved) |
| `all` | `boolean` | Include all frameworks. Overrides `frameworks`. |

Returns `{ dts: string, warnings: string[] }`.

---

## How It Works

1. [`objcjs-types`](https://www.npmjs.com/package/objcjs-types) ships pre-generated `.d.ts` files for all 153 macOS frameworks (5 400+ classes, auto-generated from Apple SDK headers via `clang -ast-dump=json`).
2. The generator reads those files and transforms them using the TypeScript compiler API:
   - Renames ObjC selectors from `$`-separated form to JXA camelCase (`foo$bar$` → `fooBar`)
   - Converts zero-parameter methods to properties (`count(): number` → `count: number`)
   - Replaces the `objc-js`-specific `NobjcObject` base type with `any`
   - Strips all `import` declarations — everything lives in one self-contained file
3. Transitive framework dependencies are resolved by scanning cross-framework `import` statements in the source `.d.ts` files.
4. A `declare global {}` block is appended with `$`, `ObjC`, `Application`, and other JXA built-ins.

---

## Coverage

Inherits objcjs-types coverage: **~5 400 classes, ~1 000 protocols, ~2 600 enums, ~100 structs** across **153 frameworks** including Foundation, AppKit, WebKit, Metal, AVFoundation, CoreData, and more.

---

## License

MIT — see [LICENSE](LICENSE).

Types data derived from [objcjs-types](https://github.com/nicholasgasior/objcjs-types) (MIT) and [@jxa/types](https://github.com/JXA-userland/JXA) (MIT).
