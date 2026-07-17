const { readFileSync } = require('node:fs');
const {
  readBarcodes,
  setZXingModuleOverrides
} = require('zxing-wasm/reader');

// Usa o binário local para não depender do CDN padrão do pacote em produção.
setZXingModuleOverrides({
  wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
});

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

const readBarcode = async (image) => {
  const results = await readBarcodes(image, {
    formats: ['Code128'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    tryDenoise: true,
    maxNumberOfSymbols: 4
  });
  return selectCteBarcode(results);
};

module.exports = { normalizeCteKey, selectCteBarcode, readBarcode };
