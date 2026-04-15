const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        console.log("Checking comprehensive models with prefixes...");
        
        const models = [
            'models/gemini-1.5-flash',
            'models/gemini-1.5-flash-latest',
            'models/gemini-1.5-flash-001',
            'models/gemini-1.5-flash-002',
            'models/gemini-1.5-pro',
            'models/gemini-1.0-pro',
            'models/gemini-2.0-flash',
            'models/gemini-2.0-flash-exp'
        ];
        
        for (const m of models) {
            try {
                // If model name starts with models/, try passing it directly
                const model = genAI.getGenerativeModel({ model: m });
                const result = await model.generateContent("echo ONLINE");
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
