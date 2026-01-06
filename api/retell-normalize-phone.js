// /api/retell-normalize-phone.js (CommonJS - Retell helper, spoken-number aware)
//
// Env vars required:
// - RETELL_SHARED_SECRET
//
// Accepts raw_phone as spoken words or digits and returns normalized US E.164 + pretty formatting.

function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}

function wordsToDigits(text) {
  var s = String(text || "").toLowerCase();

  // Normalize punctuation to spaces
  s = s.replace(/[^a-z0-9+]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  // Map number words to digits
  var map = {
    "zero": "0",
    "oh": "0",
    "o": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "for": "4",   // common ASR confusion
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "ate": "8",   // common ASR confusion
    "nine": "9"
  };

  // Tokens
  var tokens = s.split(" ").filter(Boolean);

  var out = "";
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];

    // If token already contains digits (e.g., "304" or "+1304")
    if (/[0-9]/.test(t)) {
      out += t.replace(/\D/g, "");
      continue;
    }

    // Handle "double" / "triple"
    if (t === "double" || t === "triple") {
      var next = tokens[i + 1] || "";
      var d = map[next] || (/[0-9]/.test(next) ? next.replace(/\D/g, "") : "");
      if (d.length > 0) {
        out += (t === "double") ? (d + d) : (d + d + d);
        i += 1;
      }
      continue;
    }

    // Normal word->digit
    if (map[t] !== undefined) {
      out += map[t];
      continue;
    }

    // Ignore unknown tokens
  }

  return out;
}

function normalizeUSPhoneToE164FromAny(rawPhone) {
  var raw = String(rawPhone || "");

  // First try direct digits
  var d = digitsOnly(raw);

  // If no digits, try converting words to digits
  if (!d || d.length === 0) {
    d = wordsToDigits(raw);
  }

  // Clean again (just digits)
  d = digitsOnly(d);

  // Normalize
  if (d.length === 11 && d.charAt(0) === "1") return { e164: "+" + d, d10: d.slice(1) };
  if (d.length === 10) return { e164: "+1" + d, d10: d };

  return null;
}

function formatPretty10(d10) {
  return d10.slice(0, 3) + "-" + d10.slice(3, 6) + "-" + d10.slice(6);
}

function pick(body, keys) {
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (body && body[k] !== undefined && body[k] !== null) return body[k];
  }
  return null;
}

function pickArgs(body, keys) {
  if (!body || !body.args || typeof body.args !== "object") return null;
  return pick(body.args, keys);
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

    var raw_phone =
      pickArgs(body, ["raw_phone", "rawPhone", "phone_number", "phoneNumber", "phone", "number"]) ||
      pick(body, ["raw_phone", "rawPhone", "phone_number", "phoneNumber", "phone", "number"]);

    console.log("RETELL_NORMALIZE_PHONE_INPUT", { raw_phone: raw_phone });

    if (!raw_phone) {
      return res.status(400).json({ error: "Missing raw_phone" });
    }

    var norm = normalizeUSPhoneToE164FromAny(raw_phone);

    if (!norm) {
      var directDigits = digitsOnly(raw_phone);
      var wordDigits = wordsToDigits(raw_phone);
      return res.status(200).json({
        is_valid: false,
        normalized_e164: null,
        pretty: null,
        last4: null,
        digits_found_direct: directDigits,
        digits_found_from_words: wordDigits,
        digits_count_direct: directDigits.length,
        digits_count_from_words: wordDigits.length,
        message: "Could not normalize to a US 10-digit number"
      });
    }

    return res.status(200).json({
      is_valid: true,
      normalized_e164: norm.e164,
      pretty: formatPretty10(norm.d10),
      last4: norm.d10.slice(-4),
      digits_count: 10
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled server error",
      message: (err && err.message) || String(err)
    });
  }
};
