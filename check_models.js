const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function findGenerateModels() {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await response.json();
        const genModels = data.models.filter(m => m.supportedGenerationMethods.includes('generateContent'));
        console.log("Models supporting generateContent:", genModels.map(m => m.name));
    } catch (e) {
        console.log("Failed to list models:", e.message);
    }
}

findGenerateModels();
