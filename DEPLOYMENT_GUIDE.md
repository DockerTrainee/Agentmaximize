# Deployment Guide: Agent Maximize (AON AI)

To put your app on the Play Store, you must first host your code on a production server. Here is how to do it using **Render** (free/cheap and simple).

## 1. Prepare your Repository
- Create a [GitHub](https://github.com) account if you don't have one.
- Upload your code (excluding `node_modules` and `.env`) to a new GitHub repository.

## 2. Deploy to Render
1. Go to [Render.com](https://render.com) and sign up.
2. Click **New +** and select **Web Service**.
3. Connect your GitHub repository.
4. Use the following settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Go to the **Environment** tab in Render and add your API keys:
   - `GEMINI_API_KEY`: [Your Google Gemini Key]
   - `ADMIN_PASSWORD`: [Your chosen password]

## 3. Update the Mobile App URL
Once you have your Render URL (e.g., `https://agent-maximize.onrender.com`), you need to tell the mobile app to talk to it.
- Open `capacitor.config.json`.
- Add a `url` property under `server`:
  ```json
  "server": {
    "url": "https://agent-maximize.onrender.com",
    "cleartext": true
  }
  ```

## 4. Final Mobile Build
Once the web version is live, you can generate the Android app.
1. Run `npx cap add android` in your terminal.
2. Run `npx cap open android` (This will open Android Studio).
3. In Android Studio, click **Build > Build Bundle(s) / APK(s) > Build APK**.
