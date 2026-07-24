// Generates placeholder PWA icons (solid background + simple glyph) with zero
// external dependencies, using Node's built-in zlib for PNG encoding.
// Replace public/icons/*.png with real artwork any time; this script only
// exists so the project has valid icons out of the box.
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const BG = [17, 19, 24]; // #111318
const FG = [124, 154, 255]; // accent

function crc(buf) {
  return crc32(buf) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Draws a simple centered diamond (abstract "board piece" glyph).
function pixelAt(x, y, size, maskable) {
  const margin = maskable ? size * 0.28 : size * 0.18; // safe zone for maskable icons
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - margin;
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  return dx + dy <= r ? FG : BG;
}

function makePng(size, maskable) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y, size, maskable);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

const targets = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];

for (const t of targets) {
  writeFileSync(path.join(outDir, t.file), makePng(t.size, t.maskable));
  console.log(`generated public/icons/${t.file}`);
}
