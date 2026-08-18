/**
 * A minimal ZIP writer — enough to hand someone a folder of statements.
 *
 * Store-only: no compression. The statements are small CSVs and the point of the
 * zip is that 96 files arrive as one download, not that they arrive smaller. That
 * keeps this to a CRC and two header records, with no dependency to add and
 * nothing to keep in step with a library's API.
 *
 * Pure: takes text, returns bytes. The caller wraps it in a Blob.
 */

export type ZipEntry = { name: string; text: string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time. Fixed, so the same input always produces the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = 0x2821; // 2000-01-01

class Writer {
  private parts: number[] = [];
  u16(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
  }
  u32(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  bytes(b: Uint8Array) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
  }
  get length() {
    return this.parts.length;
  }
  done(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(this.parts.length));
    out.set(this.parts);
    return out;
  }
}

/**
 * Names have to be unique inside the archive or a reader silently keeps one
 * file: two suppliers called "Le Balcon" on the same booking would collide.
 */
export function uniqueNames(entries: ZipEntry[]): ZipEntry[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const key = entry.name.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) return entry;
    const dot = entry.name.lastIndexOf(".");
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const ext = dot > 0 ? entry.name.slice(dot) : "";
    return { ...entry, name: `${stem} (${n + 1})${ext}` };
  });
}

export function zipStored(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const files = uniqueNames(entries);
  const local = new Writer();
  const central = new Writer();
  const offsets: number[] = [];

  for (const file of files) {
    const name = encoder.encode(file.name);
    // A BOM so Excel opens accented names and figures as UTF-8.
    const body = encoder.encode(`\uFEFF${file.text}`);
    const crc = crc32(body);
    offsets.push(local.length);

    local.u32(0x04034b50);
    local.u16(20); // version needed
    local.u16(0x0800); // UTF-8 names
    local.u16(0); // stored
    local.u16(DOS_TIME);
    local.u16(DOS_DATE);
    local.u32(crc);
    local.u32(body.length);
    local.u32(body.length);
    local.u16(name.length);
    local.u16(0);
    local.bytes(name);
    local.bytes(body);

    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(DOS_TIME);
    central.u16(DOS_DATE);
    central.u32(crc);
    central.u32(body.length);
    central.u32(body.length);
    central.u16(name.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(offsets[offsets.length - 1]);
    central.bytes(name);
  }

  const localBytes = local.done();
  const centralBytes = central.done();
  const end = new Writer();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(files.length);
  end.u16(files.length);
  end.u32(centralBytes.length);
  end.u32(localBytes.length);
  end.u16(0);
  const endBytes = end.done();

  const out = new Uint8Array(
    new ArrayBuffer(localBytes.length + centralBytes.length + endBytes.length),
  );
  out.set(localBytes, 0);
  out.set(centralBytes, localBytes.length);
  out.set(endBytes, localBytes.length + centralBytes.length);
  return out;
}
