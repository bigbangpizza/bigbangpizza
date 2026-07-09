// Gera as versões WebP das logos a partir dos PNGs do repositório.
// Os PNGs permanecem intocados de propósito — servem de fallback no
// <picture> para navegadores sem suporte a WebP (ex.: Safari antigo).
const sharp = require('sharp');

const jobs = [
  { src: 'logo-hero.png', out: 'logo-hero.webp', maxWidth: 800, quality: 85 },
  { src: 'logo-header.png', out: 'logo-header.webp', maxWidth: 200, quality: 85 },
];

(async () => {
  for (const job of jobs) {
    const buffer = await sharp(job.src)
      .resize({ width: job.maxWidth, withoutEnlargement: true })
      .webp({ quality: job.quality })
      .toBuffer();
    require('fs').writeFileSync(job.out, buffer);
    console.log(`${job.out}: ${(buffer.length / 1024).toFixed(0)}KB`);
  }
})();
