import { chromium } from 'playwright';
// @ts-expect-error: express types not needed for this throwaway dev-only test script
import express from 'express';

// Phase 6 cleanup (no-explicit-any sweep): express has no types here (see
// ts-expect-error above), so every value off the module is typed `any`.
// This is a one-off dev script that lives outside the app bundle; disable
// the unsafe-assignment rule for the two downstream lines rather than
// pulling in @types/express for a throwaway.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
