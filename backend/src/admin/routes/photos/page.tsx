import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { PhotoWalk, fetchProducts, photoOrder, type WalkProduct } from "../../components/product-photos"

/**
 * Product Photos (owner, 2026-11-12).
 *  - /app/photos?receiving=<historyId>: walks through the products a
 *    receiving created or restocked, photo-less ones first. Opened
 *    from "Add Photos" on the Receiving Saved screen and the history page.
 *  - /app/photos: every product with no photo yet, newest first; Start
 *    walks through them, or tap one to start there.
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
  const [start, setStart] = useState<number | null>(null)

  useEffect(() => {
    (async () => {
      const all: (WalkProduct & { status?: string })[] = []
      for (let offset = 0; ; offset += 200) {
        const qs = new URLSearchParams({
          fields: "id,title,handle,thumbnail,status,images.id,categories.name",
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
  if (start !== null) {
    return <PhotoWalk products={products} start={start} title="Products with no photo" backHref="/app/photos" backLabel="All products with no photo" />
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-start gap-3 flex-wrap">
        <div>
          <Heading level="h1">Product Photos</Heading>
          <Text className="text-ui-fg-subtle">
            {products.length
              ? `${products.length} product${products.length === 1 ? "" : "s"} with no photo, newest first.`
              : "Every product has a photo."}
          </Text>
        </div>
        {products.length > 0 && <Button size="large" onClick={() => setStart(0)}>Start taking photos</Button>}
      </div>
      <Text size="small" className="text-ui-fg-subtle">
        To photograph one receiving, open it in Receiving History and tap Add Photos.
      </Text>
      <div className="flex flex-col">
        {products.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setStart(i)}
            className="flex justify-between items-center gap-3 text-left hover:bg-ui-bg-base-hover"
            style={{ padding: "10px 4px", borderTop: "1px solid var(--border-base, #e5e7eb)" }}
          >
            <div className="flex flex-col">
              <Text weight="plus">{p.title}</Text>
              <Text size="small" className="text-ui-fg-subtle">{p.categories?.map((c) => c.name).join(" · ")}</Text>
            </div>
            <div className="flex gap-2 items-center">
              {(p as any).status === "draft" && <Badge size="2xsmall">Draft</Badge>}
              <Text size="small" className="text-ui-fg-interactive">Take photo →</Text>
            </div>
          </button>
        ))}
      </div>
    </div>
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
