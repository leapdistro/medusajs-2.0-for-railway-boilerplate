/**
 * ShipStation API wrapper — Rates V2 endpoint only.
 *
 * MBS ships every order via either UPS Ground or UPS Next Day Air Saver
 * with adult-signature confirmation + carrier insurance (~60% of invoice
 * subtotal). The fulfillment provider calls `getRates()` at checkout to
 * quote both services for the buyer's cart; pass-through cost — no markup.
 *
 * Auth: ShipStation legacy v1 endpoint uses HTTP Basic with API key +
 * secret. Both env vars are required at runtime; helpers throw a clear
 * misconfig error rather than silently 401-ing.
 *
 * Why not v2: ShipStation v2 (port from ShipEngine) requires per-shipment
 * carriers + accounts wired in their dashboard. Legacy v1 reuses the
 * account-level UPS carrier already attached to the operator's paid plan.
 */

const BASE_URL = "https://ssapi.shipstation.com"

export type ShipStationService = "ups_ground" | "ups_next_day_air_saver"

export type RateRequest = {
  toPostalCode: string
  weightLbs: number
  declaredValue: number
  /** Defaults to env SHIPSTATION_FROM_ZIP (77477 — MBS warehouse). */
  fromPostalCode?: string
}

export type ServiceRate = {
  serviceCode: ShipStationService
  /** Human label for the storefront option (e.g. "UPS Ground"). */
  label: string
  /** Total quoted cost in USD — already includes adult-signature surcharge
   *  and carrier insurance per the request. Pass-through, no markup. */
  total: number
}

/* ─── Service code map ────────────────────────────────────────────── */

const SERVICE_DEFS: Record<ShipStationService, { label: string; carrierCode: string }> = {
  ups_ground:             { label: "UPS Ground",                carrierCode: "ups_walleted" },
  ups_next_day_air_saver: { label: "UPS Next Day Air Saver",    carrierCode: "ups_walleted" },
}

/* ShipStation's legacy v1 uses `ups_walleted` for accounts billed
 * through their UPS-from-ShipStation wallet. If your account uses a
 * direct UPS carrier connection, the carrierCode would be `ups` — set
 * via env to avoid a code change. */
const CARRIER_CODE = process.env.SHIPSTATION_UPS_CARRIER_CODE || "ups_walleted"

/* ─── Auth + fetch ────────────────────────────────────────────────── */

function readEnv(): { apiKey: string; apiSecret: string; fromZip: string } {
  const apiKey = process.env.SHIPSTATION_API_KEY
  const apiSecret = process.env.SHIPSTATION_API_SECRET
  const fromZip = process.env.SHIPSTATION_FROM_ZIP || "77477"
  if (!apiKey || !apiSecret) {
    throw new Error("ShipStation credentials missing (SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET)")
  }
  return { apiKey, apiSecret, fromZip }
}

async function ssFetch(path: string, body: any): Promise<any> {
  const { apiKey, apiSecret } = readEnv()
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`ShipStation ${path} ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

/* ─── Public API: get UPS Ground + NDA Saver rates ────────────────── */

/**
 * Quote both UPS services for the cart. Returns whichever ones succeed —
 * if one service errors (e.g., NDA Saver unavailable for the zip), the
 * other still returns so the buyer has at least one option.
 */
export async function getRates(req: RateRequest): Promise<ServiceRate[]> {
  const { fromZip } = readEnv()
  if (!Number.isFinite(req.weightLbs) || req.weightLbs <= 0) {
    throw new Error("weightLbs must be positive")
  }
  if (!req.toPostalCode || !/^\d{5}/.test(req.toPostalCode)) {
    throw new Error(`Invalid toPostalCode: ${req.toPostalCode}`)
  }

  /* Per-service shipment payload. ShipStation's /shipments/getrates
   * endpoint takes ONE service per call — we fire both in parallel.
   *
   * Insurance: provider="carrier" delegates to UPS's own declared-value
   * coverage (best for hemp-restricted shipments where third-party
   * insurers refuse the SIC). Amount = caller-computed (60% × invoice).
   *
   * Confirmation: "adult_signature" applies UPS's 21+ delivery
   * confirmation surcharge — required for hemp by carrier policy and
   * MBS shipping convention. */
  const buildBody = (serviceCode: ShipStationService) => ({
    carrierCode: CARRIER_CODE,
    serviceCode,
    fromPostalCode: req.fromPostalCode ?? fromZip,
    toPostalCode: req.toPostalCode,
    toCountry: "US",
    weight: {
      value: req.weightLbs,
      units: "pounds" as const,
    },
    confirmation: "adult_signature" as const,
    insurance: {
      provider: "carrier" as const,
      insureShipment: true,
      insuredValue: Math.max(1, Math.round(req.declaredValue * 100) / 100),
    },
    /* ShipStation requires SOME packaging hint. "package" maps to UPS
     * "Your Packaging" — fine for our pouched flower + pre-roll boxes. */
    packageCode: "package",
  })

  const services: ShipStationService[] = ["ups_ground", "ups_next_day_air_saver"]
  const settled = await Promise.allSettled(
    services.map((sc) => ssFetch("/shipments/getrates", buildBody(sc))),
  )

  const results: ServiceRate[] = []
  settled.forEach((r, i) => {
    const sc = services[i]
    if (r.status !== "fulfilled") return
    /* The endpoint returns an ARRAY of rate options for the queried
     * service. With a single carrier+service, the array is typically
     * length 1, but ShipStation occasionally returns multiple lines
     * (e.g., guaranteed vs. published rates). Pick the cheapest as the
     * de-facto shipping cost. */
    const arr = (r.value as Array<{ shipmentCost?: number; otherCost?: number }>) ?? []
    if (arr.length === 0) return
    const cheapest = arr.reduce<{ shipmentCost: number; otherCost: number } | null>((best, x) => {
      const total = Number(x.shipmentCost ?? 0) + Number(x.otherCost ?? 0)
      if (!best || total < (best.shipmentCost + best.otherCost)) {
        return { shipmentCost: Number(x.shipmentCost ?? 0), otherCost: Number(x.otherCost ?? 0) }
      }
      return best
    }, null)
    if (!cheapest) return
    results.push({
      serviceCode: sc,
      label: SERVICE_DEFS[sc].label,
      total: Number((cheapest.shipmentCost + cheapest.otherCost).toFixed(2)),
    })
  })

  return results
}

/**
 * Compute the cache key shape callers should use when wrapping
 * `getRates()` with Modules.CACHE. Centralized so the provider and any
 * future debug routes use the same format.
 */
export function rateCacheKey(req: RateRequest): string {
  const from = req.fromPostalCode ?? process.env.SHIPSTATION_FROM_ZIP ?? "77477"
  return `shipstation:rate:${from}:${req.toPostalCode}:${req.weightLbs.toFixed(2)}:${req.declaredValue.toFixed(2)}`
}
