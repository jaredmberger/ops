import { chromium } from 'playwright';

const TARGET = process.env.TARGET_URL || 'https://oceanliners.net/';
const SEARCH_TERM = 'Titanic';
const SYNTHETIC_TOKEN = process.env.CURATOR_SYNTHETIC_TOKEN || '';

if (!SYNTHETIC_TOKEN) {
  throw new Error('CURATOR_SYNTHETIC_TOKEN is required for the browser search journey.');
}

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({
  viewport: { width: 1365, height: 900 }
});

await page.route('**/tools/search/pagefind/**', async route => {
  const request = route.request();
  await route.continue({
    headers: {
      ...request.headers(),
      'x-curator-synthetic': SYNTHETIC_TOKEN
    }
  });
});

const started = Date.now();
const steps = [];
const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], pagefindResponses: [], searchStatus: null };

page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') {
    diagnostics.consoleErrors.push(`${message.type()}: ${message.text()}`.slice(0, 1200));
  }
});
page.on('pageerror', error => diagnostics.pageErrors.push(String(error?.message || error).slice(0, 1200)));
page.on('requestfailed', request => {
  const url = request.url();
  if (/oceanliners\.net|pagefind|search/i.test(url)) {
    diagnostics.failedRequests.push({ url, error: request.failure()?.errorText || 'request failed' });
  }
});
page.on('response', response => {
  const url = response.url();
  if (/\/tools\/search\/pagefind\//i.test(url)) {
    diagnostics.pagefindResponses.push({
      url,
      status: response.status(),
      contentType: response.headers()['content-type'] || null
    });
  }
});

async function step(id, name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    steps.push({ id, name, ok: true, durationMs: Date.now() - t0 });
  } catch (error) {
    steps.push({ id, name, ok: false, durationMs: Date.now() - t0, error: String(error?.message || error) });
    throw error;
  }
}

try {
  await step('open-homepage', 'Open homepage', async () => {
    const response = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response || !response.ok()) throw new Error(`Homepage HTTP ${response?.status() ?? 'no response'}`);
  });

  await step('find-search', 'Find homepage archive search', async () => {
    await page.locator('#home-archive-query').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#home-archive-search-form').waitFor({ state: 'visible', timeout: 15000 });
  });

  await step('run-search', `Search for ${SEARCH_TERM}`, async () => {
    await page.locator('#home-archive-query').fill(SEARCH_TERM);
    await page.locator('#home-archive-search-form').locator('button[type="submit"]').click();

    const result = page.locator('#home-archive-search-results .home-archive-search__result').first();
    const status = page.locator('#home-archive-search-status');
    await Promise.race([
      result.waitFor({ state: 'visible', timeout: 20000 }),
      status.waitFor({ state: 'visible', timeout: 20000 })
        .then(async () => {
          for (let i = 0; i < 40; i += 1) {
            const text = (await status.textContent() || '').trim();
            diagnostics.searchStatus = text;
            if (/could not load|no results/i.test(text)) throw new Error(`Homepage search reported: ${text}`);
            if (/result/i.test(text) && !/searching/i.test(text)) return;
            await page.waitForTimeout(500);
          }
          throw new Error(`Homepage search did not finish. Status: ${diagnostics.searchStatus || 'blank'}`);
        })
    ]);

    if (!(await result.isVisible().catch(() => false))) {
      diagnostics.searchStatus = (await status.textContent().catch(() => '') || '').trim();
      throw new Error(`No rendered search result. Status: ${diagnostics.searchStatus || 'blank'}`);
    }
  });

  await step('confirm-result', 'Confirm Titanic appears with a valid OceanLiners.net destination', async () => {
    const resultLinks = page.locator('#home-archive-search-results a');
    const count = await resultLinks.count();
    let matched = false;

    for (let i = 0; i < count; i += 1) {
      const link = resultLinks.nth(i);
      const text = (await link.textContent() || '').trim();
      const href = await link.getAttribute('href');
      if (!/titanic/i.test(text) || !href) continue;

      const destination = new URL(href, TARGET);
      if (destination.origin !== new URL(TARGET).origin) {
        throw new Error(`Titanic result points outside OceanLiners.net: ${destination.href}`);
      }
      if (!/titanic/i.test(destination.pathname)) {
        throw new Error(`Titanic result has an unexpected destination: ${destination.pathname}`);
      }

      matched = true;
      break;
    }

    if (!matched) {
      throw new Error('No Titanic result with a valid OceanLiners.net destination appeared in the rendered homepage results.');
    }
  });

  console.log(JSON.stringify({ ok: true, target: TARGET, searchTerm: SEARCH_TERM, durationMs: Date.now() - started, steps, diagnostics }, null, 2));
} catch (error) {
  diagnostics.searchStatus = diagnostics.searchStatus || (await page.locator('#home-archive-search-status').textContent().catch(() => '') || '').trim() || null;
  console.error(JSON.stringify({ ok: false, target: TARGET, searchTerm: SEARCH_TERM, durationMs: Date.now() - started, error: String(error?.message || error), url: page.url(), steps, diagnostics }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
