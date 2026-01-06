```js
// /api/retell-find-booking.js  (CommonJS, Cal.com v2, Retell-friendly payload parsing)
//
// REQUIRED Vercel env vars:
// - RETELL_SHARED_SECRET   (must match the token used in Retell header: Authorization: Bearer <token>)
// - CALCOM_API_KEY         (Cal.com API key)
//
// This endpoint:
// - Accepts POST only (GET returns 405)
// - Validates Retell Authorization header
// - Parses multiple possible Retell payload shapes (object, args object, args array)
// - Normalizes US phones to +1XXXXXXXXXX
// - Calls Cal.com v2 bookings with required cal-api-version header
// - Matches booking by phone last-10 AND name parts
// - Logs a single line FIND_BOOKING_RESULT for easy debugging in Vercel runtime logs

function normalizeDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function normalizeUSPhoneToE164(phoneLike) {
  const raw = String(phoneLike || "").trim();
  const digits = normalizeDigits(raw);

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // If it already had a + and enough digits, keep it as +digits
  if (raw.startsWith("+") && digits.length >= 11) return `+${digits}`;

  return null;
}

function last10(phoneLike) {
  const d = normalizeDigits(phoneLike);
  return d.length >= 10 ? d.slice(-10) : null;
}

function normName(str) {
  return String(str || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function extractRetellArgs(body) {
  // Supports:
  // 1) { full_name, phone_number }
  // 2) { args: { full_name, phone_number } }
  // 3) ["Full Name", "+1..."]
  // 4) { args: ["Full Name", "+1..."] }
  // Also tolerates alternative key casing/names.

  let full_name =
    body?.full_name ??
    body?.fullName ??
    body?.name ??
    body?.caller_name ??
    body?.callerName ??
    body?.args?.full_name ??
    body?.args?.fullName ??
    body?.args?.name ??
    body?.args?.caller_name ??
    body?.args?.callerName ??
    null;

  let phone_number =
    body?.phone_number ??
    body?.phoneNumber ??
    body?.attendeePhoneNumber ??
    body?.caller_phone ??
    body?.callerPhone ??
    body?.args?.phone_number ??
    body?.args?.phoneNumber ??
    body?.args?.attendeePhoneNumber ??
    body?.args?.caller_phone ??
    body?.args?.callerPhone ??
    null;

  // args-only array
  if ((!full_name || !phone_number) && Array.isArray(body)) {
    full_name = full_name || body[0] || null;
    phone_number = phone_number || body[1] || null;
  }

  // { args: ["name", "phone"] }
  if ((!full_name || !phone_number) && Array.isArray(body?.args)) {
    full_name = full_name || body.args[0] || null;
    phone_number = phone_number || body.args[1] || null;
  }

  return { full_name, phone_number };
}

function collectCandidatePhonesFromObject(obj, out, depth = 0) {
  // Collect strings that look like phone numbers from arbitrary JSON.
  // Depth-limited to avoid huge recursion.
  if (!obj || depth > 6) return;

  if (typeof obj === "string") {
    const d = normalizeDigits(obj);
    if (d.length >= 10) out.push(obj);
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) collectCandidatePhonesFromObject(item, out, depth + 1);
    return;
  }

  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      // Fast-path likely phone keys
      if (
        typeof v === "string" &&
        /phone/i.test(k)
      ) {
        out.push(v);
        continue;
      }
      collectCandidatePhonesFromObject(v, out, depth + 1);
    }
  }
}

function collectCandidateNames(booking) {
  const names = [];

  const title = booking?.title;
  if (title) names.push(String(title));

  const attendees = Array.isArray(booking?.attendees) ? booking.attendees : [];
  for (const a of attendees) {
    if (a?.name) names.push(String(a.name));
    if (a?.fullName) names.push(String(a.fullName));
    if (a?.email) names.push(String(a.email)); // sometimes contains name parts
  }

  // Some Cal payloads store organizer/user fields:
  if (booking?.user?.name) names.push(String(booking.user.name));
  if (booking?.organizer?.name) names.push(String(booking.organizer.name));

  return names.map(normName).filter(Boolean);
}

function namePartsMatch(targetFullName, candidateNames) {
  const target = normName(targetFullName);
  if (!target) return false;

  const parts = target.split(" ").filter(Boolean);
  if (parts.length < 2) {
    // Require first+last for matching reliability
    return false;
  }

  const haystack = candidateNames.join(" | ");
  // Require all parts present somewhere
  return parts.every((p) => haystack.includes(p));
}

module.exports = async function handler(req, res) {
  try {
    // Only POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Auth (Retell -> server)
    const expected = process.env.RETELL_SHARED_SECRET;
    if (!expected) {
      return res.status(500).json({ error: "Server misconfigured: missing RETELL_SHARED_SECRET" });
    }
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};
    const { full_name, phone_number } = extractRetellArgs(body);

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

    // Cal.com v2 bookings
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

    // Cal v2 shape is typically { data: [...] } but can vary.
    const bookings =
      (Array.isArray(calJson?.data) && calJson.data) ||
      (Array.isArray(calJson?.bookings) && calJson.bookings) ||
      [];

    const targetNameOk = namePartsMatch(full_name, [normName(full_name)]);
    // If caller somehow provided only one name, we force a safe fail
    if (!targetNameOk) {
      return res.status(400).json({
        error: "full_name must include first and last name",
        full_name_received: full_name,
      });
    }

    const matches = [];

    for (const b of bookings) {
      // Collect phone candidates from known places + deep scan
      const phoneCandidates = [];

      const attendees = Array.isArray(b?.attendees) ? b.attendees : [];
      for (const a of attendees) {
        if (a?.phoneNumber) phoneCandidates.push(a.phoneNumber);
        if (a?.phone) phoneCandidates.push(a.phone);
        if (a?.attendeePhoneNumber) phoneCandidates.push(a.attendeePhoneNumber);
      }

      // common form-storage areas
      if (b?.metadata) collectCandidatePhonesFromObject(b.metadata, phoneCandidates);
      if (b?.responses) collectCandidatePhonesFromObject(b.responses, phoneCandidates);

      // fallback: scan entire booking object for phone-like strings
      collectCandidatePhonesFromObject(b, phoneCandidates);

      const anyPhoneMatch = phoneCandidates.some((p) => last10(p) === phoneLast10);
      if (!anyPhoneMatch) continue;

      // Name candidates
      const candidateNames = collectCandidateNames(b);
      const nameOk = namePartsMatch(full_name, candidateNames.length ? candidateNames : [normName(b?.title || "")]);
      if (!nameOk) continue;

      matches.push({
        uid: b?.uid || b?.id || b?.bookingUid || null,
        title: b?.title || null,
        startTime: b?.startTime || b?.start || b?.start_at || b?.startAt || null,
        endTime: b?.endTime || b?.end || b?.end_at || b?.endAt || null,
        attendees: attendees.map((a) => ({
          name: a?.name || a?.fullName || null,
          phoneNumber: a?.phoneNumber || a?.phone || a?.attendeePhoneNumber || null,
          email: a?.email || null,
        })),
      });
    }

    if (matches.length === 0) {
      console.log("FIND_BOOKING_RESULT", {
        found: false,
        reason: "no_match",
        full_name,
        normalizedPhone,
        phoneLast10,
        bookings_checked: bookings.length,
        sample_booking_keys: bookings[0] ? Object.keys(bookings[0]) : null,
      });

      return res.status(200).json({
        found: false,
        reason: "no_match",
        debug: {
          full_name,
          normalizedPhone,
          phoneLast10,
          bookings_checked: bookings.length,
        },
      });
    }

    if (matches.length > 1) {
      console.log("FIND_BOOKING_RESULT", {
        found: false,
        reason: "multiple_matches",
        count: matches.length,
      });

      return res.status(200).json({
        found: false,
        reason: "multiple_matches",
        matches: matches.slice(0, 5),
      });
    }

    console.log("FIND_BOOKING_RESULT", {
      found: true,
      uid: matches[0].uid,
      title: matches[0].title,
    });

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
```
