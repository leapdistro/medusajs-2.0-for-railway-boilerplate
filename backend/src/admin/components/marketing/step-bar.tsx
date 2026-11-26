import { Text } from "@medusajs/ui"

export type Step = { key: string; label: string; hint?: string }

/**
 * Progress bar for the campaign editor: a track that fills as you go,
 * with a numbered dot per step. Steps already reached are buttons (jump
 * back or forward to them); later ones aren't.
 */
export function StepBar({ steps, current, reached, onPick }: {
  steps: Step[]; current: number; reached: number; onPick: (i: number) => void
}) {
  const pct = steps.length > 1 ? (current / (steps.length - 1)) * 100 : 100
  return (
    <div role="list" aria-label="Steps" style={{ position: "relative", paddingTop: 2 }}>
      {/* Track + fill, running through the dot centres. */}
      <div style={{ position: "absolute", left: `${50 / steps.length}%`, right: `${50 / steps.length}%`, top: 15, height: 4, borderRadius: 99, background: "var(--border-base, #e5e7eb)" }}>
        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 99, background: "var(--fg-interactive, #3b82f6)", transition: "width 260ms ease" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${steps.length}, 1fr)`, position: "relative" }}>
        {steps.map((s, i) => {
          const done = i < current
          const here = i === current
          const can = i <= reached && !here
          return (
            <div key={s.key} role="listitem" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                onClick={() => can && onPick(i)}
                disabled={!can}
                aria-current={here ? "step" : undefined}
                aria-label={`Step ${i + 1}: ${s.label}`}
                style={{
                  width: 30, height: 30, borderRadius: 99, display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 600, cursor: can ? "pointer" : "default",
                  background: done ? "var(--fg-interactive, #3b82f6)" : "var(--bg-base, #fff)",
                  color: done ? "#fff" : here ? "var(--fg-interactive, #3b82f6)" : "var(--fg-muted, #9ca3af)",
                  border: `2px solid ${done || here ? "var(--fg-interactive, #3b82f6)" : "var(--border-strong, #d1d5db)"}`,
                  boxShadow: here ? "0 0 0 4px rgba(59,130,246,0.15)" : undefined,
                }}
              >
                {done ? "✓" : i + 1}
              </button>
              <button type="button" onClick={() => can && onPick(i)} disabled={!can} style={{ background: "none", border: 0, padding: 0, cursor: can ? "pointer" : "default", textAlign: "center" }}>
                <Text size="small" weight={here ? "plus" : "regular"} className={here ? "text-ui-fg-base" : "text-ui-fg-subtle"}>{s.label}</Text>
                {s.hint ? <Text size="xsmall" className="text-ui-fg-muted">{s.hint}</Text> : null}
              </button>
            </div>
          )
        })}
      </div>
      <Text size="xsmall" className="text-ui-fg-muted" style={{ textAlign: "right", marginTop: 6 }}>
        Step {current + 1} of {steps.length}
      </Text>
    </div>
  )
}
