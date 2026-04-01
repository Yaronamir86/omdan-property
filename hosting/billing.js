/**
 * ═══════════════════════════════════════════════════════
 *  OMDAN BILLING CORE — v2.0
 *  מערכת חיוב מרכזית לכל מוצרי OMDAN
 *  כל מוצר טוען billing-gate.js שמשתמש ב-BillingCore
 * ═══════════════════════════════════════════════════════
 */

// ── Plans ──
const BILLING_PLANS = {
  trial: {
    id: 'trial',
    label: 'ניסיון חינם',
    days: 14,
    price: 0,
    reportsPerMonth: 5,
    features: ['יצירת דוחות שמאות','העלאת תמונות','הפקת PDF','עד 5 דוחות בחודש','משתמש אחד'],
  },
  starter: {
    id: 'starter',
    label: 'Starter',
    labelHe: 'שמאי עצמאי',
    priceMonthly: 89,
    priceAnnual: 680,
    reportsPerMonth: 20,
    features: ['יצירת דוחות שמאות','העלאת תמונות','הפקת PDF','עד 20 דוחות בחודש','משתמש אחד'],
    stripePriceMonthly: 'price_starter_monthly', // להחליף ב-Stripe
    stripePriceAnnual:  'price_starter_annual',
    popular: false,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    labelHe: 'שמאי פעיל',
    priceMonthly: 129,
    priceAnnual: 990,
    reportsPerMonth: Infinity,
    features: ['דוחות ללא הגבלה','BOQ ומחירונים','אחסון תמונות','חתימה דיגיטלית','ייצוא לאקסל','משתמש אחד'],
    stripePriceMonthly: 'price_pro_monthly',
    stripePriceAnnual:  'price_pro_annual',
    popular: true,
  },
  office: {
    id: 'office',
    label: 'Office',
    labelHe: 'משרד שמאים',
    priceMonthly: 499,
    priceAnnual: 4500,
    reportsPerMonth: Infinity,
    features: ['5 משתמשים','ניהול תיקים','הרשאות עובדים','לוג פעילות','API חיבור למערכות'],
    stripePriceMonthly: 'price_office_monthly',
    stripePriceAnnual:  'price_office_annual',
    popular: false,
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

    // Fallback: אם אין products[] — אפשר גישה אם plan תקין
    const hasProduct = !token.products || token.products.includes(productId) || token.products.includes('omdan-property');
    if (!hasProduct) {
      console.warn('[BillingCore] no_product', token.products, productId);
      return { ok: false, reason: 'no_product' };
    }

    const now = new Date();

    // Helper: Firestore Timestamp | ISO string | Date
    const toDate = (v) => {
      if (!v) return null;
      if (v?.toDate) return v.toDate();       // Firestore Timestamp
      if (v instanceof Date) return v;
      return new Date(v);                      // ISO string / number
    };

    // Trial
    if (token.plan === 'trial') {
      const trialEnd = toDate(token.trialEnd);
      if (!trialEnd) { console.warn('[BillingCore] trial: no trialEnd'); return { ok: false, reason: 'trial_expired' }; }
      if (now > trialEnd) { console.warn('[BillingCore] trial expired', trialEnd); return { ok: false, reason: 'trial_expired' }; }
      const daysLeft = Math.ceil((trialEnd - now) / 86400000);
      console.log('[BillingCore] trial OK, daysLeft:', daysLeft);
      return { ok: true, plan: 'trial', daysLeft };
    }

    // Paid subscription: starter | pro | office
    if (['starter','pro','office'].includes(token.plan)) {
      if (token.status !== 'active') {
        console.warn('[BillingCore] paid: status not active:', token.status);
        return { ok: false, reason: 'subscription_expired' };
      }
      const subEnd = toDate(token.subscriptionEnd);
      if (!subEnd || now > subEnd) {
        console.warn('[BillingCore] paid: subEnd expired', subEnd);
        return { ok: false, reason: 'subscription_expired' };
      }
      console.log('[BillingCore] paid OK, plan:', token.plan, 'subEnd:', subEnd);
      return { ok: true, plan: token.plan };
    }

    console.warn('[BillingCore] unknown plan:', token.plan);
    return { ok: false, reason: 'unknown' };
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
if (typeof module !== 'undefined') module.exports = { BillingCore, BILLING_PLANS, BILLING_PRODUCTS };
