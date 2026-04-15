const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        console.log("Fetching available models...");
        // Note: listModels is not directly on genAI in some versions, 
        // but it's available via the 'main' export or specific endpoint.
        // In the @google/generative-ai v0.x, it's often not exposed easily. 
        // We'll try the common names directly.
        
        const models = [
            'gemini-1.5-flash',
            'gemini-1.5-pro',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite-preview-02-05',
            'gemini-2.0-pro-exp-02-05',
            'gemini-2.0-flash-thinking-exp-01-21',
            'gemini-1.5-flash-8b'
        ];
        
        for (const m of models) {
            try {
                const model = genAI.getGenerativeModel({ model: m });
                const result = await model.generateContent("hi");
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
