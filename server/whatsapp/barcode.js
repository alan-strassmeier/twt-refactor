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

const decodePipeline = async (pipeline) => {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const luminances = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const source = new RGBLuminanceSource(luminances, info.width, info.height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const hints = new Map([
    [DecodeHintType.POSSIBLE_FORMATS, formats],
    [DecodeHintType.TRY_HARDER, true]
  ]);

  try {
    const result = new MultiFormatReader().decode(bitmap, hints);
    const text = result.getText().trim();
    return text ? { text, format: BarcodeFormat[result.getBarcodeFormat()] } : null;
  } catch {
    return null;
  }
};

const readBarcode = async (image) => {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) return null;

  for (const angle of [0, 90, 180, 270]) {
    const swap = angle === 90 || angle === 270;
    const width = swap ? metadata.height : metadata.width;
    const height = swap ? metadata.width : metadata.height;
    const regions = [null];

    for (const topRatio of [0, 0.08, 0.2, 0.35, 0.5, 0.65]) {
      for (const margin of [0.05, 0.15]) {
        regions.push({
          left: Math.floor(width * margin),
          top: Math.floor(height * topRatio),
          width: Math.floor(width * (1 - margin * 2)),
          height: Math.min(Math.floor(height * 0.32), height - Math.floor(height * topRatio))
        });
      }
    }

    for (const region of regions) {
      for (const threshold of [undefined, 120, 155, 190]) {
        let pipeline = sharp(image).rotate(angle);
        if (region) pipeline = pipeline.extract(region);
        pipeline = pipeline
          .grayscale()
          .normalize()
          .sharpen({ sigma: 0.8 })
          .resize({ width: region ? region.width * 2 : width, withoutEnlargement: !region });
        if (threshold !== undefined) pipeline = pipeline.threshold(threshold);
        const decoded = await decodePipeline(pipeline);
        if (decoded) return decoded;
      }
    }
  }
  return null;
};

module.exports = { readBarcode };
