import { createPlaywrightRouter, Dataset } from 'crawlee';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
    log.info(`enqueueing new URLs`);
    await enqueueLinks({
        globs: ['https://www.google.com/maps/place/*'],
        label: 'detail',
    });
});

router.addHandler('detail', async ({ request, page, log }) => {
    log.info(`Extracting data from ${request.loadedUrl}`);

    // Name
    const name = (await page.locator('h1').textContent()) ?? null;

    // Address
    const address = (await page.locator('[data-item-id="address"]').textContent()) ?? null;

    // Phone
    let phone: string | null = null;
    const phoneButton = page.locator('button[data-item-id^="phone:tel"]');
    phone = await phoneButton
        .locator('div.Io6YTe')
        .textContent()
        .catch(() => null);
    if (phone) phone = phone.trim();

    // Website
    let website = await page
        .locator('[data-item-id="authority"]')
        .textContent()
        .catch(() => null);
    website = website?.replace(/^[^\w]+/, '').trim() || null;

    // Rating
    const rating = await page
        .locator('[aria-label*="stars"]')
        .getAttribute('aria-label')
        .catch(() => null);

    // Reviews
    const reviews = await page
        .locator('[aria-label*="reviews"]')
        .textContent()
        .catch(() => null);

    // Push to dataset
    await Dataset.pushData({
        url: request.loadedUrl,
        name,
        address,
        phone,
        website,
        rating,
        reviews,
    });
});
