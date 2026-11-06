export const supportsColor = (env: NodeJS.ProcessEnv = process.env, stream: { isTTY?: boolean } = process.stdout): boolean =>
  !env.NO_COLOR && env.TERM !== 'dumb' && Boolean(stream.isTTY);

export function palette(enabled: boolean) {
  const wrap = (code: string) => (text: string) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return { mint: wrap('38;2;126;231;196'), violet: wrap('38;2;167;139;250'), amber: wrap('38;2;246;196;83'), red: wrap('38;2;248;113;113'), dim: wrap('2'), bold: wrap('1') };
}
export function dots(color: boolean): string {
  const p = palette(color);
  return [p.mint('●'), p.mint('●'), p.violet('●'), p.amber('●'), p.violet('●')].join(' ');
}
export function box(title: string, lines: string[], color: boolean): string {
  const p = palette(color);
  const width = Math.max(title.length + 4, ...lines.map(l => stripAnsi(l).length + 2), 34);
  const top = p.dim('╭─ ') + p.bold(title) + ' ' + p.dim('─'.repeat(Math.max(0, width - stripAnsi(title).length - 3)) + '╮');
  const body = lines.map(l => p.dim('│ ') + l + ' '.repeat(Math.max(0, width - stripAnsi(l).length - 1)) + p.dim('│'));
  return [top, ...body, p.dim('╰' + '─'.repeat(width + 1) + '╯')].join('\n');
}
// eslint-disable-next-line no-control-regex
export function stripAnsi(text: string): string { return text.replace(/\x1b\[[0-9;]*m/g, ''); }
export function statusLine(label: string, ok: boolean, color: boolean, detail = ''): string {
  const p = palette(color);
  return `${ok ? p.mint('●') : p.amber('○')} ${label}${detail ? p.dim(' · ' + detail) : ''}`;
}
