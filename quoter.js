const { chromium } = require('playwright');
const path = require('path');
require('dotenv').config();

const URL = 'https://rapid-rater.live.web.corebridgefinancial.com/QoLRapidRater';

async function runQuote(inputData) {
    console.log("🚀 Starting Rapid Rater Automation...");

    const config = {
        product: inputData.product || "QoL Flex Term",
        state: inputData.state || "OH", 
        gender: inputData.gender || "Male",
        age: inputData.age || "45",
        faceAmount: inputData.faceAmount || "1000000",
        mode: inputData.mode || "Monthly",
        flatExtra: inputData.flatExtra || "0",
        tableRating: inputData.tableRating || "None",
        recipient: inputData.recipient 
    };

    console.log(`📋 Inputs: ${JSON.stringify(config, null, 2)}`);

    const headless = process.env.HEADLESS === 'false' ? false : true;
    const browser = await chromium.launch({ headless, args: ['--start-maximized'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const timestamp = Date.now();
    const screenshotName = `quote_result_${timestamp}.png`;
    const screenshotPath = path.join(__dirname, screenshotName);

    try {
        console.log(`🌐 Navigating to ${URL}...`);
        await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(2000);
        
        await safeSelect(page, '#STATE', config.state);
        await page.waitForTimeout(2000); 
        await safeSelect(page, '#DISPLAY_PRODUCT', config.product);
        await page.waitForTimeout(500);
        await safeSelect(page, '#SEX1', config.gender);
        
        await page.fill('#AGE1', config.age.toString());
        const cleanAmount = config.faceAmount.toString().replace(/,/g, '');
        await page.fill('#FACE_AMOUNT', cleanAmount);
        
        await safeSelect(page, '#PREM_MODE', config.mode);

        if (config.tableRating && config.tableRating !== 'None') {
            await safeSelect(page, '#TABLE_RATING1', config.tableRating);
        }

        if (config.flatExtra && config.flatExtra !== '0') {
             await page.fill('#FLAT_AMOUNT1', config.flatExtra.toString());
        }

        const submitBtn = page.locator('#btnSubmit');
        await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
        await submitBtn.click();

        await page.waitForSelector('#QuickView', { state: 'visible', timeout: 30000 });
        const resultText = await page.innerText('#QuickView');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await browser.close();

        return { 
            success: true, 
            quote: resultText,
            screenshotPath: screenshotPath,
            screenshot: screenshotName 
        };

    } catch (error) {
        console.error("❌ Automation Failed:", error.message);
        await browser.close();
        throw error;
    }
}

// --- IMPROVED SAFE SELECT (Case Insensitive) ---
async function safeSelect(page, selector, targetText) {
    try {
        const elHandle = await page.$(selector);
        if (!elHandle) throw new Error(`Selector ${selector} not found`);

        const tagName = await elHandle.evaluate(el => el.tagName.toLowerCase());

        // If it's a dropdown (select)
        if (tagName === 'select') {
            // Get all options with their text and values
            const options = await page.$$eval(`${selector} option`, opts => 
                opts.map(o => ({ text: o.textContent.trim(), value: o.value }))
            );
            
            const targetLower = targetText.toString().toLowerCase();

            // 1. Try Finding Exact Match (Case Insensitive)
            const match = options.find(o => 
                o.value.toLowerCase() === targetLower || 
                o.text.toLowerCase() === targetLower
            );

            if (match) {
                await page.selectOption(selector, { value: match.value });
                console.log(`   -> Selected "${match.text}" (matched "${targetText}")`);
                return;
            }

            // 2. Try Fuzzy Match (Case Insensitive)
            const fuzzyMatch = options.find(o => 
                o.text.toLowerCase().includes(targetLower)
            );

            if (fuzzyMatch) {
                await page.selectOption(selector, { value: fuzzyMatch.value });
                console.log(`   -> Fuzzy Selected "${fuzzyMatch.text}" (matched "${targetText}")`);
                return;
            }

            throw new Error(`No option found matching "${targetText}"`);
        }

        // Handle standard clickable inputs (radio buttons, etc)
        const byValue = await page.$(`${selector}[value="${targetText}"]`);
        if (byValue) { await byValue.click(); return; }

        throw new Error('No matching option/input found for selector');

    } catch (error) {
        console.error(`FAILED to select "${targetText}" for ${selector}`);
        throw error;
    }
}

module.exports = { runQuote };