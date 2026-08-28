// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

// Инициализация Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Эндпоинт для создания сессии Stripe Checkout
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { uid } = req.body; // передаём uid пользователя с клиента
    if (!uid) return res.status(400).json({ error: 'Missing uid' });

    // Создаём сессию
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: process.env.STRIPE_PRICE_ID, // ID цены из Stripe Dashboard
        quantity: 1,
      }],
      success_url: process.env.SUCCESS_URL || 'https://yourapp.com/success',
      cancel_url: process.env.CANCEL_URL || 'https://yourapp.com/cancel',
      client_reference_id: uid,
      metadata: { uid },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Вебхук Stripe
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const uid = session.client_reference_id;
    if (uid) {
      await db.collection('users').doc(uid).set({
        subscriptionStatus: 'premium',
        subscriptionExpiry: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        ),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`Subscribed user ${uid}`);
    }
  }

  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
