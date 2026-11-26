import { Heading, Text } from "@medusajs/ui"
import { useEffect, type ReactNode } from "react"

/** Plain overlay dialog (Esc / backdrop closes). */
export function Modal({ title, subtitle, onClose, children, footer, wide }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-ui-bg-base shadow-elevation-modal rounded-lg flex flex-col" style={{ width: "100%", maxWidth: wide ? 980 : 520, maxHeight: "90vh" }}>
        <div className="px-6 pt-5 pb-3 border-b border-ui-border-base">
          <Heading level="h2">{title}</Heading>
          {subtitle ? <Text size="small" className="text-ui-fg-subtle mt-1">{subtitle}</Text> : null}
        </div>
        <div className="px-6 py-4" style={{ overflowY: "auto" }}>{children}</div>
        {footer ? <div className="px-6 py-4 border-t border-ui-border-base flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  )
}
