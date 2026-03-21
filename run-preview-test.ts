import { chromium } from 'playwright';
import { preview } from 'vite';

async function run() {
  const server = await preview({
    preview: { port: 4173 }
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[Browser ${msg.type().toUpperCase()}]:`, msg.text());
    }
  });

  page.on('pageerror', error => {
    console.error(`[Browser UNCAUGHT EXCEPTION]:`, error);
  });

  console.log('Navigating to http://localhost:4173...');
  await page.goto('http://localhost:4173');
  
  // Wait a few seconds for initialization to complete
  await new Promise(r => setTimeout(r, 2000));
  
  await browser.close();
  server.httpServer.close();
  console.log('Test complete.');
}

run().catch(console.error);
