import sharp from "sharp";
import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

async function convertDir(dir, { maxWidth, quality }) {
  const files = await readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".png")) continue;
    if (file.startsWith("logo")) continue;
    const inPath = path.join(dir, file);
    const outName = file.replace(/\.png$/, ".jpg");
    const outPath = path.join(dir, outName);
    const meta = await sharp(inPath).metadata();
    const resizeWidth = meta.width && meta.width > maxWidth ? maxWidth : meta.width;
    await sharp(inPath)
      .resize({ width: resizeWidth })
      .flatten({ background: "#000000" })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outPath);
    console.log(`${file} -> ${outName}`);
  }
}

// Logo: keep as PNG (crisp edges/text) but resize down + crop the noisy border margins
await mkdir(path.join(root, "public/images/brand"), { recursive: true });
const logoIn = path.join(root, "public/images/brand/logo.png");
const logoMeta = await sharp(logoIn).metadata();
console.log("logo meta", logoMeta.width, logoMeta.height);
await sharp(logoIn)
  .extract({
    left: Math.round(logoMeta.width * 0.06),
    top: Math.round(logoMeta.height * 0.1),
    width: Math.round(logoMeta.width * 0.88),
    height: Math.round(logoMeta.height * 0.8),
  })
  .resize({ width: 900 })
  .png({ quality: 90, compressionLevel: 9 })
  .toFile(path.join(root, "public/images/brand/logo-final.png"));

await convertDir(path.join(root, "public/images/brand"), { maxWidth: 1920, quality: 82 });
await convertDir(path.join(root, "public/images/food"), { maxWidth: 1200, quality: 82 });

console.log("done");
