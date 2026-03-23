import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const GENERATED_DIR = path.join(PROJECT_ROOT, 'assets', 'generated');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'assets', 'trimmed');

const TARGET_SIZE = 32;
const WHITE_THRESHOLD = 248;

function isBackground(r, g, b, a) {
  if (a < 10) return true;
  return r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD;
}

async function processSprite(inputPath) {
  const meta = await sharp(inputPath).metadata();
  const { width, height } = meta;
  const blockSize = width / TARGET_SIZE;

  const { data: srcData } = await sharp(inputPath)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const outBuf = Buffer.alloc(TARGET_SIZE * TARGET_SIZE * 4);
  let opaqueCount = 0;

  for (let ty = 0; ty < TARGET_SIZE; ty++) {
    for (let tx = 0; tx < TARGET_SIZE; tx++) {
      const sx = Math.floor(tx * blockSize + blockSize / 2);
      const sy = Math.floor(ty * blockSize + blockSize / 2);
      const si = (sy * width + sx) * 4;

      const r = srcData[si];
      const g = srcData[si + 1];
      const b = srcData[si + 2];
      const a = srcData[si + 3];

      const oi = (ty * TARGET_SIZE + tx) * 4;

      if (isBackground(r, g, b, a)) {
        outBuf[oi] = 0;
        outBuf[oi + 1] = 0;
        outBuf[oi + 2] = 0;
        outBuf[oi + 3] = 0;
      } else {
        outBuf[oi] = r;
        outBuf[oi + 1] = g;
        outBuf[oi + 2] = b;
        outBuf[oi + 3] = 255;
        opaqueCount++;
      }
    }
  }

  const filename = path.basename(inputPath);
  const outputPath = path.join(OUTPUT_DIR, filename);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  await sharp(outBuf, {
    raw: { width: TARGET_SIZE, height: TARGET_SIZE, channels: 4 }
  })
    .png()
    .toFile(outputPath);

  console.log(`  ${width}x${height} -> ${TARGET_SIZE}x${TARGET_SIZE}  |  ${opaqueCount}/${TARGET_SIZE * TARGET_SIZE} opaque pixels`);
  console.log(`  -> ${outputPath}`);
  return outputPath;
}

async function main() {
  const args = process.argv.slice(2);

  let files;
  if (args.length > 0 && !args[0].startsWith('--')) {
    const target = args[0];
    const fullPath = path.isAbsolute(target) ? target : path.join(GENERATED_DIR, target);
    if (!fs.existsSync(fullPath)) {
      console.error(`File not found: ${fullPath}`);
      process.exit(1);
    }
    files = [fullPath];
  } else {
    const all = fs.readdirSync(GENERATED_DIR)
      .filter(f => f.endsWith('.png'))
      .sort()
      .map(f => path.join(GENERATED_DIR, f));

    if (args.includes('--latest')) {
      files = all.length ? [all[all.length - 1]] : [];
    } else {
      files = all;
    }
  }

  if (files.length === 0) {
    console.log('No PNG files found in', GENERATED_DIR);
    process.exit(0);
  }

  console.log(`Processing ${files.length} sprite(s)...\n`);

  for (const file of files) {
    console.log(path.basename(file));
    await processSprite(file);
    console.log();
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
