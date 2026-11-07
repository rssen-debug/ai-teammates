/**
 * MAJIN — the terminal banner.
 * The pixel M is `assets/majin.png` thresholded to 46x22 grey and folded two
 * pixels per text row, so an M still reads as an M in a console, then tidied by
 * hand. Colour is the same pink the window and the icon use; `ascii` and
 * `NO_COLOR` are the two ways it degrades on a terminal that cannot have nice
 * things.
 */
export const LOGO_ROWS = [
  '  ▄▄                            ▄▄  ',
  '   ▀████▄▄                 ▄████▀    ',
  '    ▀██████▄            ▄██████▀   ',
  '     ████ ▀▀█▄        ▄█▀▀ ████      ',
  '      ███    ██▄    ▄██    ███       ',
  '      ███     ▀██▄▄██▀     ███       ',
  '      ██▀█       ██▀█      ████      ',
  '   ▄▄███         ▀▀        ▄███▄▄▄  ',
  '  ▀▀   ▀▀                        ▀▀  ',
  '         ▄▄▄▄▄▄███████▄▄▄▄          ',
];

const TOP = [255, 143, 208];
const BOTTOM = [224, 92, 156];
const ESC = String.fromCharCode(27);

export function useColor(o = {}) {
  if (o.color === false) return false;
  return !process.env.NO_COLOR && !process.env.MAJIN_NO_COLOR;
}

/**
 * @param {object} [o]
 * @param {boolean} [o.color]  false (eller NO_COLOR) = inga ANSI-koder
 * @param {boolean} [o.ascii]  block byts mot # for konsoler utan Unicode
 * @param {number}  [o.indent] antal mellanslag fore varje rad
 */
export function logoArt(o = {}) {
  const color = useColor(o);
  const ascii = o.ascii === true || Boolean(process.env.MAJIN_ASCII);
  const pad = ' '.repeat(Math.max(0, Number(o.indent) || 0));
  const n = Math.max(1, LOGO_ROWS.length - 1);
  const lines = LOGO_ROWS.map((raw, i) => {
    const row = ascii ? raw.replace(/[▄▀█]/g, '#') : raw;
    if (!color) return pad + row;
    const t = i / n;
    const c = TOP.map((v, k) => Math.round(v + (BOTTOM[k] - v) * t)).join(';');
    return pad + ESC + '[38;2;' + c + 'm' + row + ESC + '[0m';
  });
  return lines.join('\n');
}

/** En kort rad under loggan: "MAJIN 0.1.0 · ready" osv. Farg follow färg-laget. */
export function tagline(text, o = {}) {
  if (!useColor(o)) return text;
  return ESC + '[38;2;255;143;208m' + text + ESC + '[0m';
}
