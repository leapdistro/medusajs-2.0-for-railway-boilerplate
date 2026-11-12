import { Badge, Button, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Product photo walk-through (owner, 2026-11-12). One product at a
 * time: take a photo, Save, then Add another or Next product. Tapping
 * a photo the product already has replaces it in place (the old one is
 * removed). The first photo is the product's main image (thumbnail).
 *
 * Same pipeline as the product page's Media section: each photo goes
 * through POST /admin/uploads (the compress middleware turns it
 * upright, caps it at 2000px and stores a JPEG), then the product's
 * images + thumbnail are saved with POST /admin/products/:id. So every
 * photo can be edited, reordered or deleted from the product page too.
 *
 * Phones (coarse pointer) open the camera app through a file input
 * with `capture`; computers show a live webcam view, or a file picker
 * when there's no camera. Uploads run in the background so the next
 * shot can be taken straight away; a failed one shows Retry.
 */

export type WalkProduct = {
  id: string
  title: string
  handle?: string
  thumbnail?: string | null
  images?: { id: string; url: string }[] | null
  categories?: { name: string }[] | null
}

type Photo = {
  key: string
  /** Stored file URL once uploaded (or the existing image's). */
  url?: string
  /** Medusa image id once saved on the product. */
  id?: string
  /** Local preview while uploading. */
  preview?: string
  status: "saved" | "uploading" | "failed"
  blob?: Blob
  /** The photo this one replaces; kept until the upload lands. */
  prev?: Photo
}

export const PRODUCT_PHOTO_FIELDS = "id,title,handle,thumbnail,status,*images,categories.name"

const hasPhoto = (p: WalkProduct) => !!(p.thumbnail || p.images?.length)

/** Photo-less products first, otherwise the order given. */
export const photoOrder = (list: WalkProduct[]) =>
  [...list.filter((p) => !hasPhoto(p)), ...list.filter(hasPhoto)]

/** Products by id through the admin API, in batches of 50. */
export async function fetchProducts(ids: string[]): Promise<WalkProduct[]> {
  const out: WalkProduct[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const qs = new URLSearchParams({ fields: PRODUCT_PHOTO_FIELDS, limit: String(chunk.length) })
    chunk.forEach((id) => qs.append("id[]", id))
    const res = await fetch(`/admin/products?${qs}`, { credentials: "include" })
    const json = await res.json()
    if (!res.ok) throw new Error(json?.message ?? `Products failed (${res.status})`)
    out.push(...(json.products ?? []))
  }
  const byId = new Map(out.map((p) => [p.id, p]))
  return ids.map((id) => byId.get(id)).filter((p): p is WalkProduct => !!p)
}

/** Shrinks big phone photos before upload so they send fast; the server
 *  still compresses. Any failure sends the original. */
async function shrink(blob: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions)
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height))
    if (scale === 1 && blob.type === "image/jpeg") return blob
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9))
    return out ?? blob
  } catch {
    return blob
  }
}

const isPhone = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches

let keySeq = 0
const newKey = () => `p${++keySeq}`

/* ── Camera ──────────────────────────────────────────────────────── */

/** Live webcam view for computers. Resolves a shot or falls back to
 *  the file picker when there's no camera or it's blocked. */
const Webcam = ({ onShot, onCancel, onNoCamera }: {
  onShot: (b: Blob) => void
  onCancel: () => void
  onNoCamera: () => void
}) => {
  const video = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    if (!navigator.mediaDevices?.getUserMedia) { onNoCamera(); return }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
      stream = s
      if (video.current) {
        video.current.srcObject = s
        video.current.play().then(() => setReady(true)).catch(() => setReady(true))
      }
    }).catch(() => { if (!stopped) onNoCamera() })
    return () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()) }
  }, [])

  const snap = () => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const canvas = document.createElement("canvas")
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext("2d")!.drawImage(v, 0, 0)
    canvas.toBlob((b) => b && onShot(b), "image/jpeg", 0.92)
  }

  return (
    <div className="flex flex-col gap-3">
      <div style={{ position: "relative", background: "#000", borderRadius: 8, overflow: "hidden", aspectRatio: "4 / 3", display: "grid", placeItems: "center" }}>
        <video ref={video} playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        {!ready && <Text className="text-ui-fg-on-color" style={{ position: "absolute" }}>Starting camera…</Text>}
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button size="large" onClick={snap} disabled={!ready}>Take photo</Button>
        <Button size="large" variant="secondary" onClick={onNoCamera}>Choose file instead</Button>
        <Button size="large" variant="transparent" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

/* ── Walk-through ────────────────────────────────────────────────── */

export const PhotoWalk = ({ products, title, backHref, backLabel, start = 0 }: {
  products: WalkProduct[]
  title: string
  backHref: string
  backLabel: string
  start?: number
}) => {
  const [index, setIndex] = useState(start)
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])

  /* Photos per product live in a ref so background uploads and the
   * serialised saves always see the latest list. */
  const photos = useRef<Record<string, Photo[]>>({})
  const chains = useRef<Record<string, Promise<void>>>({})
  const listFor = (p: WalkProduct): Photo[] => {
    if (!photos.current[p.id]) {
      const imgs = p.images?.length ? p.images : p.thumbnail ? [{ id: "", url: p.thumbnail }] : []
      photos.current[p.id] = imgs.map((im) => ({ key: newKey(), id: im.id || undefined, url: im.url, status: "saved" as const }))
    }
    return photos.current[p.id]
  }

  /* What the camera is shooting for: a new photo, or a replacement. */
  const [target, setTarget] = useState<{ replaceKey?: string } | null>(null)
  const [webcam, setWebcam] = useState(false)
  const [shot, setShot] = useState<{ blob: Blob; preview: string } | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const pickerInput = useRef<HTMLInputElement>(null)

  const product = products[index]
  const list = product ? listFor(product) : []
  const busy = Object.values(photos.current).some((l) => l.some((p) => p.status === "uploading"))

  useEffect(() => {
    if (!busy) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [busy])

  /* Save the product's images in display order; first = main image.
   * Saves for one product run one after another so ids from each
   * response reach the next. */
  const commit = (productId: string) => {
    const run = async () => {
      const current = photos.current[productId] ?? []
      const images = current
        .map((p) => (p.url ? p : p.prev?.url ? p.prev : null))
        .filter((p): p is Photo => !!p)
        .map((p) => (p.id ? { id: p.id, url: p.url! } : { url: p.url! }))
      const res = await fetch(`/admin/products/${productId}?fields=id,thumbnail,*images`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, thumbnail: images[0]?.url ?? null }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `Save failed (${res.status})`)
      const saved: { id: string; url: string }[] = json?.product?.images ?? []
      for (const p of photos.current[productId] ?? []) {
        if (p.url && !p.id) p.id = saved.find((s) => s.url === p.url)?.id
      }
    }
    const next = (chains.current[productId] ?? Promise.resolve()).then(run)
    chains.current[productId] = next.catch(() => {})
    return next
  }

  const upload = async (productId: string, photo: Photo) => {
    photo.status = "uploading"
    rerender()
    try {
      const small = await shrink(photo.blob!)
      const fd = new FormData()
      const handle = products.find((p) => p.id === productId)?.handle ?? "product"
      fd.append("files", small, `${handle}-${Date.now()}.jpg`)
      const res = await fetch("/admin/uploads", { method: "POST", credentials: "include", body: fd })
      const json = await res.json().catch(() => ({}))
      const url = json?.files?.[0]?.url
      if (!res.ok || !url) throw new Error(json?.message ?? `Upload failed (${res.status})`)
      photo.url = url
      await commit(productId)
      photo.status = "saved"
      photo.prev = undefined
      photo.blob = undefined
    } catch (e: any) {
      photo.status = "failed"
      toast.error("Photo didn't save", { description: e?.message ?? "Network error" })
    }
    rerender()
  }

  const openCamera = (replaceKey?: string) => {
    setTarget({ replaceKey })
    setJustSaved(false)
    if (isPhone()) fileInput.current?.click()
    else setWebcam(true)
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ""
    if (f) { setWebcam(false); setShot({ blob: f, preview: URL.createObjectURL(f) }) }
  }

  const onSave = () => {
    if (!shot || !product) return
    const l = listFor(product)
    const photo: Photo = { key: newKey(), blob: shot.blob, preview: shot.preview, status: "uploading" }
    const at = target?.replaceKey ? l.findIndex((p) => p.key === target.replaceKey) : -1
    if (at >= 0) {
      const old = l[at]
      /* Replacing a photo that is itself still uploading: keep what it replaced. */
      photo.prev = old.status === "saved" ? old : old.prev
      l[at] = photo
    } else {
      l.push(photo)
    }
    setShot(null)
    setTarget(null)
    setJustSaved(true)
    upload(product.id, photo)
  }

  /* A failed replacement can go back to the photo it replaced. */
  const discard = (key: string) => {
    if (!product) return
    const l = listFor(product)
    const at = l.findIndex((p) => p.key === key)
    if (at < 0) return
    const p = l[at]
    if (p.prev) l[at] = p.prev
    else l.splice(at, 1)
    rerender()
  }

  const go = (i: number) => {
    setIndex(i)
    setJustSaved(false)
    setShot(null)
    setWebcam(false)
    window.scrollTo({ top: 0 })
  }

  const inputs = (
    <>
      <input ref={fileInput} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      <input ref={pickerInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onFile} />
    </>
  )

  if (!products.length) {
    return (
      <div className="flex flex-col gap-3">
        <Heading level="h1">{title}</Heading>
        <Text className="text-ui-fg-subtle">No products to photograph.</Text>
        <Button asChild variant="secondary" className="self-start"><a href={backHref}>{backLabel}</a></Button>
      </div>
    )
  }

  if (index >= products.length) {
    const withPhoto = products.filter((p) => listFor(p).some((x) => x.url || x.prev?.url)).length
    return (
      <div className="flex flex-col gap-3">
        <Heading level="h1">Photos done</Heading>
        <Text className="text-ui-fg-subtle">
          {withPhoto} of {products.length} product{products.length === 1 ? "" : "s"} have a photo.
          {busy && " Some photos are still uploading. Keep this page open until they finish."}
        </Text>
        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" onClick={() => go(0)}>Back to the first product</Button>
          <Button asChild variant="secondary"><a href={backHref}>{backLabel}</a></Button>
        </div>
      </div>
    )
  }

  const tier = product.categories?.map((c) => c.name).join(" · ")
  const isLast = index === products.length - 1

  return (
    <div className="flex flex-col gap-5" style={{ maxWidth: 720 }}>
      {inputs}
      <div className="flex flex-col gap-1">
        <Button asChild variant="transparent" size="small" className="self-start">
          <a href={backHref}>← {backLabel}</a>
        </Button>
        <Text size="small" className="text-ui-fg-subtle">{title} · {index + 1} of {products.length}</Text>
        <div style={{ height: 4, background: "var(--bg-subtle, #eee)", borderRadius: 2 }}>
          <div style={{ height: 4, width: `${((index + 1) / products.length) * 100}%`, background: "var(--fg-interactive, #3b82f6)", borderRadius: 2 }} />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Heading level="h1">{product.title}</Heading>
        <div className="flex gap-2 items-center flex-wrap">
          {tier && <Text size="small" className="text-ui-fg-subtle">{tier}</Text>}
          {list.length
            ? <Badge size="2xsmall" color="green">{list.length} photo{list.length === 1 ? "" : "s"}</Badge>
            : <Badge size="2xsmall" color="orange">No photo</Badge>}
          <a href={`/app/products/${product.id}`} className="txt-compact-small text-ui-fg-interactive">Open product</a>
        </div>
      </div>

      {shot ? (
        <div className="flex flex-col gap-3">
          <img src={shot.preview} alt="" style={{ width: "100%", maxHeight: "60vh", objectFit: "contain", background: "#000", borderRadius: 8 }} />
          <div className="flex gap-2 flex-wrap">
            <Button size="large" onClick={onSave}>{target?.replaceKey ? "Save, replace photo" : "Save"}</Button>
            <Button size="large" variant="secondary" onClick={() => { setShot(null); openCamera(target?.replaceKey) }}>Retake</Button>
            <Button size="large" variant="transparent" onClick={() => { setShot(null); setTarget(null) }}>Cancel</Button>
          </div>
        </div>
      ) : webcam ? (
        <Webcam
          onShot={(b) => { setWebcam(false); setShot({ blob: b, preview: URL.createObjectURL(b) }) }}
          onCancel={() => { setWebcam(false); setTarget(null) }}
          onNoCamera={() => { setWebcam(false); pickerInput.current?.click() }}
        />
      ) : (
        <>
          {list.length > 0 && (
            <div className="flex flex-col gap-2">
              <Text size="small" className="text-ui-fg-subtle">Tap a photo to replace it.</Text>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                {list.map((p, i) => (
                  <div key={p.key} className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => p.status !== "uploading" && openCamera(p.key)}
                      title={p.status === "uploading" ? "Uploading…" : "Replace this photo"}
                      style={{
                        position: "relative", aspectRatio: "1", borderRadius: 8, overflow: "hidden",
                        border: i === 0 ? "2px solid var(--fg-base, #111)" : "1px solid var(--border-base, #ddd)",
                        background: "var(--bg-subtle, #f4f4f5)", padding: 0, cursor: p.status === "uploading" ? "progress" : "pointer",
                      }}
                    >
                      <img src={p.preview ?? p.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: p.status === "saved" ? 1 : 0.55 }} />
                      {i === 0 && <span style={{ position: "absolute", top: 6, left: 6 }}><Badge size="2xsmall">Main</Badge></span>}
                      {p.status === "uploading" && (
                        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                          <Badge size="2xsmall" color="blue">Uploading…</Badge>
                        </span>
                      )}
                    </button>
                    {p.status === "failed" && (
                      <div className="flex gap-1 flex-wrap">
                        <Button size="small" variant="secondary" onClick={() => upload(product.id, p)}>Retry</Button>
                        <Button size="small" variant="transparent" onClick={() => discard(p.key)}>{p.prev ? "Keep old" : "Remove"}</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            {justSaved ? (
              <>
                <Button size="large" variant="secondary" onClick={() => openCamera()}>Add another photo</Button>
                <Button size="large" onClick={() => go(index + 1)}>{isLast ? "Done" : "Next product →"}</Button>
              </>
            ) : (
              <>
                <Button size="large" onClick={() => openCamera()}>{list.length ? "Add a photo" : "Take photo"}</Button>
                <Button size="large" variant="secondary" onClick={() => go(index + 1)}>{isLast ? "Done" : "Skip →"}</Button>
              </>
            )}
          </div>
          {index > 0 && (
            <Button variant="transparent" size="small" className="self-start" onClick={() => go(index - 1)}>← Previous product</Button>
          )}
        </>
      )}
    </div>
  )
}
