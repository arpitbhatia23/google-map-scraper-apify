import { Actor, log } from 'apify';
import { PlaywrightCrawler, PlaywrightCrawlingContext } from 'crawlee';

interface Input {
    searchQuery: string;
    maxResults: number;
}

interface Business {
    name: string | null;
    address: string | null;
    rating: string | null;
    reviews: string | null;
    phone: string | null;
    website: string | null;
    category: string | null;
    url: string;
}

await Actor.init();
const input = (await Actor.getInput<Input>())!;

const { searchQuery, maxResults } = input;

const results: Business[] = [];
let collected = 0;

// Google Maps search URL
const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

log.info(`Starting search for: ${searchQuery}`);

const crawler = new PlaywrightCrawler({
    maxConcurrency: 2,
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    async requestHandler(ctx: PlaywrightCrawlingContext) {
        const { page, request, enqueueLinks } = ctx;

        // Detail Page Extraction
        if (request.userData.label === 'detail') {
            log.info(`Extracting: ${request.url}`);

            await page.waitForTimeout(1500);

            const name = await page
                .locator('h1')
                .textContent()
                .catch(() => null);
            const rating = await page
                .locator('span[aria-label*="stars"]')
                .first()
                .getAttribute('aria-label')
                .catch(() => null);
            const reviews = await page
                .locator('[aria-label*="reviews"]')
                .first()
                .textContent()
                .catch(() => null);
            const address = await page
                .locator('[data-item-id="address"]')
                .textContent()
                .catch(() => null);
            let phone: string | null = null;

            try {
                // Select any button whose data-item-id starts with phone:tel
                const phoneButton = page.locator('button[data-item-id^="phone:tel"]');

                // Extract the number from the inner div
                phone = await phoneButton.locator('div.Io6YTe').textContent();

                // If that fails, fallback to aria-label
                if (!phone) {
                    const ariaLabel = await phoneButton.getAttribute('aria-label');
                    if (ariaLabel) phone = ariaLabel.replace('Phone:', '').trim();
                }

                if (phone) phone = phone.trim();
            } catch (err) {
                phone = null;
            }

            let website = await page
                .locator('[data-item-id="authority"]')
                .textContent()
                .catch(() => null);
            website = website?.replace(/^[^\w]+/, '').trim() || null;
            const category = await page
                .locator('[jslog]')
                .nth(3)
                .textContent()
                .catch(() => null);

            results.push({
                name,
                address,
                rating,
                reviews,
                phone,
                website,
                category,
                url: request.url,
            });

            return;
        }

        // Search Page Logic
        log.info('Scrolling results...');

        for (let i = 0; i < 15; i++) {
            await page.mouse.wheel(0, 700);
            await page.waitForTimeout(800);
        }

        const placeLinks = await page.$$eval('a[href*="/maps/place/"]', (els) =>
            els.map((el) => (el as HTMLAnchorElement).href),
        );

        log.info(`Found ${placeLinks.length} place links`);

        for (const link of placeLinks) {
            if (collected >= maxResults) break;
            collected++;

            await enqueueLinks({
                urls: [link],
                userData: { label: 'detail' },
            });
        }
    },
});

await crawler.run([searchUrl]);

await Actor.pushData(results);
await Actor.exit();
