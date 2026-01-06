export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = req.headers.authorization || "";
  const expected = `Bearer ${process.env.RETELL_SHARED_SECRET}`;
  if (!process.env.RETELL_SHARED_SECRET || auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { full_name, phone_number } = req.body || {};
  if (!full_name || !phone_number) {
    return res.status(400).json({ error: "Missing full_name or phone_number" });
  }

  // Placeholder until we confirm how phone is stored in Cal.com bookings in your setup
  return res.status(200).json({ found: false, reason: "lookup_not_configured" });
}
