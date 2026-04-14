/**
 * Agent Maximize - Subscription Manager
 * Integration with RevenueCat for Google Play Billing
 */

import { Purchases } from '@revenuecat/purchases-capacitor';

export const BillingManager = {
    isPremium: false,
    
    // Initialize the SDK
    async init() {
        try {
            // Note: This API key will be configured in the Render Dashboard
            // For logic testing, we check if the key is provided
            const apiKey = window.RC_API_KEY || 'goog_placeholder_key';
            
            await Purchases.configure({ apiKey });
            console.log('RevenueCat initialized');
            
            await this.updateStatus();
        } catch (e) {
            console.error('Billing Init Error:', e);
            // Default to free mode if initialization fails
            this.isPremium = false; 
        }
    },

    // Refresh the user's premium status
    async updateStatus() {
        try {
            const customerInfo = await Purchases.getCustomerInfo();
            // We'll define the entitlement ID as 'pro' in RevenueCat dashboard
            this.isPremium = customerInfo.entitlements.active['pro'] !== undefined;
            
            // Dispatch custom event for UI updates
            const event = new CustomEvent('subscriptionChange', { detail: { isPremium: this.isPremium } });
            window.dispatchEvent(event);
        } catch (e) {
            console.error('Status Update Error:', e);
        }
    },

    // Trigger purchase flow
    async purchasePro() {
        try {
            const offerings = await Purchases.getOfferings();
            if (offerings.current !== null && offerings.current.availablePackages.length !== 0) {
                const purchaseResult = await Purchases.purchasePackage({
                    aPackage: offerings.current.availablePackages[0]
                });
                
                if (purchaseResult.customerInfo.entitlements.active['pro'] !== undefined) {
                    this.isPremium = true;
                    return true;
                }
            }
        } catch (e) {
            if (!e.userCancelled) {
                alert('Purchase Failed: ' + e.message);
            }
        }
        return false;
    }
};
