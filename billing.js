/**
 * Agent Maximize — Billing Manager
 * Browser-safe: uses localStorage for web/dev mode.
 * Native Capacitor billing (RevenueCat) is wired in separately via the Android build.
 */

export const BillingManager = {
    isPremium: false,

    async init() {
        try {
            // Synchronize client ID keys
            let clientId = localStorage.getItem('aon_client_id') || localStorage.getItem('nexus_client_id');
            
            // ── Native Device ID Lock ──
            if (window.Capacitor && window.Capacitor.Plugins) {
                try {
                    const Device = window.Capacitor.Plugins.Device;
                    if (Device) {
                        const info = await Device.getId();
                        if (info.identifier) {
                            clientId = info.identifier;
                            console.log('[BILLING] Native Device ID locked:', clientId);
                        }
                    }
                } catch (err) {
                    console.warn('[BILLING] Native ID retrieval failed, falling back to local/random ID:', err.message);
                }
            }

            if (!clientId || clientId === 'null' || clientId === 'undefined') {
                clientId = `pm-${Math.random().toString(36).substr(2, 9)}-${Date.now().toString(36)}`;
            }
            localStorage.setItem('aon_client_id', clientId);
            localStorage.setItem('nexus_client_id', clientId);

            // ── Check server-side status (Tamper-proof) ──
            await this.syncStatus();

            // ── If running inside Capacitor native app ──
            if (window.Capacitor && window.Capacitor.isNative) {
                try {
                    const Purchases = window.Capacitor.Plugins?.Purchases;
                    if (Purchases) {
                        const apiKey = "goog_SgNRYmUvIqWlpPzDxKcVqYvV";
                        await Purchases.configure({ apiKey });
                        const info = await Purchases.getCustomerInfo();
                        this.isPremium = info.entitlements.active['pro'] !== undefined;
                        localStorage.setItem('nexus_is_premium', this.isPremium ? 'true' : 'false');
                    } else {
                        console.warn('[BILLING] Purchases plugin not found on window.Capacitor.Plugins');
                    }
                } catch (err) {
                    console.error('[BILLING] Native Purchases Init Failed:', err.message);
                }
            }

            console.log('[BILLING] Status:', this.isPremium ? 'PRO 👑' : 'FREE');
        } catch (e) {
            console.warn('[BILLING] Init failed:', e.message);
        }
    },

    async syncStatus() {
        const clientId = localStorage.getItem('nexus_client_id');
        if (!clientId) return;
        try {
            const res = await fetch(`/api/subscription/status?clientId=${clientId}`);
            const data = await res.json();
            if (data.success) {
                this.isPremium = data.isPremium;
                localStorage.setItem('nexus_is_premium', this.isPremium ? 'true' : 'false');
            }
        } catch (e) {
            console.error('[BILLING] Status sync failed:', e);
        }
    },

    async purchasePro() {
        const clientId = localStorage.getItem('aon_client_id') || localStorage.getItem('nexus_client_id');
        if (window.Capacitor && window.Capacitor.isNative) {
            try {
                const Purchases = window.Capacitor.Plugins?.Purchases;
                if (!Purchases) throw new Error("RevenueCat Purchases plugin not initialized.");
                
                const offerings = await Purchases.getOfferings();
                if (offerings.current?.availablePackages?.length) {
                    const result = await Purchases.purchasePackage({
                        aPackage: offerings.current.availablePackages[0]
                    });
                    if (result.customerInfo.entitlements.active['pro'] !== undefined) {
                        this.isPremium = true;
                        localStorage.setItem('nexus_is_premium', 'true');
                        
                        // Sync with backend server
                        try {
                            await fetch('/api/subscription/activate-native', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
                                body: JSON.stringify({ clientId })
                            });
                        } catch (err) {
                            console.error('[BILLING] Backend activation sync failed:', err);
                        }
                        
                        return true;
                    }
                } else {
                    throw new Error("No active subscription packages found.");
                }
            } catch (e) {
                console.error('[BILLING] Native Purchase Error:', e);
                if (!e.userCancelled) alert('Purchase Failed: ' + e.message);
            }
            return false;
        } else {
            // ── WEB FLOW: Razorpay ──
            try {
                // 1. Create Order
                const orderRes = await fetch('/api/payment/create-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-client-id': clientId }
                });
                const orderData = await orderRes.json();
                
                if (!orderRes.ok) throw new Error(orderData.message || 'Order creation failed');

                // 2. Open Razorpay Modal
                return new Promise((resolve, reject) => {
                    const options = {
                        key: orderData.keyId,
                        amount: orderData.amount,
                        currency: orderData.currency,
                        name: "AgentMaximize Pro",
                        description: "Monthly Subscription",
                        order_id: orderData.orderId,
                        handler: async (response) => {
                            // 3. Verify Payment
                            try {
                                const verifyRes = await fetch('/api/payment/verify', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
                                    body: JSON.stringify({
                                        razorpay_order_id: response.razorpay_order_id,
                                        razorpay_payment_id: response.razorpay_payment_id,
                                        razorpay_signature: response.razorpay_signature,
                                        clientId
                                    })
                                });
                                const verifyData = await verifyRes.json();
                                if (verifyData.success) {
                                    this.isPremium = true;
                                    localStorage.setItem('nexus_is_premium', 'true');
                                    resolve(true);
                                } else {
                                    throw new Error(verifyData.message);
                                }
                            } catch (err) {
                                reject(err);
                            }
                        },
                        prefill: {
                            name: "Aon User",
                            email: "support@aon.ai"
                        },
                        theme: { color: "#00f2ff" }
                    };

                    const rzp = new window.Razorpay(options);
                    rzp.on('payment.failed', (response) => {
                        reject(new Error(response.error.description));
                    });
                    rzp.open();
                });
            } catch (e) {
                console.error('[BILLING] Purchase Error:', e);
                alert(e.message);
                return false;
            }
        }
    },
    async startTrial() {
        if (window.Capacitor && window.Capacitor.isNative) {
            alert('Free trials are managed via the App Store. Please click "Start Free Trial" to begin your secure trial via Google Play.');
            return false;
        }

        const clientId = localStorage.getItem('nexus_client_id');
        try {
            const res = await fetch('/api/subscription/start-trial', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-client-id': clientId }
            });
            const data = await res.json();

            if (data.success) {
                this.isPremium = true;
                localStorage.setItem('nexus_is_premium', 'true');
                return true;
            } else {
                throw new Error(data.message || 'Trial activation failed');
            }
        } catch (e) {
            console.error('[BILLING] Trial Error:', e);
            alert(e.message);
            return false;
        }
    },

    async restorePurchases() {
        const clientId = localStorage.getItem('aon_client_id') || localStorage.getItem('nexus_client_id');
        if (window.Capacitor && window.Capacitor.isNative) {
            try {
                const Purchases = window.Capacitor.Plugins?.Purchases;
                if (!Purchases) throw new Error("RevenueCat Purchases plugin not initialized.");
                
                const result = await Purchases.restorePurchases();
                if (result.customerInfo.entitlements.active['pro'] !== undefined) {
                    this.isPremium = true;
                    localStorage.setItem('nexus_is_premium', 'true');
                    
                    // Sync with backend server
                    try {
                        await fetch('/api/subscription/activate-native', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
                            body: JSON.stringify({ clientId })
                        });
                    } catch (err) {
                        console.error('[BILLING] Backend activation sync failed:', err);
                    }
                    
                    alert('Purchases restored successfully!');
                    return true;
                } else {
                    alert('No active Pro subscriptions found to restore.');
                }
            } catch (e) {
                console.error('[BILLING] Restore Purchases Error:', e);
                alert('Restore Failed: ' + e.message);
            }
            return false;
        } else {
            alert('Restore Purchases is only supported on native mobile devices.');
            return false;
        }
    }
};
