// /api/retell-cancel-booking.js (CommonJS - Retell + Cal.com v2)
//
// Env vars required:
// - RETELL_SHARED_SECRET
// - CALCOM_API_KEY
//
// Retell should call this with args:
// - booking_uid (string)
// - cancellation_reason (string, optional)

function pickArg(body, key) {
  body = body || {};
  if (body.args && typeof body.args === "object" && body.args[key] !== undefined) return body.args[key];
  if (body[key] !== undefined) return body[key];
  return undefined;
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

    var body = req.body || {};
    console.log("RETELL_CANCEL_REQUEST_BODY", body);

    var bookingUid = pickArg(body, "booking_uid") || pickArg(body, "bookingUid") || pickArg(body, "uid");
    var cancellationReason =
      pickArg(body, "cancellation_reason") ||
      pickArg(body, "cancellationReason") ||
      "Cancelled at patient request";

    if (!bookingUid || typeof bookingUid !== "string") {
      return res.status(400).json({ error: "Missing booking_uid" });
    }

    var calResp = await fetch("https://api.cal.com/v2/bookings/" + encodeURIComponent(bookingUid) + "/cancel", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "cal-api-version": "2024-08-13"
      },
      body: JSON.stringify({
        cancellationReason: String(cancellationReason).slice(0, 300)
      })
    });

    var calJson = null;
    try {
      calJson = await calResp.json();
    } catch (e) {
      calJson = null;
    }

    if (!calResp.ok) {
      console.log("CANCEL_BOOKING_RESULT", { ok: false, status: calResp.status, calJson: calJson });
      return res.status(502).json({
        error: "Cal.com cancel error",
        status: calResp.status,
        response: calJson
      });
    }

    console.log("CANCEL_BOOKING_RESULT", { ok: true, booking_uid: bookingUid });
    return res.status(200).json({
      success: true,
      booking_uid: bookingUid,
      cal: calJson
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled server error",
      message: (err && err.message) || String(err)
    });
  }
};
