const express = require("express");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const bodyParser = require("body-parser");

dotenv.config();
const app = express();
app.use(bodyParser.json());

const base64ServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!base64ServiceAccount) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing");
}

let serviceAccount;
try {
  const jsonString = Buffer.from(base64ServiceAccount, "base64").toString("utf8");
  serviceAccount = JSON.parse(jsonString);
} catch (err) {
  console.error("❌ Invalid base64 or JSON in FIREBASE_SERVICE_ACCOUNT:", err);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();


app.post("/webhook", async (req, res) => {
  console.log("🔔 Webhook received at /webhook");
  console.log("📦 Raw Request Body:", JSON.stringify(req.body, null, 2));

  const eventType = req.body.type || "UNKNOWN_EVENT";
  let data = req.body.data || req.body;

  // ✅ Handle webhook test registration ping
  if (eventType === "WEBHOOK" && data?.test_object?.test_key === "test_value") {
    console.log("🧪 Test webhook registration ping received.");
    return res.status(200).json({ success: true, message: "Test webhook registered successfully" });
  }

  // ✅ Only process real payment events
  if (eventType !== "PAYMENT_SUCCESS_WEBHOOK") {
    console.warn("⚠️ Unsupported event type:", eventType);
    return res.status(400).json({ success: false, message: "Unsupported event type" });
  }

  // ✅ Fallback for test event data
  const isTestFallback = !data?.payment?.cf_payment_id || !data?.payment?.payment_status;

  if (isTestFallback) {
    console.warn("⚠️ Required fields missing. Using fallback test data.");
    data = {
      order: { order_id: "test_order_123", order_amount: 100 },
      payment: {
        payment_status: "SUCCESS",
        cf_payment_id: "txn_test_456",
        bank_reference: "ref_789",
        payment_amount: 100,
      },
      customer_details: {
        customer_name: "Test User",
        customer_email: "test@example.com",
        customer_phone: "9999999999",
      },
      notes: { internal_order_id: "test_order_123" },
    };
  }

  // ✅ Extract orderId (fallback to order_id if link_id is not found)
  let orderId = data?.order?.order_tags?.link_id?.toString() || data?.order?.order_id;

  if (!orderId) {
    console.error("❌ Missing orderId");
    return res.status(400).json({ success: false, message: "Missing orderId" });
  }

  const transactionId = data?.payment?.cf_payment_id?.toString();
  const status = data?.payment?.payment_status;

  if (!transactionId || !status) {
    console.error("❌ Missing transactionId or payment status");
    return res.status(400).json({ success: false, message: "Missing transactionId or status" });
  }

  try {
    const transactionRef = db.collection("transactions").doc(transactionId);
    const existingDoc = await transactionRef.get();

    if (existingDoc.exists) {
      console.log("ℹ️ Duplicate transaction received:", transactionId);
      return res.status(200).json({ success: false, message: "Duplicate transaction" });
    }

    // ✅ Create transaction in Firestore
    await transactionRef.set({
      order_id: orderId,
      status,
      transaction_id: transactionId,
      reference: data?.payment?.bank_reference || null,
      amount: Number(data?.order?.order_amount || data?.payment?.payment_amount) || 0,
      customer: {
        name: data?.customer_details?.customer_name || null,
        email: data?.customer_details?.customer_email || null,
        phone: data?.customer_details?.customer_phone || null,
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ✅ Handle order
    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists && orderId === "test_order_123") {
      console.log("🧪 Creating test order in Firestore...");
      await orderRef.set({
        status: "paid",
        payment_status: "SUCCESS",
        created_on: admin.firestore.FieldValue.serverTimestamp(),
        user_id: "test_user",
        amount: data.order?.order_amount || data.payment?.payment_amount,
        general_menu: { dummy_item_1: 1 },
        extra_menu: "nil",
        payment_confirmed_on: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (orderSnap.exists) {
      console.log("✅ Updating existing order:", orderId);
      await orderRef.update({
        status: status === "SUCCESS" ? "paid" : undefined,
        payment_status: status,
        payment_confirmed_on:
          status === "SUCCESS" ? admin.firestore.FieldValue.serverTimestamp() : undefined,
      });
    }

    console.log(`✅ Webhook processed successfully for transaction: ${transactionId}, order: ${orderId}`);
    return res.status(200).json({ success: true, message: "Webhook handled" });
  } catch (error) {
    console.error("❌ Error processing webhook:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Webhook listening at http://localhost:${PORT}/webhook`)
);
