// api/hubspot.js — Vercel serverless function
// Proxies HubSpot CRM requests from the browser.
// The token never leaves this server; it's injected from the HUBSPOT_TOKEN env variable.
//
// Required HubSpot token scopes:
//   crm.objects.contacts.write  crm.objects.contacts.read
//   crm.objects.deals.write

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HubSpot token not configured' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { email, properties, dealProperties } = body || {};

  if (!email || !properties) {
    return res.status(400).json({ error: 'Missing email or properties' });
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  try {
    // ── Step 1: Search for existing contact ───────────────────────────────────
    const searchRes = await fetch('https://api.hubspot.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email'],
        limit: 1,
      }),
    });

    if (!searchRes.ok) {
      const err = await searchRes.json().catch(() => ({}));
      return res.status(searchRes.status).json({ error: err.message || 'HubSpot search failed' });
    }

    const searchData = await searchRes.json();

    // ── Step 2: Upsert contact ────────────────────────────────────────────────
    let contactId;
    let contactRes;

    if (searchData.total > 0) {
      contactId = searchData.results[0].id;
      contactRes = await fetch(`https://api.hubspot.com/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ properties }),
      });
    } else {
      contactRes = await fetch('https://api.hubspot.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ properties: { ...properties, email } }),
      });
    }

    if (!contactRes.ok) {
      const err = await contactRes.json().catch(() => ({}));
      return res.status(contactRes.status).json({ error: err.message || 'HubSpot contact API error' });
    }

    const contactData = await contactRes.json();
    contactId = contactId || contactData.id;

    // ── Step 3: Create Deal ───────────────────────────────────────────────────
    // Only sent on final quote submission, not intermediate step tracking calls.
    console.log('dealProperties received:', dealProperties ? JSON.stringify(dealProperties) : 'none');
    if (dealProperties && contactId) {

      // 3a. Create the deal
      const dealRes = await fetch('https://api.hubspot.com/crm/v3/objects/deals', {
        method: 'POST',
        headers,
        body: JSON.stringify({ properties: dealProperties }),
      });

      if (!dealRes.ok) {
        const dealErr = await dealRes.json().catch(() => ({}));
        console.error('Deal creation failed:', JSON.stringify(dealErr));
        return res.status(200).json({
          contact: contactData,
          dealError: JSON.stringify(dealErr),
        });
      }

      const dealData = await dealRes.json();
      const dealId = dealData.id;

      // 3b. Associate deal → contact using the v4 associations API
      const assocRes = await fetch(
        `https://api.hubspot.com/crm/v4/objects/deals/${dealId}/associations/contacts/${contactId}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]),
        }
      );

      if (!assocRes.ok) {
        const assocErr = await assocRes.json().catch(() => ({}));
        console.error('Deal association failed:', JSON.stringify(assocErr));
        // Deal was created — just log the association failure
        return res.status(200).json({
          contact: contactData,
          deal: dealData,
          associationError: assocErr.message || JSON.stringify(assocErr),
        });
      }

      return res.status(200).json({ contact: contactData, deal: dealData });
    }

    return res.status(200).json(contactData);

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Internal proxy error' });
  }
}
