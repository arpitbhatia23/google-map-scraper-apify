import { createPlaywrightRouter, Dataset } from 'crawlee';

const SELECTORS = {
    TITLE: 'h1',
    ADDRESS: '[data-item-id="address"]',
    PHONE_BTN: 'button[data-item-id^="phone:tel"]',
    PHONE_TEXT: 'div.Io6YTe',
    WEBSITE: '[data-item-id="authority"]',
    RATING: '[aria-label*="stars"]',
    REVIEWS: '[aria-label*="reviews"]',
} as const;

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
    log.info(`enqueueing new URLs`);
    await enqueueLinks({
        globs: ['https://www.google.com/maps/place/*'],
        label: 'detail',
    });
});

router.addHandler('detail', async ({ request, page }) => {
    try {
        // Extract all data in parallel with no logging overhead
        const results = await Promise.allSettled([
            page.locator(SELECTORS.TITLE).textContent().catch(() => null),
            page.locator(SELECTORS.ADDRESS).textContent().catch(() => null),
            extractPhoneFromDetail(page),
            page
                .locator(SELECTORS.WEBSITE)
                .textContent()
                .then((text) => text?.replace(/^[^\w]+/, '').trim() || null)
                .catch(() => null),
            page
                .locator(SELECTORS.RATING)
                .first()
                .getAttribute('aria-label')
                .catch(() => null),
            page
                .locator(SELECTORS.REVIEWS)
                .first()
                .textContent()
                .catch(() => null),
        ]);

        const [name, address, phone, website, rating, reviews] = results.map((r) =>
            r.status === 'fulfilled' ? r.value : null
        );

        // Push to dataset with normalized data
        await Dataset.pushData({
            url: request.loadedUrl,
            name,
            address,
            phone,
            website,
            rating,
            reviews,
        });
    } catch (error) {
        // Silent fail for faster performance
    }
});

// Optimized phone extraction helper
async function extractPhoneFromDetail(page: any): Promise<string | null> {
    try {
        const phoneButton = page.locator(SELECTORS.PHONE_BTN);
        const phoneText = await phoneButton
            .locator(SELECTORS.PHONE_TEXT)
            .first()
            .textContent()
            .catch(() => null);

        if (phoneText) return phoneText.trim();

        const ariaLabel = await phoneButton
            .first()
            .getAttribute('aria-label')
            .catch(() => null);
        return ariaLabel ? ariaLabel.replace(/^Phone:\s*/, '').trim() : null;
    } catch {
        return null;
    }
}
