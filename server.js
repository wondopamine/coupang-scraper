const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Mobile user agents - less likely to be blocked
const MOBILE_UAS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
  ];

// Desktop user agents as fallback
const DESKTOP_UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'
  ];

function getRandomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractProductId(url) {
    const match = url.match(/\/products\/(\d+)/);
    return match ? match[1] : null;
}

// Convert desktop URL to mobile URL
function toMobileUrl(url) {
    return url.replace('www.coupang.com', 'm.coupang.com');
}

// Strategy 1: Mobile site scraping (less protected)
async function scrapeMobile(url) {
    const mobileUrl = toMobileUrl(url);
    const ua = getRandomItem(MOBILE_UAS);

  console.log('[Strategy 1] Mobile scrape:', mobileUrl);

  const response = await axios.get(mobileUrl, {
        headers: {
                'User-Agent': ua,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0'
        },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500
  });

  return parseHtml(response.data, url);
}

// Strategy 2: Desktop with session cookies
async function scrapeDesktop(url) {
    const ua = getRandomItem(DESKTOP_UAS);

  console.log('[Strategy 2] Desktop scrape with session');

  // First get session cookies from homepage
  let cookies = '';
    try {
          const homeResp = await axios.get('https://www.coupang.com/', {
                  headers: {
                            'User-Agent': ua,
                            'Accept': 'text/html,application/xhtml+xml',
                            'Accept-Language': 'ko-KR,ko;q=0.9'
                  },
                  timeout: 10000,
                  maxRedirects: 3,
                  validateStatus: () => true
          });
          const setCookie = homeResp.headers['set-cookie'];
          if (setCookie) {
                  cookies = setCookie.map(c => c.split(';')[0]).join('; ');
          }
    } catch (e) {
          console.log('Cookie prefetch failed:', e.message);
    }

  await sleep(1000 + Math.random() * 2000);

  const response = await axios.get(url, {
        headers: {
                'User-Agent': ua,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Referer': 'https://www.coupang.com/np/search?q=mouse&channel=user',
                'Cookie': cookies,
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="122", "Google Chrome";v="122"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
        },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500
  });

  return parseHtml(response.data, url);
}

// Strategy 3: Use Coupang's share/SDLink endpoint
async function scrapeViaShare(url) {
    const productId = extractProductId(url);
    if (!productId) throw new Error('No product ID found');

  console.log('[Strategy 3] Share endpoint for product:', productId);

  // Try the share page which often has less protection
  const shareUrl = `https://m.coupang.com/vm/products/${productId}`;
    const ua = getRandomItem(MOBILE_UAS);

  const response = await axios.get(shareUrl, {
        headers: {
                'User-Agent': ua,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9',
                'Referer': 'https://m.coupang.com/',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500
  });

  return parseHtml(response.data, url);
}

// Parse HTML and extract product data
function parseHtml(html, originalUrl) {
    const $ = cheerio.load(html);
    const htmlLen = html.length;

  // Check for access denied
  const bodyText = $('body').text().toLowerCase();
    const isBlocked = bodyText.includes('access denied') || 
                          bodyText.includes('차단') ||
                          bodyText.includes('접근이 거부') ||
                          htmlLen < 5000;

  // Extract product name from multiple sources
  let productName = '';
    const nameSelectors = [
          'h1.prod-buy-header__title',
          '.prod-buy-header__title',
          'h2.prod-buy-header__title',
          '.product-title',
          'h1[class*="title"]',
          'h2[class*="title"]',
          '.prod-title',
          'h1',
          'title'
        ];

  for (const sel of nameSelectors) {
        const val = $(sel).first().text().trim();
        if (val && val.length > 2 && !val.toLowerCase().includes('access denied') && !val.toLowerCase().includes('coupang')) {
                productName = val.replace(/ : 쿠팡$/, '').replace(/ - 쿠팡!$/, '').trim();
                break;
        }
  }

  // Try og:title as fallback
  if (!productName) {
        const ogTitle = $('meta[property="og:title"]').attr('content') || '';
        if (ogTitle && ogTitle.length > 2 && !ogTitle.toLowerCase().includes('access denied')) {
                productName = ogTitle.replace(/ : 쿠팡$/, '').replace(/ - 쿠팡!$/, '').trim();
        }
  }

  // Extract price
  let priceKRW = 0;
    const priceSelectors = [
          '.total-price strong',
          '.total-price',
          '[class*="price-value"]',
          '[class*="total-price"]',
          '.prod-coupon-price .price',
          '.prod-price .price',
          'strong.price',
          '[class*="sale-price"]',
          'meta[property="product:price:amount"]'
        ];

  for (const sel of priceSelectors) {
        if (sel.includes('meta')) {
                const content = $(sel).attr('content');
                if (content) {
                          const num = parseInt(content.replace(/[^0-9]/g, ''));
                          if (num > 0) { priceKRW = num; break; }
                }
        } else {
                const text = $(sel).first().text().trim();
                const num = parseInt(text.replace(/[^0-9]/g, ''));
                if (num > 100) { priceKRW = num; break; }
        }
  }

  // Extract description
  const description = $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        $('.prod-description').text().trim().slice(0, 500) || '';

  // Extract images
  const mainImages = [];
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) mainImages.push(ogImage.startsWith('//') ? 'https:' + ogImage : ogImage);

  // Product gallery images
  $('[class*="prod-image"] img, [class*="thumbnail"] img, .prod-img img, [class*="gallery"] img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
        if (src) {
                const full = src.startsWith('//') ? 'https:' + src : src;
                if (!mainImages.includes(full) && full.includes('http')) {
                          mainImages.push(full);
                }
        }
  });

  // Detail/description images
  const detailImages = [];
    $('#productDetailContent img, [class*="detail"] img, [id*="detail"] img, .product-detail-content img').each((i, el) => {
          const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
          if (src) {
                  const full = src.startsWith('//') ? 'https:' + src : src;
                  if (!detailImages.includes(full) && full.includes('http')) {
                            detailImages.push(full);
                  }
          }
    });

  // All images fallback
  const allImages = [...mainImages, ...detailImages];
    if (allImages.length === 0) {
          $('img').each((i, el) => {
                  const src = $(el).attr('src') || $(el).attr('data-src');
                  if (src) {
                            const full = src.startsWith('//') ? 'https:' + src : src;
                            if (full.includes('http') && !full.includes('icon') && !full.includes('logo') && !full.includes('1x1') && !allImages.includes(full)) {
                                        allImages.push(full);
                            }
                  }
          });
    }

  // Rating
  const ratingText = $('[class*="rating"] .star-score, [class*="rating"] span, .star-score').first().text().trim();
    const rating = parseFloat(ratingText) || 0;

  // Review count
  const reviewText = $('[class*="review-count"], [class*="count-area"], .review-count').first().text().trim();
    const reviewCount = parseInt(reviewText.replace(/[^0-9]/g, '')) || 0;

  return {
        productName,
        priceKRW,
        description: description.slice(0, 500),
        mainImages: mainImages.slice(0, 10),
        detailImages: detailImages.slice(0, 20),
        allDetailImages: allImages.slice(0, 30),
        rating,
        reviewCount,
        htmlLength: htmlLen,
        isBlocked
  };
}

// Main scrape function with multiple strategies
async function scrapeCoupang(url) {
    const productId = extractProductId(url);
    const strategies = [scrapeMobile, scrapeDesktop, scrapeViaShare];

  for (let i = 0; i < strategies.length; i++) {
        try {
                const result = await strategies[i](url);

          // Check if we got real data
          if (result.productName && !result.isBlocked) {
                    console.log(`Strategy ${i + 1} succeeded! Product: ${result.productName}`);
                    return {
                                url,
                                productId,
                                productName: result.productName,
                                priceKRW: result.priceKRW,
                                priceUSD: Math.round(result.priceKRW / 1350 * 100) / 100,
                                description: result.description,
                                mainImages: result.mainImages,
                                detailImages: result.detailImages,
                                allDetailImages: result.allDetailImages,
                                rating: result.rating,
                                reviewCount: result.reviewCount,
                                htmlLength: result.htmlLength,
                                scrapedAt: new Date().toISOString(),
                                source: 'coupang',
                                strategy: i + 1
                    };
          }

          console.log(`Strategy ${i + 1} blocked or no data, trying next...`);
                if (i < strategies.length - 1) await sleep(2000);

        } catch (err) {
                console.error(`Strategy ${i + 1} error:`, err.message);
                if (i < strategies.length - 1) await sleep(2000);
        }
  }

  // All strategies failed - return error data
  console.log('All strategies failed for:', url);
    return {
          url,
          productId,
          productName: '',
          priceKRW: 0,
          priceUSD: 0,
          description: '',
          mainImages: [],
          detailImages: [],
          allDetailImages: [],
          rating: 0,
          reviewCount: 0,
          htmlLength: 0,
          error: 'All scraping strategies failed - Coupang anti-bot active',
          scrapedAt: new Date().toISOString(),
          source: 'coupang'
    };
}

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', version: '3.0-multi-strategy', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
    const { url } = req.body;

           if (!url) {
                 return res.status(400).json({ success: false, error: 'URL is required' });
           }

           if (!url.includes('coupang.com')) {
                 return res.status(400).json({ success: false, error: 'Only Coupang URLs are supported' });
           }

           try {
                 const data = await scrapeCoupang(url);
                 res.json({ success: true, data });
           } catch (error) {
                 console.error('Unhandled scrape error:', error.message);
                 res.json({
                         success: true,
                         data: {
                                   url,
                                   productId: extractProductId(url),
                                   productName: '',
                                   priceKRW: 0,
                                   priceUSD: 0,
                                   description: '',
                                   mainImages: [],
                                   detailImages: [],
                                   allDetailImages: [],
                                   rating: 0,
                                   reviewCount: 0,
                                   htmlLength: 0,
                                   error: error.message,
                                   scrapedAt: new Date().toISOString(),
                                   source: 'coupang'
                         }
                 });
           }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Coupang scraper v3.0 (multi-strategy) running on port ${PORT}`);
});
