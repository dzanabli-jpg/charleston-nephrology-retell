// /api/retell-find-booking.js  (Vercel Serverless, CommonJS, clean ASCII only)
//
// REQUIRED Vercel Environment Variables:
// - RETELL_SHARED_SECRET   (must exactly match the token AFTER "Bearer " in Retell header)
// - CALCOM_API_KEY         (your Cal.com API key)
//
// What this endpoint does:
// - POST only
// - Validates Authorization: Bearer <RETELL_SHARED_SECRET>
// - Extracts args from Retell tool-call payloads reliably
// - Normalizes US phone to +1XXXXXXXXXX and matches by last-10 digits
// - Normalizes DOB to MM/DD/YY and matches against Cal.com bookingFieldsResponses / metadata / description notes
// - Fetches Cal.com v2 bookings with a large page size (and cursor pagination if provided)
// - Returns a single match (or not found / multiple matches)
// - Logs useful debug lines to Vercel Runtime Logs

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

// Accepts many DOB inputs, returns MM/DD/YY or null
function normalizeDobToMMDDYY(dobLike) {
  var raw = String(dobLike || "").trim();
  if (!raw) return null;

  // If already contains digits and separators (like 02/24/08, 2-24-2008)
  // pull out numbers in order.
  var nums = raw.match(/\d+/g);

  // If they gave something like "February 24 2008", nums will be ["24","2008"] so we still need month.
  // We will also support month names.
  var monthMap = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", sept: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12"
  };

  var lower = raw.toLowerCase();

  // Find month from name if present
  var mm = null;
  var keys = Object.keys(monthMap);
  for (var i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i]) !== -1) {
      mm = monthMap[keys[i]];
      break;
    }
  }

  var dd = null;
  var yy = null;

  // Case A: "MM/DD/YYYY" or "MM/DD/YY" style
  if (nums && nums.length >= 3) {
    // Heuristic: if first num <= 12, treat as month; second as day; third as year
    var n1 = parseInt(nums[0], 10);
    var n2 = parseInt(nums[1], 10);
    var n3 = parseInt(nums[2], 10);

    if (!mm) {
      if (!isNaN(n1) && n1 >= 1 && n1 <= 12) mm = pad2(n1);
    }
    if (!isNaN(n2) && n2 >= 1 && n2 <= 31) dd = pad2(n2);

    if (!isNaN(n3)) {
      // If they gave 4-digit year, use last two. If 2-digit, use as-is.
      if (String(nums[2]).length === 4) yy = String(nums[2]).slice(2);
      else yy = pad2(n3);
    }
  }

  // Case B: Month name present + nums includes day + year
  if (mm && nums && nums.length >= 2 && (!dd || !yy)) {
    // day is usually first 1-31 in nums
    for (var j = 0; j < nums.length; j++) {
      var v = parseInt(nums[j], 10);
      if (!dd && v >= 1 && v <= 31) dd = pad2(v);
      else if (!yy && (String(nums[j]).length === 4 || v >= 0)) {
        if (String(nums[j]).length === 4) yy = String(nums[j]).slice(2);
        else if (v >= 0 && v <= 99) yy = pad2(v);
      }
    }
  }

  // Case C: They gave "January 1 2000" -> nums might be ["1","2000"]
  if (mm && nums && nums.length === 2 && (!dd || !yy)) {
    var d1 = parseInt(nums[0], 10);
    if (!dd && d1 >= 1 && d1 <= 31) dd = pad2(d1);
    if (!yy) {
      if (String(nums[1]).length === 4) yy = String(nums[1]).slice(2);
      else yy = pad2(parseInt(nums[1], 10));
    }
  }

  if (!mm || !dd || !yy) return null;
  return mm + "/" + dd + "/" + yy;
}

function pad2(n) {
  var s = String(n);
  return s.length === 1 ? "0" + s : s;
}

function extractArgs(body) {
  body = body || {};

  // Retell sends: { name: "<tool_name>", args: { ... }, call: {...} }
  // Prefer args first.
  var argsObj = body.args && typeof body.args === "object" ? body.args : null;

  var full_name =
    (argsObj && (argsObj.full_name || argsObj.fullName || argsObj.caller_name || argsObj.callerName || argsObj.name)) ||
    body.full_name ||
    body.fullName ||
    body.caller_name ||
    body.callerName ||
    null;

  var phone_number =
    (argsObj && (argsObj.phone_number || argsObj.phoneNumber || argsObj.caller_phone || argsObj.callerPhone || argsObj.attendeePhoneNumber)) ||
    body.phone_number ||
    body.phoneNumber ||
    body.caller_phone ||
    body.callerPhone ||
    body.attendeePhoneNumber ||
    null;

  var dob =
    (argsObj && (argsObj.dob || argsObj.date_of_birth || argsObj.dateOfBirth)) ||
    body.dob ||
    body.date_of_birth ||
    body.dateOfBirth ||
    null;

  // Handle args-only array payloads
  if ((!full_name || !phone_number || !dob) && Array.isArray(body)) {
    full_name = full_name || body[0] || null;
    phone_number = phone_number || body[1] || null;
    dob = dob || body[2] || null;
  }
  if ((!full_name || !phone_number || !dob) && body.args && Array.isArray(body.args)) {
    full_name = full_name || body.args[0] || null;
    phone_number = phone_number || body.args[1] || null;
    dob = dob || body.args[2] || null;
  }

  return { full_name: full_name, phone_number: phone_number, dob: dob };
}

function extractPossibleDobStringsFromBooking(b) {
  var out = [];

  if (!b || typeof b !== "object") return out;

  // bookingFieldsResponses often contains custom field answers (including DOB)
  if (b.bookingFieldsResponses && typeof b.bookingFieldsResponses === "object") {
    for (var k in b.bookingFieldsResponses) {
      var val = b.bookingFieldsResponses[k];
      if (typeof val === "string" && val.trim()) out.push(val.trim());
    }
  }

  // metadata sometimes stores custom fields
  if (b.metadata && typeof b.metadata === "object") {
    for (var m in b.metadata) {
      var mv = b.metadata[m];
      if (typeof mv === "string" && mv.trim()) out.push(mv.trim());
    }
  }

  // description or additional notes may include "DOB: 02/24/08"
  if (typeof b.description === "string" && b.description.trim()) out.push(b.description.trim());

  // Some payloads use "additionalNotes" or similar
  if (typeof b.additionalNotes === "string" && b.additionalNotes.trim()) out.push(b.additionalNotes.trim());

  return out;
}

function extractPhonesFromBooking(b) {
  var phones = [];
  if (!b || typeof b !== "object") return phones;

  var attendees = Array.isArray(b.attendees) ? b.attendees : [];
  for (var i = 0; i < attendees.length; i++) {
    var a = attendees[i] || {};
    if (a.phoneNumber) phones.push(a.phoneNumber);
    if (a.phone) phones.push(a.phone);
    if (a.attendeePhoneNumber) phones.push(a.attendeePhoneNumber);
  }

  // Try bookingFieldsResponses too (often contains attendeePhoneNumber)
  if (b.bookingFieldsResponses && typeof b.bookingFieldsResponses === "object") {
    for (var k in b.bookingFieldsResponses) {
      var v = b.bookingFieldsResponses[k];
      if (typeof v === "string" && normalizeDigits(v).length >= 10) phones.push(v);
    }
  }

  // metadata / responses
  if (b.metadata && typeof b.metadata === "object") {
    for (var m in b.metadata) {
      var mv = b.metadata[m];
      if (typeof mv === "string" && normalizeDigits(mv).length >= 10) phones.push(mv);
    }
  }

  return phones;
}

async function fetchAllBookings(apiKey) {
  var all = [];
  var take = 100;
  var cursor = null;
  var pageGuard = 0;

  while (pageGuard < 20) {
    pageGuard++;

    var url = "https://api.cal.com/v2/bookings?take=" + take;
    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);

    var resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "cal-api-version": "2024-08-13"
      }
    });

    var json = null;
    try {
      json = await resp.json();
    } catch (e) {
      json = null;
    }

    if (!resp.ok) {
      return { ok: false, status: resp.status, json: json, bookings: [] };
    }

    var batch = [];
    if (json && Array.isArray(json.data)) batch = json.data;
    else if (json && Array.isArray(json.bookings)) batch = json.bookings;

    for (var i = 0; i < batch.length; i++) all.push(batch[i]);

    // Cursor handling (best-effort; only continues if API returns a next cursor)
    var next = null;
    if (json && json.pagination && json.pagination.nextCursor) next = json.pagination.nextCursor;
    else if (json && json.nextCursor) next = json.nextCursor;
    else if (json && json.cursor && json.cursor.next) next = json.cursor.next;

    if (next) cursor = next;
    else break;
  }

  return { ok: true, status: 200, json: null, bookings: all };
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
    console.log("RETELL_FIND_BOOKING_BODY_KEYS", body && typeof body === "object" ? Object.keys(body) : null);

    var args = extractArgs(body);

    if (!args.full_name || !args.phone_number || !args.dob) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["full_name", "phone_number", "dob"],
        got: { full_name: args.full_name, phone_number: args.phone_number, dob: args.dob }
      });
    }

    // Guard against placeholders/tool names being passed as names
    var nameLower = String(args.full_name || "").trim().toLowerCase();
    if (nameLower === "find_booking" || nameLower.indexOf("find booking") !== -1) {
      return res.status(400).json({ error: "INVALID_FULL_NAME" });
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

    var normalizedDob = normalizeDobToMMDDYY(args.dob);
    if (!normalizedDob) {
      return res.status(400).json({
        error: "Invalid DOB format",
        dob_received: args.dob,
        expected: "MM/DD/YY (or a spoken equivalent that can be parsed)"
      });
    }

    var apiKey = process.env.CALCOM_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing CALCOM_API_KEY" });
    }

    // Fetch bookings (best-effort pagination)
    var fetched = await fetchAllBookings(apiKey);
    if (!fetched.ok) {
      return res.status(502).json({
        error: "Cal.com API error",
        status: fetched.status,
        response: fetched.json
      });
    }

    var bookings = fetched.bookings || [];
    var targetName = normName(args.full_name);
    var nameParts = targetName.split(" ").filter(Boolean);

    var matches = [];

    for (var i = 0; i < bookings.length; i++) {
      var b = bookings[i] || {};
      var attendees = Array.isArray(b.attendees) ? b.attendees : [];

      // 1) Phone match by last-10
      var phones = extractPhonesFromBooking(b);
      var phoneMatch = false;
      for (var p = 0; p < phones.length; p++) {
        if (last10(phones[p]) === phoneLast10) {
          phoneMatch = true;
          break;
        }
      }
      if (!phoneMatch) continue;

      // 2) DOB match (MM/DD/YY)
      // Try to find any dob-like value in bookingFieldsResponses/metadata/description and normalize it
      var dobCandidates = extractPossibleDobStringsFromBooking(b);
      var dobMatch = false;
      for (var d = 0; d < dobCandidates.length; d++) {
        var cand = dobCandidates[d];

        // Common pattern: "DOB: 02/24/08" or "Date of birth 02/24/08"
        // Extract best-looking substring first
        var m = String(cand).match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
        var maybe = m ? m[1] : cand;

        var nd = normalizeDobToMMDDYY(maybe);
        if (nd && nd === normalizedDob) {
          dobMatch = true;
          break;
        }
      }
      if (!dobMatch) continue;

      // 3) Name match (kept, but less brittle: require ALL parts in title/attendees text)
      var hay = (b.title ? normName(b.title) : "");
      for (var k = 0; k < attendees.length; k++) {
        var an = attendees[k] && (attendees[k].name || attendees[k].fullName);
        if (an) hay += " " + normName(an);
      }

      var ok = true;
      for (var np = 0; np < nameParts.length; np++) {
        if (nameParts[np] && hay.indexOf(nameParts[np]) === -1) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      matches.push({
        uid: b.uid || b.id || null,
        title: b.title || null,
        startTime: b.start || b.startTime || b.startAt || null,
        endTime: b.end || b.endTime || b.endAt || null,
        dobMatched: normalizedDob,
        attendees: attendees.map(function(x) {
          x = x || {};
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
        normalizedDob: normalizedDob,
        bookings_checked: bookings.length
      });

      return res.status(200).json({
        found: false,
        reason: "no_match",
        debug: {
          phoneLast10: phoneLast10,
          normalizedDob: normalizedDob,
          bookings_checked: bookings.length
        }
      });
    }

    if (matches.length > 1) {
      console.log("FIND_BOOKING_RESULT", {
        found: false,
        reason: "multiple_matches",
        count: matches.length
      });

      return res.status(200).json({
        found: false,
        reason: "multiple_matches",
        matches: matches.slice(0, 5)
      });
    }

    console.log("FIND_BOOKING_RESULT", {
      found: true,
      uid: matches[0].uid,
      title: matches[0].title
    });

    return res.status(200).json({
      found: true,
      booking: matches[0]
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled server error",
      message: (err && err.message) || String(err)
    });
  }
};
