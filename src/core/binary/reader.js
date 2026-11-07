/**
 * MAJIN RE — byte reader.
 * Small, safe, and honest about bounds: it throws a typed error instead of
 * reading garbage past the end (the classic bug in quick PE parsers).
 */
export class BinError extends Error {
  constructor(msg, { code = 'binary_error', hint = null, offset = null } = {}) {
    super(msg);
    this.name = 'BinError';
    this.code = code;
    this.hint = hint;
    this.offset = offset;
  }
}

export class Reader {
  constructor(buf) {
    if (!Buffer.isBuffer(buf)) throw new BinError('the buffer is not a Buffer', { code: 'bad_input' });
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.size = buf.length;
  }

  need(off, len) {
    if (!Number.isInteger(off) || off < 0 || off + len > this.size) {
      throw new BinError(`read outside the file @${off}+${len} (size ${this.size})`, { code: 'oob', offset: off });
    }
    return this;
  }

  u8(off) {
    this.need(off, 1);
    return this.view.getUint8(off);
  }

  u16(off, le = true) {
    this.need(off, 2);
    return this.view.getUint16(off, le);
  }

  u32(off, le = true) {
    this.need(off, 4);
    return this.view.getUint32(off, le);
  }

  u64(off, le = true) {
    this.need(off, 8);
    return Number(this.view.getBigUint64(off, le));
  }

  i32(off, le = true) {
    this.need(off, 4);
    return this.view.getInt32(off, le);
  }

  bytes(off, len) {
    this.need(off, len);
    return this.buf.subarray(off, off + len);
  }

  str(off, max = 256, enc = 'latin1') {
    const start = off;
    let end = off;
    while (end < this.size && end - start < max && this.buf[end] !== 0) end += 1;
    return this.buf.toString(enc, off, end).replace(/\0+$/, '');
  }

  cstr(off, max = 4096) {
    let end = off;
    while (end < this.size && end - off < max && this.buf[end] !== 0) end += 1;
    return this.buf.toString('latin1', off, end);
  }

  /** Read until 4-byte alignment boundary past `off`. */
  align(off, n = 4) {
    return Math.ceil(off / n) * n;
  }

  slice(start, end) {
    return this.buf.subarray(Math.max(0, start), Math.min(this.size, end));
  }
}

/** Section lookup for RVA translation. */
export function makeRvaMapper(sections) {
  return function rvaToOffset(rva) {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    return -1;
  };
}

export function hex(buf, limit = 64) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const s = b.subarray(0, limit).toString('hex').replace(/../g, (m) => `${m} `);
  return `${s}${b.length > limit ? `… (${b.length} byte)` : ''}`.trim();
}

export function looksText(buf, n = 512) {
  let printable = 0;
  const len = Math.min(buf.length, n);
  for (let i = 0; i < len; i += 1) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc0) printable += 1;
  }
  return len > 0 && printable / len > 0.88;
}
