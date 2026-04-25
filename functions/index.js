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
const CARDCOM_USERNAME = defineSecret("CARDCOM_USERNAME");

// ── Plans ─────────────────────────────────────────────────
const PLANS = {
  starter: { monthly: 89,  annual: 680,  name: "OMDA רכוש Starter", product: "omdan-property" },
  pro:     { monthly: 129, annual: 990,  name: "OMDA רכוש Pro",     product: "omdan-property" },
  office:  { monthly: 499, annual: 4500, name: "OMDA רכוש Office",  product: "omdan-property" },
  leak:    { monthly: 29,  annual: 290,  name: "OMDA איתור",         product: "omdan-leak"     },
  "bundle-starter-leak": {
    monthly: 109, annual: 890,
    name: "Bundle — רכוש Starter + איתור",
    product: "bundle",
    includes: { "omdan-property": "starter", "omdan-leak": "leak" },
  },
};

const CARDCOM_URLS = {
  lowProfile: "https://secure.cardcom.solutions/Interface/LowProfile.aspx",
  indicator: "https://secure.cardcom.solutions/Interface/BillGoldGetLowProfileIndicator.aspx",
  chargeToken: "https://secure.cardcom.solutions/Interface/BillGoldService.asmx",
  successUrl: "https://omdan-property.web.app/billing-success.html",
  errorUrl: "https://omdan-property.web.app/billing-error.html",
  webhookUrl: "https://us-central1-omdan-property.cloudfunctions.net/cardcomWebhook",
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
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const decoded = await verifyToken(req);
    if (!decoded) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const uid = decoded.uid;

    const d = req.body || {};
    if (!d.insuredName && !d.claimNumber) {
      res.status(400).json({ error: "נדרשים לפחות שם מבוטח או מספר תביעה" });
      return;
    }

    const caseNumber = await nextCaseNumber();
    const now = FieldValue.serverTimestamp();
    const caseRef = db.collection("cases").doc();
    const propRef = db.collection("propertyCases").doc(caseRef.id);

    const title = d.insuredName
      ? `${d.insuredName}${d.claimNumber ? " — " + d.claimNumber : ""}`
      : `תיק ${caseNumber}`;

    await caseRef.set({
      caseNumber,
      title,
      moduleKey: "property",
      status: "draft",
      createdBy: uid,
      assignedTo: uid,
      summary: buildSummary(d),
      createdAt: now,
      updatedAt: now,
    });

    await propRef.set({
      caseId: caseRef.id,
      caseNumber,

      // מבוטח
      insuredName: d.insuredName || "",
      idNumber: d.idNumber || "",
      phone: d.phone || "",
      email: d.email || "",

      // תביעה
      claimNumber: d.claimNumber || "",
      policyNumber: d.policyNumber || "",
      insurer: d.insurer || "",

      // תאריכים
      eventDate: d.eventDate || "",
      reportDate: d.reportDate || "",
      inspectionDate: d.inspectionDate || "",

      // נכס
      assetType: d.assetType || "apartment",
      usageType: d.usageType || "residential",
      city: d.city || "",
      street: d.street || "",
      houseNumber: d.houseNumber || "",
      apartment: d.apartment || "",
      fullAddress: d.fullAddress || "",
      floor: d.floor || "",
      rooms: d.rooms || "",
      area: d.area || "",
      buildYear: d.buildYear || "",

      // אירוע
      incidentType: d.incidentType || "water_damage",
      lossType: d.lossType || "property_damage",
      urgencyLevel: d.urgencyLevel || "normal",

      // בדיקה
      inspectorName: d.inspectorName || "",
      weather: d.weather || "",
      occupancy: d.occupancy || "",
      affectedAreas: d.affectedAreas || [],
      affectedContents: d.affectedContents || [],
      initialObservation: d.initialObservation || "",
      description: d.description || "",

      // BOQ
      boqItems: [],
      boqTotal: 0,
      shiputTotal: 0,
      claimTotal: 0,

      // extras
      reportMode: d.reportMode || "insurance",
      extraNotes: d.extraNotes || "",
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    });

    logger.info("Case created", { caseId: caseRef.id, caseNumber, uid });

    res.json({
      success: true,
      caseId: caseRef.id,
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
// ════════════════════════════════════════════════════════════
exports.processCase = onRequest({ region: "us-central1" }, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const decoded = await verifyToken(req);
    if (!decoded) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { caseId, data } = req.body || {};
    if (!caseId) {
      res.status(400).json({ error: "caseId נדרש" });
      return;
    }

    const caseRef = db.collection("cases").doc(caseId);
    const propRef = db.collection("propertyCases").doc(caseId);

    const propSnap = await propRef.get();
    if (!propSnap.exists) {
      res.status(404).json({ error: "תיק לא נמצא" });
      return;
    }

    const now = FieldValue.serverTimestamp();
    const d = data || {};

    const boqItems = d.boqItems || [];
    const boqTotal = boqItems.reduce((s, i) => s + (Number(i.totalKinun) || 0), 0);
    const shiputTotal = boqItems.reduce((s, i) => s + (Number(i.totalShiput) || 0), 0);
    const claimTotal = boqItems.reduce((s, i) => s + (Number(i.totalClaim) || 0), 0);

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

    await caseRef.set(
      {
        status: "processing",
        summary: buildSummary({ ...propSnap.data(), ...d }),
        updatedAt: now,
        lastProcessedAt: now,
      },
      { merge: true }
    );

    res.json({
      success: true,
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
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const decoded = await verifyToken(req);
    if (!decoded) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const caseId = req.query.caseId;
    if (!caseId) {
      res.status(400).json({ error: "caseId נדרש" });
      return;
    }

    const [caseSnap, propSnap] = await Promise.all([
      db.collection("cases").doc(caseId).get(),
      db.collection("propertyCases").doc(caseId).get(),
    ]);

    if (!caseSnap.exists) {
      res.status(404).json({ error: "תיק לא נמצא" });
      return;
    }

    res.json({
      success: true,
      case: { id: caseSnap.id, ...toJS(caseSnap.data()) },
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
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const decoded = await verifyToken(req);
    if (!decoded) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit || "25"), 100);
    const snap = await db.collection("cases")
      .where("createdBy", "==", decoded.uid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const cases = snap.docs.map((d) => ({ id: d.id, ...toJS(d.data()) }));
    res.json({ success: true, cases, total: cases.length });
  } catch (e) {
    logger.error("listCases", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Helpers ───────────────────────────────────────────────
function buildSummary(d) {
  const parts = [];
  if (d.claimNumber) parts.push(`תביעה ${d.claimNumber}`);
  if (d.fullAddress || (d.city && d.street)) {
    parts.push(`נכס: ${d.fullAddress || d.city + " " + d.street}`);
  }
  if (d.insurer) parts.push(`מבטח: ${d.insurer}`);
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
//  BILLING — Cardcom
// ════════════════════════════════════════════════════════════
function httpPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(params);
    const u = new URL(url);

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => {
          d += c;
        });
        res.on("end", () => resolve(d));
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => {
          d += c;
        });
        res.on("end", () => resolve(d));
      })
      .on("error", reject);
  });
}

function parseNV(str) {
  const r = {};
  str.split("&").forEach((p) => {
    const [k, ...v] = p.split("=");
    if (k) r[decodeURIComponent(k)] = decodeURIComponent(v.join("=") || "");
  });
  return r;
}

function calcEnd(mode, from = new Date()) {
  const d = new Date(from);
  if (mode === "annual") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function buildCardcomBasePayload({ amount, planData, billingMode, decoded, sessionId }) {
  return {
    TerminalNumber: CARDCOM_TERMINAL.value(),
    UserName: CARDCOM_USERNAME.value(),
    APILevel: "10",
    Operation: "2",
    CoinId: "1",
    Language: "he",
    Codepage: "65001",

    SumToBill: String(amount),
    ProductName: planData.name,
    CardOwnerEmail: decoded.email || "",

    SuccessRedirectUrl: `${CARDCOM_URLS.successUrl}?session=${sessionId}`,
    ErrorRedirectUrl: `${CARDCOM_URLS.errorUrl}?session=${sessionId}`,
    IndicatorUrl: CARDCOM_URLS.webhookUrl,
    ReturnValue: sessionId,

    InvoiceHeadOperation: "1",
    DocTypeToCreate: "400",
    AutoRedirect: "false",

    "InvoiceHead.CustName": decoded.name || decoded.email || "לקוח OMDAN",
    "InvoiceHead.Email": decoded.email || "",
    "InvoiceHead.SendByEmail": "true",
    "InvoiceHead.Language": "he",
    "InvoiceHead.Comments": `${planData.name} - ${billingMode}`,
  };
}

async function tryCardcomCreatePayment(payload, label) {
  logger.info(`Cardcom payload ${label}`, payload);

  const raw = await httpPost(CARDCOM_URLS.lowProfile, payload);
  const parsed = parseNV(raw);

  logger.info(`Cardcom raw response ${label}`, { raw });
  logger.info(`Cardcom parsed response ${label}`, parsed);

  return { raw, parsed };
}

exports.cardcomCreatePayment = onRequest(
  { region: "us-central1", secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME] },
  async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const decoded = await verifyToken(req);
      if (!decoded) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { planId, billingMode } = req.body || {};
      const planData = PLANS[planId];

      if (!planData || !["monthly", "annual"].includes(billingMode)) {
        res.status(400).json({ error: "Invalid plan" });
        return;
      }

      const amount = billingMode === "annual" ? planData.annual : planData.monthly;

      const sessionRef = db.collection("checkoutSessions").doc();
      await sessionRef.set({
        uid: decoded.uid,
        planId,
        billingMode,
        amount,
        productName: planData.name,
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
      });

      const basePayload = buildCardcomBasePayload({
        amount,
        planData,
        billingMode,
        decoded,
        sessionId: sessionRef.id,
      });

      // Attempt 1: InvoiceLines בלי אינדקס
      let attempt = await tryCardcomCreatePayment(
        {
          ...basePayload,
          "InvoiceLines.Description": planData.name,
          "InvoiceLines.Quantity": "1",
          "InvoiceLines.Price": String(amount),
          "InvoiceLines.IsPriceIncludeVAT": "true",
        },
        "attempt_1_unindexed"
      );

      // Attempt 2: InvoiceLines עם אינדקס
      if (attempt.parsed.ResponseCode !== "0") {
        logger.warn("Cardcom attempt 1 failed, retrying with indexed InvoiceLines", {
          description: attempt.parsed.Description || "",
          responseCode: attempt.parsed.ResponseCode || "",
        });

        attempt = await tryCardcomCreatePayment(
          {
            ...basePayload,
            "InvoiceLines1.Description": planData.name,
            "InvoiceLines1.Quantity": "1",
            "InvoiceLines1.Price": String(amount),
            "InvoiceLines1.IsPriceIncludeVAT": "true",
          },
          "attempt_2_indexed"
        );
      }

      if (attempt.parsed.ResponseCode !== "0") {
        logger.error("cardcomCreatePayment final failure", {
          parsed: attempt.parsed,
          sessionId: sessionRef.id,
          uid: decoded.uid,
          planId,
          billingMode,
        });

        await sessionRef.update({
          status: "failed",
          error: attempt.parsed.Description || "Cardcom error",
          errorCode: attempt.parsed.ResponseCode || null,
          updatedAt: FieldValue.serverTimestamp(),
        });

        res.status(500).json({
          error: attempt.parsed.Description || "Cardcom error",
          details: attempt.parsed,
        });
        return;
      }

      const paymentUrl = attempt.parsed.Url || attempt.parsed.url || attempt.parsed.LowProfileUrl || null;

      await sessionRef.update({
        lowProfileCode: attempt.parsed.LowProfileCode || null,
        paymentUrl,
        updatedAt: FieldValue.serverTimestamp(),
      });

      logger.info("cardcomCreatePayment success", {
        sessionId: sessionRef.id,
        lowProfileCode: attempt.parsed.LowProfileCode || null,
        paymentUrl,
      });

      res.json({
        success: true,
        url: paymentUrl,
        sessionId: sessionRef.id,
      });
    } catch (e) {
      logger.error("cardcomCreatePayment crash", {
        message: e.message,
        stack: e.stack,
      });
      res.status(500).json({ error: e.message });
    }
  }
);

exports.cardcomWebhook = onRequest(
  { region: "us-central1", secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME] },
  async (req, res) => {
    try {
      const { terminalnumber, lowprofilecode, ReturnValue } = req.query;

      logger.info("cardcomWebhook hit", {
        terminalnumber,
        lowprofilecode,
        ReturnValue,
        query: req.query,
      });

      if (!lowprofilecode || !ReturnValue) {
        res.status(200).send("ok");
        return;
      }

      const sessionRef = db.collection("checkoutSessions").doc(ReturnValue);
      const sessionSnap = await sessionRef.get();

      if (!sessionSnap.exists) {
        logger.warn("cardcomWebhook: session not found", { sessionId: ReturnValue });
        res.status(200).send("ok");
        return;
      }

      const session = sessionSnap.data();

      if (session.status === "paid") {
        logger.info("cardcomWebhook: session already paid", { sessionId: ReturnValue });
        res.status(200).send("ok");
        return;
      }

      const verifyUrl =
        `${CARDCOM_URLS.indicator}?terminalnumber=${terminalnumber}` +
        `&username=${encodeURIComponent(CARDCOM_USERNAME.value())}` +
        `&lowprofilecode=${encodeURIComponent(lowprofilecode)}`;

      logger.info("cardcomWebhook verify URL", { verifyUrl });

      const verifyRaw = await httpGet(verifyUrl);
      const verified = parseNV(verifyRaw);

      logger.info("cardcomWebhook verify raw", { verifyRaw });
      logger.info("cardcomWebhook verify parsed", verified);

      if (verified.OperationResponse !== "0" || verified.DealResponse !== "0") {
        await sessionRef.update({
          status: "failed",
          verifyResponse: verified,
          updatedAt: FieldValue.serverTimestamp(),
        });
        res.status(200).send("ok");
        return;
      }

      const dealNumber = verified.InternalDealNumber;
      const payRef = db.collection("payments").doc(String(dealNumber));
      const DUPLICATE = "DUPLICATE";

      try {
        await db.runTransaction(async (t) => {
          const paySnap = await t.get(payRef);
          if (paySnap.exists) {
            const e = new Error(DUPLICATE);
            e.code = DUPLICATE;
            throw e;
          }

          t.set(payRef, {
            sessionId: ReturnValue,
            uid: session.uid,
            planId: session.planId,
            amount: session.amount,
            processedAt: FieldValue.serverTimestamp(),
            verified,
          });

          t.update(sessionRef, {
            status: "paid",
            paidAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
      } catch (e) {
        if (e.code === DUPLICATE) {
          logger.warn("cardcomWebhook duplicate payment", { dealNumber });
          res.status(200).send("ok");
          return;
        }
        throw e;
      }

      const plan = PLANS[session.planId];
      if (!plan) {
        logger.warn("cardcomWebhook: invalid plan in session", { session });
        res.status(200).send("ok");
        return;
      }

      const subEnd = calcEnd(session.billingMode);
      const isBundle = plan?.product === "bundle";

      const docUpdate = {
        lastPaymentAt: FieldValue.serverTimestamp(),
        lastPaymentAmount: session.amount,
        cardcomToken: verified.Token || null,
        cardcomTokenExp: verified.TokenExDate || null,
        cardcomDealNumber: dealNumber,
      };

      if (isBundle && plan.includes) {
        docUpdate.bundle = session.planId;
        for (const [productId, planId] of Object.entries(plan.includes)) {
          docUpdate[`plans.${productId}`] = {
            plan: planId, status: "active",
            billingMode: session.billingMode,
            subscriptionStart: admin.firestore.Timestamp.fromDate(new Date()),
            subscriptionEnd: admin.firestore.Timestamp.fromDate(subEnd),
          };
        }
        docUpdate.products = Object.keys(plan.includes);
      } else {
        const productId = plan?.product || "omdan-property";
        docUpdate[`plans.${productId}`] = {
          plan: session.planId, status: "active",
          billingMode: session.billingMode,
          subscriptionStart: admin.firestore.Timestamp.fromDate(new Date()),
          subscriptionEnd: admin.firestore.Timestamp.fromDate(subEnd),
        };
        // Legacy backwards compat לomda-property
        if (productId === "omdan-property") {
          Object.assign(docUpdate, {
            plan: session.planId, status: "active",
            billingMode: session.billingMode,
            subscriptionEnd: admin.firestore.Timestamp.fromDate(subEnd),
          });
        }
        docUpdate.products = [productId];
        docUpdate.reportsThisMonth = 0;
      }

      await db.collection("billing").doc(session.uid).set(docUpdate, { merge: true });

      logger.info("cardcomWebhook success", {
        uid: session.uid,
        dealNumber,
        plan: session.planId,
        billingMode: session.billingMode,
      });

      res.status(200).send("ok");
    } catch (e) {
      logger.error("cardcomWebhook crash", {
        message: e.message,
        stack: e.stack,
      });
      res.status(200).send("ok");
    }
  }
);

exports.cardcomRenewSubscriptions = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME],
  },
  async () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const snap = await db.collection("billing")
      .where("status", "==", "active")
      .where("subscriptionEnd", ">=", admin.firestore.Timestamp.fromDate(now))
      .where("subscriptionEnd", "<", admin.firestore.Timestamp.fromDate(tomorrow))
      .get();

    for (const docSnap of snap.docs) {
      const uid = docSnap.id;
      const b = docSnap.data();

      if (b.cancelAtEnd) {
        await db.collection("billing").doc(uid).update({
          status: "canceled",
          canceledAt: FieldValue.serverTimestamp(),
        });
        continue;
      }

      if (!b.cardcomToken) continue;

      const plan = PLANS[b.plan];
      if (!plan) continue;

      const amount = b.billingMode === "annual" ? plan.annual : plan.monthly;

      try {
        const raw = await httpPost(`${CARDCOM_URLS.chargeToken}?op=DoTransaction`, {
          TerminalNumber: CARDCOM_TERMINAL.value(),
          UserName: CARDCOM_USERNAME.value(),
          Token: b.cardcomToken,
          TokenExDate: b.cardcomTokenExp,
          SumToBill: String(amount),
          CoinId: "1",
          Operation: "1",
          ProductName: `${plan.name} — חידוש`,
        });

        const parsed = parseNV(raw);

        logger.info("cardcomRenewSubscriptions response", {
          uid,
          raw,
          parsed,
        });

        if (parsed.ResponseCode === "0" && parsed.OperationResponse === "0") {
          const newEnd = calcEnd(b.billingMode, b.subscriptionEnd.toDate());

          await db.collection("billing").doc(uid).update({
            status: "active",
            subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd),
            lastPaymentAt: FieldValue.serverTimestamp(),
            lastPaymentAmount: amount,
            reportsThisMonth: 0,
          });
        } else {
          await db.collection("billing").doc(uid).update({
            status: "renewal_failed",
            renewalError: parsed.Description || parsed.ResponseCode,
          });
        }
      } catch (e) {
        logger.error("Renewal error", {
          uid,
          message: e.message,
          stack: e.stack,
        });
      }
    }
  }
);

// ════════════════════════════════════════════════════════════
//  generatePDF  — Puppeteer PDF via httpsCallable
//  נקרא מ-case.html דרך firebase.app().functions().httpsCallable("generatePDF")
// ════════════════════════════════════════════════════════════
const functionsV1 = require("firebase-functions");
const chromium    = require("@sparticuz/chromium");
const puppeteer   = require("puppeteer-core");
const { v4: uuidv4 } = require("uuid");

const PDF_BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    direction: rtl;
    font-family: 'Heebo', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1a202c;
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .rpt-body   { max-width: 820px; margin: 0 auto; padding: 32px 24px; }
  .rpt-header { padding-bottom: 20px; margin-bottom: 28px; border-bottom: 2px solid #e5e7eb; }
  h1 { font-size: 24px; font-weight: 900; color: #111827; }
  h2 { font-size: 18px; font-weight: 800; color: #1f2937; margin: 20px 0 10px; }
  h3 { font-size: 15px; font-weight: 800; color: #374151; margin: 16px 0 8px; }
  p  { margin-bottom: 10px; }
  .rpt-section { margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid #f3f4f6; page-break-inside: avoid; break-inside: avoid; }
  .rpt-section:last-of-type { border-bottom: none; }
  .rpt-section-title { font-size: 14px; font-weight: 800; color: #92400e; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .rpt-section-title::before { content: ''; display: inline-block; width: 4px; height: 16px; background: #f59e0b; border-radius: 2px; flex-shrink: 0; }
  .rpt-p { font-size: 13px; color: #374151; line-height: 1.8; white-space: pre-line; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12px; }
  th { background: #fef3c7; color: #92400e; font-weight: 800; padding: 9px 12px; border: 1px solid #fde68a; text-align: right; }
  td { padding: 8px 12px; border: 1px solid #e5e7eb; color: #374151; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  .photo-grid-pdf { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin: 12px 0; }
  .photo-grid-pdf img { width: 100%; height: 160px; object-fit: cover; border-radius: 8px; border: 1px solid #e5e7eb; display: block; }
  .photo-caption-pdf { font-size: 10px; color: #6b7280; text-align: center; margin-top: 3px; }
  .rpt-signature { border-top: 2px solid #e5e7eb; padding-top: 24px; margin-top: 32px; text-align: center; color: #6b7280; font-size: 12px; }
  .page-break { page-break-after: always; break-after: page; }
  img { page-break-inside: avoid; break-inside: avoid; }
  .no-print, .voice-btn, .photo-del, button { display: none !important; }
`;

function wrapHtml(body) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>דוח שמאות רכוש — OMDA</title>
  <style>${PDF_BASE_CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

exports.generatePDF = functionsV1
  .runWith({ timeoutSeconds: 120, memory: "1GB" })
  .region("us-central1")
  .https.onCall(async (data, context) => {

    if (!context.auth) {
      throw new functionsV1.https.HttpsError("unauthenticated", "יש להתחבר כדי ליצור PDF");
    }

    const { htmlPayload, caseId } = data;
    if (!htmlPayload?.trim()) {
      throw new functionsV1.https.HttpsError("invalid-argument", "htmlPayload ריק");
    }

    let browser;
    try {
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      });

      const page = await browser.newPage();

      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const t = req.resourceType();
        const u = req.url();
        if (t === "media" || (t === "font" && !u.includes("fonts.gstatic.com"))) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.setContent(wrapHtml(htmlPayload), {
        waitUntil: ["networkidle0", "domcontentloaded"],
        timeout: 90000,
      });

      // המתן לטעינת תמונות
      await page.evaluate(() =>
        Promise.all(
          Array.from(document.images)
            .filter((i) => !i.complete)
            .map((i) => new Promise((r) => { i.onload = i.onerror = r; }))
        )
      );

      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "15mm", bottom: "18mm", left: "12mm", right: "12mm" },
        displayHeaderFooter: true,
        headerTemplate: `<div style="width:100%;font-size:9px;color:#9ca3af;text-align:left;padding:0 12mm;font-family:Arial,sans-serif;">דוח שמאות רכוש — OMDA</div>`,
        footerTemplate: `<div style="width:100%;display:flex;justify-content:space-between;padding:0 12mm;font-size:9px;color:#9ca3af;font-family:Arial,sans-serif;"><span>הופק באמצעות OMDA רכוש</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      });

      await browser.close();
      browser = null;

      // העלאה ל-Storage
      const uid      = context.auth.uid;
      const fname    = `rechushPdfs/${uid}/${caseId || "report"}_${Date.now()}.pdf`;
      const bucket   = admin.storage().bucket();
      const file     = bucket.file(fname);
      const token    = uuidv4();

      await file.save(pdfBuffer, {
        metadata: {
          contentType: "application/pdf",
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });

      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fname)}?alt=media&token=${token}`;
      logger.info("generatePDF success", { uid, caseId, fname });
      return { url };

    } catch (err) {
      if (browser) { try { await browser.close(); } catch (_) {} }
      logger.error("generatePDF error", { message: err.message });
      throw new functionsV1.https.HttpsError("internal", err.message || "שגיאה ביצירת PDF");
    }
  });
