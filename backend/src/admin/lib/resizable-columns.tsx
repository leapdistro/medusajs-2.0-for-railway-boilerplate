import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"

/**
 * Resizable table columns — drag-to-resize handle + localStorage
 * persistence so widths survive page refresh.
 *
 * Pattern:
 *   const { widths, startResize, totalWidth } = useColumnWidths("mbs:rcv:flower", DEFAULTS)
 *   <table style={{ tableLayout: "fixed", width: totalWidth }}>
 *     <colgroup>
 *       {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
 *     </colgroup>
 *     <thead>
 *       <tr>
 *         <ResizableTh onResize={startResize(0)}>...</ResizableTh>
 *         ...
 *
 * Why a hook + atom rather than a full table component: the receiving
 * pages have heavy custom row rendering; wrapping in a generic table
 * component would require lifting too much state. The hook stays
 * lightweight and the consumer drives the render.
 */

const MIN_COL_WIDTH = 40

export function useColumnWidths(storageKey: string, defaults: number[]) {
  const [widths, setWidths] = useState<number[]>(() => {
    if (typeof window === "undefined") return defaults
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length === defaults.length && parsed.every((n) => typeof n === "number" && Number.isFinite(n))) {
          return parsed
        }
      }
    } catch { /* localStorage blocked → fall through to defaults */ }
    return defaults
  })

  useEffect(() => {
    if (typeof window === "undefined") return
    try { window.localStorage.setItem(storageKey, JSON.stringify(widths)) } catch { /* quota / private mode — ignore */ }
  }, [storageKey, widths])

  const startResize = (idx: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widths[idx]
    const move = (ev: PointerEvent) => {
      const next = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX))
      setWidths((cur) => {
        if (cur[idx] === next) return cur
        const out = [...cur]
        out[idx] = next
        return out
      })
    }
    const up = () => {
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", up)
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", up)
  }

  const reset = () => setWidths(defaults)

  const totalWidth = widths.reduce((s, w) => s + w, 0)

  return { widths, startResize, totalWidth, reset }
}

/* The handle that sits on the right edge of the <th>. The parent <th>
 * must be `position: relative` so this absolute positioning works.
 * Subtle on-hover red tint matches the brand. */
export function ColResizeHandle({ onResize }: { onResize: (e: ReactPointerEvent<HTMLDivElement>) => void }) {
  const [hover, setHover] = useState(false)
  const style: CSSProperties = {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 6,
    cursor: "col-resize",
    userSelect: "none",
    background: hover ? "rgba(217,55,55,0.4)" : "transparent",
    touchAction: "none",
  }
  return (
    <div
      onPointerDown={onResize}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    />
  )
}
