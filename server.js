/**
 * AON AI — NEXUS PRIME v5.0
 * Architected using patterns from: Claude Code, Anthropic Agent Research,
 * OpenHands, CrewAI, and SWE-Agent.
 *
 * Key Patterns Applied:
 * - ORCHESTRATOR-WORKERS: Orchestrator plans, specialized workers execute in parallel
 * - EVALUATOR-OPTIMIZER: QA Critic Agent reviews and requests fixes
 * - ROUTING: Goal classifier routes to the best synthesis strategy
 * - REAL-TIME TELEMETRY: Socket.io replaces polling for zero-latency streaming
 * - PERSISTENT MEMORY: Agent registry stored in JSON DB
 * - ACI DESIGN: All AI tools are carefully documented for the LLM
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────────────────────
const BUILDS_DIR = path.join(__dirname, 'builds');
const AGENTS_DB_PATH = path.join(__dirname, 'agents-db.json');
fs.ensureDirSync(BUILDS_DIR);
if (!fs.existsSync(AGENTS_DB_PATH)) fs.writeJsonSync(AGENTS_DB_PATH, { agents: [] });

const jobs = {};
global.IS_ON_QUOTA_RESTRICTION = false;

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request Logger
app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
});

// Body Parse Error Handler
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('[BODY PARSE ERROR]:', err.message);
        return res.status(400).send({ error: 'Malformed JSON' });
    }
    if (err.type === 'entity.too.large') {
        console.error('[BODY SIZE ERROR]: Payload too large');
        return res.status(413).send({ error: 'Payload too large' });
    }
    next();
});

// Admin Auth Middleware
const authMiddleware = (req, res, next) => {
    const adminPassword = sanitizeEnv(process.env.ADMIN_PASSWORD || '1234');
    const clientPassword = req.headers['x-admin-password'];
    
    if (clientPassword === adminPassword) {
        next();
    } else {
        res.status(401).json({ success: false, error: 'Unauthorized: Invalid Admin Password' });
    }
};

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const sanitizeEnv = (val) => (val || "").split(/[\s\r\n]/)[0].trim();
const genAI = new GoogleGenerativeAI(sanitizeEnv(process.env.GEMINI_API_KEY));

// ─────────────────────────────────────────────────────────────────────────────
// REAL-TIME TELEMETRY — Socket.io
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[NEXUS] CLIENT CONNECTED: ${socket.id}`);
    socket.on('disconnect', () => console.log(`[NEXUS] CLIENT DISCONNECTED: ${socket.id}`));
});

/**
 * Emit a log event to a specific job's clients.
 * @param {string} jobId - The job ID to emit to.
 * @param {string} message - The log message.
 * @param {'system'|'success'|'error'|'agent'|'user'} type - Log type.
 */
function streamLog(jobId, message, type = 'system') {
    io.emit(`job:${jobId}:log`, { message, type, ts: new Date().toLocaleTimeString() });
    if (jobs[jobId]) jobs[jobId].logs.push(`[${type.toUpperCase()}] ${message}`);
}

function streamProgress(jobId, value, label = '') {
    io.emit(`job:${jobId}:progress`, { value, label });
    if (jobs[jobId]) jobs[jobId].progress = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE AI ENGINE — Hybrid Cascade with Multi-Provider Fallback
// ─────────────────────────────────────────────────────────────────────────────
const GITHUB_ENDPOINT = 'https://models.inference.ai.azure.com/chat/completions';

const MODEL_CASCADE = [
    "models/gemini-2.0-flash",
    "models/gemini-flash-latest",
    "github/gpt-4o",
    "github/meta-llama-3.1-70b-instruct",
    "models/gemini-1.5-flash-latest",
    "github/gpt-4o-mini"
];

/**
 * GitHub Models API Caller (OpenAI Compatible)
 */
async function callGitHubAI(modelName, prompt, jobId = null) {
    const token = sanitizeEnv(process.env.GITHUB_TOKEN);
    if (!token || token === 'your_github_token_here') {
        throw new Error('GITHUB_TOKEN not configured');
    }

    const cleanModelName = modelName.replace('github/', '');
    if (jobId) streamLog(jobId, `[GITHUB] Calling ${cleanModelName}...`, 'system');

    try {
        const response = await axios.post(GITHUB_ENDPOINT, {
            model: cleanModelName,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 4096
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content.trim();
    } catch (err) {
        const errMsg = err.response?.data?.error?.message || err.message;
        throw new Error(`GitHub API Error: ${errMsg}`);
    }
}

async function callAI(prompt, format = 'HTML', jobId = null, agentName = '') {
    const tag = agentName ? `[${agentName}]` : '[AI]';
    
    for (const modelName of MODEL_CASCADE) {
        let attempts = 0;
        const isGithub = modelName.startsWith('github/');
        
        while (attempts < 2) {
            try {
                let text = '';
                if (isGithub) {
                    text = await callGitHubAI(modelName, prompt, jobId);
                } else {
                    if (jobId) streamLog(jobId, `${tag} Calling ${modelName}...`, 'system');
                    const model = genAI.getGenerativeModel({ model: modelName });
                    const result = await model.generateContent(prompt);
                    text = result.response.text().trim();
                }

                text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

                if (format === 'JSON') {
                    const match = text.match(/\{[\s\S]*\}/);
                    if (match) text = match[0];
                    JSON.parse(text); 
                }
                return text;
            } catch (err) {
                console.error(`[AI ATTEMPT FAILED] Provider: ${isGithub ? 'GitHub' : 'Google'} | Model: ${modelName} | Error: ${err.message}`);
                
                // Retry logic for rate limits
                const isRateLimit = err.message.includes('429') || err.message.includes('quota') || err.message.includes('rate limit');
                
                if (isRateLimit) {
                    if (jobId) streamLog(jobId, `⚠️ ${modelName} rate limited, retrying...`, 'error');
                    await new Promise(r => setTimeout(r, 2000));
                    attempts++;
                } else {
                    if (jobId) streamLog(jobId, `❌ ${modelName} failed: ${err.message.substring(0, 50)}...`, 'error');
                    break; // Move to next model in cascade
                }
            }
        }
    }
    const finalError = `Critical Failure: All fallback models in the hybrid cascade (${MODEL_CASCADE.length}) failed.`;
    if (jobId) streamLog(jobId, finalError, 'error');
    throw new Error(finalError);
}

/**
 * Multimodal Vision Helper with Cascade Fallback
 */
async function callAIVision(prompt, imageBase64) {
    if (!imageBase64) throw new Error('No image context');
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imagePart = { inlineData: { data: base64Data, mimeType: 'image/jpeg' } };
    
    for (const modelName of MODEL_CASCADE) {
        try {
            console.log(`[VISION] Calling ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent([prompt, imagePart]);
            return result.response.text().trim();
        } catch (err) {
            console.error(`[VISION ERROR] ${modelName}:`, err);
            continue; 
        }
    }
    throw new Error('All vision-capable models failed or were rate-limited.');
}
/**
 * SELF-HEALING REPAIR ENGINE
 * Analyzes crash reports and re-synthesizes broken logic.
 */
async function runAgentRepair(jobId, errorData, currentCode) {
    streamLog(jobId, '🩹 SELF-HEAL: Analyzing crash report...', 'agent');
    
    const repairPrompt = `
You are the "Aon AI Neural Surgeon". An application has crashed.
GOAL: Repair the JavaScript/HTML to resolve the error.

ERROR DATA:
${JSON.stringify(errorData, null, 2)}

CURRENT CODE (first 5000 chars):
${currentCode.substring(0, 5000)}

TASK:
1. Identify the cause of the error.
2. Provide the COMPLETELY FIXED version of the code.
3. Keep the styling and HTML exactly the same unless they caused the error.
4. Focus specifically on fixing the JavaScript logic or missing state variables.

OUTPUT: Full HTML file content ONLY. No markdown. No explanation.
`;

    try {
        const repairedCode = await callAI(repairPrompt, 'HTML', jobId, 'REPAIR-AGENT');
        return repairedCode;
    } catch (e) {
        streamLog(jobId, `Repair attempt failed: ${e.message}`, 'error');
        throw e;
    }
}

/**
 * DASHBOARD REPAIR — The doctor that heals itself.
 * Analyzes errors in the main orchestrator files and provides patches.
 */
async function runDashboardRepair(errorData) {
    console.log('[DASHBOARD-HEAL] Reading system source files...');
    
    // Read the primary dashboard files
    const indexHTML = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
    const scriptJS = await fs.readFile(path.join(__dirname, 'script.js'), 'utf8');
    
    const repairPrompt = `
You are the "NEXUS SYSTEMS ARCHITECT". The Central Orchestration Dashboard has crashed.
GOAL: Repair the critical system files to restore stability.

ERROR DATA:
${JSON.stringify(errorData, null, 2)}

CURRENT INDEX.HTML (Complete):
${indexHTML}

CURRENT SCRIPT.JS (Complete):
${scriptJS}

TASK:
1. Identify which file is causing the error (index.html, script.js, or style.css).
2. Provide the COMPLETELY FIXED version of ONLY that specific file.
3. You MUST return the ENTIRE file content, not just the fixed part. Do not truncate!

OUTPUT FORMAT:
Your response must be a valid JSON object:
{
  "file": "script.js", // or index.html, style.css
  "content": "the ENTIRE fixed content of the file"
}
Only output the JSON. No markdown fences.
`;

    try {
        const responseText = await callAI(repairPrompt, 'Plain Text', 'DASHBOARD', 'REPAIR-DASHBOARD');
        // Clean up possible markdown fences if AI ignores instructions
        const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (e) {
        console.error('[DASHBOARD-HEAL] Repair failed:', e.message);
        throw e;
    }
}


/**
 * REFINEMENT ENGINE — Optimizer Agent
 * Takes synthesized code and a QA critique to perform a 'Premium Polish' pass.
 */
async function runOptimizerPass(jobId, critique, html, css, js) {
    streamLog(jobId, '💎 OPTIMIZER: Performing Premium Polish pass...', 'agent');
    
    const optimizerPrompt = `
You are the "Aon AI Senior Design Lead". Your job is to take a 'prototype' and turn it into a 'Production Masterpiece'.

QA CRITIQUE:
${JSON.stringify(critique, null, 2)}

CURRENT ASSETS:
--- HTML ---
${html.substring(0, 2000)}
--- CSS ---
${css.substring(0, 2000)}
--- JS ---
${js.substring(0, 2000)}

TASK:
1. Address ALL critical issues from the QA critique.
2. Upgrade the aesthetics to "Apple/Stripe" standards.
3. Fix any logical inconsistencies or basic placeholders.
4. If Chart.js containers exist, ensure the JS initializes them.

Respond with ONLY valid JSON (no markdown):
{
  "html": "Updated raw HTML",
  "css": "Updated raw CSS",
  "js": "Updated raw JS"
}
`;

    try {
        const resultText = await callAI(optimizerPrompt, 'JSON', jobId, 'OPTIMIZER');
        return JSON.parse(resultText);
    } catch (e) {
        streamLog(jobId, `Optimization pass failed: ${e.message}. Using original assets.`, 'error');
        return { html, css, js };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSION ROUTER — Inspired by Anthropic's Routing Workflow
// Classifies the goal and selects the best synthesis strategy.
// ─────────────────────────────────────────────────────────────────────────────
async function routeMission(goal) {
    const routerPrompt = `
You are the "Aon AI Mission Router". Your ONLY job is to classify a user's goal.
Analyze this goal: "${goal}"

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "type": "dashboard|chatbot|game|tool|analyzer|landing",
  "complexity": "simple|moderate|complex",
  "keyFeatures": ["feature1", "feature2", "feature3"],
  "suggestedModules": ["Module Name 1", "Module Name 2"],
  "primaryColor": "#hexcolor",
  "secondaryColor": "#hexcolor"
}

Rules:
- dashboard: data visualization, analytics, monitoring
- chatbot: conversational, AI assistant, customer support
- game: interactive, scoring, levels
- tool: utility, converter, calculator, generator
- analyzer: reports, insights, parsing
- landing: marketing page, portfolio, showcase
`;
    try {
        const result = await callAI(routerPrompt, 'JSON');
        return JSON.parse(result);
    } catch {
        return {
            type: 'dashboard', complexity: 'moderate',
            keyFeatures: ['Main View', 'Data Display', 'Controls'],
            suggestedModules: ['Header', 'Main Content Panel', 'Footer'],
            primaryColor: '#00f2ff', secondaryColor: '#9d50ff'
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT REGISTRY — Persistent Memory (inspired by CLAUDE.md memory system)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/agents', async (req, res) => {
    try {
        const db = await fs.readJson(AGENTS_DB_PATH);
        res.json({ success: true, agents: db.agents });
    } catch (e) {
        res.json({ success: false, agents: [] });
    }
});

app.delete('/api/agents/:id', authMiddleware, async (req, res) => {
    try {
        const db = await fs.readJson(AGENTS_DB_PATH);
        const agent = db.agents.find(a => a.id === req.params.id);
        if (agent && agent.filePath) {
            fs.removeSync(path.join(__dirname, agent.filePath));
        }
        db.agents = db.agents.filter(a => a.id !== req.params.id);
        await fs.writeJson(AGENTS_DB_PATH, db, { spaces: 2 });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/self-heal', authMiddleware, async (req, res) => {
    const { jobId, error, code } = req.body;
    if (!jobId || !error) return res.status(400).json({ error: 'Missing jobId or error context' });
    
    console.log(`[SELF-HEAL] Received report for ${jobId}: ${error.message}`);
    
    try {
        // Trigger background repair
        const repairedCode = await runAgentRepair(jobId, error, code);
        
        // Update the file
        const db = await fs.readJson(AGENTS_DB_PATH);
        const agent = db.agents.find(a => a.id === jobId);
        if (agent) {
            const filePath = path.join(__dirname, agent.filePath);
            await fs.writeFile(filePath, repairedCode, 'utf8');
            streamLog(jobId, '✨ REPAIR COMPLETE: Agent has been autonomously patched.', 'success');
            res.json({ success: true, message: 'Repair cycle complete. Please refresh the agent page.' });
        } else {
            res.status(404).json({ error: 'Agent record not found' });
        }
    } catch (e) {
        console.error('[SELF-HEAL ERROR]:', e);
        res.status(500).json({ error: 'Repair failed', details: e.message });
    }
});

async function saveAgentToRegistry(agentData) {
    const db = await fs.readJson(AGENTS_DB_PATH);
    db.agents.unshift(agentData); // Newest first
    if (db.agents.length > 50) db.agents = db.agents.slice(0, 50); // Keep last 50
    await fs.writeJson(AGENTS_DB_PATH, db, { spaces: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATION API — Returns job ID immediately (non-blocking)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/orchestrate', authMiddleware, async (req, res) => {
    const { goal } = req.body;
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ success: false, error: 'MISSING GEMINI_API_KEY in .env' });
    }
    const jobId = `job-${Date.now()}`;
    jobs[jobId] = { id: jobId, goal, status: 'processing', progress: 0, logs: [], result: null, error: null };
    console.log(`[NEXUS] JOB QUEUED: ${jobId}`);
    runNexusPrimeSynthesis(jobId, goal).catch(err => {
        jobs[jobId].status = 'failed';
        jobs[jobId].error = err.message;
        streamLog(jobId, `CRITICAL FAILURE: ${err.message}`, 'error');
        io.emit(`job:${jobId}:status`, { status: 'failed', error: err.message });
    });
    res.json({ success: true, jobId });
});

// Legacy polling endpoint (fallback for clients that need it)
app.get('/job-status/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// ─────────────────────────────────────────────────────────────────────────────
// NEXUS PRIME SYNTHESIS ENGINE v5.0
// Applies: Orchestrator-Workers, Parallelization, Evaluator-Optimizer, Routing
// ─────────────────────────────────────────────────────────────────────────────
async function runNexusPrimeSynthesis(jobId, goal) {
    const job = jobs[jobId];
    const stripDocTags = t => t.replace(/<\/?(html|head|body|!DOCTYPE|meta|title|link|script)[^>]*>/gi, '').trim();

    // ── PHASE 0: MISSION ROUTING ──────────────────────────────────────────────
    streamLog(jobId, '🔀 ROUTING MISSION... Classifying goal type.', 'system');
    streamProgress(jobId, 5, 'ROUTING');
    const route = await routeMission(goal);
    streamLog(jobId, `✅ ROUTE DETECTED: ${route.type.toUpperCase()} | Complexity: ${route.complexity}`, 'agent');
    io.emit(`job:${jobId}:route`, route);

    // ── PHASE 1: ORCHESTRATOR AGENT (Blueprint) ───────────────────────────────
    streamLog(jobId, '🏛️ ORCHESTRATOR AGENT: Architecting blueprint...', 'agent');
    streamProgress(jobId, 15, 'BLUEPRINTING');

    const orchestratorPrompt = `
You are the "Aon AI Lead Orchestrator" - an elite software architect for a high-end SaaS product.

MISSION: Architect an industry-leading ${route.type} application for: "${goal}"

DESIGN SYSTEM SPECIFICATION:
- Spacing: 8px-based grid (4|8|16|24|32|48|64)
- Typography: Primary (Outfit), Secondary (Inter)
- Aesthetic: Modern High-Contrast Dark Mode (Glassmorphism, Bento-Grid, Premium Gradients)

Respond with ONLY valid JSON (no markdown wrapper):
{
  "projectName": "Project Name",
  "tagline": "Premium one-line description",
  "designSystem": {
    "accentColor": "${route.primaryColor}",
    "complementary": "${route.secondaryColor}",
    "surfaceBlur": "12px",
    "cornerRadius": "16px"
  },
  "modules": [
    { "id": "mod_1", "name": "Module Name", "role": "Strategic purpose", "priority": "high|medium|low", "type": "chart|feed|control|display" }
  ],
  "dataStrategy": {
    "liveSync": true,
    "entities": ["entity1", "entity2"],
    "charting": true
  },
  "uiArchitecture": {
    "layout": "sidebar_bento|tabs_professional|split_dashboard",
    "motionIntensity": "subtle|smooth|dynamic"
  }
}
    `;
    const blueprintText = await callAI(orchestratorPrompt, 'JSON', jobId, 'ORCHESTRATOR');
    const blueprint = JSON.parse(blueprintText);
    streamLog(jobId, `📋 BLUEPRINT READY: "${blueprint.projectName}"`, 'success');
    streamProgress(jobId, 28, 'BLUEPRINT COMPLETE');
    io.emit(`job:${jobId}:blueprint`, blueprint);

    // ── PHASE 2: PARALLEL WORKERS — HTML + Data Analysis ─────────────────────
    // INSPIRED BY: Anthropic's Parallelization Workflow
    streamLog(jobId, '⚡ PARALLEL WORKERS DEPLOYING: HTML Agent + Data Agent...', 'agent');
    streamProgress(jobId, 35, 'PARALLEL SYNTHESIS');

    const htmlAgentPrompt = `
You are "HTML Agent" - an expert in Semantic HTML5 and Enterprise UI Architecture.
Build the BODY content for: "${blueprint.projectName}" (goal: ${goal})

ARCHITECTURE:
- Layout: ${blueprint.uiArchitecture.layout}
- Design Tokens: Corresponds to Corner Radius ${blueprint.designSystem.cornerRadius}
- Framework: Professional Bento-Grid implementation

STRICT RULES:
1. Output ONLY raw HTML fragment. NO <html>, <head>, <body> tags.
2. Use Semantic HTML5: <main>, <section>, <article>, <aside>, <nav>, <header>.
3. Include a "GUIDE" button (id="aon-guide-trigger") in the top nav or header.
4. Include an "OPERATIONS MODAL" (id="aon-guide-modal") that is hidden by default.
5. ZERO-PLACEHOLDER POLICY: Do not use "Loading..." or "Coming Soon" in static HTML.
6. Accessibility: Include aria-labels and proper role attributes for all modules.
7. Structure for application type: ${route.type}.
`;

    const mockDataPrompt = `
You are "Data Architect Agent" - you design the JavaScript data layer.
For this application: "${blueprint.projectName}" (goal: ${goal})
Data requirements: ${JSON.stringify(blueprint.dataRequirements)}

Define the data architecture. Respond with ONLY a valid JSON object:
{
  "endpoints": [{ "id": "id", "path": "/path" }],
  "mockData": { "key": "value" },
  "operations_manual": [
    { "feature": "Name", "action": "How to use", "value_prop": "Why it matters" }
  ],
  "stateVariables": { "var": "default" }
}
Endpoints available: /live-data/crypto, /live-data/news, /search (POST with { query }).
    `;

    const [structureHTML, dataArchText] = await Promise.all([
        callAI(htmlAgentPrompt, 'HTML', jobId, 'HTML-AGENT'),
        callAI(mockDataPrompt, 'JSON', jobId, 'DATA-AGENT')
    ]);

    const cleanHTML = stripDocTags(structureHTML);
    let dataArch = {};
    try { dataArch = JSON.parse(dataArchText); } catch { dataArch = { endpoints: [], stateVariables: {}, eventHandlers: [] }; }

    streamLog(jobId, '✅ HTML AGENT: Structure synthesized.', 'success');
    streamLog(jobId, '✅ DATA AGENT: Data architecture ready.', 'success');
    streamProgress(jobId, 55, 'WORKERS COMPLETE');

    // ── PHASE 3: PARALLEL WORKERS — JS Logic + CSS Styling ───────────────────
    streamLog(jobId, '⚡ PARALLEL WORKERS DEPLOYING: JS Agent + CSS Agent...', 'agent');

    const jsAgentPrompt = `
You are "JS Agent" - a Senior Software Engineer specializing in Vanilla JS and System Architecture.
Write Enterprise JavaScript for: "${blueprint.projectName}"

GOAL: ${goal} | CATEGORY: ${blueprint.modules.map(m => m.type).join(', ')}

ARCHITECTURE:
1. Global State: window.__AON_STATE__ = { data: {}, ui: { loading: true }, config: ${JSON.stringify(blueprint.designSystem)} };
2. Logic Patterns: Use a centralized 'store' update pattern.
3. Charting: IF modules include 'chart', implement Chart.js logic using the canvases provided.
4. Error Resilience: Wrap all fetch/async calls in try/catch with UI toast/notification feedback.
5. Micro-interactions: Use standard easing for all UI transitions.

STRICT RULES:
- Output ONLY raw JavaScript.
- POPULATE the UI immediately using the 'mockData' from Data Architect. DO NOT show empty states.
- HYDRATE the "OPERATIONS MODAL" using the 'operations_manual' data.
- IMPLEMENT real logic for every tap/click event mentioned in the HTML.
- Hook into Bento-Grid article IDs.
- Use 'lucide.createIcons()' for premium iconography.
- IMPORTANT: Use RELATIVE paths for all fetch calls (e.g., '/chat', '/live-data').
`;

    const cssAgentPrompt = `
You are "CSS Agent" - a Master of UI/UX and High-Fidelity Professional Web Design.
Build the Design System for: "${blueprint.projectName}"

DESIGN TOKENS:
- Primary: ${blueprint.designSystem.accentColor}
- Secondary: ${blueprint.designSystem.complementary}
- Corner: ${blueprint.designSystem.cornerRadius}
- Blur: ${blueprint.designSystem.surfaceBlur}

REQUIREMENTS:
1. Use Professional Bento-Grid Layout: Use 'display: grid' with 'grid-template-columns: repeat(12, 1fr)'.
2. Elevation: Implement multi-layered box-shadows (0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)).
3. Glassmorphism: Use backdrop-filter for mesh surface effects.
4. Typography Scales: Enforce professional 'clamp()' based font weights.
5. Hover Effects: Interactive cards must scale (1.02) and glow on hover.
6. Responsive: Mobile-first design that adapts to desktop ultra-wides.
7. Scrollbars: Use thin, modern, invisible-until-hover gutter styles.
8. Guide Modal: Provide a stunning, fullscreen or large-centered glassmorphism modal style for '.aon-guide-modal'. Highlight '.guide-feature' cards within it.

OUTPUT: Raw CSS ONLY.
`;

    const [coreJS, coreCSS] = await Promise.all([
        callAI(jsAgentPrompt, 'JS', jobId, 'JS-AGENT'),
        callAI(cssAgentPrompt, 'CSS', jobId, 'CSS-AGENT')
    ]);

    streamLog(jobId, '✅ JS AGENT: Logic hydration complete.', 'success');
    streamLog(jobId, '✅ CSS AGENT: Design system applied.', 'success');
    streamProgress(jobId, 75, 'AGENTS COMPLETE');

    // ── PHASE 4: ASSEMBLY ─────────────────────────────────────────────────────
    streamLog(jobId, '🔩 ASSEMBLER: Compiling unified application...', 'system');
    const assembledApp = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${blueprint.projectName} | Aon AI Factory</title>
    <meta name="description" content="${blueprint.tagline || goal}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Inter:wght@300;400;500;700&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css"/>
    <style>
        :root {
            --primary: ${blueprint.designSystem.accentColor};
            --secondary: ${blueprint.designSystem.complementary};
            --bg: #050507;
            --surface: rgba(15,15,20,0.85);
            --border: rgba(255,255,255,0.08);
            --text: #f0f0f5;
            --text-muted: rgba(255,255,255,0.5);
            --error: #ef4444;
            --radius: ${blueprint.designSystem.cornerRadius};
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--bg);
            color: var(--text);
            font-family: 'Inter', sans-serif;
            overflow-x: hidden;
            min-height: 100vh;
        }
        h1,h2,h3,h4 { font-family: 'Outfit', sans-serif; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        
        /* SELF-HEAL UI */
        #aon-self-heal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.8); backdrop-filter: blur(8px);
            display: none; flex-direction: column; align-items: center; justify-content: center;
            z-index: 9999; text-align: center; padding: 20px;
        }
        .heal-card {
            background: #111; border: 1px solid var(--error); border-radius: 16px;
            padding: 40px; max-width: 500px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);
        }
        .heal-btn {
            background: var(--primary); color: white; border: none; padding: 12px 24px;
            border-radius: 8px; cursor: pointer; font-weight: 600; margin-top: 20px;
            transition: all 0.3s;
        }
        .heal-btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px var(--primary); }
        .heal-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .aon-watermark {
            position: fixed; bottom: 12px; right: 16px;
            font-size: 11px; font-family: 'Outfit', sans-serif;
            opacity: 0.25; pointer-events: none; letter-spacing: 0.1em;
        }
        ${coreCSS}
    </style>
</head>
<body>
    <div id="aon-self-heal-overlay">
        <div class="heal-card">
            <h2 style="color: var(--error); margin-bottom: 10px;">Neural Instability Detected</h2>
            <p style="color: var(--text-muted); margin-bottom: 20px;">This agent has encountered a runtime error. The Aon Factory can attempt an autonomous repair.</p>
            <div id="error-details" style="font-family: monospace; font-size: 12px; background: #000; padding: 10px; border-radius: 8px; color: #ff9d9d; text-align: left; margin-bottom: 20px; max-height: 150px; overflow: auto;"></div>
            <input type="password" id="repair-pass" placeholder="Admin Access Key" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: #000; color: white; margin-bottom: 10px; outline: none;">
            <button id="repair-btn" class="heal-btn">Execute Self-Repair</button>
        </div>
    </div>

    ${cleanHTML}
    <div class="aon-watermark">⚡ AON AI FACTORY v6.0 Alpha</div>
    <script>
    (async () => {
        const JOB_ID = "${jobId}";
        const repairBtn = document.getElementById('repair-btn');
        const repairPass = document.getElementById('repair-pass');
        const overlay = document.getElementById('aon-self-heal-overlay');
        const errorView = document.getElementById('error-details');

        window.onerror = function(msg, url, line, col, error) {
            handleCrash({ message: msg, stack: error?.stack, line, col });
            return false;
        };

        window.onunhandledrejection = function(event) {
            handleCrash({ message: event.reason?.message || 'Unhandled Rejection', stack: event.reason?.stack });
        };

        function handleCrash(err) {
            console.error('[AON CRASH]:', err);
            overlay.style.display = 'flex';
            errorView.innerText = err.message + "\\n" + (err.stack || '');
        }

        repairBtn.onclick = async () => {
            const pass = repairPass.value;
            if (!pass) { alert("Admin password required for self-repair."); return; }
            
            repairBtn.innerText = "Repairing Neural Pathways...";
            repairBtn.disabled = true;
            try {
                const res = await fetch('/api/self-heal', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'x-admin-password': pass
                    },
                    body: JSON.stringify({
                        jobId: JOB_ID,
                        error: { message: errorView.innerText },
                        code: document.documentElement.outerHTML
                    })
                });
                const data = await res.json();
                if (data.success) {
                    repairBtn.innerText = "Repair Successful! Reloading...";
                    setTimeout(() => location.reload(), 2000);
                } else {
                    throw new Error(data.error);
                }
            } catch (e) {
                repairBtn.innerText = "Repair Failed. Try again?";
                repairBtn.disabled = false;
                alert("Repair Error: " + e.message);
            }
        };

        try {
            ${coreJS}
            if (typeof lucide !== 'undefined') lucide.createIcons();
        } catch (e) {
            handleCrash(e);
        }
    })();
    </script>
</body>
</html>`;

    // ── PHASE 5: EVALUATOR-OPTIMIZER (QA Critic Agent) ───────────────────────
    streamLog(jobId, '🔍 QA CRITIC AGENT: Auditing output...', 'agent');
    streamProgress(jobId, 85, 'QA REVIEW');

    const qaPrompt = `
You are the "Aon AI QA Critic Agent". Evaluate this generated web application.
Review for Maturity, Visual Excellence, and Logical Depth.

Review the assembled code:
${assembledApp.substring(0, 4000)}

Respond with ONLY valid JSON:
{
  "score": 0-100,
  "criticalIssues": ["issue1", "issue2"],
  "maturityRating": "low|medium|high",
  "verdict": "PASS|FAIL"
}
`;

    let qaResult = { score: 70, criticalIssues: ['Initial Pass'], verdict: 'FAIL' };
    try {
        const qaText = await callAI(qaPrompt, 'JSON', jobId, 'QA-CRITIC');
        qaResult = JSON.parse(qaText);
    } catch (e) {}

    // ── PHASE 5.5: RECURSIVE REFINEMENT ──────────────────────────────────────
    let finalApp = assembledApp;
    if (qaResult.score < 90) {
        streamLog(jobId, `🔄 REFINEMENT TRIGGERED: Score ${qaResult.score}/100 is below Maturity threshold.`, 'agent');
        const optimized = await runOptimizerPass(jobId, qaResult, cleanHTML, coreCSS, coreJS);
        
        // Re-assemble
        finalApp = assembledApp.replace(cleanHTML, optimized.html)
                               .replace(coreCSS, optimized.css)
                               .replace(coreJS, optimized.js);
        
        streamLog(jobId, '✨ REFINEMENT COMPLETE: Premium Polish applied.', 'success');
    }

    // UPDATE RECORD
    const safeId = `${blueprint.projectName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${jobId}`;
    const fileName = `${safeId}.html`;
    const filePath = path.join(BUILDS_DIR, fileName);
    await fs.writeFile(filePath, finalApp.trim(), 'utf8');

    const agentRecord = {
        id: jobId,
        projectName: blueprint.projectName,
        tagline: blueprint.tagline || goal,
        goal,
        type: route.type,
        filePath: `builds/${fileName}`,
        qaScore: qaResult.score,
        createdAt: new Date().toISOString(),
        primaryColor: blueprint.designSystem.accentColor,
        secondaryColor: blueprint.designSystem.complementary
    };

    await saveAgentToRegistry(agentRecord);

    job.status = 'completed';
    job.progress = 100;
    job.result = agentRecord;
    job.logs.push('MISSION_SUCCESS');

    streamProgress(jobId, 100, 'COMPLETE');
    streamLog(jobId, `🚀 MISSION COMPLETE: "${blueprint.projectName}" is live!`, 'success');
    io.emit(`job:${jobId}:status`, { status: 'completed', result: agentRecord });

    console.log(`[NEXUS] JOB ${jobId} COMPLETED. FILE: ${filePath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE DATA BRIDGE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/live-data/:type', async (req, res) => {
    try {
        if (req.params.type === 'crypto') {
            try {
                const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true', { timeout: 5000 });
                return res.json(r.data);
            } catch (e) {
                console.warn('[FALLBACK] Coingecko failed, returning mock crypto data.');
                return res.json({
                    bitcoin: { usd: 68432.12, usd_24h_change: 1.2 },
                    ethereum: { usd: 3451.88, usd_24h_change: -0.5 },
                    solana: { usd: 145.22, usd_24h_change: 4.8 }
                });
            }
        }
        if (req.params.type === 'news') {
            try {
                const r = await axios.get('https://ok.surf/api/v1/cors/news-feed', { timeout: 5000 });
                return res.json(r.data);
            } catch (e) {
                console.warn('[FALLBACK] News API failed, returning mock news.');
                return res.json({ 
                    US: [{ title: "AI Meta-Factory Systems Online", link: "#", source: "AON Internal" }],
                    World: [{ title: "Global Neural Adoption Rising", link: "#", source: "AON Internal" }]
                });
            }
        }
        res.status(404).json({ error: 'Data type not supported' });
    } catch (e) {
        console.error('[LIVE DATA ERROR]:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/self-heal-dashboard', authMiddleware, async (req, res) => {
    const { error } = req.body;
    if (!error) return res.status(400).json({ error: 'Missing error context' });
    
    console.log(`[DASHBOARD-HEAL] Received critical system failure report: ${error.message}`);
    
    try {
        const repairResult = await runDashboardRepair(error);
        const { file, content } = repairResult;
        
        if (!['index.html', 'script.js', 'style.css', 'server.js'].includes(file)) {
            throw new Error(`Invalid file target for repair: ${file}`);
        }
        
        // Backup the original file
        const filePath = path.join(__dirname, file);
        await fs.copy(filePath, `${filePath}.bak`);
        
        // Write the fix
        await fs.writeFile(filePath, content, 'utf8');
        
        console.log(`[DASHBOARD-HEAL] SUCCESSFULLY PATCHED ${file}. System stabilizing.`);
        
        res.json({ 
            success: true, 
            message: `System stabilized. Patched ${file}. Restarting link...`,
            target: file 
        });
    } catch (e) {
        console.error('[DASHBOARD-HEAL] Emergency repair failed:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH BRIDGE
// ─────────────────────────────────────────────────────────────────────────────
app.post('/search', async (req, res) => {
    try {
        const r = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(req.body.query)}&format=json&no_html=1`, { timeout: 5000 });
        const results = (r.data.RelatedTopics || []).slice(0, 5).map(t => t.Text).filter(Boolean);
        if (results.length === 0) throw new Error('No results');
        res.json({ results });
    } catch (e) {
        console.warn('[FALLBACK] Search failed for:', req.body.query);
        res.json({ results: [`Analysis for ${req.body.query} suggests standard architectural compliance and high utility score.`] });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT BRIDGE (for generated chatbot agents)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
    const { message, mission } = req.body;
    try {
        const prompt = `You are an expert AI assistant for: "${mission}". Respond helpfully and naturally. User says: ${message}`;
        const reply = await callAI(prompt, 'Plain Text', null, 'CHAT-REPLY');
        res.json({ reply });
    } catch (e) {
        console.error('[CHAT ROUTE FALLBACK]: AI Cascade exhausted. Returning simulated response.');
        // GRACEFUL DEGRADATION: Return a helpful simulated response if AI is down/over quota
        const simulatedReplies = [
            "I'm operating in emergency power-save mode due to high neural traffic. I recommend sticking to the blueprint for now!",
            "Neural sync is currently limited. Let's focus on the core modules of your mission.",
            "I'm analyzing your request via backup protocols. The optimization lab suggests refining your primary goal.",
            "System quota reached, but I'm still here! I've logged your request for full processing once the neural link stabilizes."
        ];
        const randomReply = simulatedReplies[Math.floor(Math.random() * simulatedReplies.length)];
        res.json({ 
            reply: `[Neural Backup]: ${randomReply}`,
            isSimulated: true,
            warning: "Gemini API Quota Exceeded. Using local heuristic fallback."
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// VISION ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────
app.post('/vision-analyze', async (req, res) => {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const prompt = 'Identify the primary object in this image. Reply with ONLY its name (e.g., "Server Rack"). Keep it brief.';
    try {
        const objectName = await callAIVision(prompt, imageBase64);
        res.json({ objectName: objectName.replace(/[.\s]+$/g, '') });
    } catch (e) {
        console.warn(`[VISION FALLBACK] Using simulated detection: ${e.message}`);
        res.status(200).json({ objectName: "Active Surveillance Node" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOK NOTES EXTRACTOR — Gemini Vision multimodal endpoint
// Extracts structured, editable notes from a photographed book page
// ─────────────────────────────────────────────────────────────────────────────
app.post('/vision-book-extract', async (req, res) => {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const prompt = `You are an expert book notes extractor and academic assistant.
Carefully analyze this image of a book page and extract comprehensive, structured notes.

Output your response in this exact format (plain text, no markdown fences):

BOOK TITLE: [Extract or infer the book title if visible, otherwise write "Unknown"]
AUTHOR: [Extract author name if visible, otherwise write "Unknown"]
CHAPTER / SECTION: [Extract chapter or section heading if visible]
PAGE NUMBER: [If visible]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FULL EXTRACTED TEXT:
[Transcribe ALL readable text from the page verbatim, preserving paragraphs]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KEY CONCEPTS & SUMMARIES:
• [Key concept or idea 1]
• [Key concept or idea 2]
• [Key concept or idea 3]
(Add as many points as needed)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPORTANT TERMS:
[List any important terms, definitions, or names mentioned]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STUDY NOTES:
[Write 2-3 sentences summarizing the main takeaway of this page, useful for revision]

If the image is blurry or text is not clearly visible, describe what you can see and provide whatever partial extraction is possible.`;

    try {
        const notes = await callAIVision(prompt, imageBase64);
        res.json({ notes });
    } catch (e) {
        console.error('[BOOK EXTRACT ERROR]:', e.message);
        // Providing a descriptive error in the actual JSON so the UI can display it
        res.status(200).json({ 
            notes: `⚠️ EXTRACTION SERVICE UNAVAILABLE\n\nERROR: ${e.message}\n\nREASON: All Gemini Vision models returned 404 or were restricted. Please verify your API key supports Multimodal/Vision capabilities in the current region.` 
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY: Simple agent generation (kept for backwards compat)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/generate-agent', async (req, res) => {
    const { mission } = req.body;
    try {
        const code = await callAI(`Build a complete single-file HTML/CSS/JS ${mission} app. Use dark theme, glassmorphism, Inter/Outfit fonts, Lucide icons. Output raw HTML only.`, 'HTML');
        await fs.writeFile(path.join(__dirname, 'generated_agent.html'), code, 'utf8');
        res.json({ success: true, file: 'generated_agent.html' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║         AON AI — NEXUS PRIME v5.0  ONLINE             ║
║  Patterns: ClaudeCode | Anthropic | OpenHands | CrewAI ║
╠═══════════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${PORT}                     ║
║  WebSocket: ws://localhost:${PORT}                       ║
╚═══════════════════════════════════════════════════════╝
    `);
});
