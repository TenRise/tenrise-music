// netlify/functions/donation-summary.js
import { getStore } from '@netlify/blobs';

const RATES_STORE = 'donation-fx';
const SUMMARY_STORE = 'donation-summary';

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
  try {
    const store = getStore(SUMMARY_STORE);
    const summary = (await store.get('summary', { type: 'json' })) || {
      totalCHF: 0,
      supportersCount: 0,
      recentSupporters: [],
      lastUpdatedIso: null
    };

    const qs = event.queryStringParameters || {};
    const displayCurrency = (qs.currency || '').toUpperCase();
    const rates = await getRates();

    // Default if unspecified: JPY
    const displayKey = displayCurrency === 'EUR' ? 'EUR' : 'JPY';
    const fx = rates[displayKey] || 0;
    const totalDisplay = fx ? summary.totalCHF * fx : summary.totalCHF;

    const recent = (summary.recentSupporters || []).map(s => {
      const displayAmount = fx ? s.donationCHF * fx : s.donationCHF;
      return {
        name: s.name,
        amount: Math.round(displayAmount),
        currency: displayKey,
        message: s.message || '',
        timestamp: s.timestamp
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        currency: displayKey,
        totalAmount: Math.round(totalDisplay),
        supportersCount: summary.supportersCount || 0,
        recentSupporters: recent,
        lastUpdatedIso: summary.lastUpdatedIso || new Date().toISOString()
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}
