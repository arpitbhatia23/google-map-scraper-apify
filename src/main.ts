import { Actor, Dataset, log } from 'apify';
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

log.info(`Starting search for: ${searchQuery}`);

const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
const visited = new Set<string>();
let collected = 0;

const crawler = new PlaywrightCrawler({
    maxConcurrency: 1,
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    async requestHandler(ctx: PlaywrightCrawlingContext) {
        const { page, request, enqueueLinks } = ctx;

        // === Detail page extraction ===
        if (request.userData.label === 'detail') {
            log.info(`Extracting: ${request.url}`);

            await page.waitForTimeout(1500); // small delay for dynamic content

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

            // Phone extraction
            let phone: string | null = null;
            try {
                const phoneButton = page.locator('button[data-item-id^="phone:tel"]');
                phone = await phoneButton
                    .locator('div.Io6YTe')
                    .textContent()
                    .catch(() => null);
                if (!phone) {
                    const ariaLabel = await phoneButton.getAttribute('aria-label');
                    if (ariaLabel) phone = ariaLabel.replace('Phone:', '').trim();
                }
                phone = phone?.replace(/^[^\d+]+/, '').trim() || null;
            } catch {
                phone = null;
            }

            // Website extraction
            let website = await page
                .locator('a[data-item-id="authority"]')
                .getAttribute('href')
                .catch(() => null);
            website = website?.replace(/^[^\w]+/, '').trim() || null;

            const category = await page
                .locator('[jslog]')
                .nth(3)
                .textContent()
                .catch(() => null);

            // Push data directly to dataset (memory efficient)
            await Dataset.pushData({
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

        // === Search page logic ===
        log.info('Scrolling search results...');
        for (let i = 0; i < 5; i++) {
            // reduced scroll for memory efficiency
            await page.mouse.wheel(0, 700);
            await page.waitForTimeout(800);
        }

        const placeLinks = await page.$$eval('a[href*="/maps/place/"]', (els) =>
            els.map((el) => (el as HTMLAnchorElement).href),
        );

        log.info(`Found ${placeLinks.length} place links`);

        for (const link of placeLinks) {
            if (collected >= maxResults) break;
            if (visited.has(link)) continue;
            visited.add(link);
            collected++;

            await enqueueLinks({ urls: [link], userData: { label: 'detail' } });
        }
    },
});

await crawler.run([searchUrl]);
log.info(`Crawling finished. Collected ${collected} places.`);

await Actor.exit();
