import { chromium } from 'playwright';
// @ts-ignore - express types not needed for this test script
import express from 'express';

const app = express();
app.use(express.static('dist'));
const server = app.listen(3000, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', error => console.error('BROWSER ERROR:', error));

  try {
    await page.goto('http://localhost:3000');
    // Wait for a bit to let initialization happen
    await page.waitForTimeout(2000);
    console.log('App loaded successfully in browser test.');
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await browser.close();
    server.close();
  }
});
