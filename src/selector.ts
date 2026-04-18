// src/selector.ts
// Converts an objcjs-types ObjC selector ($ as separator) to JXA camelCase.
//
// ObjC:          initWithContentRect:styleMask:backing:defer:
// objcjs-types:  initWithContentRect$styleMask$backing$defer$
// JXA (output):  initWithContentRectStyleMaskBackingDefer
//
// Names without $ pass through unchanged.

export function normalizeSelector(name: string): string {
    if (name.indexOf('$') < 0) return name;
    const parts = name.split('$').filter(p => p.length > 0);
    if (parts.length === 0) return name;
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        out += p.charAt(0).toUpperCase() + p.slice(1);
    }
    return out;
}
