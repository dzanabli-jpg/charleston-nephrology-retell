// /api/retell-find-booking.js (CommonJS)

function normalizeDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function normalizeUSPhoneToE164(phoneLike) {
  const digits = normalizeDigits(phoneLike);

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  if (String(phoneLike || "").trim().startsWith("+") && digits.length >= 11) {
    return `+${digits}`;
  }

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

module.exports = async function handler(req, res) {
  try {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Auth check
    const auth = req.headers.authorization || "";
    const expected = process.env.RETELL_SHARED_SECRET;

    if (!expected) {
      return res.status(500).json({ error: "Server misconfigured: missing RETELL_SHARED_SECRET" });
    }
    if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};

    // Support multiple payload shapes
    let full_name =
      body.full_name ??
      body.fullName ??
      body.name ??
      (body.args && body.args.full_name) ??
      (body.args && body.args.fullName) ??
      (body.args && body.args.name) ??
      null;

    let phone_number =
      body.phone_number ??
      body.phoneNumber ??
      body.attendeePhoneNumber ??
      (body.args && body.args.phone_number) ??
      (body.args && body.args.phoneNumber) ??
      (body.args && body.args.attendeePhoneNumber) ??
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
   const calResp = await fetch("https://api.cal.com/v2/bookings", {
  method: "GET",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "cal-api-version": "2024-08-13",
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

    const bookings = Array.isArray(calJson && calJson.bookings) ? calJson.bookings : [];

    const targetName = normName(full_name);

    const matches = [];
    for (const b of bookings) {
      const attendees = Array.isArray(b && b.attendees) ? b.attendees : [];
      const bookingUid = (b && (b.uid || b.id)) || null;

      // collect possible phones
      const phones = attendees
        .map((a) => (a && (a.phoneNumber || a.phone || a.attendeePhoneNumber)) || "")
        .filter(Boolean);

      if (b && b.metadata && b.metadata.attendeePhoneNumber) phones.push(b.metadata.attendeePhoneNumber);
      if (b && b.responses && b.responses.attendeePhoneNumber) phones.push(b.responses.attendeePhoneNumber);

      const anyPhoneMatch = phones.some((p) => last10(p) === phoneLast10);
      if (!anyPhoneMatch) continue;

      const attendeeNames = attendees
        .map((a) => (a && (a.name || a.fullName)) || "")
        .filter(Boolean)
        .map(normName);

      const title = normName((b && b.title) || "");
      const nameHit =
        attendeeNames.some((n) => n.includes(targetName) || targetName.includes(n)) ||
        title.includes(targetName) ||
        targetName
          .split(" ")
          .every((part) => part && (title.includes(part) || attendeeNames.some((n) => n.includes(part))));

      if (!nameHit) continue;

      matches.push({
        uid: bookingUid,
        title: (b && b.title) || null,
        startTime: b && (b.startTime || b.start) ? (b.startTime || b.start) : null,
        endTime: b && (b.endTime || b.end) ? (b.endTime || b.end) : null,
        attendees: attendees.map((a) => ({
          name: (a && (a.name || a.fullName)) || null,
          phoneNumber: (a && (a.phoneNumber || a.phone || a.attendeePhoneNumber)) || null,
          email: (a && a.email) || null,
        })),
      });
    }

    if (matches.length === 0) {
      return res.status(200).json({
        found: false,
        reason: "no_match",
        debug: {
          full_name: full_name,
          normalizedPhone,
          phoneLast10,
          bookings_checked: bookings.length,
        },
      });
    }

    if (matches.length > 1) {
      return res.status(200).json({
        found: false,
        reason: "multiple_matches",
        matches: matches.slice(0, 5),
      });
    }

    return res.status(200).json({
      found: true,
      booking: matches[0],
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled server error",
      message: (err && err.message) || String(err),
    });
  }
};
