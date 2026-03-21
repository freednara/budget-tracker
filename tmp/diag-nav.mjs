import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto('http://127.0.0.1:3000/e2e-reset.html?skipOnboarding=1', {
  waitUntil: 'load',
});
await page.waitForFunction(
  () => document.body.dataset.reset === 'done' || document.body.dataset.reset === 'error'
);
console.log('reset', await page.locator('#reset-status').textContent());

await page.addInitScript(() => {
  window.__PW_TEST__ = true;
});

await page.goto('http://127.0.0.1:3000/?force-load=true', {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(1500);

console.log('ready', await page.evaluate(() => ({
  shell: window.__APP_SHELL_READY__,
  init: window.__APP_INITIALIZED__,
  progress: window.__APP_STARTUP_PROGRESS__ || null,
})));

await page.evaluate(() => {
  const button = document.getElementById('tab-transactions-btn');
  button?.click();
});
await page.waitForTimeout(500);

console.log('after', await page.evaluate(() => {
  const tabButton = document.getElementById('tab-transactions-btn');
  const transactionsTab = document.getElementById('tab-transactions');
  const amountInput = document.getElementById('amount');

  return {
    selected: tabButton?.getAttribute('aria-selected') ?? null,
    tabDisplay: transactionsTab ? getComputedStyle(transactionsTab).display : null,
    amountVisible: Boolean(amountInput && amountInput.offsetParent !== null),
  };
}));

await browser.close();
