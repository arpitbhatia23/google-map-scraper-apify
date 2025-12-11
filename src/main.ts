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

// Cache for compiled selectors
const SELECTORS = {
    PLACE_LINK: 'a[href*="/maps/place/"]',
    FEED: 'div[role="feed"]',
    TITLE: 'h1',
    RATING: 'span[aria-label*="stars"]',
    REVIEWS: '[aria-label*="reviews"]',
    ADDRESS: '[data-item-id="address"]',
    PHONE_BTN: 'button[data-item-id^="phone:tel"]',
    PHONE_TEXT: 'div.Io6YTe',
    WEBSITE: 'a[data-item-id="authority"]',
    CATEGORY: '[jslog]',
} as const;

await Actor.init();
const input = (await Actor.getInput<Input>())!;
const { searchQuery, maxResults } = input;

log.info(`Starting search for: ${searchQuery}`);

const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
const visited = new Set<string>();
let collected = 0;

const crawler = new PlaywrightCrawler({
    maxConcurrency: 10, // Aggressive parallelism for speed
    requestHandlerTimeoutSecs: 20,
    navigationTimeoutSecs: 15,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--no-sandbox',
                '--no-zygote',
                '--disable-extensions',
                '--disable-images',
                '--blink-settings=imagesEnabled=false',
                '--disable-css',
                '--disable-fonts',
                '--disable-default-apps',
                '--disable-plugins',
                '--disable-java',
                '--disable-sync',
            ],
        },
    },
    preNavigationHooks: [
        async ({ page }) => {
            // Aggressive resource blocking
            const blockedTypes = new Set([
                'image',
                'stylesheet',
                'font',
                'media',
                'ping',
                'manifest',
                'websocket',
                'other',
            ]);
            await page.route('**/*', (route) => {
                if (blockedTypes.has(route.request().resourceType())) {
                    route.abort();
                } else {
                    route.continue();
                }
            });
        },
    ],

    async requestHandler(ctx: PlaywrightCrawlingContext) {
        const { page, request, enqueueLinks } = ctx;

        // === Detail page extraction ===
        if (request.userData.label === 'detail') {
            try {
                await page.waitForSelector(SELECTORS.TITLE, { state: 'attached', timeout: 4000 });
            } catch (e) {
                return; // Fast fail on timeout
            }

            // Extract all data in parallel
            const [name, rating, reviews, address, phone, website, category] = await Promise.allSettled([
                page
                    .locator(SELECTORS.TITLE)
                    .textContent()
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
                page
                    .locator(SELECTORS.ADDRESS)
                    .textContent()
                    .catch(() => null),
                extractPhone(page),
                page
                    .locator(SELECTORS.WEBSITE)
                    .getAttribute('href')
                    .catch(() => null),
                page
                    .locator(SELECTORS.CATEGORY)
                    .nth(3)
                    .textContent()
                    .catch(() => null),
            ]).then((results) => results.map((r) => (r.status === 'fulfilled' ? r.value : null)));

            await Dataset.pushData({
                name,
                address,
                rating,
                reviews,
                phone: phone?.replace(/^[^\d+]+/, '').trim() || null,
                website: website?.replace(/^[^\w]+/, '').trim() || null,
                category,
                url: request.url,
            } as Business);

            collected++;
            return;
        }

        // === Search page logic ===
        try {
            await page.waitForSelector(SELECTORS.PLACE_LINK, { state: 'attached', timeout: 8000 });
        } catch (e) {
            return; // Fast fail
        }

        // Rapid scrolling - no logging overhead
        const scrollDiv = page.locator(SELECTORS.FEED).first();
        let lastHeight = 0;
        let stableCount = 0;
        const maxScrolls = 8; // Reduced scrolls

        for (let i = 0; i < maxScrolls; i++) {
            const currentCount = (await page.$$(SELECTORS.PLACE_LINK)).length;
            if (currentCount >= maxResults) break;

            await scrollDiv.evaluate((el) => el.scrollBy(0, 3500)); // Bigger scroll jumps
            await page.waitForTimeout(300); // Ultra-fast - 300ms only

            const newHeight = await scrollDiv.evaluate((el) => el.scrollHeight);
            if (newHeight === lastHeight) {
                stableCount++;
                if (stableCount >= 1) break; // Stop after 1 stable check
            } else {
                stableCount = 0;
            }
            lastHeight = newHeight;
        }

        // Batch extract links in parallel chunks
        const placeElements = page.locator(SELECTORS.PLACE_LINK);
        const count = await placeElements.count();
        const limit = Math.min(count, maxResults);
        const chunkSize = 20;
        const placeLinks: (string | null)[] = [];

        for (let i = 0; i < limit; i += chunkSize) {
            const chunk = await Promise.all(
                Array.from({ length: Math.min(chunkSize, limit - i) }, (_, j) =>
                    placeElements
                        .nth(i + j)
                        .getAttribute('href')
                        .catch(() => null),
                ),
            );
            placeLinks.push(...chunk);
        }

        const newLinks = placeLinks.filter((link): link is string => link !== null).slice(0, maxResults - visited.size);
        if (newLinks.length > 0) {
            newLinks.forEach((link) => visited.add(link));
            await enqueueLinks({
                urls: newLinks,
                userData: { label: 'detail' },
            });
        }
    },
});

// Helper function for phone extraction - optimized
async function extractPhone(page: any): Promise<string | null> {
    const phoneButton = page.locator(SELECTORS.PHONE_BTN);

    // Try to get phone from direct text content
    const phoneText = await phoneButton
        .locator(SELECTORS.PHONE_TEXT)
        .first()
        .textContent()
        .catch(() => null);

    if (phoneText) return phoneText;

    // Fallback to aria-label if direct text fails
    const ariaLabel = await phoneButton
        .first()
        .getAttribute('aria-label')
        .catch(() => null);
    return ariaLabel ? ariaLabel.replace(/^Phone:\s*/, '').trim() : null;
}

await crawler.run([searchUrl]);
await Actor.exit();
