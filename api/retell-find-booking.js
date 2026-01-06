// /api/retell-find-booking.js

function normalizeDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function normalizeUSPhoneToE164(phoneLike) {
  const digits = normalizeDigits(phoneLike);

  // If user gave 10 digits, assume US
  if (digits.length === 10) return `+1${digits}`;

  // If user gave 11 digits starting with 1, treat as US
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // If already includes country code with + but had symbols, fallback:
  if (String(phoneLike || "").trim().startsWith("+") && digits.length >= 11) {
    return `+${digits}`;
  }

  // Otherwise return null to signal invalid
  return null;
}

function last10(digitsOrE164) {
  const d = normalizeDigits(digitsOrE164);
  return d.length >= 10 ? d.slice(-10) : null;
}

function normName(str) {
  return String(str || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export default async function handler(req, res) {
  try {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Auth check (Retell -> your endpoint)
    const auth = req.headers.authorization || "";
    const expected = process.env.RETELL_SHARED_SECRET;
    if (!expected) {
      return res.status(500).json({ error: "Server misconfigured: missing RETELL_SHARED_SECRET" });
    }
    if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};

    // Support multiple payload shapes Retell may send
    let full_name =
      body.full_name ??
      body.fullName ??
      body.name ??
      body?.args?.full_name ??
      body?.args?.fullName ??
      body?.args?.name ??
      null;

    let phone_number =
      body.phone_number ??
      body.phoneNumber ??
      body.attendeePhoneNumber ??
      body?.args?.phone_number ??
      body?.args?.phoneNumber ??
      body?.args?.attendeePhoneNumber ??
      null;

    // args-only array payload: ["Emily Smith", "+1304..."]
    if ((!full_name || !phone_number) && Array.isArray(body)) {
      full_name = full_name || body[0] || null;
      phone_number = phone_number || body[1] || null;
    }

    // payload like { args: ["Emily Smith", "+1304..."] }
    if ((!full_name || !phone_number) && Array.isArray(body.args)) {
      full_name = full_name || body.args[0] || null;
      phone_number = phone_number || body.args[1] || null;
    }

    if (!full_name || !phone_number) {
      return res.status(400).json({
        error: "Missing full_name or phone_number",
        got_type: typeof body,
        got_isArray: Array.isArray(body),
        got_keys: body && typeof body === "object" ? Object.keys(body) : null,
        got_body: body,
      });
    }

    const normalizedPhone = normalizeUSPhoneToE164(phone_number);
    const phoneLast10 = last10(normalizedPhone);

    if (!normalizedPhone || !phoneLast10) {
      return res.status(400).json({
        error: "Invalid phone number after normalization",
        phone_number_received: phone_number,
        normalizedPhone,
      });
    }

    const apiKey = process.env.CALCOM_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Server misconfigured: missing CALCOM_API_KEY" });
    }

    // ---- Cal.com API call ----
    // NOTE: Cal.com API versions vary; this endpoint works for many setups.
    // If your Cal.com uses a different path, we can adjust once we see the response.
    const calResp = await fetch("https://api.cal.com/v1/bookings", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    const calJson = await calResp.json().catch(() => null);

    if (!calResp.ok) {
      return res.status(502).json({
        error: "Cal.com API error",
        status: calResp.status,
        response: calJson,
      });
    }

    const bookings = Array.isArray(calJson?.bookings) ? calJson.bookings : [];

    const targetName = normName(full_name);

    // Try to find matches by phone last-10 and name similarity.
    // This is intentionally forgiving about formatting.
    const matches = [];
    for (const b of bookings) {
      const attendees = Array.isArray(b?.attendees) ? b.attendees : [];
      const bookingUid = b?.uid || b?.id || null;

      // Pull attendee phone candidates
      const phones = attendees
        .map((a) => a?.phoneNumber || a?.phone || a?.attendeePhoneNumber || "")
        .filter(Boolean);

      // Sometimes phone i
