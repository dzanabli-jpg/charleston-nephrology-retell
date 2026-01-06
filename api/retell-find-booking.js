// /api/retell-find-booking.js (CommonJS, clean ASCII only)

function normalizeDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function normalizeUSPhoneToE164(phoneLike) {
  var raw = String(phoneLike || "").trim();
  var digits = normalizeDigits(raw);

  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.charAt(0) === "1") return "+" + digits;

  if (raw.charAt(0) === "+" && digits.length >= 11) return "+" + digits;

  return null;
}

function last10(phoneLike) {
  var d = normalizeDigits(phoneLike);
  return d.length >= 10 ? d.slice(d.length - 10) : null;
}

function normName(str) {
  return String(str || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function extractArgs(body) {
  body = body || {};

  var full_name =
    body.full_name ||
    body.fullName ||
    body.name ||
    (body.args && (body.args.full_name || body.args.fullName || body.args.name)) ||
    null;

  var phone_number =
    body.phone_number ||
    body.phoneNumber ||
    body.attendeePhoneNumber ||
    (body.args && (body.args.phone_number || body.args.phoneNumber || body.args.attendeePhoneNumber)) ||
    null;

  // args-only array: ["Name", "+1..."]
  if ((!full_name || !phone_number) && Array.isArray(body)) {
    full_name = full_name || body[0] || null;
    phone_number = phone_number || body[1] || null;
  }

  // { args: ["Name", "+1..."] }
  if ((!full_name || !phone_number) && body.args && Array.isArray(body.args)) {
    full_name = full_name || body.args[0] || null;
    phone_number = phone_number || body.args[1] || null;
  }

  return { full_name: full_name, phone_number: phone_number };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    var expected = process.env.RETELL_SHARED_SECRET;
    if (!expected) {
      return res.status(500).json({ error: "Missing RETELL_SHARED_SECRET" });
    }

    var auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    var body = req.body || {};
    var args = extractArgs(body);

    if (!args.full_name || !args.phone_number) {
      return res.status(400).json({
        error: "Missing full_name or phone_number",
        got_type: typeof body,
        got_isArray: Array.isArray(body),
        got_keys: body && typeof body === "object" ? Object.keys(body) : null,
        got_body: body
      });
    }

    var normalizedPhone = normalizeUSPhoneToE164(args.phone_number);
    var phoneLast10 = last10(normalizedPhone);

    if (!normalizedPhone || !phoneLast10) {
      return res.status(400).json({
        error: "Invalid phone after normalization",
        phone_number_received: args.phone_number,
        normalizedPhone: normalizedPhone
      });
    }

    var apiKey = process.env.CALCOM_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing CALCOM_API_KEY" });
    }

    var calResp = await fetch("https://api.cal.com/v2/bookings", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "cal-api-version": "2024-08-13"
      }
    });

    var calJson = null;
    try {
      calJson = await calResp.json();
    } catch (e) {
      calJson = null;
    }

    if (!calResp.ok) {
      return res.status(502).json({
        error: "Cal.com API error",
        status: calResp.status,
        response: calJson
      });
    }

    var bookings = [];
    if (calJson && Array.isArray(calJson.data)) bookings = calJson.data;
    else if (calJson && Array.isArray(calJson.bookings)) bookings = calJson.bookings;

    var target = normName(args.full_name);
    var parts = target.split(" ").filter(Boolean);

    var matches = [];

    for (var i = 0; i < bookings.length; i++) {
      var b = bookings[i];

      var attendees = Array.isArray(b.attendees) ? b.attendees : [];
      var phones = [];

      for (var j = 0; j < attendees.length; j++) {
        var a = attendees[j] || {};
        if (a.phoneNumber) phones.push(a.phoneNumber);
        if (a.phone) phones.push(a.phone);
        if (a.attendeePhoneNumber) phones.push(a.attendeePhoneNumber);
      }

      // common custom fields
      if (b.metadata && b.metadata.attendeePhoneNumber) phones.push(b.metadata.attendeePhoneNumber);
      if (b.responses && b.responses.attendeePhoneNumber) phones.push(b.responses.attendeePhoneNumber);

      var phoneMatch = false;
      for (var p = 0; p < phones.length; p++) {
        if (last10(phones[p]) === phoneLast10) {
          phoneMatch = true;
          break;
        }
      }
      if (!phoneMatch) continue;

      // name match: require all name parts in title or attendee names
      var hay = (b.title ? normName(b.title) : "");
      for (var k = 0; k < attendees.length; k++) {
        var an = attendees[k] && (attendees[k].name || attendees[k].fullName);
        if (an) hay += " " + normName(an);
      }

      var ok = true;
      for (var m = 0; m < parts.length; m++) {
        if (parts[m] && hay.indexOf(parts[m]) === -1) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      matches.push({
        uid: b.uid || b.id || null,
        title: b.title || null,
        startTime: b.startTime || b.start || b.startAt || null,
        endTime: b.endTime || b.end || b.endAt || null,
        attendees: attendees.map(function(x) {
          return {
            name: x.name || x.fullName || null,
            phoneNumber: x.phoneNumber || x.phone || x.attendeePhoneNumber || null,
            email: x.email || null
          };
        })
      });
    }

    if (matches.length === 0) {
      console.log("FIND_BOOKING_RESULT", {
        found: false,
        reason: "no_match",
        full_name: args.full_name,
        normalizedPhone: normalizedPhone,
        phoneLast10: phoneLast10,
        bookings_checked: bookings.length,
        sample_booking_keys: bookings[0] ? Object.keys(bookings[0]) : null
      });

      return res.status(200).json({
        found: false,
        reason: "no_match",
        debug: {
          full_name: args.full_name,
          normalizedPhone: normalizedPhone,
          phoneLast10: phoneLast10,
          bookings_checked: bookings.length
        }
      });
    }

    if (matches.length > 1) {
      console.log("FIND_BOOKING_RESULT", { found: false, reason: "multiple_matches", count: matches.length });
      return res.status(200).json({ found: false, reason: "multiple_matches", matches: matches.slice(0, 5) });
    }

    console.log("FIND_BOOKING_RESULT", { found: true, uid: matches[0].uid, title: matches[0].title });
    return res.status(200).json({ found: true, booking: matches[0] });

  } catch (err) {
    return res.status(500).json({
      error: "Unhandled server error",
      message: (err && err.message) || String(err)
    });
  }
};
