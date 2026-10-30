import { test, expect } from '@playwright/test';

const row = {
  cik: '0000320193', symbol: 'AAPL', symbols: ['AAPL'], name: 'Apple Inc.', sector: 'Information Technology',
  price: 200, marketCap: 3000000000000, ttmNetIncome: 180000000000, earningsYield: 0.06,
  treasurySpread: 0.02, periodEnd: '2026-06-30', incomeMethod: 'SEC EDGAR NetIncomeLoss · 최근 4개 분기 합산',
  multiClass: false, classQuotes: [{ symbol: 'AAPL', price: 200, sharesOutstanding: 15000000000, marketCap: 3000000000000 }],
};
const screen = {
  generatedAt: '2026-10-30T10:00:00Z', treasury: { value: 4, date: '2026-10-29' },
  coverage: { universe: 503, issuers: 500, rowsWithComparableData: 2 },
  rows: [row, { ...row, cik: '0001652044', symbol: 'GOOG / GOOGL', symbols: ['GOOG', 'GOOGL'], name: 'Alphabet Inc.', sector: 'Communication Services', earningsYield: -0.01, treasurySpread: -0.05, ttmNetIncome: -30000000000, multiClass: true, classQuotes: [{ symbol: 'GOOG', price: 180, sharesOutstanding: 10, marketCap: 1800 }, { symbol: 'GOOGL', price: 179, sharesOutstanding: 20, marketCap: 3580 }] }],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { configured: { complete: true } } }));
  await page.route('**/api/screen?**', route => route.fulfill({ json: screen }));
});

test('search, filters, keyboard sorting, details and history', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#results-body tr')).toHaveCount(1);
  await page.locator('#above-only-toggle').uncheck();
  await expect(page.locator('#results-body tr')).toHaveCount(2);
  await page.locator('th[data-sort="earningsYield"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#results-body tr').first()).toContainText('Alphabet');
  await page.locator('#search-input').fill('apple');
  await expect(page.locator('#results-body tr')).toHaveCount(1);
  await page.locator('a[data-company]').click();
  await expect(page).toHaveURL(/\/company\/AAPL$/);
  await expect(page.locator('#company-view h1')).toHaveText('Apple Inc.');
  await expect(page.locator('#company-view')).toContainText('+2.00%p');
  await expect(page.getByRole('link', { name: /SEC 공시/ })).toHaveAttribute('href', /CIK=0000320193/);
  await page.goBack();
  await expect(page.locator('#search-input')).toHaveValue('apple');
  await expect(page.locator('#dashboard-view')).toBeVisible();
});

test('direct detail URL, reload and multiple share classes', async ({ page }) => {
  await page.goto('/company/GOOGL');
  await expect(page.locator('#company-view h1')).toHaveText('Alphabet Inc.');
  await expect(page.locator('.quote-item')).toHaveCount(2);
  await expect(page.locator('#company-view')).toContainText('-5.00%p');
  await page.reload();
  await expect(page.locator('#company-view h1')).toHaveText('Alphabet Inc.');
});

test('unknown company, failed refresh with retained data, and retry', async ({ page }) => {
  await page.goto('/company/UNKNOWN');
  await expect(page.getByRole('heading', { name: '비교 가능한 기업 데이터가 없습니다' })).toBeVisible();
  await page.goto('/company/AAPL');
  await expect(page.locator('#company-view h1')).toHaveText('Apple Inc.');
  await page.route('**/api/screen?**', route => route.fulfill({ status: 502, json: { error: '테스트 연결 실패' } }));
  await page.locator('[data-detail-refresh]').click();
  await expect(page.locator('.detail-status')).toContainText('마지막 수신 데이터를 표시합니다');
  await expect(page.locator('#company-view h1')).toHaveText('Apple Inc.');
  await page.reload();
  await expect(page.getByRole('heading', { name: '데이터를 불러오지 못했습니다' })).toBeVisible();
  await page.route('**/api/screen?**', route => route.fulfill({ json: screen }));
  await page.locator('[data-detail-refresh]').click();
  await expect(page.locator('#company-view h1')).toHaveText('Apple Inc.');
});

test('setup dialog and mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#results-body')).toContainText('Apple');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('a[data-company]').click();
  await expect(page.locator('#company-view h1')).toHaveText('Apple Inc.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.route('**/api/config', route => route.fulfill({ json: { configured: { complete: false } } }));
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('heading', { name: '데이터 연결이 필요합니다' })).toBeVisible();
});

test('screenshots for visual review', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto('/');
  await page.locator('#above-only-toggle').uncheck();
  await expect(page.locator('#results-body tr')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  await page.goto('/company/AAPL');
  await expect(page.locator('#company-view h1')).toHaveText('Apple Inc.');
  await page.screenshot({ path: 'test-results/company.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/company-mobile.png', fullPage: true });
});
