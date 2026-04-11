/**
 * AON AI — NEXUS PRIME v5.0 — Frontend Intelligence
 * Patterns: Claude Code agentic loop, Anthropic pipeline viz, OpenHands event model
 */
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();

    // ═══════════════════════════════════════════════════════════════
    // DOM REFS
    // ═══════════════════════════════════════════════════════════════
    const goalInput      = document.getElementById('goal-input');
    const initBtn        = document.getElementById('initialize-btn');
    const terminalEl     = document.getElementById('log-terminal');
    const pipelineLogEl  = document.getElementById('pipeline-log');
    const progressFill   = document.getElementById('nexus-progress');
    const progressLabel  = document.getElementById('progress-label');
    const currentTask    = document.getElementById('current-task');
    const squadList      = document.getElementById('squad-list');
    const agentsGrid     = document.getElementById('agents-grid');
    const overlayEl      = document.getElementById('nexus-overlay');
    const agentCountBadge = document.getElementById('agent-count-badge');
    const missionTypeBadge = document.getElementById('mission-type-badge');
    const missionTypeText  = document.getElementById('mission-type-text');
    const socketStatusEl   = document.getElementById('socket-status');
    const diagWS           = document.getElementById('diag-ws');
    const diagAgents       = document.getElementById('diag-agents');
    
    // Admin Security
    const adminLockBtn     = document.getElementById('admin-lock-btn');
    const adminOverlay     = document.getElementById('admin-overlay');
    const adminPassInput   = document.getElementById('admin-password-input');
    const unlockBtn        = document.getElementById('unlock-btn');
    const closeAdminBtn    = document.getElementById('close-admin-overlay');
    const lockStatusText   = document.getElementById('lock-status-text');
    let adminPassword      = localStorage.getItem('nexus_admin_pass') || '';

    const navItems = document.querySelectorAll('.nav-item');

    // Pipeline node map
    const pipelineNodes = {
        router:       document.getElementById('node-router'),
        orchestrator: document.getElementById('node-orchestrator'),
        html:         document.getElementById('node-html'),
        data:         document.getElementById('node-data'),
        js:           document.getElementById('node-js'),
        css:          document.getElementById('node-css'),
        qa:           document.getElementById('node-qa'),
        output:       document.getElementById('node-output'),
    };

    let isProcessing = false;
    let currentJobId = null;

    // ═══════════════════════════════════════════════════════════════
    // ANIMATED BACKGROUND (Grid + Particles) — Inspired by Claude Code's terminal
    // ═══════════════════════════════════════════════════════════════
    const bgCanvas = document.getElementById('bg-canvas');
    const bgCtx    = bgCanvas.getContext('2d');
    bgCanvas.width  = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    window.addEventListener('resize', () => {
        bgCanvas.width  = window.innerWidth;
        bgCanvas.height = window.innerHeight;
    });

    function drawBg() {
        bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
        const gridSize = 52;
        bgCtx.strokeStyle = 'rgba(255,255,255,0.018)';
        bgCtx.lineWidth = 0.5;
        for (let x = 0; x < bgCanvas.width; x += gridSize) {
            bgCtx.beginPath(); bgCtx.moveTo(x, 0); bgCtx.lineTo(x, bgCanvas.height); bgCtx.stroke();
        }
        for (let y = 0; y < bgCanvas.height; y += gridSize) {
            bgCtx.beginPath(); bgCtx.moveTo(0, y); bgCtx.lineTo(bgCanvas.width, y); bgCtx.stroke();
        }
        // Radial gradient overlays
        const g1 = bgCtx.createRadialGradient(bgCanvas.width*0.1, bgCanvas.height*0.2, 0, bgCanvas.width*0.1, bgCanvas.height*0.2, bgCanvas.width*0.4);
        g1.addColorStop(0, 'rgba(157,80,255,0.06)');
        g1.addColorStop(1, 'transparent');
        bgCtx.fillStyle = g1; bgCtx.fillRect(0,0,bgCanvas.width,bgCanvas.height);
        const g2 = bgCtx.createRadialGradient(bgCanvas.width*0.9, bgCanvas.height*0.8, 0, bgCanvas.width*0.9, bgCanvas.height*0.8, bgCanvas.width*0.35);
        g2.addColorStop(0, 'rgba(0,242,255,0.05)');
        g2.addColorStop(1, 'transparent');
        bgCtx.fillStyle = g2; bgCtx.fillRect(0,0,bgCanvas.width,bgCanvas.height);
        requestAnimationFrame(drawBg);
    }
    drawBg();

    // ═══════════════════════════════════════════════════════════════
    // ORB CANVAS — Central energy orb
    // ═══════════════════════════════════════════════════════════════
    const orbCanvas = document.getElementById('orb-canvas');
    const orbCtx    = orbCanvas.getContext('2d');
    let orbRadius = 80;
    let orbGrowDir = 1;

    function resizeOrb() {
        orbCanvas.width  = orbCanvas.offsetWidth;
        orbCanvas.height = orbCanvas.offsetHeight;
    }
    window.addEventListener('resize', resizeOrb);
    resizeOrb();

    const particles = Array.from({ length: 60 }, () => createParticle());
    function createParticle() {
        return {
            x: orbCanvas.width / 2, y: orbCanvas.height / 2,
            size: Math.random() * 3 + 0.5,
            vx: (Math.random() - 0.5) * 5,
            vy: (Math.random() - 0.5) * 5,
            life: Math.random() * 100,
            maxLife: 100 + Math.random() * 50,
            color: Math.random() > 0.5 ? '#00f2ff' : '#9d50ff',
        };
    }

    function animateOrb() {
        orbCtx.clearRect(0, 0, orbCanvas.width, orbCanvas.height);
        const cx = orbCanvas.width / 2, cy = orbCanvas.height / 2;

        // Glow
        const grd = orbCtx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius);
        grd.addColorStop(0, isProcessing ? 'rgba(0,242,255,0.35)' : 'rgba(157,80,255,0.2)');
        grd.addColorStop(0.6, isProcessing ? 'rgba(157,80,255,0.1)' : 'rgba(0,242,255,0.05)');
        grd.addColorStop(1, 'transparent');
        orbCtx.fillStyle = grd;
        orbCtx.beginPath(); orbCtx.arc(cx, cy, orbRadius, 0, Math.PI * 2); orbCtx.fill();

        // Pulse
        if (isProcessing) {
            orbRadius += orbGrowDir * 0.6;
            if (orbRadius > 120 || orbRadius < 70) orbGrowDir *= -1;
            particles.forEach(p => {
                p.x += p.vx; p.y += p.vy; p.life += 1;
                if (p.life >= p.maxLife) { Object.assign(p, createParticle()); return; }
                orbCtx.globalAlpha = 1 - p.life / p.maxLife;
                orbCtx.fillStyle = p.color;
                orbCtx.beginPath(); orbCtx.arc(p.x, p.y, p.size, 0, Math.PI*2); orbCtx.fill();
            });
            orbCtx.globalAlpha = 1;
        } else {
            orbRadius = 80 + Math.sin(Date.now() / 1200) * 8;
        }

        // Core dot
        const core = orbCtx.createRadialGradient(cx,cy,0,cx,cy,20);
        core.addColorStop(0,'rgba(255,255,255,0.9)');
        core.addColorStop(1,'transparent');
        orbCtx.fillStyle = core;
        orbCtx.beginPath(); orbCtx.arc(cx,cy,20,0,Math.PI*2); orbCtx.fill();

        requestAnimationFrame(animateOrb);
    }
    animateOrb();

    // ═══════════════════════════════════════════════════════════════
    // REAL-TIME WEBSOCKET — Socket.io (replaces HTTP polling)
    // Inspired by OpenHands' event-driven action/observation pairs
    // ═══════════════════════════════════════════════════════════════
    const socket = io();

    socket.on('connect', () => {
        socketStatusEl.textContent = 'WS: CONNECTED';
        socketStatusEl.style.color = '#00ff88';
        diagWS.textContent = 'ACTIVE';
        diagWS.className = 'diag-value cyan';
        addLog('[NEXUS] WebSocket connected.', 'success');
    });

    socket.on('disconnect', () => {
        socketStatusEl.textContent = 'WS: DISCONNECTED';
        socketStatusEl.style.color = '#ff5555';
        diagWS.textContent = 'OFFLINE';
        diagWS.className = 'diag-value';
    });

    function listenToJob(jobId) {
        currentJobId = jobId;

        socket.on(`job:${jobId}:log`, (data) => {
            addLog(data.message, data.type || 'system');
            addPipelineLog(data.message, data.type || 'system');
            // Auto-activate pipeline nodes based on log content
            if (data.message.includes('ROUTING')) setNodeState('router', 'active');
            if (data.message.includes('ORCHESTRATOR')) { setNodeState('router', 'done'); setNodeState('orchestrator', 'active'); }
            if (data.message.includes('HTML AGENT')) { setNodeState('orchestrator', 'done'); setNodeState('html', 'active'); setNodeState('data', 'active'); }
            if (data.message.includes('HTML AGENT:')) setNodeState('html', 'done');
            if (data.message.includes('DATA AGENT:')) setNodeState('data', 'done');
            if (data.message.includes('JS AGENT')) { setNodeState('js', 'active'); setNodeState('css', 'active'); }
            if (data.message.includes('JS AGENT:')) setNodeState('js', 'done');
            if (data.message.includes('CSS AGENT:')) setNodeState('css', 'done');
            if (data.message.includes('QA CRITIC')) { setNodeState('qa', 'active'); }
            if (data.message.includes('QA SCORE')) setNodeState('qa', 'done');
            if (data.message.includes('MISSION COMPLETE')) setNodeState('output', 'active');
        });

        socket.on(`job:${jobId}:progress`, (data) => {
            updateProgress(data.value, data.label);
        });

        socket.on(`job:${jobId}:route`, (route) => {
            missionTypeBadge.classList.remove('hidden');
            missionTypeText.textContent = route.type.toUpperCase();
            addSquadAgent('MISSION ROUTER', 'Route: ' + route.type, 'orchestrator');
        });

        socket.on(`job:${jobId}:blueprint`, (blueprint) => {
            squadList.innerHTML = '';
            addSquadAgent('ORCHESTRATOR', blueprint.projectName, 'orchestrator');
            blueprint.modules.slice(0,4).forEach(m => addSquadAgent(m.name, m.role, 'data'));
        });

        socket.on(`job:${jobId}:qa`, (qa) => {
            addLog(`[QA CRITIC] Score: ${qa.score}/100 | ${qa.verdict}`, qa.score >= 60 ? 'success' : 'error');
        });

        socket.on(`job:${jobId}:status`, async (data) => {
            // Cleanup socket listeners
            socket.off(`job:${jobId}:log`);
            socket.off(`job:${jobId}:progress`);
            socket.off(`job:${jobId}:route`);
            socket.off(`job:${jobId}:blueprint`);
            socket.off(`job:${jobId}:qa`);
            socket.off(`job:${jobId}:status`);

            if (data.status === 'completed') {
                setNodeState('output', 'done');
                finalizeMission(data.result);
            } else {
                addLog(`[NEXUS] MISSION FAILED: ${data.error}`, 'error');
                resetMission();
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // PIPELINE NODE STATES
    // ═══════════════════════════════════════════════════════════════
    function setNodeState(nodeKey, state) {
        const node = pipelineNodes[nodeKey];
        if (!node) return;
        node.classList.remove('active', 'done');
        if (state === 'active' || state === 'done') node.classList.add(state);
        const statusEl = node.querySelector('.node-status');
        if (statusEl) {
            statusEl.textContent = state === 'idle' ? 'IDLE' : state === 'active' ? 'WORKING' : 'DONE';
            statusEl.className = `node-status ${state}`;
        }
    }

    function resetPipelineNodes() {
        Object.keys(pipelineNodes).forEach(k => setNodeState(k, 'idle'));
    }

    // ═══════════════════════════════════════════════════════════════
    // TERMINAL LOGGING
    // ═══════════════════════════════════════════════════════════════
    function addLog(message, type = 'system') {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = message;
        terminalEl.appendChild(line);
        terminalEl.scrollTop = terminalEl.scrollHeight;
    }

    function addPipelineLog(message, type = 'system') {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = message;
        pipelineLogEl.appendChild(line);
        pipelineLogEl.scrollTop = pipelineLogEl.scrollHeight;
    }

    function updateProgress(value, label = '') {
        progressFill.style.width = `${value}%`;
        progressLabel.textContent = `${value}%`;
        if (label) currentTask.textContent = label;
    }

    // ═══════════════════════════════════════════════════════════════
    // SQUAD AGENT CHIPS
    // ═══════════════════════════════════════════════════════════════
    function addSquadAgent(name, role, type = 'data') {
        const chip = document.createElement('div');
        chip.className = 'agent-chip';
        const icons = { html: 'code-2', data: 'database', js: 'braces', css: 'palette', qa: 'shield-check', orchestrator: 'crown' };
        chip.innerHTML = `
            <div class="chip-icon ${type}"><i data-lucide="${icons[type] || 'bot'}"></i></div>
            <div class="chip-info">
                <h4>${name}</h4>
                <p>${role}</p>
            </div>
            <div class="chip-status">ACTIVE</div>
        `;
        squadList.appendChild(chip);
        lucide.createIcons();
    }

    // ═══════════════════════════════════════════════════════════════
    // MISSION EXECUTION
    // ═══════════════════════════════════════════════════════════════
    async function runMission(goal) {
        if (isProcessing) return;
        isProcessing = true;

        // Reset UI
        squadList.innerHTML = '';
        resetPipelineNodes();
        missionTypeBadge.classList.add('hidden');
        updateProgress(0, 'INITIALIZING...');
        addLog(`[MISSION] "${goal}"`, 'user');

        initBtn.disabled = true;
        initBtn.querySelector('span').textContent = 'RUNNING';

        try {
            const res = await fetch('/orchestrate', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-admin-password': adminPassword 
                },
                body: JSON.stringify({ goal })
            });
            
            if (res.status === 401) {
                showAdminPrompt();
                throw new Error('Unauthorized: Admin Password Required');
            }
            
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed to start mission');

            addLog(`[NEXUS] Job ID: ${data.jobId}`, 'system');
            listenToJob(data.jobId);

        } catch (err) {
            addLog(`[ERROR] ${err.message}`, 'error');
            resetMission();
        }
    }

    function finalizeMission(result) {
        addLog(`[SUCCESS] ${result.projectName} is live!`, 'success');
        updateProgress(100, 'MISSION COMPLETE');
        showOverlay(result);
        loadAgentLibrary();
        resetMission();
    }

    function resetMission() {
        isProcessing = false;
        initBtn.disabled = false;
        initBtn.querySelector('span').textContent = 'DEPLOY';
    }

    // ═══════════════════════════════════════════════════════════════
    // MISSION SUCCESS OVERLAY
    // ═══════════════════════════════════════════════════════════════
    function showOverlay(result) {
        document.getElementById('overlay-title').textContent = result.projectName;
        document.getElementById('overlay-subtitle').textContent = result.tagline || result.goal;
        document.getElementById('overlay-type').textContent = (result.type || 'app').toUpperCase();
        document.getElementById('overlay-qa').textContent = `${result.qaScore || '-'}/100`;
        document.getElementById('overlay-complexity').textContent = (result.complexity || '?').toUpperCase();
        document.getElementById('overlay-agents').textContent = '5 Agents';

        const modulesEl = document.getElementById('overlay-modules');
        modulesEl.innerHTML = '';
        (result.modules || []).slice(0,6).forEach(m => {
            const tag = document.createElement('div');
            tag.className = 'module-tag';
            tag.textContent = m.name || m.role;
            modulesEl.appendChild(tag);
        });

        document.getElementById('overlay-launch-btn').href = `/${result.filePath}`;
        overlayEl.classList.remove('hidden');
        lucide.createIcons();
    }

    document.getElementById('close-overlay').addEventListener('click', () => overlayEl.classList.add('hidden'));
    document.getElementById('overlay-close-btn').addEventListener('click', () => overlayEl.classList.add('hidden'));
    overlayEl.addEventListener('click', (e) => {
        if (e.target === overlayEl) overlayEl.classList.add('hidden');
    });

    // ═══════════════════════════════════════════════════════════════
    // AGENT LIBRARY — Persistent Storage
    // Inspired by CLAUDE.md persistent memory + Claude Code session history
    // ═══════════════════════════════════════════════════════════════
    async function loadAgentLibrary() {
        try {
            const res = await fetch('/api/agents');
            const data = await res.json();
            const agents = data.agents || [];

            agentCountBadge.textContent = agents.length;
            diagAgents.textContent = `${agents.length} AGENTS`;

            if (agents.length === 0) {
                agentsGrid.innerHTML = `
                    <div class="empty-state full-width">
                        <i data-lucide="archive"></i>
                        <p>NO AGENTS DEPLOYED YET</p>
                        <small>Run a mission to create your first agent.</small>
                    </div>`;
                lucide.createIcons();
                return;
            }

            agentsGrid.innerHTML = '';
            agents.forEach((agent, i) => {
                const card = document.createElement('div');
                card.className = 'agent-card';
                card.style.animationDelay = `${i * 0.05}s`;

                const qaColor = agent.qaScore >= 80 ? '#00ff88' : agent.qaScore >= 60 ? '#ffbd2e' : '#ff5555';
                const date = new Date(agent.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                card.innerHTML = `
                    <div class="agent-card-header">
                        <div class="agent-card-name">${agent.projectName}</div>
                        <div class="agent-card-type">${agent.type || 'app'}</div>
                    </div>
                    <div class="agent-card-goal">${agent.tagline || agent.goal}</div>
                    <div class="qa-score-bar">
                        <div class="qa-score-fill" style="width:${agent.qaScore||0}%; background:${qaColor};"></div>
                    </div>
                    <div class="agent-card-meta">
                        <div class="agent-meta-item">QA <span>${agent.qaScore || '?'}/100</span></div>
                        <div class="agent-meta-item">Built <span>${date}</span></div>
                        <div class="agent-meta-item">Complexity <span>${agent.complexity || '?'}</span></div>
                    </div>
                    <div class="agent-card-actions">
                        <a href="/${agent.filePath}" target="_blank" class="agent-btn launch">
                            <i data-lucide="rocket"></i> Launch
                        </a>
                        <button class="agent-btn delete" data-id="${agent.id}">
                            <i data-lucide="trash-2"></i> Delete
                        </button>
                    </div>
                `;

                card.querySelector('.delete').addEventListener('click', async (e) => {
                    const id = e.currentTarget.getAttribute('data-id');
                    if (confirm('Delete this agent?')) {
                        const res = await fetch(`/api/agents/${id}`, { 
                            method: 'DELETE',
                            headers: { 'x-admin-password': adminPassword }
                        });
                        
                        if (res.status === 401) {
                            alert('Unauthorized: Admin Password Required');
                            showAdminPrompt();
                        } else {
                            loadAgentLibrary();
                        }
                    }
                });

                agentsGrid.appendChild(card);
            });
            lucide.createIcons();
        } catch (err) {
            agentsGrid.innerHTML = `<div class="empty-state full-width"><p>FAILED TO LOAD: ${err.message}</p></div>`;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // NAVIGATION
    // ═══════════════════════════════════════════════════════════════
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const view = item.getAttribute('data-view');
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            document.querySelectorAll('.view-content').forEach(v => v.classList.add('hidden'));
            const target = document.getElementById(`view-${view}`);
            if (target) { target.classList.remove('hidden'); target.classList.add('active'); }
            if (view === 'agents') loadAgentLibrary();
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // GOAL INPUT INTERACTIONS
    // ═══════════════════════════════════════════════════════════════
    initBtn.addEventListener('click', () => {
        const goal = goalInput.value.trim();
        if (!goal) { addLog('[ERROR] Please enter a mission goal.', 'error'); return; }
        runMission(goal);
    });

    goalInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') initBtn.click();
    });

    // ═══════════════════════════════════════════════════════════════
    // ADMIN SECURITY LOGIC
    // ═══════════════════════════════════════════════════════════════
    function updateLockUI() {
        if (adminPassword) {
            adminLockBtn.querySelector('i').setAttribute('data-lucide', 'unlock');
            lockStatusText.textContent = 'UNLOCKED';
            adminLockBtn.classList.add('unlocked');
        } else {
            adminLockBtn.querySelector('i').setAttribute('data-lucide', 'lock');
            lockStatusText.textContent = 'LOCKED';
            adminLockBtn.classList.remove('unlocked');
        }
        lucide.createIcons();
    }

    function showAdminPrompt() {
        adminOverlay.classList.remove('hidden');
        adminPassInput.focus();
    }

    adminLockBtn.addEventListener('click', showAdminPrompt);
    closeAdminBtn.addEventListener('click', () => adminOverlay.classList.add('hidden'));

    unlockBtn.addEventListener('click', () => {
        const pass = adminPassInput.value.trim();
        if (!pass) return;
        adminPassword = pass;
        localStorage.setItem('nexus_admin_pass', pass);
        adminOverlay.classList.add('hidden');
        updateLockUI();
        addLog(`[SYSTEM] System access key synchronized.`, 'success');
    });

    adminPassInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') unlockBtn.click();
    });

    // ═══════════════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════════════
    updateLockUI();
    loadAgentLibrary();
});
