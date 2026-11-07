/** Narrow, conservative static recognition of argv forwarding via immutable locals. */
export function forwardsJoinedRuntimeThroughLocal(source) {
  const decl = /\bconst\s+([A-Za-z_]\w*)\s*=\s*process\.argv\.slice\s*\(\s*2\s*\)\s*;/g;
  for (const args of source.matchAll(decl)) {
    const a = args[1];
    const join = new RegExp(String.raw`\bconst\s+([A-Za-z_]\w*)\s*=\s*(?:${a}\.length\s*\?\s*)?${a}\.join\s*\(\s*(['"])\s\2\s*\)(?:\s*:\s*(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*;`, 'g');
    for (const value of source.matchAll(join)) {
      if (value.index <= args.index) continue;
      const v = value[1];
      const output = new RegExp(String.raw`(?:^|[;\n}])\s*(?:console\.(?:log|info)|process\.stdout\.write)\s*\(\s*respond\s*\(\s*${v}\s*\)`);
      if (output.test(source.slice(value.index + value[0].length))) return true;
    }
  }
  return false;
}
