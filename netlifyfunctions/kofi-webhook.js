// netlify/functions/kofi-webhook.js
import { getStore } from '@netlify/blobs';

const RATES_STORE = 'donation-fx';
const SUMMARY_STORE = 'donation-summary';

// Fetch FX rates with CHF as base and cache in Blobs
async function getRates() {
  const store = getStore(RATES_STORE);
  const cached = await store.get('rates', { type: 'json' });
  const now = Date.now();
  if (cached && cached.timestamp && (now - cached.timestamp) < 12 * 60 * 60 * 1000) {
    return cached.rates;
  }
  const url = 'https://api.exchangerate.host/latest?base=CHF&symbols=JPY,EUR';
  const res = await fetch(url);
  const json = await res.json();
  const rates = json?.rates || { JPY: 0, EUR: 0 };
  await store.set('rates', { rates, timestamp: now });
  return rates;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const token = process.env.KOFI_VERIFICATION_TOKEN;
    if (!token) {
      return { statusCode: 500, body: JSON.stringify({ error: 'KOFI_VERIFICATION_TOKEN missing' }) };
    }

    const body = JSON.parse(event.body || '{}');

    // Ko-fi sends a verification token along with the payload (plain text)
    const incomingToken =
      body.verification_token || body.verificationToken || body?.data?.verification_token;
    if (incomingToken !== token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid verification token' }) };
    }

    // Extract donation/support details (Ko-fi webhook fields differ by setup; support common ones)
    const amountRaw =
      body.amount || body?.data?.amount || body?.data?.tier?.amount || body?.data?.total || '0';
    const currency =
      body.currency || body?.data?.currency || body?.data?.tier?.currency || 'CHF';
    const supporterName =
      body.from_name || body.name || body?.data?.from_name || 'Anonymous';
    const message =
      body.message || body?.data?.message || '';
    const timestamp =
      body.timestamp || body?.data?.timestamp || body?.data?.created_at || new Date().toISOString();

    const amount = parseFloat(String(amountRaw).replace(/[^\d.]/g, '')) || 0;
    if (amount <= 0) {
      // Ignore zero/invalid amounts
      return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: true }) };
    }

    // Convert incoming amount to CHF for storage
    const rates = await getRates();
    let amountCHF = amount;
    if (currency && currency.toUpperCase() !== 'CHF') {
      // rates are base CHF: 1 CHF = rates[currency] units of currency
      // So 1 unit of currency = 1 / rates[currency] CHF
      const key = currency.toUpperCase();
      const rate = rates[key];
      if (rate && rate > 0) {
        amountCHF = amount / rate;
      } else {
        // If we don't have a rate, we store the original assuming CHF to keep data consistent
        amountCHF = amount;
      }
    }

    const store = getStore(SUMMARY_STORE);
    const summary = (await store.get('summary', { type: 'json' })) || {
      totalCHF: 0,
      supportersCount: 0,
      recentSupporters: [], // stores donationCHF for consistent display conversion later
      lastUpdatedIso: null
    };

    summary.totalCHF = (summary.totalCHF || 0) + amountCHF;
    summary.supportersCount = (summary.supportersCount || 0) + 1;
    summary.lastUpdatedIso = new Date().toISOString();

    summary.recentSupporters = [
      {
        name: supporterName || 'Anonymous',
        // Store CHF-equivalent for consistent display conversion later
        donationCHF: amountCHF,
        original: { amount, currency: currency?.toUpperCase() || 'CHF' },
        message: message || '',
        timestamp
      },
      ...summary.recentSupporters
    ].slice(0, 10); // keep last 10

    await store.set('summary', summary, { addRandomSuffix: false });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}
