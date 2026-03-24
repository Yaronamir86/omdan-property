/**
 * OMDAN Property — Firebase Cloud Functions
 * ==========================================
 * Endpoints (HTTP):
 *   POST /createCase      — יצירת תיק חדש
 *   POST /processCase     — עיבוד + שמירת BOQ
 *   GET  /getCase         — טעינת תיק מלא
 *   GET  /listCases       — רשימת תיקים
 *
 * Billing (Cardcom):
 *   POST /cardcomCreatePayment
 *   POST /cardcomWebhook
 *   cardcomRenewSubscriptions (Scheduled)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const https = require("https");
const querystring = require("querystring");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ── Secrets ──────────────────────────────────────────────
const CARDCOM_TERMINAL = defineSecret("CARDCOM_TERMINAL");
const CARDCOM_USERNAME  = defineSecret("CARDCOM_USERNAME");

// ── Plans ─────────────────────────────────────────────────
const PLANS = {
  starter: { monthly: 89,  annual: 680,  name: "OMDAN Starter" },
  pro:     { monthly: 129, annual: 990,  name: "OMDAN Pro" },
  office:  { monthly: 499, annual: 4500, name: "OMDAN Office" },
};

const CARDCOM_URLS = {
  lowProfile:  "https://secure.cardcom.solutions/Interface/LowProfile.aspx",
  indicator:   "https://secure.cardcom.solutions/Interface/BillGoldGetLowProfileIndicator.aspx",
  chargeToken: "https://secure.cardcom.solutions/Interface/BillGoldService.asmx",
  successUrl:  "https://omdan-property.web.app/billing-success.html",
  errorUrl:    "https://omdan-property.web.app/billing-error.html",
  webhookUrl:  "https://us-central1-omdan-property.cloudfunctions.net/cardcomWebhook",
};

// ── CORS helper ───────────────────────────────────────────
function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function verifyToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    return await admin.auth().verifyIdToken(auth.replace("Bearer ", ""));
  } catch {
    return null;
  }
}

// ── Case number generator ──────────────────────────────────
async function nextCaseNumber() {
  const counterRef = db.collection("counters").doc("cases");
  const num = await db.runTransaction(async (t) => {
    const snap = await t.get(counterRef);
    const next = (snap.exists ? snap.data().value : 0) + 1;
    t.set(counterRef, { value: next });
    return next;
  });
  const year = new Date().getFullYear().toString().slice(-2);
  return `OP-${year}-${String(num).padStart(4, "0")}`;
}

// ════════════════════════════════════════════════════════════
//  1. createCase  POST /createCase
// ════════════════════════════════════════════════════════════
exports.createCase = onRequest({ region: "us-central1" }, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const decoded = await verifyToken(req);
    if (!decoded)                { res.status(401).json({ error: "Unauthorized" }); return; }
    const uid = decoded.uid;

    const d = req.body || {};
    if (!d.insuredName && !d.claimNumber) {
      res.status(400).json({ error: "נדרשים לפחות שם מבוטח או מספר תביעה" });
      return;
    }

    const caseNumber   = await nextCaseNumber();
    const now          = FieldValue.serverTimestamp();
    const caseRef      = db.collection("cases").doc();
    const propRef      = db.collection("propertyCases").doc(caseRef.id);

    const title = d.insuredName
      ? `${d.insuredName}${d.claimNumber ? " — " + d.claimNumber : ""}`
      : `תיק ${caseNumber}`;

    await caseRef.set({
      caseNumber,
      title,
      moduleKey:  "property",
      status:     "draft",
      createdBy:  uid,
      assignedTo: uid,
      summary:    buildSummary(d),
      createdAt:  now,
      updatedAt:  now,
    });

    await propRef.set({
      caseId:           caseRef.id,
      caseNumber,
      // מבוטח
      insuredName:      d.insuredName      || "",
      idNumber:         d.idNumber         || "",
      phone:            d.phone            || "",
      email:            d.email            || "",
      // תביעה
      claimNumber:      d.claimNumber      || "",
      policyNumber:     d.policyNumber     || "",
      insurer:          d.insurer          || "",
      // תאריכים
      eventDate:        d.eventDate        || "",
      reportDate:       d.reportDate       || "",
      inspectionDate:   d.inspectionDate   || "",
      // נכס
      assetType:        d.assetType        || "apartment",
      usageType:        d.usageType        || "residential",
      city:             d.city             || "",
      street:           d.street           || "",
      houseNumber:      d.houseNumber      || "",
      apartment:        d.apartment        || "",
      fullAddress:      d.fullAddress      || "",
      floor:            d.floor            || "",
      rooms:            d.rooms            || "",
      area:             d.area             || "",
      buildYear:        d.buildYear        || "",
      // אירוע
      incidentType:     d.incidentType     || "water_damage",
      lossType:         d.lossType         || "property_damage",
      urgencyLevel:     d.urgencyLevel     || "normal",
      // בדיקה
      inspectorName:    d.inspectorName    || "",
      weather:          d.weather          || "",
      occupancy:        d.occupancy        || "",
      affectedAreas:    d.affectedAreas    || [],
      affectedContents: d.affectedContents || [],
      initialObservation: d.initialObservation || "",
      description:      d.description     || "",
      // BOQ
      boqItems:         [],
      boqTotal:         0,
      shiputTotal:      0,
      claimTotal:       0,
      // extras
      reportMode:       d.reportMode       || "insurance",
      extraNotes:       d.extraNotes       || "",
      createdBy:        uid,
      createdAt:        now,
      updatedAt:        now,
    });

    logger.info("Case created", { caseId: caseRef.id, caseNumber, uid });

    res.json({
      success:        true,
      caseId:         caseRef.id,
      propertyCaseId: propRef.id,
      caseNumber,
    });
  } catch (e) {
    logger.error("createCase", e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  2. processCase  POST /processCase
//     מקבל BOQ ונתונים מעודכנים, שומר, מחזיר summary
// ════════════════════════════════════════════════════════════
exports.processCase = onRequest({ region: "us-central1" }, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const decoded = await verifyToken(req);
    if (!decoded) { res.status(401).json({ error: "Unauthorized" }); return; }

    const { caseId, data } = req.body || {};
    if (!caseId) { res.status(400).json({ error: "caseId נדרש" }); return; }

    const caseRef = db.collection("cases").doc(caseId);
    const propRef = db.collection("propertyCases").doc(caseId);

    const propSnap = await propRef.get();
    if (!propSnap.exists) { res.status(404).json({ error: "תיק לא נמצא" }); return; }

    const now = FieldValue.serverTimestamp();
    const d   = data || {};

    // חשב סכומי BOQ
    const boqItems   = d.boqItems || [];
    const boqTotal   = boqItems.reduce((s, i) => s + (Number(i.totalKinun)  || 0), 0);
    const shiputTotal = boqItems.reduce((s, i) => s + (Number(i.totalShiput) || 0), 0);
    const claimTotal  = boqItems.reduce((s, i) => s + (Number(i.totalClaim)  || 0), 0);

    const updateData = {
      ...d,
      boqItems,
      boqTotal,
      shiputTotal,
      claimTotal,
      updatedAt: now,
    };
    delete updateData.caseId;

    await propRef.set(updateData, { merge: true });

    await caseRef.set({
      status:    "processing",
      summary:   buildSummary({ ...propSnap.data(), ...d }),
      updatedAt: now,
      lastProcessedAt: now,
    }, { merge: true });

    res.json({
      success:     true,
      caseId,
      boqTotal,
      shiputTotal,
      claimTotal,
    });
  } catch (e) {
    logger.error("processCase", e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  3. getCase  GET /getCase?caseId=
// ════════════════════════════════════════════════════════════
exports.getCase = onRequest({ region: "us-central1" }, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  try {
    const decoded = await verifyToken(req);
    if (!decoded) { res.status(401).json({ error: "Unauthorized" }); return; }

    const caseId = req.query.caseId;
    if (!caseId) { res.status(400).json({ error: "caseId נדרש" }); return; }

    const [caseSnap, propSnap] = await Promise.all([
      db.collection("cases").doc(caseId).get(),
      db.collection("propertyCases").doc(caseId).get(),
    ]);

    if (!caseSnap.exists) { res.status(404).json({ error: "תיק לא נמצא" }); return; }

    res.json({
      success:      true,
      case:         { id: caseSnap.id, ...toJS(caseSnap.data()) },
      propertyCase: propSnap.exists ? { id: propSnap.id, ...toJS(propSnap.data()) } : null,
    });
  } catch (e) {
    logger.error("getCase", e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  4. listCases  GET /listCases?limit=25
// ════════════════════════════════════════════════════════════
exports.listCases = onRequest({ region: "us-central1" }, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  try {
    const decoded = await verifyToken(req);
    if (!decoded) { res.status(401).json({ error: "Unauthorized" }); return; }

    const limit = Math.min(parseInt(req.query.limit || "25"), 100);
    const snap  = await db.collection("cases")
      .where("createdBy", "==", decoded.uid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const cases = snap.docs.map(d => ({ id: d.id, ...toJS(d.data()) }));
    res.json({ success: true, cases, total: cases.length });
  } catch (e) {
    logger.error("listCases", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Helpers ───────────────────────────────────────────────
function buildSummary(d) {
  const parts = [];
  if (d.claimNumber)   parts.push(`תביעה ${d.claimNumber}`);
  if (d.fullAddress || (d.city && d.street))
    parts.push(`נכס: ${d.fullAddress || d.city + " " + d.street}`);
  if (d.insurer)       parts.push(`מבטח: ${d.insurer}`);
  return parts.join(" | ");
}

function toJS(data) {
  if (!data) return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v.toDate === "function") out[k] = v.toDate().toISOString();
    else out[k] = v;
  }
  return out;
}

// ════════════════════════════════════════════════════════════
//  BILLING — Cardcom (same as appraiser-Pro, updated URLs)
// ════════════════════════════════════════════════════════════
function httpPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(params);
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname, path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); }).on("error", reject);
  });
}

function parseNV(str) {
  const r = {};
  str.split("&").forEach(p => { const [k, ...v] = p.split("="); if (k) r[decodeURIComponent(k)] = decodeURIComponent(v.join("=") || ""); });
  return r;
}

function calcEnd(mode, from = new Date()) {
  const d = new Date(from);
  if (mode === "annual") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

exports.cardcomCreatePayment = onRequest(
  { region: "us-central1", secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME] },
  async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }
    try {
      const decoded = await verifyToken(req);
      if (!decoded) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { planId, billingMode } = req.body || {};
      const planData = PLANS[planId];
      if (!planData || !["monthly","annual"].includes(billingMode)) { res.status(400).json({ error: "Invalid plan" }); return; }
      const amount = billingMode === "annual" ? planData.annual : planData.monthly;
      const sessionRef = db.collection("checkoutSessions").doc();
      await sessionRef.set({ uid: decoded.uid, planId, billingMode, amount, productName: planData.name, status: "pending", createdAt: FieldValue.serverTimestamp() });
      const raw = await httpPost(CARDCOM_URLS.lowProfile, {
        TerminalNumber: CARDCOM_TERMINAL.value(), UserName: CARDCOM_USERNAME.value(),
        APILevel: "10", Operation: "2", CoinId: "1", Language: "he", Codepage: "65001",
        SumToBill: String(amount), ProductName: planData.name,
        CardOwnerEmail: decoded.email || "",
        SuccessRedirectUrl: `${CARDCOM_URLS.successUrl}?session=${sessionRef.id}`,
        ErrorRedirectUrl:   `${CARDCOM_URLS.errorUrl}?session=${sessionRef.id}`,
        IndicatorUrl: CARDCOM_URLS.webhookUrl, ReturnValue: sessionRef.id,
        InvoiceHeadOperation: "1", DocTypeToCreate: "400", AutoRedirect: "false",
      });
      const parsed = parseNV(raw);
      if (parsed.ResponseCode !== "0") throw new Error(parsed.Description || "Cardcom error");
      await sessionRef.update({ lowProfileCode: parsed.LowProfileCode || null });
      res.json({ url: parsed.Url || parsed.url, sessionId: sessionRef.id });
    } catch (e) { logger.error("cardcomCreatePayment", e); res.status(500).json({ error: e.message }); }
  }
);

exports.cardcomWebhook = onRequest(
  { region: "us-central1", secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME] },
  async (req, res) => {
    try {
      const { terminalnumber, lowprofilecode, ReturnValue } = req.query;
      if (!lowprofilecode || !ReturnValue) { res.status(200).send("ok"); return; }
      const sessionRef  = db.collection("checkoutSessions").doc(ReturnValue);
      const sessionSnap = await sessionRef.get();
      if (!sessionSnap.exists) { res.status(200).send("ok"); return; }
      const session = sessionSnap.data();
      if (session.status === "paid") { res.status(200).send("ok"); return; }
      const verifyRaw = await httpGet(`${CARDCOM_URLS.indicator}?terminalnumber=${terminalnumber}&username=${CARDCOM_USERNAME.value()}&lowprofilecode=${lowprofilecode}`);
      const verified  = parseNV(verifyRaw);
      if (verified.OperationResponse !== "0" || verified.DealResponse !== "0") { await sessionRef.update({ status: "failed" }); res.status(200).send("ok"); return; }
      const dealNumber = verified.InternalDealNumber;
      const payRef     = db.collection("payments").doc(String(dealNumber));
      const DUPLICATE  = "DUPLICATE";
      try {
        await db.runTransaction(async t => {
          const paySnap = await t.get(payRef);
          if (paySnap.exists) { const e = new Error(DUPLICATE); e.code = DUPLICATE; throw e; }
          t.set(payRef, { sessionId: ReturnValue, uid: session.uid, planId: session.planId, amount: session.amount, processedAt: FieldValue.serverTimestamp() });
          t.update(sessionRef, { status: "paid", paidAt: FieldValue.serverTimestamp() });
        });
      } catch (e) { if (e.code === DUPLICATE) { res.status(200).send("ok"); return; } throw e; }
      const plan = PLANS[session.planId];
      if (!plan) { res.status(200).send("ok"); return; }
      const subEnd = calcEnd(session.billingMode);
      await db.collection("billing").doc(session.uid).set({
        plan: session.planId, billingMode: session.billingMode, status: "active",
        subscriptionStart: admin.firestore.Timestamp.fromDate(new Date()),
        subscriptionEnd:   admin.firestore.Timestamp.fromDate(subEnd),
        lastPaymentAt: FieldValue.serverTimestamp(),
        lastPaymentAmount: session.amount,
        cardcomToken: verified.Token || null, cardcomTokenExp: verified.TokenExDate || null,
        cardcomDealNumber: dealNumber, reportsThisMonth: 0,
      }, { merge: true });
      res.status(200).send("ok");
    } catch (e) { logger.error("cardcomWebhook", e); res.status(200).send("ok"); }
  }
);

exports.cardcomRenewSubscriptions = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Jerusalem", region: "us-central1", secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME] },
  async () => {
    const now = new Date(), tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const snap = await db.collection("billing")
      .where("status", "==", "active")
      .where("subscriptionEnd", ">=", admin.firestore.Timestamp.fromDate(now))
      .where("subscriptionEnd", "<",  admin.firestore.Timestamp.fromDate(tomorrow))
      .get();
    for (const docSnap of snap.docs) {
      const uid = docSnap.id, b = docSnap.data();
      if (b.cancelAtEnd) { await db.collection("billing").doc(uid).update({ status: "canceled", canceledAt: FieldValue.serverTimestamp() }); continue; }
      if (!b.cardcomToken) continue;
      const plan = PLANS[b.plan]; if (!plan) continue;
      const amount = b.billingMode === "annual" ? plan.annual : plan.monthly;
      try {
        const raw = await httpPost(`${CARDCOM_URLS.chargeToken}?op=DoTransaction`, {
          TerminalNumber: CARDCOM_TERMINAL.value(), UserName: CARDCOM_USERNAME.value(),
          Token: b.cardcomToken, TokenExDate: b.cardcomTokenExp,
          SumToBill: String(amount), CoinId: "1", Operation: "1", ProductName: `${plan.name} — חידוש`,
        });
        const parsed = parseNV(raw);
        if (parsed.ResponseCode === "0" && parsed.OperationResponse === "0") {
          const newEnd = calcEnd(b.billingMode, b.subscriptionEnd.toDate());
          await db.collection("billing").doc(uid).update({ status: "active", subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd), lastPaymentAt: FieldValue.serverTimestamp(), lastPaymentAmount: amount, reportsThisMonth: 0 });
        } else {
          await db.collection("billing").doc(uid).update({ status: "renewal_failed", renewalError: parsed.Description || parsed.ResponseCode });
        }
      } catch (e) { logger.error("Renewal error", { uid, err: e.message }); }
    }
  }
);
