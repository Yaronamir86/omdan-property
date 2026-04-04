/**
 * ═══════════════════════════════════════════════════════
 *  OMDAN BILLING CORE — v2.0
 *  מערכת חיוב מרכזית לכל מוצרי OMDAN
 *  כל מוצר טוען billing-gate.js שמשתמש ב-BillingCore
 * ═══════════════════════════════════════════════════════
 */

// ── Plans ──
// ── תוכניות מנוי לפי מוצר ──
const BILLING_PLANS = {

  // ── OMDA רכוש ──
  trial:   { id:'trial',   product:'omdan-property', label:'ניסיון חינם', priceMonthly:0,   priceAnnual:0,    reportsPerMonth:5   },
  starter: { id:'starter', product:'omdan-property', label:'Starter',     priceMonthly:89,  priceAnnual:680,  reportsPerMonth:20  },
  pro:     { id:'pro',     product:'omdan-property', label:'Pro',         priceMonthly:129, priceAnnual:990,  reportsPerMonth:Infinity },
  office:  { id:'office',  product:'omdan-property', label:'Office',      priceMonthly:499, priceAnnual:4500, reportsPerMonth:Infinity },

  // ── OMDA איתור ──
  leak: { id:'leak', product:'omdan-leak', label:'OMDA איתור', priceMonthly:29, priceAnnual:290 },

  // ── Bundles ──
  'bundle-starter-leak': {
    id: 'bundle-starter-leak',
    product: 'bundle',
    label: 'Bundle — רכוש Starter + איתור',
    priceMonthly: 109,           // במקום 118 (89+29)
    priceAnnual:  890,           // במקום 970
    fullPriceMonthly: 118,       // לתצוגת "חיסכון"
    includes: ['omdan-property:starter', 'omdan-leak:leak'],
  },
};

// ── Bundle definitions ──
const BUNDLES = {
  'bundle-starter-leak': {
    products: {
      'omdan-property': { plan:'starter' },
      'omdan-leak':     { plan:'leak'    },
    },
  },
};

// ── Product IDs ──
const BILLING_PRODUCTS = {
  APPRAISER_PRO: 'omdan-property',
  SMART_VAAD:    'smart-vaad',
};

// ── Firebase Config ──
const BILLING_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCkhNhUHWLAf6G45nIH1wIZeE-rGQFrwgM",
  authDomain: "omdan-property.firebaseapp.com",
  projectId: "omdan-property",
  storageBucket: "omdan-property.firebasestorage.app",
  messagingSenderId: "1028931108038",
  appId: "1:1028931108038:web:01731ca2a152b700ea6bc7"
};

// ══════════════════════════════════════════════════
// BillingCore
// ══════════════════════════════════════════════════
class BillingCore {

  /**
   * Firestore token structure — /billing/{uid}:
   * {
   *   uid, email, plan: 'trial'|'starter'|'pro'|'office',
   *   products: ['omdan-property'],
   *   trialEnd: ISO,
   *   subscriptionEnd: ISO,
   *   reportsThisMonth: number,
   *   reportsResetAt: ISO,
   *   stripeCustomerId, stripeSubscriptionId,
   *   createdAt, updatedAt
   * }
   */

  static async getToken(uid) {
    try {
      const doc = await firebase.firestore().collection('billing').doc(uid).get();
      if (!doc.exists) return null;
      return doc.data();
    } catch(e) {
      console.error('BillingCore.getToken:', e);
      return null;
    }
  }

  static async createTrialToken(uid, email) {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);
    const token = {
      uid, email,
      plan: 'trial',
      products: ['omdan-property'],
      trialEnd: trialEnd.toISOString(),
      subscriptionEnd: null,
      reportsThisMonth: 0,
      reportsResetAt: new Date(new Date().getFullYear(), new Date().getMonth()+1, 1).toISOString(),
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await firebase.firestore().collection('billing').doc(uid).set(token);
    return token;
  }

  static checkAccess(token, productId) {
    if (!token) {
      console.warn('[BillingCore] checkAccess: no token');
      return { ok: false, reason: 'no_token' };
    }

    const now = new Date();
    const toDate = (v) => {
      if (!v) return null;
      if (v?.toDate) return v.toDate();
      if (v instanceof Date) return v;
      return new Date(v);
    };

    // ── NEW: plans-map structure ──
    // billing doc יכיל: plans: { 'omdan-property': { status, subEnd }, 'omdan-leak': {...} }
    if (token.plans && token.plans[productId]) {
      const p = token.plans[productId];
      if (p.plan === 'trial') {
        const trialEnd = toDate(p.trialEnd);
        if (!trialEnd || now > trialEnd) return { ok: false, reason: 'trial_expired' };
        const daysLeft = Math.ceil((trialEnd - now) / 86400000);
        console.log('[BillingCore] plans-map trial OK', productId, 'daysLeft:', daysLeft);
        return { ok: true, plan: 'trial', daysLeft };
      }
      if (p.status === 'active') {
        const subEnd = toDate(p.subscriptionEnd);
        if (!subEnd || now > subEnd) return { ok: false, reason: 'subscription_expired' };
        console.log('[BillingCore] plans-map paid OK', productId, p.plan);
        return { ok: true, plan: p.plan };
      }
      return { ok: false, reason: 'subscription_expired' };
    }

    // ── LEGACY: flat structure (backwards compat לרכוש קיים) ──
    const hasProduct = !token.products
      || token.products.includes(productId)
      || (productId === 'omdan-property' && token.products.includes('omdan-property'));

    if (!hasProduct) {
      console.warn('[BillingCore] no_product', productId);
      return { ok: false, reason: 'no_product' };
    }

    if (token.plan === 'trial') {
      const trialEnd = toDate(token.trialEnd);
      if (!trialEnd || now > trialEnd) return { ok: false, reason: 'trial_expired' };
      const daysLeft = Math.ceil((trialEnd - now) / 86400000);
      return { ok: true, plan: 'trial', daysLeft };
    }

    if (['starter','pro','office'].includes(token.plan) && token.status === 'active') {
      const subEnd = toDate(token.subscriptionEnd);
      if (!subEnd || now > subEnd) return { ok: false, reason: 'subscription_expired' };
      return { ok: true, plan: token.plan };
    }

    console.warn('[BillingCore] unknown/expired', token.plan);
    return { ok: false, reason: 'unknown' };
  }

  // בדוק אם user זכאי להנחת bundle
  static getBundleOffer(token, buyingProductId) {
    if (!token) return null;
    // אם קונה איתור ויש לו רכוש Starter → הצע bundle
    if (buyingProductId === 'omdan-leak') {
      const hasProperty = token.plans?.['omdan-property']?.status === 'active'
        || (token.plan && ['starter','pro','office'].includes(token.plan) && token.status === 'active');
      if (hasProperty) {
        return {
          bundleId: 'bundle-starter-leak',
          bundlePrice: 109,
          fullPrice: 118,
          saving: 9,
          label: 'Bundle עם OMDA רכוש — ₪109 במקום ₪118'
        };
      }
    }
    return null;
  }

  static getDaysLeftInTrial(token) {
    if (!token || token.plan !== 'trial') return null;
    const trialEnd = token.trialEnd?.toDate ? token.trialEnd.toDate() : new Date(token.trialEnd);
    return Math.max(0, Math.ceil((trialEnd - new Date()) / 86400000));
  }

  static getPlanDetails(planId) {
    return BILLING_PLANS[planId] || null;
  }
}

// Export for use in other files
if (typeof module !== 'undefined') module.exports = { BillingCore, BILLING_PLANS, BILLING_PRODUCTS, BUNDLES };
