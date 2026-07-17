const sharp = require('sharp');
const {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource
} = require('@zxing/library');

const formats = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8
];

const hints = new Map([
  [DecodeHintType.POSSIBLE_FORMATS, formats],
  [DecodeHintType.TRY_HARDER, true]
]);

const MAX_SIDE = 1800;
const MAX_CROP_WIDTH = 2800;
const MAX_READING_MS = 25000;

const decodePipeline = async (pipeline) => {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const luminances = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const source = new RGBLuminanceSource(luminances, info.width, info.height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));

  try {
    const result = new MultiFormatReader().decode(bitmap, hints);
    const text = result.getText().trim();
    return text ? { text, format: BarcodeFormat[result.getBarcodeFormat()] } : null;
  } catch {
    return null;
  }
};

const readBarcode = async (image) => {
  const deadline = Date.now() + MAX_READING_MS;
  // Corrige EXIF uma única vez e limita imagens grandes antes das tentativas.
  const normalized = await sharp(image)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  const metadata = await sharp(normalized).metadata();
  if (!metadata.width || !metadata.height) return null;

  // Leitores 1D já testam a linha nos dois sentidos; 0° e 90° cobrem as
  // orientações relevantes sem repetir 180° e 270°.
  for (const angle of [90, 0]) {
    const swap = angle === 90;
    const width = swap ? metadata.height : metadata.width;
    const height = swap ? metadata.width : metadata.height;
    const regions = [
      null,
      // Comprovantes rodoviários normalmente trazem o código na faixa inferior.
      { top: 0.62, height: 0.36, margin: 0.05, upscale: true },
      { top: 0.58, height: 0.42 },
      { top: 0.32, height: 0.40 },
      { top: 0.08, height: 0.40 },
      { top: 0, height: 0.28 }
    ].map((region) => region && ({
      left: Math.floor(width * (region.margin ?? 0.03)),
      top: Math.floor(height * region.top),
      width: Math.floor(width * (1 - (region.margin ?? 0.03) * 2)),
      height: Math.min(Math.floor(height * region.height), height - Math.floor(height * region.top)),
      upscale: Boolean(region.upscale)
    }));

    for (const region of regions) {
      const thresholds = !region || region.upscale
        ? [undefined, 120, 155, 190]
        : [undefined, 165];
      for (const threshold of thresholds) {
        if (Date.now() >= deadline) return null;
        let pipeline = sharp(normalized).rotate(angle);
        if (region) pipeline = pipeline.extract(region);
        pipeline = pipeline
          .grayscale()
          .normalize()
          .sharpen({ sigma: 0.8 })
          .resize({
            width: region?.upscale
              ? Math.min(MAX_CROP_WIDTH, region.width * 2)
              : Math.min(MAX_SIDE, region ? Math.max(region.width, 1200) : width),
            withoutEnlargement: !region
          });
        if (threshold !== undefined) pipeline = pipeline.threshold(threshold);
        const decoded = await decodePipeline(pipeline);
        if (decoded) return decoded;
      }
    }
  }
  return null;
};

module.exports = { readBarcode };
