# Agentmaximise — AI Meta-Factory

Production-ready version of the AON AI Nexus Prime.

## 🚀 One-Click Deployment to Render

1. **Create GitHub Repo**: Create a new repository on your GitHub (e.g., `agent-maximise`).
2. **Push Code**:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/agent-maximise.git
   git branch -M main
   git push -u origin main
   ```
3. **Deploy to Render**:
   - Go to [dashboard.render.com](https://dashboard.render.com).
   - Click **New +** > **Web Service**.
   - Connect your GitHub repository.
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**: Add your `GEMINI_API_KEY` (and `GITHUB_TOKEN` if used).

## 🛠 Features
- **Hybrid Cascade AI**: Fallback logic between Google Gemini and GitHub Models.
- **Self-Healing**: Autonomous repair of generated agents.
- **Real-time Telemetry**: Powered by Socket.io.

## ⚠️ Important Note on persistence
This app uses a free hosting tier. Any agents built will be stored in `agents-db.json` and the `builds/` folder. On Render, these files are **deleted** when the service restarts. 
To keep them permanently, upgrade to a paid Render plan with a "Persistent Disk."
