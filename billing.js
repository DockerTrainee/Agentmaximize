/**
 * Agent Maximize — Billing Manager
 * Browser-safe: uses localStorage for web/dev mode.
 * Native Capacitor billing (RevenueCat) is wired in separately via the Android build.
 */

export const BillingManager = {
    isPremium: false,

    async init() {
        try {
            // ── Check trial expiry first ───────────────────────────
            const trialEnd = localStorage.getItem('nexus_trial_end');
            if (trialEnd && Date.now() > parseInt(trialEnd)) {
                // Trial has expired — revert to free
                localStorage.setItem('nexus_is_premium', 'false');
                localStorage.removeItem('nexus_trial_end');
                console.log('[BILLING] Trial expired. Reverted to Free tier.');
            }

            // ── Check stored premium status ────────────────────────
            const stored = localStorage.getItem('nexus_is_premium');
            this.isPremium = stored === 'true';

            // ── If running inside Capacitor native app ─────────────
            // Verify via RevenueCat (overrides localStorage)
            if (window.Capacitor && window.Capacitor.isNative) {
                const { Purchases } = await import('@revenuecat/purchases-capacitor');
                const apiKey = window.RC_API_KEY || 'goog_placeholder_key';
                await Purchases.configure({ apiKey });
                const info = await Purchases.getCustomerInfo();
                this.isPremium = info.entitlements.active['pro'] !== undefined;
                localStorage.setItem('nexus_is_premium', this.isPremium ? 'true' : 'false');
            }

            console.log('[BILLING] Status:', this.isPremium ? 'PRO ✅' : 'FREE | Trial ends:', trialEnd ? new Date(parseInt(trialEnd)).toLocaleDateString() : 'N/A');
        } catch (e) {
            console.warn('[BILLING] Init failed, defaulting to free mode:', e.message);
            this.isPremium = false;
        }
    },

    async purchasePro() {
        if (window.Capacitor && window.Capacitor.isNative) {
            try {
                const { Purchases } = await import('@revenuecat/purchases-capacitor');
                const offerings = await Purchases.getOfferings();
                if (offerings.current?.availablePackages?.length) {
                    const result = await Purchases.purchasePackage({
                        aPackage: offerings.current.availablePackages[0]
                    });
                    if (result.customerInfo.entitlements.active['pro'] !== undefined) {
                        this.isPremium = true;
                        localStorage.setItem('nexus_is_premium', 'true');
                        return true;
                    }
                }
            } catch (e) {
                if (!e.userCancelled) alert('Purchase Failed: ' + e.message);
            }
        } else {
            // Web fallback — redirect to pricing page
            location.assign('pricing.html');
        }
        return false;
    }
};
