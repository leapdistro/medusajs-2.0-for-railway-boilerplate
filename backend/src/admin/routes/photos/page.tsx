import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Container, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { PhotoWalk, fetchProducts, photoOrder, type WalkProduct } from "../../components/product-photos"

/**
 * Product Photos (owner, 2026-11-12).
 *  - /app/photos?receiving=<historyId>: the products a
 *    receiving created or restocked, photo-less ones first. Opened
 *    from "Add Photos" on the Receiving Saved screen and the history page.
 *  - /app/photos: every product with no photo yet, newest first.
 * Both open on a list of product cards; tap one to photograph it.
 * Photos are the products' own images (see PhotoWalk).
 */

const CameraIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
  </svg>
)

const FromReceiving = ({ historyId }: { historyId: string }) => {
  const [state, setState] = useState<{ products: WalkProduct[]; invoice: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const res = await fetch(`/admin/receiving/history/${historyId}`, { credentials: "include" })
      const json = await res.json()
      if (!json?.record) throw new Error(json?.message ?? "Receiving not found")
      const ids: string[] = Array.from(new Set(
        ((json.record.line_results ?? []) as any[])
          .filter((l) => l.productId && (l.action === "created" || l.action === "restocked"))
          .map((l) => l.productId as string),
      ))
      setState({ products: photoOrder(await fetchProducts(ids)), invoice: json.record.invoice_number })
    })().catch((e) => setError(e?.message ?? "Network error"))
  }, [historyId])

  if (error) return <Text style={{ color: "#B91C1C" }}>{error}</Text>
  if (!state) return <Text>Loading…</Text>
  return (
    <PhotoWalk
      products={state.products}
      title={`Receiving ${state.invoice}`}
      backHref={`/app/receiving/history/${historyId}`}
      backLabel="Back to the receiving"
    />
  )
}

const Missing = () => {
  const [products, setProducts] = useState<WalkProduct[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const all: (WalkProduct & { status?: string })[] = []
      for (let offset = 0; ; offset += 200) {
        const qs = new URLSearchParams({
          fields: "id,title,handle,thumbnail,status,images.id,images.url,categories.name",
          limit: "200", offset: String(offset), order: "-created_at",
        })
        const res = await fetch(`/admin/products?${qs}`, { credentials: "include" })
        const json = await res.json()
        if (!res.ok) throw new Error(json?.message ?? `Products failed (${res.status})`)
        all.push(...(json.products ?? []))
        if (all.length >= (json.count ?? 0) || !(json.products ?? []).length) break
      }
      setProducts(all.filter((p) => p.status !== "rejected" && !p.thumbnail && !p.images?.length))
    })().catch((e) => setError(e?.message ?? "Network error"))
  }, [])

  if (error) return <Text style={{ color: "#B91C1C" }}>{error}</Text>
  if (!products) return <Text>Loading…</Text>
  return (
    <PhotoWalk
      products={products}
      title="Product Photos"
      intro={
        <Text size="small" className="text-ui-fg-subtle">
          Products with no photo, newest first. For one receiving, open it in Receiving History and tap Add Photos.
        </Text>
      }
    />
  )
}

const PhotosPage = () => {
  const historyId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("receiving") : null
  return (
    <Container className="p-4 sm:p-6">
      {historyId ? <FromReceiving historyId={historyId} /> : <Missing />}
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Product Photos",
  icon: CameraIcon,
})

export default PhotosPage
