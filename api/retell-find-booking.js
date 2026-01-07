// /api/retell-find-booking.js (Vercel Serverless, CommonJS, clean ASCII only)
//
// REQUIRED Vercel Environment Variables:
// - RETELL_SHARED_SECRET
// - CALCOM_API_KEY
//
// Behavior:
// - POST only
// - Validates Authorization header
// - Extracts full_name, phone_number, dob from Retell args
// - Normalizes phone to +1XXXXXXXXXX and matches by last-10
// - Normalizes DOB to MM/DD/YY and matches against bookingFieldsResponses / metadata / description notes
// - Fetches Cal.com v2 bookings with take=100 (+ cursor if provided)
// - If multiple matches, auto-selects the best one (soonest upcoming; else most recent)
// - Returns found:true with the selected booking

function normalizeDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function pad2(n) {
  var s = String(n);
  return s.length === 1 ? "0" + s : s;
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

// Accepts many DOB formats, returns MM/DD/YY or null
function normalizeDobToMMDDYY(dobLike) {
  var raw = String(dobLike || "").trim();
  if (!raw) return null;

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
  var mm = null;
  var keys = Object.keys(monthMap);
  for (var i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i]) !== -1) {
      mm = monthMap[keys[i]];
      break;
    }
  }

  // Extract numeric groups
  var nums = raw.match(/\d+/g);
  var dd = null;
  var yy = null;

  // Try patterns like 02/24/2008 or 2-24-08
  if (nums && nums.length >= 3) {
    var n1 = parseInt(nums[0], 10);
    var n2 = parseInt(nums[1], 10);
    var n3 = parseInt(nums[2], 10);

    if (!mm && n1 >= 1 && n1 <= 12) mm = pad2(n1);
    if (n2 >= 1 && n2 <= 31) dd = pad2(n2);

    if (String(nums[2]).length === 4) yy = String(nums[2]).slice(2);
    else if (n3 >= 0 && n3 <= 99) yy = pad2(n3);
  }

  // Month name + day + year (e.g., February 24 2008)
  if (mm && nums && nums.length >= 2 && (!dd || !yy)) {
    for (var j = 0; j < nums.length; j++) {
      var v = parseInt(nums[j], 10);
      if (!dd && v >= 1 && v <= 31) dd = pad2(v);
      else if (!yy) {
        if (String(nums[j]).length === 4) yy = String(nums[j]).slice(2);
        else if (v >= 0 && v <= 99) yy = pad2(v);
      }
    }
  }

  // Month name + two nums (January 1 2000)
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

function extractArgs(body) {
  body = body || {};
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

  return { full_name: full_name, phone_number: phone_number, dob: dob };
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

  if (b.bookingFieldsResponses && typeof b.bookingFieldsResponses === "object") {
    for (var k in b.bookingFieldsResponses) {
      var v = b.bookingFieldsResponses[k];
      if (typeof v === "string" && normalizeDigits(v).length >= 10) phones.push(v);
    }
  }

  if (b.metadata && typeof b.metadata === "object") {
    for (var m in b.metadata) {
      var mv = b.metadata[m];
      if (typeof mv === "string" && normalizeDigits(mv).length >= 10) phones.push(mv);
    }
  }

  return phones;
}

function extractDobCandidates(b) {
  var out = [];
  if (!b || typeof b !== "object") return out;

  if (b.bookingFieldsResponses && typeof b.bookingFieldsResponses === "object") {
    for (var k in b.bookingFieldsResponses) {
      var v = b.bookingFieldsResponses[k];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }

  if (b.metadata && typeof b.metadata === "object") {
    for (var m in b.metadata) {
      var mv = b.metadata[m];
      if (typeof mv === "string" && mv.trim()) out.push(mv.trim());
    }
  }

  if (typeof b.description === "string" && b.description.trim()) out.push(b.description.trim());
  if (typeof b.additionalNotes === "string" && b.additionalNotes.trim()) out.push(b.additionalNotes.trim());

  return out;
}

function parseTimeMs(val) {
  if (!val) return null;
  var t = Date.parse(val);
  return isNaN(t) ? null : t;
}

async function fetchBookings(apiKey) {
  // Best-effort: take=100 plus cursor if the API returns one.
  var all = [];
  var take = 100;
  var cursor = null;
  var guard = 0;

  while (guard < 20) {
    guard++;
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
    try { json = await resp.json(); } catch (e) { json = null; }

    if (!resp.ok) {
      return { ok: false, status: resp.status, json: json, bookings: [] };
    }

    var batch = [];
    if (json && Array.isArray(json.data)) batch = json.data;
    else if (json && Array.isArray(json.bookings)) batch = json.bookings;

    for (var i = 0; i < batch.length; i++) all.push(batch[i]);

    var next = null;
    if (json && json.pagination && json.pagination.nextCursor) next = json.pagination.nextCursor;
    else if (json && json.nextCursor) next = json.nextCursor;

    if (next) cursor = next;
    else break;
  }

  return { ok: true, status: 200, bookings: all };
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

    var args = extractArgs(req.body || {});
    if (!args.full_name || !args.phone_number || !args.dob) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["full_name", "phone_number", "dob"],
        got: { full_name: args.full_name, phone_number: args.phone_number, dob: args.dob }
      });
    }

    var normalizedPhone = normalizeUSPhoneToE164(args.phone_number);
    var phoneLast10 = last10(normalizedPhone);
    if (!normalizedPhone || !phoneLast10) {
      return res.status(400).json({ error: "Invalid phone", phone_number_received: args.phone_number });
    }

    var normalizedDob = normalizeDobToMMDDYY(args.dob);
    if (!normalizedDob) {
      return res.status(400).json({ error: "Invalid DOB", dob_received: args.dob, expected: "MM/DD/YY" });
    }

    var apiKey = process.env.CALCOM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing CALCOM_API_KEY" });

    var fetched = await fetchBookings(apiKey);
    if (!fetched.ok) {
      return res.status(502).json({ error: "Cal.com API error", status: fetched.status, response: fetched.json });
    }

    var bookings = fetched.bookings || [];
    var targetName = normName(args.full_name);
    var nameParts = targetName.split(" ").filter(Boolean);

    var matches = [];

    for (var i = 0; i < bookings.length; i++) {
      var b = bookings[i] || {};

      // Phone last-10 match
      var phones = extractPhonesFromBooking(b);
      var okPhone = false;
      for (var p = 0; p < phones.length; p++) {
        if (last10(phones[p]) === phoneLast10) { okPhone = true; break; }
      }
      if (!okPhone) continue;

      // DOB match
      var dobCandidates = extractDobCandidates(b);
      var okDob = false;
      for (var d = 0; d < dobCandidates.length; d++) {
        var cand = dobCandidates[d];
        var m = String(cand).match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
        var maybe = m ? m[1] : cand;
        var nd = normalizeDobToMMDDYY(maybe);
        if (nd && nd === normalizedDob) { okDob = true; break; }
      }
      if (!okDob) continue;

      // Name match (parts must appear somewhere in title or attendee names)
      var attendees = Array.isArray(b.attendees) ? b.attendees : [];
      var hay = (b.title ? normName(b.title) : "");
      for (var k = 0; k < attendees.length; k++) {
        var an = attendees[k] && (attendees[k].name || attendees[k].fullName);
        if (an) hay += " " + normName(an);
      }
      var okName = true;
      for (var np = 0; np < nameParts.length; np++) {
        if (nameParts[np] && hay.indexOf(nameParts[np]) === -1) { okName = false; break; }
      }
      if (!okName) continue;

      matches.push({
        uid: b.uid || b.id || null,
        title: b.title || null,
        startTime: b.start || b.startTime || b.startAt || null,
        endTime: b.end || b.endTime || b.endAt || null,
        status: b.status || null,
        createdAt: b.createdAt || null,
        updatedAt: b.updatedAt || null,
        _startMs: parseTimeMs(b.start || b.startTime || b.startAt),
        _createdMs: parseTimeMs(b.createdAt),
        _updatedMs: parseTimeMs(b.updatedAt)
      });
    }

    if (matches.length === 0) {
      console.log("FIND_BOOKING_RESULT", {
        found: false,
        reason: "no_match",
        normalizedDob: normalizedDob,
        phoneLast10: phoneLast10,
        bookings_checked: bookings.length
      });
      return res.status(200).json({ found: false, reason: "no_match" });
    }

    // Auto-select best match (do NOT make the agent deal with multiple)
    var now = Date.now();

    var upcoming = matches.filter(function(x) { return x._startMs && x._startMs >= now; });
    var best = null;

    if (upcoming.length > 0) {
      upcoming.sort(function(a, b) { return a._startMs - b._startMs; });
      best = upcoming[0];
    } else {
      // Fall back to most recently updated/created
      matches.sort(function(a, b) {
        var aScore = a._updatedMs || a._createdMs || 0;
        var bScore = b._updatedMs || b._createdMs || 0;
        return bScore - aScore;
      });
      best = matches[0];
    }

    console.log("FIND_BOOKING_RESULT", {
      found: true,
      matched_count: matches.length,
      selected_uid: best.uid,
      selected_start: best.startTime,
      selected_status: best.status
    });

    // Remove internal helper fields
    delete best._startMs;
    delete best._createdMs;
    delete best._updatedMs;

    return res.status(200).json({
      found: true,
      matched_count: matches.length,
      booking: best
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled server error",
      message: (err && err.message) || String(err)
    });
  }
};
