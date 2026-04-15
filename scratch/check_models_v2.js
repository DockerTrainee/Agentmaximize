const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        console.log("Checking refined model list...");
        
        const models = [
            'gemini-pro',
            'gemini-1.5-flash-latest',
            'gemini-1.5-pro-latest',
            'gemini-1.0-pro-latest',
            'gemini-2.0-flash-exp'
        ];
        
        for (const m of models) {
            try {
                const model = genAI.getGenerativeModel({ model: m });
                const result = await model.generateContent("echo 'ONLINE'");
                console.log(`✅ [SUCCESS] ${m}: ${result.response.text().substring(0, 10)}...`);
            } catch (e) {
                console.log(`❌ [FAILED] ${m}: ${e.message}`);
            }
        }
    } catch (e) {
        console.error("List Models Error:", e);
    }
}

listModels();
