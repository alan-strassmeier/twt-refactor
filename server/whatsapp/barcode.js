const { readFileSync } = require('node:fs');
const {
  readBarcodes,
  setZXingModuleOverrides
} = require('zxing-wasm/reader');
const sharp = require('sharp');

// Usa o binário local para não depender do CDN padrão do pacote em produção.
setZXingModuleOverrides({
  wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
});

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_ENHANCED_WIDTH = 3200;
const MAX_ENHANCED_PIXELS = 20_000_000;
const READER_OPTIONS = {
  formats: ['Code128'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: false,
  tryDenoise: false,
  minLineCount: 1,
  maxNumberOfSymbols: 20
};

const normalizeCteKey = (value) => {
  const text = String(value || '').trim();
  return /^\d{44}$/.test(text) ? text : null;
};

const selectCteBarcode = (results) => {
  const matches = results.flatMap((result) => {
    const text = result?.isValid ? normalizeCteKey(result.text) : null;
    return text ? [{ text, format: result.format }] : [];
  });
  const unique = [...new Map(matches.map((item) => [item.text, item])).values()];
  return unique.length === 1 ? unique[0] : null;
};

const scan = async (image, binarizer = 'LocalAverage') =>
  selectCteBarcode(await readBarcodes(image, {
    ...READER_OPTIONS,
    binarizer
  }));

const enhanceForBarcode = async (image) => {
  const source = sharp(image, {
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true
  });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Não foi possível identificar as dimensões da foto.');
  }
  const scale = Math.min(
    2,
    MAX_ENHANCED_WIDTH / metadata.width,
    Math.sqrt(MAX_ENHANCED_PIXELS / (metadata.width * metadata.height))
  );
  const width = Math.max(1, Math.round(metadata.width * scale));
  return source
    .rotate()
    .resize({ width, kernel: 'lanczos3' })
    .greyscale()
    .normalize()
    .sharpen({ sigma: 1 })
    .png()
    .toBuffer();
};

const readBarcode = async (image) => {
  const original = await scan(image);
  if (original) return original;

  const enhanced = await enhanceForBarcode(image);
  return await scan(enhanced) || scan(enhanced, 'GlobalHistogram');
};

module.exports = {
  normalizeCteKey,
  selectCteBarcode,
  enhanceForBarcode,
  readBarcode
};
