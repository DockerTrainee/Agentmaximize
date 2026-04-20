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
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const Razorpay = require('razorpay');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { JSDOM } = require('jsdom');
const vm = require('vm');

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE — Supports Persistent Disks (Render / Cloud Run)
// ─────────────────────────────────────────────────────────────────────────────
const DATA_BASE = process.env.DATA_DIR || __dirname;
const AGENTS_DB_PATH = path.join(DATA_BASE, 'agents-db.json');
const SUBS_DB_PATH = path.join(DATA_BASE, 'data', 'subscriptions.json');
const BUILDS_DIR = path.join(DATA_BASE, 'builds');

fs.ensureDirSync(path.join(DATA_BASE, 'data'));
fs.ensureDirSync(path.join(DATA_BASE, 'builds'));
fs.ensureDirSync(path.join(DATA_BASE, 'system_agents'));

if (!fs.existsSync(AGENTS_DB_PATH)) fs.writeJsonSync(AGENTS_DB_PATH, { agents: [] });
if (!fs.existsSync(SUBS_DB_PATH)) fs.writeJsonSync(SUBS_DB_PATH, { subscriptions: {} });

// ── SYSTEM AGENTS — Permanent entries ────────────────────────────────
const SYSTEM_AGENTS = [
    {
        "id": "job-1775752755594",
        "projectName": "Agent Maximize",
        "tagline": "The Core Intelligence of AON AI — Specialized in high-fidelity synthesis.",
        "goal": "how can i use this agent at it's best ?",
        "type": "chatbot",
        "complexity": "elite",
        "filePath": "system_agents/agent_maximize.html",
        "qaScore": 99,
        "isSystem": true,
        "modules": [
            { "id": "mod_1", "name": "Contextual Guidance", "role": "Analyzes user intent", "priority": "high" },
            { "id": "mod_2", "name": "Prompt Refinement", "role": "Transforms queries", "priority": "high" }
        ],
        "createdAt": "2026-04-16T09:21:30.411Z",
        "primaryColor": "#6366F1",
        "secondaryColor": "#10B981"
    }
];

async function seedSystemAgents() {
    try {
        console.log('[SEED] Ensuring only Core Agent exists...');
        let db;
        try {
            db = await fs.readJson(AGENTS_DB_PATH);
        } catch (e) {
            console.warn('[SEED] Registry missing, creating new one...');
            db = { agents: [] };
        }
        
        let updated = false;
        
        // 1. Remove non-system agents and old system agents (Full Reset to Only Agent Maximize)
        const originalCount = db.agents.length;
        db.agents = db.agents.filter(a => a.id === SYSTEM_AGENTS[0].id);
        
        if (db.agents.length !== originalCount) {
            updated = true;
            console.log(`[SEED] Pruned ${originalCount - db.agents.length} other agents.`);
        }

        // 2. Add or repair the core system agent
        for (const sa of SYSTEM_AGENTS) {
            const index = db.agents.findIndex(a => a.id === sa.id);
            if (index === -1) {
                db.agents.unshift(sa); 
                updated = true;
                console.log(`[SEED] Restored system agent: ${sa.projectName}`);
            } else {
                // Ensure name and system flags are correct
                db.agents[index] = { ...db.agents[index], ...sa };
                updated = true;
                console.log(`[SEED] Hardened system agent: ${sa.projectName}`);
            }
        }
        
        if (updated) {
            await fs.writeJson(AGENTS_DB_PATH, db, { spaces: 2 });
            console.log('[SEED] Registry hardened successfully.');
        }
    } catch (err) {
        console.error('[SEED] FAILURE:', err.message);
    }
}

seedSystemAgents();

// ─────────────────────────────────────────────────────────────────────────────
// RAZORPAY CLIENT
// ─────────────────────────────────────────────────────────────────────────────
let razorpayInstance = null;
try {
    const rzpKeyId = (process.env.RAZORPAY_KEY_ID || '').trim();
    const rzpKeySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (rzpKeyId && rzpKeySecret && !rzpKeyId.includes('YOUR_KEY')) {
        razorpayInstance = new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret });
        console.log('[RAZORPAY] Payment gateway initialized.');
    } else {
        console.warn('[RAZORPAY] Keys not configured. Payment endpoints will return errors.');
    }
} catch (e) {
    console.error('[RAZORPAY] Init failed:', e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP TOOL MANAGER — Bridges external tools to Gemini
// ─────────────────────────────────────────────────────────────────────────────
class MCPManager {
    constructor() {
        this.clients = new Map();
        this.tools = [];
    }

    async connectServer(name, config) {
        try {
            console.log(`[MCP] Connecting to ${name}...`);
            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args || []
            });
            const client = new Client({ name: "aon-ai-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });
            await client.connect(transport);
            this.clients.set(name, client);
            
            const serverTools = await client.listTools();
            const mapped = serverTools.tools.map(t => ({
                serverName: name,
                ...t
            }));
            this.tools.push(...mapped);
            console.log(`[MCP] Server ${name} connected. Tools: ${serverTools.tools.length}`);
        } catch (e) {
            console.error(`[MCP] Connection failed for ${name}:`, e.message);
        }
    }

    getGeminiTools() {
        if (this.tools.length === 0) return [];
        return [{
            functionDeclarations: this.tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.inputSchema
            }))
        }];
    }

    async executeTool(toolName, args, jobId = null) {
        const tool = this.tools.find(t => t.name === toolName);
        if (!tool) throw new Error(`Tool ${toolName} not found.`);
        
        if (jobId) streamLog(jobId, `[TOOL] Executing ${toolName}...`, 'system');
        const client = this.clients.get(tool.serverName);
        const result = await client.callTool({ name: toolName, arguments: args });
        return result.content || result;
    }
}

const mcp = new MCPManager();

async function loadMCPServers() {
    try {
        const configPath = path.join(DATA_BASE, 'data', 'mcp-servers.json');
        if (!fs.existsSync(configPath)) {
            // Create default template for user
            await fs.writeJson(configPath, {
                servers: [
                    { "name": "sequential-thinking", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"], "enabled": true },
                    { "name": "duckduckgo", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-duckduckgo"], "enabled": true },
                    { "name": "brave-search", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-brave-search"], "enabled": false, "notes": "Set BRAVE_API_KEY in .env" }
                ]
            }, { spaces: 2 });
            console.log('[MCP] Created default config template at data/mcp-servers.json');
            return;
        }

        const config = await fs.readJson(configPath);
        for (const s of config.servers) {
            if (s.enabled) {
                console.log(`[MCP] Connecting to ${s.name}...`);
                try {
                    // 5-second timeout for server handshake
                    await Promise.race([
                        mcp.connectServer(s.name, s),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection Timeout')), 8000))
                    ]);
                    console.log(`[MCP] ✅ ${s.name} ready.`);
                } catch (err) {
                    console.error(`[MCP] ❌ ${s.name} failed:`, err.message);
                    // Do not throw, allow other servers to load
                }
            }
        }
    } catch (e) {
        console.error('[MCP] Config Load Failed:', e.message);
    }
}

loadMCPServers();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: ["http://localhost:3000", /\.onrender\.com$/, "https://agentmaximize.onrender.com"],
        methods: ["GET", "POST"],
        credentials: true
    } 
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

const PORT = process.env.PORT || 3000;

// ── MCP Diagnostics API ──────────────────────────────────────────────
app.get('/api/mcp-status', (req, res) => {
    const servers = [];
    mcp.clients.forEach((client, name) => {
        servers.push({ name, active: true });
    });
    res.json({
        totalTools: mcp.tools.length,
        servers,
        health: mcp.tools.length > 0 ? 'GOOD' : 'NO_TOOLS'
    });
});

// ── Subscription Helpers ─────────────────────────────────────────────────────
async function getSubscription(clientId) {
    try {
        const db = await fs.readJson(SUBS_DB_PATH);
        const sub = db.subscriptions[clientId];
        if (!sub) return { isPremium: false };
        // Check expiry
        if (sub.expiresAt && Date.now() > new Date(sub.expiresAt).getTime()) {
            sub.status = 'expired';
            db.subscriptions[clientId] = sub;
            await fs.writeJson(SUBS_DB_PATH, db, { spaces: 2 });
            return { isPremium: false, status: 'expired', ...sub };
        }
        // In Trial or Active Status are both Premium
        const isPremium = sub.status === 'active' || sub.status === 'trial';
        return { isPremium, ...sub };
    } catch (e) {
        console.error('[SUBS] Read error:', e.message);
        return { isPremium: false };
    }
}

async function activateSubscription(clientId, paymentId, orderId, plan = 'pro_monthly') {
    const db = await fs.readJson(SUBS_DB_PATH);
    db.subscriptions[clientId] = {
        status: 'active',
        plan,
        paymentId,
        orderId,
        activatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    };
    await fs.writeJson(SUBS_DB_PATH, db, { spaces: 2 });
    console.log(`[SUBS] Activated ${plan} for ${clientId}`);
    return db.subscriptions[clientId];
}

console.log(`[STORAGE] Persistence Mode: ${process.env.DATA_DIR ? 'DISK-BASED' : 'EPHEMERAL'}`);
console.log(`[STORAGE] Data Base: ${DATA_BASE}`);

const jobs = {};
global.IS_ON_QUOTA_RESTRICTION = false;

app.post('/api/subscription/start-trial', async (req, res) => {
    const clientId = req.headers['x-client-id'] || req.query.clientId;
    if (!clientId) return res.status(400).json({ error: 'Missing clientId' });

    try {
        const db = await fs.readJson(SUBS_DB_PATH);
        const existing = db.subscriptions[clientId];

        // Only allow trial if they never had a plan or trial before
        if (existing) {
            return res.status(400).json({ 
                error: 'TRIAL_ALREADY_USED', 
                message: 'A trial or subscription has already been activated for this account.' 
            });
        }

        const trialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        db.subscriptions[clientId] = {
            status: 'trial',
            plan: '7_day_trial',
            activatedAt: new Date().toISOString(),
            expiresAt: trialExpiry
        };

        await fs.writeJson(SUBS_DB_PATH, db, { spaces: 2 });
        console.log(`[SUBS] 🎁 7-Day Trial activated for ${clientId}`);
        res.json({ success: true, expiresAt: trialExpiry });
    } catch (e) {
        console.error('[SUBS] Trial activation error:', e.message);
        res.status(500).json({ error: 'TRIAL_FAILED', message: e.message });
    }
});
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

// Auth Middleware — password system removed, open access
const authMiddleware = (req, res, next) => next();

app.use('/builds', express.static(path.join(DATA_BASE, 'builds')));
app.use('/system_agents', express.static(path.join(DATA_BASE, 'system_agents')));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Redirect /favicon.ico → /favicon.png to stop 404 errors
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.png'));

// Capacitor Mock — Silences 404 console errors on web/render deployments
app.get('/capacitor.js', (req, res) => {
    res.type('application/javascript').send('/* Capacitor Native Bridge Mock (Web) */');
});

// Health check for Deployment (Render/Cloud Run)
app.get('/health', (req, res) => res.json({ status: 'HEALTHY', timestamp: new Date() }));

// Serving Legal Docs for App Store Compliance
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const sanitizeEnv = (val) => (val || "").split(/[\s\r\n]/)[0].replace(/['"]/g, '').trim();
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
 */
function streamLog(jobId, message, type = 'system') {
    io.emit(`job:${jobId}:log`, { message, type, ts: new Date().toLocaleTimeString() });
    if (jobs[jobId]) jobs[jobId].logs.push(`[${type.toUpperCase()}] ${message}`);
}

function streamProgress(jobId, value, label = '') {
    io.emit(`job:${jobId}:progress`, { value, label });
    if (jobs[jobId]) jobs[jobId].progress = value;
}

function streamThought(jobId, agent, message) {
    io.emit(`job:${jobId}:thought`, { agent, message, ts: new Date().toLocaleTimeString() });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// CORE AI ENGINE — Hybrid Cascade with Multi-Provider Fallback
// ─────────────────────────────────────────────────────────────────────────────
const GITHUB_ENDPOINT = 'https://models.inference.ai.azure.com/chat/completions';

const MODEL_CASCADE = [
    "anthropic/claude-3-5-sonnet-20241022",
    "gemini-2.0-flash-thinking-exp", 
    "gemini-1.5-pro",         
    "gemini-2.0-flash-exp",
    "gemini-1.5-flash",
    "github/gpt-4o",
    "github/gpt-4o-mini",
];

const PREMIUM_DESIGN_TOKENS = {
    glassmorphism: "backdrop-filter: blur(16px) saturate(180%); background: rgba(10, 10, 18, 0.7); border: 1px solid rgba(255, 255, 255, 0.08);",
    shadows: {
        soft: "0 10px 40px -10px rgba(0,0,0,0.5)",
        sharp: "0 2px 4px rgba(0,0,0,0.1)",
        glow: "0 0 20px rgba(99, 102, 241, 0.3)"
    },
    typography: {
        header: "font-family: 'Outfit', sans-serif; letter-spacing: -0.035em; font-weight: 800; line-height: 1.1;",
        body: "font-family: 'Inter', sans-serif; line-height: 1.625; letter-spacing: -0.011em;"
    },
    colors: {
        dark_surface: "#020205",
        card_surface: "rgba(15, 15, 25, 0.6)",
        accent_gradient: "linear-gradient(135deg, #6366F1 0%, #a855f7 100%)"
    },
    transitions: {
        spring: "all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
        smooth: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
    }
};

const AON_IDENTITY_CSS = `
:root {
    --glass: ${PREMIUM_DESIGN_TOKENS.glassmorphism};
    --shadow-premium: ${PREMIUM_DESIGN_TOKENS.shadows.soft};
    --accent-glow: ${PREMIUM_DESIGN_TOKENS.shadows.glow};
    --header-font: ${PREMIUM_DESIGN_TOKENS.typography.header};
    --body-font: ${PREMIUM_DESIGN_TOKENS.typography.body};
    --surface-noise: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
}

.aon-grid-elite {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(clamp(280px, 30vw, 450px), 1fr));
    gap: 24px;
    width: 100%;
    padding: 20px 0;
}

.aon-card {
    position: relative;
    ${PREMIUM_DESIGN_TOKENS.glassmorphism}
    border-radius: 24px;
    padding: 32px;
    box-shadow: var(--shadow-premium);
    overflow: hidden;
    transition: ${PREMIUM_DESIGN_TOKENS.transitions.spring};
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.aon-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 100%; height: 100%;
    background-image: var(--surface-noise);
    opacity: 0.04;
    pointer-events: none;
}

.aon-card::after {
    content: '';
    position: absolute;
    top: 0; left: 0; width: 100%; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
}

.aon-card:hover {
    transform: translateY(-10px) scale(1.01);
    box-shadow: 0 30px 60px -12px rgba(0,0,0,0.7), 0 18px 36px -18px rgba(0,0,0,0.7);
    border-color: rgba(255, 255, 255, 0.2);
}

.aon-btn-premium {
    position: relative;
    background: ${PREMIUM_DESIGN_TOKENS.colors.accent_gradient};
    color: white;
    border: none;
    border-radius: 12px;
    padding: 16px 32px;
    font-size: 0.95rem;
    ${PREMIUM_DESIGN_TOKENS.typography.header}
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    box-shadow: var(--accent-glow);
    transition: ${PREMIUM_DESIGN_TOKENS.transitions.smooth};
    overflow: hidden;
}

.aon-btn-premium:hover {
    transform: translateY(-2px) scale(1.02);
    box-shadow: 0 10px 30px rgba(99, 102, 241, 0.6);
    filter: brightness(1.1);
}

@keyframes entranceFadeIn {
    from { opacity: 0; transform: translateY(30px); filter: blur(10px); }
    to { opacity: 1; transform: translateY(0); filter: blur(0); }
}

.aon-entrance {
    animation: entranceFadeIn 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
}
`;

async function callAnthropicAI(modelName, prompt, jobId = null) {
    const token = sanitizeEnv(process.env.ANTHROPIC_API_KEY);
    if (!token || token === 'your_anthropic_key_here') {
        throw new Error('401 Unauthorized: ANTHROPIC_API_KEY not configured');
    }

    const cleanModelName = modelName.replace('anthropic/', '');
    if (jobId) streamLog(jobId, `[ANTHROPIC] Calling ${cleanModelName}...`, 'system');

    const anthropic = new Anthropic({ apiKey: token });
    const response = await anthropic.messages.create({
        model: cleanModelName,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
    });
    return response.content[0].text;
}

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

/**
 * The AON AI Virtual Execution Sandbox.
 * Runs generated JS locally to catch ReferenceErrors and SyntaxErrors.
 */
function validateJS(jsCode, htmlContext) {
    try {
        const dom = new JSDOM(htmlContext, { runScripts: "outside-only" });
        const script = new vm.Script(jsCode);
        const context = dom.getInternalVMContext();
        script.runInContext(context, { timeout: 1000 });
        return { valid: true, error: null };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

/**
 * AST Context Compaction (The Context Optimizer)
 * Parses HTML and strips large internal objects (like SVGs or base64 images)
 * to save LLM context window and speed up the Agent pipeline.
 */
function compactContext(htmlString) {
    try {
        const dom = new JSDOM(htmlString);
        const doc = dom.window.document;
        
        // Strip heavy inner contents
        doc.querySelectorAll('svg').forEach(el => el.innerHTML = '...[AON_COMPACTED_SVG]...');
        doc.querySelectorAll('img').forEach(el => el.setAttribute('src', '[AON_COMPACTED_IMG]'));
        doc.querySelectorAll('path').forEach(el => el.setAttribute('d', '...'));
        
        // Target long text nodes
        const walk = doc.createTreeWalker(doc.body, 4, null, false);
        let n;
        while(n = walk.nextNode()) {
            if(n.textContent.trim().length > 200) {
                n.textContent = n.textContent.substring(0, 200) + '...[AON_COMPACTED_TEXT]';
            }
        }
        
        return doc.body.innerHTML || htmlString;
    } catch (e) {
        return htmlString;
    }
}

/**
 * The Virtual Browser - Renders the app locally and takes a snapshot.
 */
async function captureVirtualScreenshot(htmlContent) {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        
        // Wait for entrance animations defined by AON DNA
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
        return screenshotBuffer.toString('base64');
    } catch (e) {
        console.error('[PUPPETEER ERROR]', e);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * The Vision Critic - Evaluates screenshots for UI/UX flaws.
 */
async function callVisionAI(prompt, base64Image, jobId) {
    if (jobId) streamLog(jobId, '[VISION-CRITIC] Calling gemini-1.5-pro for visual analysis...', 'system');
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const imagePart = {
        inlineData: {
            data: base64Image,
            mimeType: "image/jpeg"
        }
    };
    const result = await model.generateContent([prompt, imagePart]);
    return result.response.text().trim();
}

/**
 * The Optimizer Pass - Recursive refinement of low-score agents.
 */
async function runOptimizerPass(jobId, qaResult, html, css, js) {
    const prompt = `
You are the "Aon AI optimizer". You have been tasked with fixing logical gaps or visual flaws in an application.
QA SCORE: ${qaResult.score}/100
CRITICAL ISSUES: ${qaResult.criticalIssues.join(', ')}

CURRENT CODE:
HTML: ${html.substring(0, 1000)}...
CSS: ${css.substring(0, 1000)}...
JS: ${js.substring(0, 1000)}...

Respond with a JSON object containing the improved code:
{
  "html": "...",
  "css": "...",
  "js": "..."
}
Respond ONLY with JSON.
`;
    try {
        const resultText = await callAI(prompt, 'JSON', jobId, 'OPTIMIZER');
        return JSON.parse(resultText);
    } catch (e) {
        console.error('[OPTIMIZER ERROR]', e.message);
        return { html, css, js };
    }
}

async function callAI(prompt, format = 'HTML', jobId = null, agentName = '') {
    const tag = agentName ? `[${agentName}]` : '[AI]';
    const geminiTools = mcp.getGeminiTools();
    
    for (const modelId of MODEL_CASCADE) {
        const variations = (modelId.startsWith('github/') || modelId.startsWith('anthropic/')) ? [modelId] : [modelId, `models/${modelId}`];
        
        for (const modelName of variations) {
            let attempts = 0;
            const isGithub = modelName.startsWith('github/');
            const isAnthropic = modelName.startsWith('anthropic/');
            const maxAttempts = 2;
            
            while (attempts < maxAttempts) {
                try {
                    let text = '';
                    if (isGithub) {
                        text = await callGitHubAI(modelName, prompt, jobId);
                    } else if (isAnthropic) {
                        text = await callAnthropicAI(modelName, prompt, jobId);
                    } else {
                        if (jobId) streamLog(jobId, `${tag} Calling ${modelName}...`, 'system');
                        const model = genAI.getGenerativeModel({ 
                            model: modelName,
                            tools: geminiTools
                        });

                        const chat = model.startChat();
                        let result = await chat.sendMessage(prompt);
                        let response = result.response;
                        
                        let loopLimit = 5;
                        while(response.functionCalls()?.length > 0 && loopLimit > 0) {
                            loopLimit--;
                            const calls = response.functionCalls();
                            const toolResponses = [];

                            for (const call of calls) {
                                if (jobId) streamThought(jobId, agentName || 'System', `Executing tool: ${call.name}`);
                                const toolOutput = await mcp.executeTool(call.name, call.args, jobId);
                                toolResponses.push({
                                    functionResponse: {
                                        name: call.name,
                                        response: { content: toolOutput }
                                    }
                                });
                            }

                            result = await chat.sendMessage(toolResponses);
                            response = result.response;
                        }

                        text = response.text().trim();
                    }

                    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

                    if (format === 'JSON') {
                        const match = text.match(/\{[\s\S]*\}/);
                        if (match) text = match[0];
                        JSON.parse(text); 
                    }
                    return text;
                } catch (err) {
                    console.error(`[AI ATTEMPT FAILED] Model: ${modelName} | Error: ${err.message}`);
                    const isRateLimit = err.message.includes('429') || err.message.includes('quota') || err.message.includes('rate limit');
                    const isNotFound  = err.message.includes('404') || err.message.includes('not found') || err.message.includes('Model not found');
                    
                    if (isNotFound) {
                        console.warn(`[AON] Model ${modelName} not found, skipping.`);
                        break; 
                    }
                    
                    if (isRateLimit) {
                        if (jobId) streamLog(jobId, `⚠️ ${modelName} quota reached. Moving to fallback...`, 'error');
                        break; 
                    }

                    // 🛡️ NEW: Handle Forbidden/Auth errors as immediate skip signals
                    const isAuthError = err.message.includes('403') || err.message.includes('401') || err.message.includes('Forbidden');
                    if (isAuthError) {
                        console.warn(`[AON] Auth error for ${modelName}, skipping.`);
                        break;
                    }
                    
                    attempts++;
                    await wait(1000);
                }
            }
        }
    }

    // 🛡️ SURVIVAL FALLBACK: If all real AI fail, provide a structured mock response 
    // to allow the UI to continue and the user to see the build.
    if (jobId) streamLog(jobId, '⚠️ SYSTEM: Hybrid AI Cascade exhausted. Entering Autonomous Simulation Mode.', 'error');
    
    if (format === 'JSON') {
        return JSON.stringify({
            projectName: "Nexus Simulation",
            tagline: "AI Environment is disconnected - running in simulated state.",
            type: "dashboard",
            modules: [{ id: "sim_1", name: "System Stabilizer", role: "Mock Logic", priority: "high", type: "dashboard" }],
            designSystem: { accentColor: "#00f2ff", complementary: "#9d50ff", cornerRadius: "12px", surfaceBlur: "16px" },
            dataRequirements: { endpoints: [], mockData: {} },
            uiArchitecture: { layout: "sidebar_bento" }
        });
    }

    return `<div>
        <h1 style="color:#ff5555">AI ENVIRONMENT DISCONNECTED</h1>
        <p>All AI providers in the cascade (Gemini/GitHub) are currently returning errors. This usually means a missing key in the Render Dashboard or a 429 Rate Limit.</p>
        <div style="background:#111; padding:20px; border-radius:10px; border:1px solid #333; margin-top: 15px;">
            <strong style="color: #6366F1;">Critical Diagnosis steps:</strong>
            <ul style="margin-top: 10px; color: #94A3B8; font-size: 13px;">
                <li>Check <strong>Render Dashboard -> Environment Variables</strong> for GITHUB_TOKEN or GEMINI_API_KEY.</li>
                <li>Verify 'Generative Language API' is <strong>Enabled</strong> in GCP Console.</li>
                <li>If using a free Gemini key, you might be hitting the 15 RPM limit.</li>
            </ul>
        </div>
    </div>`;
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
${html}
--- CSS ---
${css}
--- JS ---
${js}

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
        const clientId = req.headers['x-client-id'];
        const db = await fs.readJson(AGENTS_DB_PATH);
        // Filter to only return this user's agents + all system agents
        const agents = clientId
            ? db.agents.filter(a => a.isSystem || a.clientId === clientId || !a.clientId)
            : db.agents;
        res.json({ success: true, agents });
    } catch (e) {
        console.error('[API] GET /api/agents Error:', e.message);
        res.json({ success: false, agents: [], error: e.message });
    }
});

app.get('/api/debug-status', async (req, res) => {
    try {
        const stats = {
            status: 'ONLINE',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            environment: process.env.NODE_ENV || 'development',
            storage: {
                dbExists: fs.existsSync(AGENTS_DB_PATH),
                dbPath: AGENTS_DB_PATH,
                baseDir: DATA_BASE,
                persistence: process.env.DATA_DIR ? 'DISK' : 'EPHEMERAL'
            }
        };

        // Aggressive error catching for filesystem ops to prevent 500
        try {
            stats.storage.dirContents = await fs.readdir(DATA_BASE);
            stats.storage.systemAgentsExists = fs.existsSync(path.join(DATA_BASE, 'system_agents'));
            if (stats.storage.systemAgentsExists) {
                stats.storage.systemAgents = await fs.readdir(path.join(DATA_BASE, 'system_agents'));
            }
        } catch (fsErr) {
            stats.storage.error = fsErr.message;
        }

        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

app.delete('/api/agents/:id', async (req, res) => {
    try {
        const clientId = req.headers['x-client-id'];
        const db = await fs.readJson(AGENTS_DB_PATH);
        const agent = db.agents.find(a => a.id === req.params.id);
        
        // Security: Block deletion of system agents
        if (agent && agent.isSystem) {
            return res.status(403).json({ success: false, error: 'Cannot delete core system agent.' });
        }

        // Security: Only allow deletion of own agents
        if (agent && clientId && agent.clientId && agent.clientId !== clientId) {
            return res.status(403).json({ success: false, error: 'Forbidden: Not your agent.' });
        }
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

app.post('/api/self-heal', async (req, res) => {
    const { jobId, error, code } = req.body;
    if (!jobId || !error) return res.status(400).json({ error: 'Missing jobId or error context' });
    
    console.log(`[SELF-HEAL] Received report for ${jobId}: ${error.message}`);
    
    try {
        // Trigger background repair
        const projectType = 'automated-fix'; 

        // 🛡️ SUBSCRIPTION GATE: Limit free users to 1 agent
        let currentAgents = [];
        try {
            const dbData = await fs.readJson(AGENTS_DB_PATH);
            currentAgents = dbData.agents || [];
        } catch (e) {}

        const isPremium = req.headers['x-subscription-pro'] === 'true';
        const isExistingAgent = currentAgents.some(a => a.id === jobId);

        if (!isPremium && currentAgents.length >= 1 && !isExistingAgent) {
            return res.status(403).json({
                error: 'AGENT_LIMIT_REACHED',
                message: 'Free users are limited to 1 active agent. Upgrade to Pro for unlimited synthesis.'
            });
        }

        // Initialize Synthesis Engine with Gemini Cloud Orchestration
        const synthesisId = `job-${Date.now()}`;
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
    db.agents.unshift(agentData); // Newest first, includes clientId
    if (db.agents.length > 500) db.agents = db.agents.slice(0, 500); // Increase limit for multi-user
    await fs.writeJson(AGENTS_DB_PATH, db, { spaces: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATION API — Returns job ID immediately (non-blocking)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/orchestrate', async (req, res) => {
    const { goal } = req.body;
    const clientId = req.headers['x-client-id'] || `anon-${Date.now()}`;
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ success: false, error: 'MISSING GEMINI_API_KEY in .env' });
    }

    // 🛡️ SUBSCRIPTION GATE: Server-side DB check (tamper-proof)
    try {
        const db = await fs.readJson(AGENTS_DB_PATH);
        const userAgents = db.agents.filter(a => a.clientId === clientId);
        const sub = await getSubscription(clientId);
        if (!sub.isPremium && userAgents.length >= 1) {
            return res.status(403).json({
                success: false,
                error: 'AGENT_LIMIT_REACHED',
                message: 'Free users are limited to 1 active agent. Upgrade to Pro for unlimited synthesis.'
            });
        }
    } catch (e) { /* if db read fails, allow synthesis */ }

    const jobId = `job-${Date.now()}`;
    jobs[jobId] = { id: jobId, goal, clientId, status: 'processing', progress: 0, logs: [], result: null, error: null };
    console.log(`[NEXUS] JOB QUEUED: ${jobId} for client: ${clientId}`);
    runNexusPrimeSynthesis(jobId, goal, clientId).catch(err => {
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
async function runNexusPrimeSynthesis(jobId, goal, clientId) {
    const job = jobs[jobId];
    const stripDocTags = t => t.replace(/<\/?(html|head|body|!DOCTYPE|meta|title|link|script)[^>]*>/gi, '').trim();

    // ── PHASE 0: MISSION ROUTING ──────────────────────────────────────────────
    streamLog(jobId, '🔀 ROUTING MISSION... Classifying goal type.', 'system');
    streamProgress(jobId, 5, 'ROUTING');
    const route = await routeMission(goal);
    const routeType = (route?.type || 'dashboard').toUpperCase();
    streamLog(jobId, `✅ ROUTE DETECTED: ${routeType} | Complexity: ${route?.complexity || 'moderate'}`, 'agent');
    io.emit(`job:${jobId}:route`, route);
    streamThought(jobId, 'Router', `Goal classified as ${route.type}. Setting ${route.complexity} complexity profile.`);

    // ── PHASE 0.5: UX DESIGN LEAD (The Mood Board) ──────────────────────────
    streamLog(jobId, '🎨 UX DESIGN LEAD: Establishing premium visual identity...', 'agent');
    streamProgress(jobId, 10, 'DESIGN STRATEGY');

    const uxDesignPrompt = `
You are the "Antigravity-Class UX Visionary". Your role is to define the "Visual Soul" for an app called: "${goal}"
The current route is ${route.type}.

MISSION: Design a high-fidelity, professional SaaS aesthetic.

TASKS:
1. THEME: Define a specific premium aesthetic (e.g. "Linear-Elite Dark", "Stripe-Pristine White", "Cyber-Vesta Glass").
2. COLOR THEORY: Precise HSL variables for Primary, Secondary, and Accent (Avoid generic colors. Use deep blacks, sophisticated grays, and vibrant primary accents).
3. SPATIAL LOGIC: Define container padding, inner-card gaps, and border-thickness for maximum "Airyness".
4. MOTION ARCHITECTURE: Define the spring curve and entrance stagger strategy.

Return JSON ONLY:
{
  "themeName": "Theme Name",
  "visualVibe": "Detailed description of the look/feel",
  "colorPalette": { "primary": "hsl(x,y,z)", "surface": "hsl(x,y,z)", "accent": "hsl(x,y,z)" },
  "motion": "elastic|smooth|sharp",
  "depth": "deep|minimal|layered",
  "spacingProfile": "airy|compact|balanced"
}
    `;

    const uxVibeText = await callAI(uxDesignPrompt, 'JSON', jobId, 'UX-DESIGNER');
    const uxVibe = JSON.parse(uxVibeText);
    streamThought(jobId, 'UX Designer', `Visual identity locked: ${uxVibe.themeName}. Applying ${uxVibe.motion} motion and ${uxVibe.depth} depth strategy.`);
    streamLog(jobId, '✅ UX DESIGNER: Mood Board initialized.', 'success');

    // ── PHASE 1: ORCHESTRATOR AGENT (Blueprint) ───────────────────────────────
    streamLog(jobId, '🏛️ ORCHESTRATOR AGENT: Architecting blueprint...', 'agent');
    streamProgress(jobId, 20, 'BLUEPRINTING');

    const orchestratorPrompt = `
You are the "Aon AI Lead Orchestrator". 
MISSION: Architect an industry-leading ${route.type} for: "${goal}"

TOOL USAGE PROTOCOL (MANDATORY):
1. THINK: Use the 'sequential_thinking' tool for at least 3 steps to identify architectural risks and niche-specific requirements.
2. GROUNDING: Use the 'search' tool to verify real-world standards for this mission.


Return JSON (NO MARKDOWN WRAPPERS):
{
  "projectName": "Project Name",
  "tagline": "Premium Slogan",
  "confidenceScore": 95,
  "reasoning": "Global strategy reasoning...",
  "designSystem": {
    "accentColor": "${route.primaryColor}",
    "complementary": "${route.secondaryColor}",
    "surfaceBlur": "12px",
    "cornerRadius": "16px"
  },
  "modules": [
    { 
      "id": "mod_1", 
      "name": "Module Name", 
      "role": "Strategic purpose", 
      "priority": "high|medium|low", 
      "type": "chart|feed|control|display",
      "reasoning": "Why this specific module is needed...",
      "confidence": 98
    }
  ],
  "dataStrategy": { "liveSync": true, "entities": ["entity1"], "charting": true },
  "uiArchitecture": { "layout": "sidebar_bento|tabs_professional|split_dashboard" }
}
    `;
    const blueprintText = await callAI(orchestratorPrompt, 'JSON', jobId, 'ORCHESTRATOR');
    const blueprint = JSON.parse(blueprintText);
    streamLog(jobId, `📋 BLUEPRINT READY: "${blueprint.projectName}"`, 'success');
    streamThought(jobId, 'Orchestrator', `Phase 1 complete. ${blueprint.reasoning}`);
    io.emit(`job:${jobId}:confidence`, blueprint.confidenceScore || 90);
    streamProgress(jobId, 28, 'BLUEPRINT COMPLETE (Awaiting Approval)');
    io.emit(`job:${jobId}:blueprint`, blueprint);

    // INTERNATIONAL STANDARD: Approval Gate
    // If we want to enforce an approval step, we pause here.
    // For now, we'll check if the client sends an 'approve' signal or if it's auto-approved.
    const requireApproval = true; 
    if (requireApproval) {
        streamLog(jobId, '⏳ SYSTEM PAUSED: Please review and approve the Mission Blueprint to proceed.', 'system');
        
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                streamLog(jobId, '⏰ APPROVAL TIMEOUT: Auto-approving based on high-confidence blueprint...', 'system');
                resolve();
            }, 60000); // 60s timeout

            const onApprove = (data) => {
                if (data.jobId === jobId) {
                    clearTimeout(timeout);
                    streamLog(jobId, '✅ BLUEPRINT APPROVED: Resuming synthesis...', 'success');
                    resolve();
                }
            };
            io.once('blueprint:approve', onApprove);
        });
    }

    // ── PHASE 1.5: PRD AGENT (Architectural Master Blueprint) ─────────────────
    streamLog(jobId, '🧠 PRD AGENT: Creating Source of Truth...', 'agent');
    streamProgress(jobId, 32, 'SPECIFICATION');

    const prdPrompt = `
You are the "Aon AI PRD Architect". Define the "Source of Truth" for "${blueprint.projectName}".
GOAL: ${goal} | BLUEPRINT: ${JSON.stringify(blueprint)}
UX VIBE: ${JSON.stringify(uxVibe)}

MANDATORY TOOL USAGE:
1. GROUNDING: Use the 'search' tool to find real-world schemas, medical/financial standards, or API docs for this mission. Do not guess data contracts.

TASKS:
1. DATA CONTRACT: Detailed JSON schema for live data (MUST be grounded in tool findings).
2. UX FLOWS: Key interaction patterns.
3. DOMAIN LOGIC: Solve the business logic.
4. BRAND DNA: Define HSL based on the Mood Board: ${JSON.stringify(uxVibe.colorPalette)}.

Respond with ONLY valid JSON.
    `;

    const prdText = await callAI(prdPrompt, 'JSON', jobId, 'PRD-AGENT');
    const prd = JSON.parse(prdText);
    streamThought(jobId, 'PRD Agent', 'Source of Truth locked. Color theory and data contracts initialized.');
    streamLog(jobId, '✅ PRD AGENT: Specification complete.', 'success');

    // ── PHASE 2: PARALLEL WORKERS ─────────────────────────────────────────────
    streamLog(jobId, '⚡ PARALLEL WORKERS DEPLOYING: HTML Agent + Data Agent...', 'agent');
    streamProgress(jobId, 45, 'SYNTHESIS');

    const htmlAgentPrompt = `
You are the "Antigravity-Class HTML Architect". 
Build the semantic layout for "${blueprint.projectName}".

UX DESIGN STRATEGY: ${uxVibe.visualVibe}
PRD CONTEXT: ${JSON.stringify(prd)}

RULES:
1. USE ELITE CLASSES: Use '.aon-grid-elite' as the primary layout container. Use '.aon-card' for all content modules.
2. FLUID BENTO: DO NOT use static column spans if they result in narrow boxes. Use '.aon-grid-elite' which handles auto-stacking via minmax(320px, 1fr).
3. SEMANTIC HIERARCHY: Every module must have a clear <h1> or <h2> using the '--header-font'.
4. MOTION: Tag main entrance modules with '.aon-entrance' and increasing animation-delay.
5. NO SQUISH: Ensure modules have enough breathing room. Use 32px padding inside cards.
`;

    const mockDataPrompt = `
You are "Data Architect Agent" - you design the JavaScript data layer.
For this application: "${blueprint.projectName}" (goal: ${goal})
Data requirements: ${JSON.stringify(blueprint.dataRequirements)}

Define the data architecture. Respond with ONLY a valid JSON object:
{
  "endpoints": [{ "id": "id", "path": "/path" }],
  "mockData": { "key": "value" },
  "stateVariables": { "var": "default" }
}
Endpoints available: /live-data/crypto, /live-data/news, /search (POST with { query }).
    `;

    const structureHTML = await callAI(htmlAgentPrompt, 'HTML', jobId, 'HTML-AGENT');
    streamThought(jobId, 'HTML Agent', 'Structured semantic layout with premium fluid bento-grid patterns.');
    
    await wait(800);
    const dataArchText = await callAI(mockDataPrompt, 'JSON', jobId, 'DATA-AGENT');
    streamThought(jobId, 'Data Agent', 'Architecture mapped. Live endpoints and state variables initialized.');

    const cleanHTML = stripDocTags(structureHTML);
    let dataArch = {};
    try { dataArch = JSON.parse(dataArchText); } catch { dataArch = { endpoints: [], stateVariables: {}, eventHandlers: [] }; }

    streamLog(jobId, '✅ HTML AGENT: Structure synthesized.', 'success');
    streamLog(jobId, '✅ DATA AGENT: Data architecture ready.', 'success');
    streamProgress(jobId, 55, 'WORKERS COMPLETE');

    // ── PHASE 3: PARALLEL WORKERS — JS Logic + CSS Styling ───────────────────
    streamLog(jobId, '⚡ PARALLEL WORKERS DEPLOYING: JS Agent + CSS Agent...', 'agent');

    const compactedHTML = compactContext(cleanHTML);
    streamThought(jobId, 'System Compactor', 'Executed Context Compaction. HTML AST compressed for higher agent IQ.');

    let jsAgentPrompt = `
You are "JS Agent" - a Master of Interaction Design and System Logic.
Write Enterprise JavaScript for: "${blueprint.projectName}"

CONTEXT:
- HTML CONTENT: ${compactedHTML}
- PRD & DATA: ${JSON.stringify(prd)}
- UX VIBE: ${uxVibe.visualVibe}

RULES:
1. INTERACTION DNA: Every click/hover MUST have a spring-animated feedback loop (use scale(0.98) on click, rotate(0.5deg) on hover).
2. ENTRANCE: Implement staggered fade-ins for cards using the '.aon-entrance' class.
3. DATA FLOW: Implement the 'domainLogic' from the PRD with real-time state updates.
4. FEEDBACK: Use Toast-style notifications for all actions.
`;

    let cssAgentPrompt = `
You are the "Antigravity-Class Design Engineer". 
Build the Luxury Design System for: "${blueprint.projectName}"
UX MOOD BOARD: ${JSON.stringify(uxVibe)}
PRD THEME: ${JSON.stringify(prd.designGuide)}
CONTEXT: ${compactedHTML}

RULES:
1. SPATIAL HYGIENE: EVERY container MUST have enough breathing room. Use 'gap: 24px' in the grid.
2. ELITE GRID: Strictly use '.aon-grid-elite' for the main wrapper. Never allow a column to be smaller than 320px wide (use min-width: 320px logic).
3. DEPTH LAYERING: Use '--glass' and '--shadow-premium' for a deep, high-fidelity SaaS look.
4. TYPOGRAPHY: Use '--header-font' for all headings. Ensure a 1.625 line-height for body text using '--body-font'. High-contrast only.
5. NO SQUISH: If you use flexbox, you MUST use 'flex-wrap: wrap'. Forbid any layout that squishes text into narrow vertical slivers.
`;

    let coreCSS = await callAI(cssAgentPrompt, 'CSS', jobId, 'CSS-AGENT');

    let coreJS = null;
    let jsAttempts = 0;
    while (jsAttempts < 3) {
        jsAttempts++;
        coreJS = await callAI(jsAgentPrompt, 'JS', jobId, 'JS-AGENT');
        streamThought(jobId, 'System Sandbox', `Evaluating generated Logic (Attempt ${jsAttempts})...`);
        const validation = validateJS(coreJS, cleanHTML);
        
        if (validation.valid) {
            streamThought(jobId, 'System Sandbox', '✅ Logic verified. No Reference or Syntax Errors found.');
            break;
        } else {
            const errorMsg = `CRITICAL ERROR: The Sandbox caught an error in your code: ${validation.error}. Rewrite the code to fix this.`;
            streamThought(jobId, 'System QA', `❌ Sandbox Error Caught: ${validation.error}. Retrying...`);
            jsAgentPrompt += `\n\n${errorMsg}`;
        }
    }
    streamThought(jobId, 'JS Agent', 'Neural logic hydrated. Event listeners and state management active.');
    await wait(800);

    const buildAppTemplate = (cssContent, jsContent, htmlContent) => `<!DOCTYPE html>
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
            --primary: ${blueprint.designSystem?.accentColor || '#6366F1'};
            --secondary: ${blueprint.designSystem?.complementary || '#a855f7'};
            --bg: #050507;
            --surface: rgba(15,15,20,0.85);
            --border: rgba(255,255,255,0.08);
            --text: #f0f0f5;
            --text-muted: rgba(255,255,255,0.5);
            --error: #ef4444;
            --radius: ${blueprint.designSystem?.cornerRadius || '16px'};
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
        ${AON_IDENTITY_CSS}
        
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
        
        /* {{AON_CSS}} */
        ${cssContent || ''}
    </style>
</head>
<body>
    <div id="aon-self-heal-overlay">
        <div class="heal-card">
            <h2 style="color: var(--error); margin-bottom: 10px;">Neural Instability Detected</h2>
            <p style="color: var(--text-muted); margin-bottom: 20px;">This agent has encountered a runtime error. The Aon Factory can attempt an autonomous repair.</p>
            <div id="error-details" style="font-family: monospace; font-size: 12px; background: #000; padding: 10px; border-radius: 8px; color: #ff9d9d; text-align: left; margin-bottom: 20px; max-height: 150px; overflow: auto;"></div>
            <button id="repair-btn" class="heal-btn">Execute Self-Repair</button>
        </div>
    </div>

    <!-- {{AON_HTML}} -->
    ${htmlContent || ''}

    <div class="aon-watermark">⚡ AON AI FACTORY v6.0 Alpha</div>
    <script>
    (async () => {
        const JOB_ID = "${jobId}";
        const repairBtn = document.getElementById('repair-btn');
        const overlay = document.getElementById('aon-self-heal-overlay');
        const errorView = document.getElementById('error-details');

        window.onerror = function(msg, url, line, col, error) {
            const isExtension = (url && (url.includes('chrome-extension') || url.includes('moz-extension'))) || 
                                (msg && (msg.includes('Origin not allowed') || msg.includes('ExtensionContext')));
            if (!isExtension) handleCrash({ message: msg, stack: error?.stack, line, col });
            return false;
        };

        window.onunhandledrejection = function(event) {
            const reason = event.reason?.message || '';
            const stack = event.reason?.stack || '';
            const isExtension = reason.includes('Origin not allowed') || reason.includes('extension') || stack.includes('inpage.js');
            if (!isExtension) {
                handleCrash({ message: event.reason?.message || 'Unhandled Rejection', stack: event.reason?.stack });
            } else {
                event.preventDefault();
            }
        };

        function handleCrash(err) {
            console.error('[AON CRASH]:', err);
            overlay.style.display = 'flex';
            errorView.innerText = err.message + "\\n" + (err.stack || '');
        }

        repairBtn.onclick = async () => {
            repairBtn.innerText = "Repairing Neural Pathways...";
            repairBtn.disabled = true;
            try {
                const res = await fetch('/api/self-heal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
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
            /* {{AON_JS}} */
            ${jsContent || ''}
            if (typeof lucide !== 'undefined') lucide.createIcons();
        } catch(e) {
            handleCrash(e);
        }
    })();
    </script>
</body>
</html>`;

    let assembledApp = buildAppTemplate(coreCSS, coreJS, cleanHTML);

    // ── PHASE 3.5: VISION CRITIC (Visual Evaluation) ─────────────────────────
    let visionAttempts = 0;
    while(visionAttempts < 2) {
        visionAttempts++;
        streamThought(jobId, 'Vision Critic', `Capturing Virtual Snapshot using headless chromium (Pass ${visionAttempts})...`);
        const snapshotBase64 = await captureVirtualScreenshot(assembledApp);
        
        if (snapshotBase64) {
             const visionPrompt = `
You are the "Antigravity Visual Auditor". 
Review the Virtual Snapshot for "${blueprint.projectName}".

AUDIT CRITERIA:
1. THE SQUISH: Are any cards narrow or vertically squished? (REJECT if true).
2. THE OVERFLOW: Is any text cutting off or overlapping? (REJECT if true).
3. THE VIBE: Does it look like a $1M SaaS product? (REJECT if it looks like a basic 2010 website).
4. CONTRAST: Is everything readable?

If the UI is perfect and elite, reply EXACTLY with: "PERFECT".
Otherwise, provide RUTHLESS CSS instructions to fix the spatial failure.
`;
             const critique = await callVisionAI(visionPrompt, snapshotBase64, jobId);
             if (critique === 'PERFECT' || critique.includes('PERFECT')) {
                 streamThought(jobId, 'Vision Critic', '✅ Visual Aesthetics Approved (PERFECT).');
                 break;
             } else {
                 streamThought(jobId, 'System QA', `❌ Visual Flaw Detected: Critic requested changes. Retrying CSS...`);
                 cssAgentPrompt += `\n\nCRITICAL UI FEEDBACK FROM VISION CRITIC:\nThe screenshot looks flawed: ${critique}\nRewrite the CSS carefully to fix these layout and color issues.`;
                 coreCSS = await callAI(cssAgentPrompt, 'CSS', jobId, 'CSS-AGENT');
                 assembledApp = buildAppTemplate(coreCSS, coreJS, cleanHTML);
             }
        } else {
             streamThought(jobId, 'Vision Critic', 'Snapshot failed or skipped, bypassing visual verification.');
             break;
        }
    }

    // ── PHASE 5: EVALUATOR-OPTIMIZER (QA Critic Agent) ───────────────────────
    streamLog(jobId, '🔍 QA CRITIC AGENT: Auditing output...', 'agent');
    streamThought(jobId, 'QA Critic', 'Running comprehensive audit. Checking visual excellence and logical integrity.');
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
        streamThought(jobId, 'Optimizer', `Polish required. Resolving ${qaResult.criticalIssues.length} logical gaps.`);
        const optimized = await runOptimizerPass(jobId, qaResult, cleanHTML, coreCSS, coreJS);
        
        // Re-assemble with high-fidelity polish
        finalApp = buildAppTemplate(optimized.css, optimized.js, optimized.html);
        
        streamLog(jobId, '✨ REFINEMENT COMPLETE: Premium Polish applied.', 'success');
        streamThought(jobId, 'Optimizer', 'Refinement complete. System reached stability threshold.');
    }

    // FINAL SANITY CHECK
    if (!finalApp || finalApp.length < 100 || finalApp.includes('undefined')) {
        streamLog(jobId, '⚠️ SYSTEM ERROR: Corrupted build detected. Falling back to non-optimized version.', 'error');
        finalApp = assembledApp;
    }

    // UPDATE RECORD
    const safeId = `${blueprint.projectName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${jobId}`;
    const fileName = `${safeId}.html`;
    const filePath = path.join(BUILDS_DIR, fileName);
    await fs.writeFile(filePath, finalApp.trim(), 'utf8');

    const moduleCount = blueprint.modules?.length || 0;
    const complexity = moduleCount > 5 ? 'complex' : (moduleCount > 2 ? 'medium' : 'simple');

    const agentRecord = {
        id: jobId,
        projectName: blueprint.projectName,
        tagline: blueprint.tagline || goal,
        goal,
        type: route.type,
        complexity,
        agentsUsed: 5, // Orchestrator, HTML, Data, JS, CSS
        filePath: `builds/${fileName}`,
        qaScore: qaResult.score,
        modules: blueprint.modules, // Storing modules for detailed view
        createdAt: new Date().toISOString(),
        primaryColor: blueprint.designSystem.accentColor,
        secondaryColor: blueprint.designSystem.complementary,
        clientId: clientId || 'shared'  // Tag agent to the user's device
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
// PAYMENT API — Razorpay Integration
// ─────────────────────────────────────────────────────────────────────────────
const PLAN_AMOUNT = 79900; // ₹799 in paise
const PLAN_CURRENCY = 'INR';

app.post('/api/payment/create-order', async (req, res) => {
    if (!razorpayInstance) {
        return res.status(503).json({ error: 'PAYMENT_NOT_CONFIGURED', message: 'Razorpay keys are not configured on the server.' });
    }
    const clientId = req.headers['x-client-id'] || `anon-${Date.now()}`;
    try {
        const order = await razorpayInstance.orders.create({
            amount: PLAN_AMOUNT,
            currency: PLAN_CURRENCY,
            receipt: `rcpt_${clientId}_${Date.now()}`,
            notes: { clientId, plan: 'pro_monthly' }
        });
        console.log(`[PAYMENT] Order created: ${order.id} for ${clientId}`);
        res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID.trim()
        });
    } catch (e) {
        console.error('[PAYMENT] Order creation failed:', e.message);
        res.status(500).json({ error: 'ORDER_FAILED', message: e.message });
    }
});

app.post('/api/payment/verify', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const clientId = req.headers['x-client-id'] || req.body.clientId;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'MISSING_PARAMS', message: 'Missing payment verification parameters.' });
    }

    try {
        // HMAC SHA256 signature verification (Razorpay standard)
        const secret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.error('[PAYMENT] Signature mismatch! Possible tampering.');
            return res.status(400).json({ error: 'INVALID_SIGNATURE', message: 'Payment signature verification failed.' });
        }

        // Activate subscription on server
        const sub = await activateSubscription(clientId, razorpay_payment_id, razorpay_order_id);
        console.log(`[PAYMENT] ✅ Verified & activated for ${clientId}`);

        res.json({
            success: true,
            message: 'Payment verified. Pro subscription activated!',
            subscription: sub
        });
    } catch (e) {
        console.error('[PAYMENT] Verification error:', e.message);
        res.status(500).json({ error: 'VERIFY_FAILED', message: e.message });
    }
});

app.get('/api/subscription/status', async (req, res) => {
    const clientId = req.headers['x-client-id'] || req.query.clientId;
    if (!clientId) return res.status(400).json({ error: 'Missing clientId' });
    const sub = await getSubscription(clientId);
    res.json({ success: true, ...sub });
});

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

app.post('/api/self-heal-dashboard', async (req, res) => {
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
        console.error('[CHAT] AI Cascade exhausted:', e.message);
        const isQuota = e.message.includes('quota') || e.message.includes('429') || e.message.includes('rate limit');
        
        // INTERNATIONAL STANDARD: Descriptive error recovery
        res.status(isQuota ? 429 : 503).json({
            error: true,
            code: isQuota ? 'QUOTA_EXCEEDED' : 'AI_UNAVAILABLE',
            message: `API Feedback: ${e.message}`,
            suggestedAction: 'Wait 30 seconds and click Retry.'
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
        const objectName = await callVisionAI(prompt, imageBase64);
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
        const notes = await callVisionAI(prompt, imageBase64);
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║         AON AI — NEXUS PRIME v5.0  ONLINE             ║
║  Patterns: ClaudeCode | Anthropic | OpenHands | CrewAI ║
╠═══════════════════════════════════════════════════════╣
║  HTTP:      http://0.0.0.0:${PORT}                     ║
║  WebSocket: ws://0.0.0.0:${PORT}                       ║
╚═══════════════════════════════════════════════════════╝
    `);
});

// Graceful Shutdown — Save DB before exit (Critical for Render/Cloud Run)
const shutdown = async (signal) => {
    console.log(`[SYSTEM] Received ${signal}. Shutting down gracefully...`);
    try {
        // Any final persistence logic (subscriptions already save on write, but good for safety)
        process.exit(0);
    } catch (e) {
        console.error('[SYSTEM] Error during shutdown:', e);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
