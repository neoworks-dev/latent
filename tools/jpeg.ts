// Baseline JPEG encoder, ~250 lines, used only by the mock engine: `catalog.thumbnail`
// must answer with real JPEG bytes in an LTHM frame, and the client must be able to hand
// those bytes to the browser as an image Blob. A fixed JPEG blob would have done, but a
// real encoder lets every mock photo get its own picture, which is what makes the
// filmstrip screenshot worth looking at.
//
// 4:4:4, no subsampling, Annex K Huffman tables. Not fast, not clever — correct.

/** JPEG zig-zag scan: coefficient k of the scan is this index of the natural 8×8 order. */
const zigZag = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const luminanceQuant = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const chrominanceQuant = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const dcLuminanceBits = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const dcChrominanceBits = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const dcValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const acLuminanceBits = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const acLuminanceValues = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const acChrominanceBits = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const acChrominanceValues = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** code + length per symbol, built from a table's BITS/HUFFVAL the way Annex C does. */
type HuffmanTable = Map<number, { code: number; length: number }>;

function buildHuffmanTable(bits: number[], values: number[]): HuffmanTable {
  const table: HuffmanTable = new Map();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    const count = bits[length - 1] ?? 0;
    for (let n = 0; n < count; n++) {
      const symbol = values[index++];
      if (symbol === undefined) throw new Error("huffman table: fewer values than bits promise");
      table.set(symbol, { code, length });
      code += 1;
    }
    code <<= 1;
  }
  return table;
}

const dcLuminance = buildHuffmanTable(dcLuminanceBits, dcValues);
const dcChrominance = buildHuffmanTable(dcChrominanceBits, dcValues);
const acLuminance = buildHuffmanTable(acLuminanceBits, acLuminanceValues);
const acChrominance = buildHuffmanTable(acChrominanceBits, acChrominanceValues);

/** Scaled quantisation table, natural order, as the DQT segment and the divisor. */
function scaleQuant(base: number[], quality: number): number[] {
  const clamped = Math.min(100, Math.max(1, quality));
  const factor = clamped < 50 ? 5000 / clamped : 200 - clamped * 2;
  return base.map((value) => {
    const scaled = Math.round((value * factor + 50) / 100);
    return Math.min(255, Math.max(1, scaled));
  });
}

const cosine: number[] = [];
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) cosine[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
}

/** Separable float DCT-II on an 8×8 block. Clear beats fast for a 256 px thumbnail. */
function forwardDct(block: Float64Array): Float64Array {
  const rows = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += (block[y * 8 + x] ?? 0) * (cosine[u * 8 + x] ?? 0);
      rows[y * 8 + u] = sum * (u === 0 ? Math.SQRT1_2 : 1);
    }
  }
  const out = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += (rows[y * 8 + u] ?? 0) * (cosine[v * 8 + y] ?? 0);
      out[v * 8 + u] = (sum * (v === 0 ? Math.SQRT1_2 : 1)) / 4;
    }
  }
  return out;
}

class BitWriter {
  readonly bytes: number[] = [];
  private accumulator = 0;
  private bitCount = 0;

  byte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  word(value: number): void {
    this.byte(value >> 8);
    this.byte(value);
  }

  /** Writes `length` low bits, MSB first, stuffing 0x00 after every emitted 0xFF. */
  bits(code: number, length: number): void {
    for (let index = length - 1; index >= 0; index--) {
      this.accumulator = (this.accumulator << 1) | ((code >> index) & 1);
      this.bitCount += 1;
      if (this.bitCount < 8) continue;
      const full = this.accumulator & 0xff;
      this.byte(full);
      if (full === 0xff) this.byte(0x00);
      this.accumulator = 0;
      this.bitCount = 0;
    }
  }

  /** Pads the final partial byte with 1-bits, as the standard requires before EOI. */
  flush(): void {
    while (this.bitCount > 0) this.bits(1, 1);
  }
}

function symbol(table: HuffmanTable, key: number): { code: number; length: number } {
  const entry = table.get(key);
  if (!entry) throw new Error(`huffman symbol ${key} is not in the table`);
  return entry;
}

/** Bit length of a DC difference or AC value, i.e. its JPEG "category". */
function category(value: number): number {
  let magnitude = Math.abs(value);
  let bits = 0;
  while (magnitude > 0) {
    magnitude >>= 1;
    bits += 1;
  }
  return bits;
}

function writeValue(writer: BitWriter, value: number, bits: number): void {
  if (bits === 0) return;
  const encoded = value < 0 ? value + (1 << bits) - 1 : value;
  writer.bits(encoded, bits);
}

/** Encodes one quantised block and returns its DC for the next block's difference. */
function writeBlock(
  writer: BitWriter,
  block: Float64Array,
  quant: number[],
  dcTable: HuffmanTable,
  acTable: HuffmanTable,
  previousDc: number,
): number {
  const coefficients = forwardDct(block);
  const quantised = zigZag.map((natural) =>
    Math.round((coefficients[natural] ?? 0) / (quant[natural] ?? 1)),
  );

  const dc = quantised[0] ?? 0;
  const diff = dc - previousDc;
  const diffBits = category(diff);
  const dcCode = symbol(dcTable, diffBits);
  writer.bits(dcCode.code, dcCode.length);
  writeValue(writer, diff, diffBits);

  let lastNonZero = 0;
  for (let index = 63; index > 0; index--) {
    if (quantised[index] !== 0) {
      lastNonZero = index;
      break;
    }
  }

  let run = 0;
  for (let index = 1; index <= lastNonZero; index++) {
    const value = quantised[index] ?? 0;
    if (value === 0) {
      run += 1;
      continue;
    }
    while (run >= 16) {
      const zrl = symbol(acTable, 0xf0);
      writer.bits(zrl.code, zrl.length);
      run -= 16;
    }
    const valueBits = category(value);
    const acCode = symbol(acTable, (run << 4) | valueBits);
    writer.bits(acCode.code, acCode.length);
    writeValue(writer, value, valueBits);
    run = 0;
  }
  if (lastNonZero < 63) {
    const eob = symbol(acTable, 0x00);
    writer.bits(eob.code, eob.length);
  }
  return dc;
}

function writeHuffmanSegment(
  writer: BitWriter,
  id: number,
  bits: number[],
  values: number[],
): void {
  writer.word(0xffc4);
  writer.word(3 + bits.length + values.length);
  writer.byte(id);
  for (const count of bits) writer.byte(count);
  for (const value of values) writer.byte(value);
}

/**
 * Encodes tightly-packed rgba8 pixels as a baseline JPEG. `quality` is the usual 1–100
 * scale; 70 is a good thumbnail.
 */
export function encodeJpeg(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  quality = 70,
): Uint8Array {
  if (width <= 0 || height <= 0) throw new Error("jpeg: empty image");
  if (pixels.length < width * height * 4) throw new Error("jpeg: pixel buffer too short");
  const luminance = scaleQuant(luminanceQuant, quality);
  const chrominance = scaleQuant(chrominanceQuant, quality);
  const writer = new BitWriter();

  writer.word(0xffd8); // SOI

  writer.word(0xffe0); // APP0 / JFIF
  writer.word(16);
  for (const character of "JFIF") writer.byte(character.charCodeAt(0));
  writer.byte(0);
  writer.word(0x0101); // version 1.1
  writer.byte(0); // no density units
  writer.word(1);
  writer.word(1);
  writer.byte(0);
  writer.byte(0);

  for (const [id, table] of [
    [0, luminance],
    [1, chrominance],
  ] as const) {
    writer.word(0xffdb); // DQT
    writer.word(67);
    writer.byte(id);
    for (const natural of zigZag) writer.byte(table[natural] ?? 1);
  }

  writer.word(0xffc0); // SOF0, baseline, 3 components, 4:4:4
  writer.word(17);
  writer.byte(8);
  writer.word(height);
  writer.word(width);
  writer.byte(3);
  for (const [id, quantId] of [
    [1, 0],
    [2, 1],
    [3, 1],
  ] as const) {
    writer.byte(id);
    writer.byte(0x11);
    writer.byte(quantId);
  }

  writeHuffmanSegment(writer, 0x00, dcLuminanceBits, dcValues);
  writeHuffmanSegment(writer, 0x10, acLuminanceBits, acLuminanceValues);
  writeHuffmanSegment(writer, 0x01, dcChrominanceBits, dcValues);
  writeHuffmanSegment(writer, 0x11, acChrominanceBits, acChrominanceValues);

  writer.word(0xffda); // SOS
  writer.word(12);
  writer.byte(3);
  for (const [id, tables] of [
    [1, 0x00],
    [2, 0x11],
    [3, 0x11],
  ] as const) {
    writer.byte(id);
    writer.byte(tables);
  }
  writer.byte(0);
  writer.byte(63);
  writer.byte(0);

  const y = new Float64Array(64);
  const cb = new Float64Array(64);
  const cr = new Float64Array(64);
  let dcY = 0;
  let dcCb = 0;
  let dcCr = 0;

  for (let blockY = 0; blockY < height; blockY += 8) {
    for (let blockX = 0; blockX < width; blockX += 8) {
      for (let row = 0; row < 8; row++) {
        // Edge blocks repeat the last row/column instead of padding with black.
        const sampleY = Math.min(height - 1, blockY + row);
        for (let column = 0; column < 8; column++) {
          const sampleX = Math.min(width - 1, blockX + column);
          const offset = (sampleY * width + sampleX) * 4;
          const red = pixels[offset] ?? 0;
          const green = pixels[offset + 1] ?? 0;
          const blue = pixels[offset + 2] ?? 0;
          const index = row * 8 + column;
          y[index] = 0.299 * red + 0.587 * green + 0.114 * blue - 128;
          cb[index] = -0.168736 * red - 0.331264 * green + 0.5 * blue;
          cr[index] = 0.5 * red - 0.418688 * green - 0.081312 * blue;
        }
      }
      dcY = writeBlock(writer, y, luminance, dcLuminance, acLuminance, dcY);
      dcCb = writeBlock(writer, cb, chrominance, dcChrominance, acChrominance, dcCb);
      dcCr = writeBlock(writer, cr, chrominance, dcChrominance, acChrominance, dcCr);
    }
  }

  writer.flush();
  writer.word(0xffd9); // EOI
  return Uint8Array.from(writer.bytes);
}
