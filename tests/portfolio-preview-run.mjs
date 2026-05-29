/**
 * Browser test: portfolio preview with user's Telegram Desktop images.
 * Run: node tests/portfolio-preview-run.mjs
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const catalogPath = pathToFileURL(join(root, 'catalog.html')).href;
const IMAGE_DIR = 'C:/Users/OMOW/Downloads/Telegram Desktop';
const FILES = [
  'IMG-20260529-WA0000.jpg',
  '20260529_163459.jpg',
  'file_00000000fda071faa9077be2dcf37557.png',
  'IMG_20260525_090547_878.jpg',
];

async function readPreviewState(page) {
  return page.evaluate(() => ({
    count: _portfolioSlots.length,
    previews: Array.from(document.querySelectorAll('.portfolio-slot img')).map((img) => ({
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    })),
  }));
}

async function addFile(page, fileName) {
  await page.setInputFiles('#portfolioFileInput', join(IMAGE_DIR, fileName));
  await page.waitForTimeout(2000);
  return readPreviewState(page);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(catalogPath);
await page.evaluate(() => {
  resetPortfolioState();
  var chk = document.getElementById('portfolio_enabled');
  if (chk) {
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
  }
});

console.log('=== catalog.html: add each file once ===');
for (const file of FILES) {
  const state = await addFile(page, file);
  const ok = state.previews.every((p) => p.complete && p.naturalWidth > 0);
  console.log(file, 'slots=' + state.count, ok ? 'OK' : 'FAIL', JSON.stringify(state.previews));
}

console.log('\n=== catalog.html: duplicate 20260529_163459.jpg ===');
const dup = await addFile(page, '20260529_163459.jpg');
const dupOk = dup.previews.every((p) => p.complete && p.naturalWidth > 0);
console.log('slots=' + dup.count, dupOk ? 'OK' : 'FAIL', JSON.stringify(dup.previews));

console.log('\n=== catalog.html: duplicate file_00000000...png ===');
const dup2 = await addFile(page, 'file_00000000fda071faa9077be2dcf37557.png');
const dup2Ok = dup2.previews.every((p) => p.complete && p.naturalWidth > 0);
console.log('slots=' + dup2.count, dup2Ok ? 'OK' : 'FAIL', JSON.stringify(dup2.previews));

await browser.close();
