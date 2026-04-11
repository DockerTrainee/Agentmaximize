const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function test() {
    try {
        console.log("Testing models/gemini-flash-latest...");
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        const result = await model.generateContent("Hello, respond with 'SUCCESS'");
        console.log("Response:", result.response.text());
    } catch (e) {
        console.log("Error:", e.message);
        if (e.response) {
            console.log("Response body:", await e.response.text());
        }
    }
}

test();
