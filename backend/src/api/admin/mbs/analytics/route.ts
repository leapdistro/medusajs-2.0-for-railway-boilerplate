import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { analyticsReport, type Bucket } from "../../../../lib/analytics"

/**
 * GET /admin/mbs/analytics?from=<ISO>&to=<ISO>&tz=<IANA>[&bucket=day|week|month]
 *
 * Sales, COGS, margin, payments, open balance and customers for orders
 * placed from `from` (inclusive) to `to` (exclusive). See lib/analytics.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const q = req.query as Record<string, string | undefined>
  const tz = q.tz && isTimeZone(q.tz) ? q.tz : "America/Chicago"
  const bucket = q.bucket === "day" || q.bucket === "week" || q.bucket === "month" ? (q.bucket as Bucket) : undefined
  if (!q.from || !q.to) return res.status(400).json({ message: "from and to are required" })
  try {
    res.json(await analyticsReport(req.scope, { from: q.from, to: q.to, tz, bucket }))
  } catch (e: any) {
    res.status(400).json({ message: e?.message ?? "Couldn't build the report" })
  }
}

function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true } catch { return false }
}
