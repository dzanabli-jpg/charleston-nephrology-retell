// /api/retell-normalize-phone.js (CommonJS - Retell helper)
//
// Purpose: Accept ANY phone-number phrasing/grouping and return a normalized US E.164 phone.
// Example inputs (raw_phone):
// - "three zero four, one one one, one one one one"
// - "304-111-1111"
// - "+1 304 111 1111"
// - "one two three, one two three, one two three four"
//
// Env vars required:
// - RETELL_SHARED_SECRET

function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}

function normalizeUSPhoneToE164(rawPhone) {
  var d = digitsOnly(rawPhone);

  // Common case: caller includes country code in digits
  if (d.length === 11 && d.charAt(0) === "1") return "+" + d;

  // Standard US 10-digit
  if (d.length === 10) return "+1" + d;

  return null;
}

function formatPretty10(d10) {
  // d10 must be exactly 10 digits
  return d10.slice(0, 3) + "-" + d10.slice(3, 6) + "-" + d10.slice(6);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    var expected = process.env.RETELL_SHARED_SECRET;
    if (!expected) return res.status(500).json({ error: "Missing RETELL_SHARED_SECRET" });

    var auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    var body = req.body || {};
    console.log("RETELL_NORMALIZE_PHONE_BODY", body);

    // Accept a few possible shapes
    var raw_phone =
      (body.args && (body.args.raw_phone || body.args.rawPhone || body.args.phone || body.args.phone_number)) ||
      body.raw_phone ||
      body.rawPhone ||
      body.phone ||
      body.phone_number ||
      null;

    if (!raw_phone) {
      return res.status(400).json({ error: "Missing raw_phone" });
    }

    var normalized = normalizeUSPhoneToE164(raw_phone);
    if (!normalized) {
      var d = digitsOnly(raw_phone);
      return res.status(200).json({
        is_valid: false,
        normalized_e164: null,
        pretty: null,
        digits_found: d,
        digits_count: d.length,
        message: "Could not normalize to a US 10-digit number"
      });
    }

    var d10 = digitsOnly(normalized).slice(-10);
    return res.status(200).json({
      is_valid: true,
      normalized_e164: normalized,
      pretty: formatPretty10(d10),
      last4: d10.slice(-4),
      digits_count: 10
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled server error",
      message: (err && err.message) || String(err)
    });
  }
};
