import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto('http://127.0.0.1:3000/?force-load=true');
await page.click('#tab-transactions-btn');
await page.waitForSelector('#inline-add-cat');
await page.click('#inline-add-cat');
await page.waitForSelector('#category-modal');

const before = {
  preview: await page.locator('#selected-emoji-preview').textContent(),
  hidden: await page.locator('#custom-cat-emoji').inputValue()
};

await page.click('#emoji-picker-trigger');

const open1 = await page.locator('#emoji-picker-dropdown').evaluate((el) => {
  return !el.classList.contains('hidden');
});
const tabs = await page.locator('.emoji-tab').count();
const cells = await page.locator('.emoji-cell').count();

let afterTab = null;
if (tabs > 1) {
  await page.locator('.emoji-tab').nth(1).click();
  afterTab = await page.locator('.emoji-tab.active').textContent();
}

if (cells > 3) {
  await page.locator('.emoji-cell').nth(3).click();
}

const after = {
  preview: await page.locator('#selected-emoji-preview').textContent(),
  hidden: await page.locator('#custom-cat-emoji').inputValue(),
  dropdownHidden: await page.locator('#emoji-picker-dropdown').evaluate((el) => {
    return el.classList.contains('hidden');
  })
};

console.log(JSON.stringify({ before, open1, tabs, cells, afterTab, after }, null, 2));

await browser.close();
