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
  if (browser) {
    return browser;
  }
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
      waitUntil: 'networkidle0',
      timeout: 60000
    });
    
    // Wait for page to load with longer timeout
    await sleep(5000);
    
    // Check if we got an access denied page
    const pageContent = await page.content();
    if (pageContent.includes('Access Denied') || pageContent.includes('차단') || pageContent.includes('접근이 거부') || pageContent.includes('찾을 수 없습니다')) {
      console.log('Access denied or product not found detected');
    }
    
    // Take a screenshot for debugging
    // await page.screenshot({ path: '/tmp/screenshot.png' });
    
    // Extract product data - wait for specific elements
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
      
      // Product name - looking for h1 or h2 with prod-buy-header__title class or similar
      let productName = '';
      const nameSelectors = [
        'h1',
        'h2',
        '.prod-buy-header__title',
        'h1.prod-buy-header__title',
        'h2.prod-buy-header__title',
        '[class*=\"prod\"][class*=\"title\"]'
      ];
      
      for (const sel of nameSelectors) {
        const text = getText(sel);
        if (text && text.length > 3) {
          productName = text;
          break;
        }
      }
      
      // Fallback to meta tag
      if (!productName) {
        productName = getAttr('meta[property=\"og:title\"]', 'content');
      }
      
      // Price - try multiple selectors
      let priceKRW = '';
      const priceSelectors = [
        '.total-price strong',
        '.total-price',
        '.price-value',
        '[class*=\"sale\"][class*=\"price\"]',
        '[class*=\"total\"][class*=\"price\"]',
        '.prod-price',
        'meta[property=\"product:price:amount\"]'
      ];
      
      for (const sel of priceSelectors) {
        if (sel.includes('meta')) {
          const price = getAttr(sel, 'content');
          if (price) {
            priceKRW = price;
            break;
          }
        } else {
          const text = getText(sel);
          if (text && /\d/.test(text)) {
            priceKRW = text.replace(/[^0-9]/g, '');
            break;
          }
        }
      }
      
      // Description - try multiple selectors
      let description = '';
      const descSelectors = [
        '.prod-description',
        '#btfDetail',
        '.product-detail',
        '[class*=\"description\"]'
      ];
      
      for (const sel of descSelectors) {
        const text = getText(sel);
        if (text && text.length > 10) {
          description = text.substring(0, 500);
          break;
        }
      }
      
      // Images
      const images = [];
      const imgElements = document.querySelectorAll('img[src*=\"coupang\"], img[alt*=\"Product\"]');
      imgElements.forEach(img => {
        const src = img.src || img.getAttribute('data-src');
        if (src && !src.includes('icon') && !src.includes('logo')) {
          images.push(src);
        }
      });
      
      return {
        productName: productName || 'empty',
        priceKRW: priceKRW || '0',
        priceUSD: '0',
        description: description || 'No description',
        images: images.slice(0, 5)
      };
    });
    
    await page.close();
    
    console.log('Scraped data:', data);
    return {
      success: true,
      data: {
        url: url,
        productId: extractProductId(url),
        ...data
      }
    };
    
  } catch (error) {
    console.error('Scraping error:', error);
    await page.close();
    return {
      success: false,
      error: error.message,
      data: {
        url: url,
        productId: extractProductId(url),
        productName: 'Error: ' + error.message,
        priceKRW: '0',
        priceUSD: '0',
        description: '',
        images: []
      }
    };
  }
}

// Scrape endpoint
app.post('/scrape', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    
    console.log('Received scrape request for:', url);
    
    const result = await scrapeCoupangWithPuppeteer(url);
    res.json(result);
    
  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Product scraper with Puppeteer running',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Product scraper with Puppeteer running on port ${PORT}`);
});
