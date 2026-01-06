export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = req.headers.authorization || "";
  const expected = `Bearer ${process.env.RETELL_SHARED_SECRET}`;
  if (!process.env.RETELL_SHARED_SECRET || auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { booking_uid, new_start_time, reason } = req.body || {};
  if (!booking_uid || !new_start_time) {
    return res.status(400).json({ error: "Missing booking_uid or new_start_time" });
  }

  const calKey = process.env.CALCOM_API_KEY;
  if (!calKey) return res.status(500).json({ error: "Missing CALCOM_API_KEY in env" });

  try {
    const r = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(booking_uid)}/reschedule`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${calKey}`
      },
      body: JSON.stringify({
        start: new_start_time,
        reschedulingReason: reason || "Patient requested reschedule"
      })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ success: false, error: data });

    return res.status(200).json({ success: true, updated_start_time: new_start_time });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e) });
  }
}
