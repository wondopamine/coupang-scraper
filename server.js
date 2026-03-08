const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use stealth plugin to evade bot detection
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractProductId(url) {
  const coupangMatch = url.match(/\/products\/(\d+)/);
  if (coupangMatch) return coupangMatch[1];
  const amazonMatch = url.match(/\/dp\/([A-Z0-9]+)/);
  return amazonMatch ? amazonMatch[1] : null;
}

// Launch browser once and reuse
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      ignoreHTTPSErrors: true
    });
  }
  return browser;
}

async function scrapeCoupangWithPuppeteer(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set extra headers to appear more human-like
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });
    
    // Navigate to the page with a random delay
    await sleep(Math.random() * 2000 + 1000);
    
    console.log('Navigating to:', url);
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 45000 
    });
    
    // Wait for page to load
    await sleep(3000);
    
    // Check if we got an access denied page
    const pageContent = await page.content();
    if (pageContent.includes('Access Denied') || pageContent.includes('차단') || pageContent.includes('접근이 거부')) {
      console.log('Access denied detected, trying alternative selectors...');
    }
    
    // Take a screenshot for debugging
    // await page.screenshot({ path: '/tmp/screenshot.png' });
    
    // Extract product data with multiple fallback strategies
    const data = await page.evaluate(() => {
      // Helper function to safely get text
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : '';
      };
      
      // Helper function to get attribute
      const getAttr = (selector, attr) => {
        const el = document.querySelector(selector);
        return el ? el.getAttribute(attr) : '';
      };
      
      // Product name - try multiple selectors
      let productName = '';
      const nameSelectors = [
        'h1.prod-buy-header__title',
        '.prod-buy-header__title',
        'h2.prod-buy-header__title',
        '[class*="prod-buy"] h1',
        '[class*="prod-buy"] h2',
        '.prod-title',
        '#btfDetail h2',
        'meta[property="og:title"]'
      ];
      
      for (const sel of nameSelectors) {
        if (sel.includes('meta')) {
          productName = getAttr(sel, 'content');
        } else {
          productName = getText(sel);
        }
        if (productName && productName.length > 2) {
          productName = productName.replace(/ : 쿠팡$/,'').replace(/쿠팡$/,'').trim();
          break;
        }
      }
      
      // Price - try multiple selectors
      let priceKRW = 0;
      const priceSelectors = [
        '.total-price strong',
        '.total-price span',
        '.price-value',
        '[class*="total-price"] strong',
        '[class*="total-price"] span',
        '[class*="price-value"]',
        '.prod-price .total-price',
        '.sale-price',
        '.base-price'
      ];
      
      for (const sel of priceSelectors) {
        const text = getText(sel);
        if (text) {
          const num = parseInt(text.replace(/[^0-9]/g, ''));
          if (num > 0) {
            priceKRW = num;
            break;
          }
        }
      }
      
      // Description
      let description = getAttr('meta[name="description"]', 'content') ||
                       getAttr('meta[property="og:description"]', 'content') ||
                       getText('.prod-description') ||
                       '';
      
      // Images - comprehensive collection
      const allImages = [];
      
      // Try og:image first
      const ogImage = getAttr('meta[property="og:image"]', 'content');
      if (ogImage) allImages.push(ogImage);
      
      // Product gallery images
      const imageSelectors = [
        '.prod-image__detail img',
        '.prod-image__item img',
        '.prod-image-container img',
        '[class*="prod-image"] img',
        '#btfDetail img',
        '.product-image img',
        '.detail-image img'
      ];
      
      // Collect all images
      document.querySelectorAll('img').forEach(img => {
        let src = img.src || img.dataset.src || img.getAttribute('data-src') || img.getAttribute('data-original');
        if (!src && img.hasAttribute('srcset')) {
          const srcset = img.getAttribute('srcset');
          const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
          src = urls[urls.length - 1]; // Get highest quality
        }
        if (src) {
          if (src.startsWith('//')) src = 'https:' + src;
          if (src.startsWith('http') && !allImages.includes(src)) {
            // Filter out tiny icons, logos, and UI elements
            if (!src.includes('1x1') && 
                !src.includes('blank') && 
                !src.includes('logo') &&
                !src.includes('icon') &&
                !src.match(/\/(\d{1,2})x(\d{1,2})\//)) {
              allImages.push(src);
            }
          }
        }
      });
      
      return {
        productName,
        priceKRW,
        description: description.slice(0, 500),
        mainImages: allImages.slice(0, 10),
        detailImages: allImages.slice(10, 30),
        allDetailImages: allImages.slice(0, 30),
        totalImagesFound: allImages.length
      };
    });
    
    console.log('Scrape result:', JSON.stringify({
      productName: data.productName,
      priceKRW: data.priceKRW,
      imagesFound: data.totalImagesFound
    }));
    
    await page.close();
    
    return {
      url,
      productId: extractProductId(url),
      productName: data.productName || '',
      priceKRW: data.priceKRW || 0,
      priceUSD: Math.round(data.priceKRW / 1350 * 100) / 100,
      description: data.description || '',
      mainImages: data.mainImages || [],
      detailImages: data.detailImages || [],
      allDetailImages: data.allDetailImages || [],
      rating: 0,
      reviewCount: 0,
      scrapedAt: new Date().toISOString(),
      source: 'coupang'
    };
    
  } catch (error) {
    console.error('Scrape error:', error.message);
    await page.close();
    throw new Error(`Coupang scrape failed: ${error.message}`);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }
  
  try {
    let data;
    
    if (url.includes('coupang.com')) {
      data = await scrapeCoupangWithPuppeteer(url);
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Only Coupang URLs are supported' 
      });
    }
    
    res.json({ success: true, data });
    
  } catch (error) {
    console.error('Scrape error:', error.message);
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
        error: error.message,
        scrapedAt: new Date().toISOString(),
        source: 'coupang'
      }
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Product scraper with Puppeteer + Stealth running on port ${PORT}`);
});
