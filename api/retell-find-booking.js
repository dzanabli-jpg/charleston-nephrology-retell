export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Retell auth guard
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${process.env.RETELL_SHARED_SECRET}`;
  if (!process.env.RETELL_SHARED_SECRET || auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { full_name, phone_number } = req.body || {};
  if (!full_name || !phone_number) {
    return res.status(400).json({ error: "Missing full_name or phone_number" });
  }

  const calKey = process.env.CALCOM_API_KEY;
  if (!calKey) return res.status(500).json({ error: "Missing CALCOM_API_KEY in env" });

  const EVENT_TYPE_IDS = ["4323791", "4323781"]; // follow-up, new patient
  const normalizePhone = (p) => String(p || "").replace(/[^\d]/g, "");
  const last10 = (p) => {
    const d = normalizePhone(p);
    return d.length >= 10 ? d.slice(-10) : d;
  };

  const target = last10(phone_number);

  // Pull upcoming-ish bookings for both event types
  // Cal.com API v2 supports status + eventTypeIds + sorting + pagination. :contentReference[oaicite:2]{index=2}
  const url = new URL("https://api.cal.com/v2/bookings");
  url.searchParams.set("eventTypeIds", EVENT_TYPE_IDS.join(",")); // supports comma-separated ids :contentReference[oaicite:3]{index=3}
  url.searchParams.set("status", "upcoming,unconfirmed"); // comma-separated allowed :contentReference[oaicite:4]{index=4}
  url.searchParams.set("take", "100");
  url.searchParams.set("skip", "0");
  url.searchParams.set("sortStart", "asc");

  // Optional: attendeeName filter can reduce noise (not required)
  // url.searchParams.set("attendeeName", full_name);

  try {
    const r = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${calKey}`,
        "cal-api-version": "2024-08-13" // required for v2 behavior :contentReference[oaicite:5]{index=5}
      }
    });

    const payload = await r.json().catch(() => ({}));
    if (!r.ok || payload?.status !== "success") {
      return res.status(r.status || 500).json({
        found: false,
        reason: "calcom_error",
        calcom: payload
      });
    }

    const bookings = Array.isArray(payload.data) ? payload.data : [];
    const matches = bookings
      .map((b) => {
        const attendees = Array.isArray(b.attendees) ? b.attendees : [];
        const attendeePhones = attendees
          .map((a) => a?.phoneNumber)
          .filter(Boolean);

        const matched = attendeePhones.some((p) => last10(p) === target);
        return matched
          ? {
              booking_uid: b.uid,
              start_time: b.start,
              end_time: b.end,
              status: b.status,
              eventTypeId: b.eventTypeId,
              attendee_name: attendees?.[0]?.name || null
            }
          : null;
      })
      .filter(Boolean);

    if (matches.length === 0) {
      return res.status(200).json({
        found: false,
        reason: "no_match",
        searched_eventTypeIds: EVENT_TYPE_IDS
      });
    }

    if (matches.length === 1) {
      return res.status(200).json({
        found: true,
        booking_uid: matches[0].booking_uid,
        start_time: matches[0].start_time,
        end_time: matches[0].end_time,
        eventTypeId: matches[0].eventTypeId
      });
    }

    // Multiple matches: let the AI ask which one
    return res.status(200).json({
      found: false,
      reason: "multiple_matches",
      matches
    });
  } catch (e) {
    return res.status(500).json({ found: false, reason: "exception", error: String(e) });
  }
}
