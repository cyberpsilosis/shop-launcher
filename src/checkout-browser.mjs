// Pays on Stripe's hosted test Checkout with Playwright, as a buyer would:
// open the product page, tap Buy, fill Stripe's form with the test card
// 4242 4242 4242 4242, pay, and wait to land on /shop/thanks?session_id=...
//
// Field ids are Stripe Checkout's own (#email, #cardNumber, #cardExpiry,
// #cardCvc, #billingName, #shipping*). Playwright is loaded only in smoke
// mode, so plan and apply never need a browser.

export const TEST_CARD = { number: '4242 4242 4242 4242', expiry: '12 / 34', cvc: '123' };
const ADDRESS = { name: 'Smoke Test', line1: '510 Townsend St', city: 'San Francisco', zip: '94103', state: 'CA' };

export function playwrightBrowser({ headless = true, timeoutMs = 90000 } = {}) {
  return {
    async pay({ productUrl, email }) {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(timeoutMs);
        await page.goto(productUrl);
        await page.getByRole('button', { name: /buy/i }).first().click();
        await page.waitForURL(/checkout\.stripe\.com/);
        if (!/\/c\/pay\/cs_test_/.test(page.url())) throw new Error('Checkout is not a test-mode session');
        const fill = async (sel, v) => {
          const f = page.locator(sel);
          if (await f.count()) await f.first().fill(v);
        };
        await fill('#email', email);
        await fill('#shippingName', ADDRESS.name);
        await fill('#shippingAddressLine1', ADDRESS.line1);
        await fill('#shippingLocality', ADDRESS.city);
        await fill('#shippingPostalCode', ADDRESS.zip);
        const st = page.locator('#shippingAdministrativeArea');
        if (await st.count()) await st.selectOption(ADDRESS.state);
        const card = page.locator('[data-testid="card-accordion-item-button"]');
        if (await card.count()) await card.click();
        await fill('#cardNumber', TEST_CARD.number);
        await fill('#cardExpiry', TEST_CARD.expiry);
        await fill('#cardCvc', TEST_CARD.cvc);
        await fill('#billingName', ADDRESS.name);
        const same = page.locator('#sameAsShipping, input[name="sameAsShipping"]');
        if ((await same.count()) && !(await same.first().isChecked())) await same.first().check();
        await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
        await page.waitForURL(/\/shop\/thanks\?session_id=cs_test_/);
        return { sessionId: new URL(page.url()).searchParams.get('session_id') };
      } finally {
        await browser.close();
      }
    },
  };
}
