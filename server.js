const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { runQuote } = require('./quoter'); 
const { logToSheet } = require('./logger'); 
require('dotenv').config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userSessions = {}; 
const VALID_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

console.log("🤖 Rapid Rater Bot Online...");

// --- 1. AI EXTRACTION ---
async function extractDataFromText(userText, currentContext = {}) {
    const systemPrompt = `
    You are an insurance data assistant. 
    Current known data: ${JSON.stringify(currentContext)}
    New User Input: "${userText}"

    Update JSON. Fields: state, age, gender, faceAmount, product, mode, recipient, tableRating, flatExtra.
    
    CRITICAL RULES:
    1. **Corrections**: If user contradicts themselves (e.g., "500k... no wait 1 million"), USE THE LAST SPOKEN VALUE.
    2. **State**: Convert to 2-letter Code (e.g., "Ohio" -> "OH").
    3. **Face Amount**: 
       - If user says "500", assume "500000". 
       - If user says "1 million", use "1000000".
       - Min value is 100000.
    4. **Product**: MUST be 'QoL Flex Term' or 'QoL Guarantee Plus GUL II'. 
       - Default to 'QoL Flex Term'. 
       - NEVER put "Table" values here.
    5. **Table Rating**: Look for "Table" followed by letter (e.g., "Table C"). 
       - Default: 'None'.
    6. **Flat Extra**: Look for extra numeric cost (e.g. "Flat extra 2.50"). 
       - Default: 0.
    7. **Mode**: 'Annual', 'Semi-Annual', 'Quarterly', 'Monthly'. 
       - Default: 'Annual'.
    8. **Gender**: Title Case ('Male' or 'Female').
    9. **Confirmation**: If user says "Yes", "Run", set 'userAgreed' = true.
    10. If a MANDATORY field (Age, State, Gender, Amount, Email) is missing, set to "MISSING".
    
    Return ONLY JSON.
    `;

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }],
        temperature: 0
    });
    
    const cleanJson = response.choices[0].message.content.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanJson);
}

// --- 2. VALIDATION LAYER ---
function validateInputs(data) {
    const errors = [];
    if (data.state && !VALID_STATES.includes(data.state.toUpperCase())) {
        errors.push(`❌ **${data.state}** is not a valid US State code.`);
    }
    if (data.age && (data.age < 18 || data.age > 85)) {
        errors.push(`❌ Age **${data.age}** is likely outside the quotable range (18-85).`);
    }
    if (data.faceAmount && data.faceAmount < 100000) {
        errors.push(`❌ Face Amount **$${data.faceAmount}** is too low. Minimum is $100,000.`);
    }
    return errors;
}

// --- 3. HTML FORMATTER ---
async function formatQuoteToHtml(rawQuoteText) {
    const systemPrompt = `Convert insurance text data to a clean HTML <table>. Blue header, clear rows. No html/body tags.`;
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: rawQuoteText }],
        temperature: 0
    });
    return response.choices[0].message.content.replace(/```html/g, "").replace(/```/g, "").trim();
}

// --- 4. SEND EMAIL ---
async function sendHtmlEmail(data, formattedTable, screenshotPath) {
    if (!process.env.SMTP_USER) return;
    let transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: false, 
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const htmlContent = `
        <h3>Rapid Rater Quote Result</h3>
        <p><strong>Client:</strong> ${data.gender}, Age ${data.age}, ${data.state}</p>
        <p><strong>Details:</strong> ${data.product} (${data.mode})</p>
        <p><strong>Rating:</strong> ${data.tableRating} | <strong>Flat Extra:</strong> ${data.flatExtra}</p>
        ${formattedTable}
        <p><em>Screenshot attached.</em></p>
    `;

    await transporter.sendMail({
        from: `"Bot" <${process.env.SMTP_USER}>`,
        to: data.recipient,
        subject: `Quote: ${data.product} - $${data.faceAmount}`,
        html: htmlContent,
        attachments: [{ filename: 'Quote.png', path: screenshotPath }]
    });
}

// --- 5. CONVERSATION HANDLER ---
async function handleConversation(chatId, textInput, isVoiceSource) {
    let currentData = userSessions[chatId] || { confirmed: false };
    
    if (isVoiceSource) await bot.sendMessage(chatId, "🤔 Analyzing...");
    else await bot.sendMessage(chatId, "⚡ Processing...");

    // A. Extract
    const newData = await extractDataFromText(textInput, currentData);
    if (newData.userAgreed) currentData.confirmed = true;
    userSessions[chatId] = newData;

    // B. Missing Fields
    const mandatory = ['age', 'state', 'gender', 'faceAmount', 'recipient'];
    const missing = mandatory.filter(field => newData[field] === "MISSING" || !newData[field]);

    if (missing.length > 0) {
        const fieldName = missing[0];
        let question = `I am missing the **${fieldName}**.`;
        if (fieldName === 'recipient') question = "Please **Type the Email Address**.";
        await bot.sendMessage(chatId, `⚠️ ${question}`, { parse_mode: 'Markdown' });
        return;
    }

    // C. Validation
    const logicErrors = validateInputs(newData);
    if (logicErrors.length > 0) {
        const errorMsg = logicErrors.join("\n") + "\n\nPlease correct this.";
        await bot.sendMessage(chatId, errorMsg, { parse_mode: 'Markdown' });
        return; 
    }

    // D. Confirmation (Voice Only)
    if (!currentData.confirmed && isVoiceSource) {
        const summary = `
🎙 **Voice Detected. Please Review:**
• **Email:** ${newData.recipient}
• **Client:** ${newData.age} / ${newData.gender} / ${newData.state}
• **Amount:** $${newData.faceAmount}
• **Mode:** ${newData.mode}
• **Rating:** ${newData.tableRating || 'None'}
• **Flat Extra:** ${newData.flatExtra || 0}

Type **'Yes'** to run.
Type **'Change X to Y'** to fix.
        `;
        await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
        return; 
    }

    // E. Execution
    await bot.sendMessage(chatId, `🚀 Running quote for **${newData.recipient}**...`);
    
    try {
        const result = await runQuote(newData);
        if (!result.success) throw new Error("Quote failed");

        const formattedTable = await formatQuoteToHtml(result.quote);
        const screenshotPath = result.screenshotPath || path.join(__dirname, result.screenshot); 
        
        await sendHtmlEmail(newData, formattedTable, screenshotPath);
        
        // Log to Supabase
        await logToSheet(newData, result.quote);

        await bot.sendMessage(chatId, `✅ Done! Email sent to ${newData.recipient}.`);

        if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
        delete userSessions[chatId]; 

    } catch (e) {
        await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
        userSessions[chatId].confirmed = false; 
    }
}

// --- LISTENERS ---
bot.on('message', async (msg) => {
    if (msg.voice) return; 
    console.log(`📩 Text: ${msg.text}`);
    await handleConversation(msg.chat.id, msg.text, false);
});

bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    try {
        const fileLink = await bot.getFileLink(msg.voice.file_id);
        const localPath = path.join(__dirname, 'temp_voice.ogg');
        const writer = fs.createWriteStream(localPath);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((r) => writer.on('finish', r));

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(localPath),
            model: "whisper-1",
        });
        
        fs.unlinkSync(localPath);
        await bot.sendMessage(chatId, `🗣 I heard: "${transcription.text}"`);
        await handleConversation(chatId, transcription.text, true); 

    } catch (e) {
        await bot.sendMessage(chatId, "❌ Voice error.");
    }
});