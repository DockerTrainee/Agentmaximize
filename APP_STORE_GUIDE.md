# Google Play Store Publishing Guide

Now that the code is ready, follow these steps to get your app on the store.

## 1. Create a Developer Account
1. Go to the [Google Play Console](https://play.google.com/console).
2. Pay the **$25 USD** one-time registration fee.
3. Complete the identity verification.

## 2. Install Android Studio
1. Download from [developer.android.com/studio](https://developer.android.com/studio).
2. Install the **Android SDK** and **Virtual Device** (emulator) when prompted.

## 3. Generate your Signed App Bundle (.aab)
1. In your project, run: `npx cap sync android`
2. Open Android Studio: `npx cap open android`
3. In Android Studio, go to **Build > Generate Signed Bundle / APK**.
4. Create a new **Key Store** (Keep this safe! You need it for all future updates).
5. Follow the wizard to generate the `.aab` file.

## 4. Create your Store Listing
- **App Name**: AON AI — Nexus Prime
- **Short Description**: Self-directed multi-agent AI factory.
- **Full Description**: (Use your generated README content).
- **Icon**: Use the `icon.png` I generated.
- **Splash**: Use the `splash.png` I generated.

## 5. Submit for Review
Upload the `.aab` file in the **Production** track and submit it. Google usually takes 3-7 days to review the first release.
