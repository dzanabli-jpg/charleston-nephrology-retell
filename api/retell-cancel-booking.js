// /api/retell-cancel-booking.js
// Vercel Serverless Function (CommonJS)
//
// ENV:
// - RETELL_SHARED_SECRET
// - CALCOM_API_KEY
//
// Input (Retell tool args):
// - booking_uid (string) OR uid (string)
//
// Output:
// - { ok: true, already_cancelled: false }
// - { ok: false, already_cancelled: true }
// - { ok: false, already_cancelled: false, error: "..." }

function extractUid(body) {
  body = body || {};
  var args = body.args && typeof body.args === "object" ? body.args : body;

  return (
    args.booking_uid ||
    args.bookingUid ||
    args.uid ||
    args.booking_id ||
    args.bookingId ||
    null
  );
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

    var apiKey = process.env.CALCOM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing CALCOM_API_KEY" });

    var uid = extractUid(req.body || {});
    if (!uid) return res.status(400).json({ error: "Missing booking uid" });

    // Call Cal.com cancel endpoint
    var url = "https://api.cal.com/v2/bookings/" + encodeURIComponent(uid) + "/cancel";

    var calResp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "cal-api-version": "2024-08-13"
      },
      body: JSON.stringify({ cancellationReason: "Canceled by caller request" }) // Cal expects POST; empty body is fine
    });

    var calJson = null;
    try { calJson = await calResp.json(); } catch (e) { calJson = null; }

    if (calResp.ok) {
      console.log("CANCEL_BOOKING_RESULT", { ok: true, uid: uid });
      return res.status(200).json({ ok: true, already_cancelled: false });
    }

    // Detect "already cancelled" condition
    var msg =
      (calJson && calJson.error && calJson.error.message) ||
      (calJson && calJson.message) ||
      "";

    var already =
      String(msg).toLowerCase().indexOf("already") !== -1 &&
      (String(msg).toLowerCase().indexOf("cancelled") !== -1 || String(msg).toLowerCase().indexOf("canceled") !== -1);

    console.log("CANCEL_BOOKING_RESULT", { ok: false, status: calResp.status, already_cancelled: already, calJson: calJson });

    return res.status(200).json({
      ok: false,
      already_cancelled: already,
      error: msg || "Cancel failed"
    });
  } catch (err) {
    console.log("CANCEL_BOOKING_RESULT", { ok: false, error: (err && err.message) || String(err) });
    return res.status(200).json({ ok: false, already_cancelled: false, error: (err && err.message) || String(err) });
  }
};
