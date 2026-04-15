const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").split(/[\s\r\n]/)[0].trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").split(/[\s\r\n]/)[0].trim();

async function testGemini() {
    console.log('--- Testing Gemini ---');
    if (!GEMINI_API_KEY) {
        console.log('❌ GEMINI_API_KEY is missing');
        return;
    }
    
    try {
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Say hello");
        console.log('✅ Gemini Success:', result.response.text().trim());
    } catch (err) {
        console.log('❌ Gemini Failed:', err.message);
        if (err.message.includes('404')) console.log('   (Possibility: Model not enabled or invalid name)');
        if (err.message.includes('429')) console.log('   (Possibility: Quota exceeded)');
        if (err.message.includes('403')) console.log('   (Possibility: API Key invalid)');
    }
}

async function testGitHub() {
    console.log('\n--- Testing GitHub ---');
    if (!GITHUB_TOKEN) {
        console.log('❌ GITHUB_TOKEN is missing');
        return;
    }
    
    try {
        const response = await axios.post('https://models.inference.ai.azure.com/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'Say hello' }],
            max_tokens: 10
        }, {
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` }
        });
        console.log('✅ GitHub Success:', response.data.choices[0].message.content.trim());
    } catch (err) {
        console.log('❌ GitHub Failed:', err.response?.data?.error?.message || err.message);
        if (err.response?.status === 403) console.log('   (Possibility: Missing "models" scope or token invalid)');
    }
}

async function run() {
    await testGemini();
    await testGitHub();
}

run();
