import { Body, Container, Head, Html, Img, Link, Preview, Section, Text, render } from "@react-email/components"
import * as React from "react"
import type { Block, ProductsBlock } from "./blocks"
import type { EmailProduct } from "./products"
import { storefrontBase } from "./products"

/**
 * Renders a marketing email from blocks. Every colour, font, corner and
 * spacing is fixed here, from the site's design tokens (storefront
 * CLAUDE.md), so content can't go off-brand. Same card, sage header,
 * butter button and footer as the transactional emails (email-
 * notifications/templates/base.tsx), plus the marketing footer:
 * why you're getting it + unsubscribe (CAN-SPAM, Resend AUP).
 *
 * Inline styles and tables only; Fraunces / Inter load where the client
 * allows web fonts (Apple Mail, iOS) and fall back to Georgia / Helvetica
 * elsewhere (Gmail, Outlook).
 */

const C = {
  ink: "#171B14", mute: "#414738", paper: "#FFF9ED", card: "#FFFDF7",
  sage: "#DCE8D7", butter: "#FFE6B8", strip: "#ECEDDF", line: "#DDD7C4",
}
const SERIF = "Fraunces, Georgia, 'Times New Roman', serif"
const SANS = "Inter, Helvetica, Arial, sans-serif"

export type EmailContact = { firstName?: string; company?: string } | null

export type RenderInput = {
  campaignId: string
  subject: string
  preheader: string
  blocks: Block[]
  products: Map<string, EmailProduct>
  contact: EmailContact
  /** Footer link; null in previews (shows a dead link). */
  unsubscribeUrl: string | null
  showPrices?: boolean
}

/* ───────── text helpers ───────── */

export function personalize(s: string, contact: EmailContact): string {
  return s
    .replace(/\{\{\s*first_name\s*\}\}/gi, contact?.firstName || "there")
    .replace(/\{\{\s*company\s*\}\}/gi, contact?.company || "your store")
}

/** Absolute URL with campaign tags on links to our own site. */
export function trackedUrl(raw: string, campaignId: string): string {
  if (!raw) return storefrontBase()
  const abs = raw.startsWith("/") ? `${storefrontBase()}${raw}` : raw
  try {
    const u = new URL(abs)
    const site = new URL(storefrontBase())
    const ours = u.hostname === site.hostname || u.hostname.replace(/^www\./, "") === site.hostname.replace(/^www\./, "")
    if (ours) {
      u.searchParams.set("utm_source", "mbs-email")
      u.searchParams.set("utm_medium", "email")
      u.searchParams.set("utm_campaign", campaignId)
    }
    return u.toString()
  } catch {
    return abs
  }
}

/** **bold** and [label](url) inside one paragraph. */
function inline(text: string, campaignId: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1]) out.push(<strong key={k++} style={{ fontWeight: 700 }}>{m[1]}</strong>)
    else out.push(
      <Link key={k++} href={trackedUrl(m[3], campaignId)} style={{ color: C.ink, textDecoration: "underline", fontWeight: 600 }}>{m[2]}</Link>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`

/* ───────── blocks ───────── */

function Heading({ text, highlight }: { text: string; highlight?: string }) {
  const style: React.CSSProperties = {
    margin: "0 0 16px", fontFamily: SERIF, fontSize: "34px", fontWeight: 800,
    lineHeight: "1.05", letterSpacing: "-0.04em", color: C.ink,
  }
  const at = highlight ? text.toLowerCase().indexOf(highlight.toLowerCase()) : -1
  if (!highlight || at < 0) return <Text style={style}>{text}</Text>
  return (
    <Text style={style}>
      {text.slice(0, at)}
      <span style={{ backgroundColor: C.butter, padding: "0 4px" }}>{text.slice(at, at + highlight.length)}</span>
      {text.slice(at + highlight.length)}
    </Text>
  )
}

function Paragraphs({ text, campaignId }: { text: string; campaignId: string }) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  return (
    <>
      {paras.map((p, i) => (
        <Text key={i} style={{ margin: "0 0 14px", fontFamily: SANS, fontSize: "16px", lineHeight: "1.6", color: C.ink }}>
          {p.split("\n").flatMap((line, j) => (j ? [<br key={`b${j}`} />, ...inline(line, campaignId)] : inline(line, campaignId)))}
        </Text>
      ))}
    </>
  )
}

function Button({ label, href }: { label: string; href: string }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ width: "100%", margin: "8px 0 20px" }}>
      <tbody><tr><td align="center">
        <a href={href} style={{
          display: "inline-block", backgroundColor: C.butter, color: C.ink, fontFamily: SANS, fontSize: "16px",
          fontWeight: 700, letterSpacing: "-0.01em", padding: "15px 34px", border: `2.5px solid ${C.ink}`,
          borderBottomWidth: "4.5px", textDecoration: "none", borderRadius: "999px",
        }}>{label}</a>
      </td></tr></tbody>
    </table>
  )
}

function ProductCard({ p, showPrice, href, compact }: { p: EmailProduct; showPrice: boolean; href: string; compact?: boolean }) {
  const badge = (
    <span style={{
      display: "inline-block", backgroundColor: C.card, border: `1.5px solid ${C.ink}`, borderRadius: "999px",
      padding: "3px 10px 3px 8px", fontFamily: SANS, fontSize: "11px", fontWeight: 700, color: C.ink, whiteSpace: "nowrap",
    }}>
      <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "999px", backgroundColor: p.colors.swatch, marginRight: "6px", verticalAlign: "middle" }} />
      <span style={{ verticalAlign: "middle" }}>{p.badge}</span>
    </span>
  )
  const price = showPrice && p.price ? (
    <Text style={{ margin: "6px 0 0", fontFamily: SANS, fontSize: "13px", color: C.mute }}>
      <span style={{ fontFamily: SERIF, fontSize: "20px", fontWeight: 760, color: C.ink, letterSpacing: "-0.02em" }}>{money(p.price.amount)}</span>
      {p.price.label ? <span> · {p.price.label}</span> : null}
      {p.moreSizes ? <span> · +{p.moreSizes} size{p.moreSizes === 1 ? "" : "s"}</span> : null}
    </Text>
  ) : null
  const name = (
    <Text style={{ margin: "8px 0 0", fontFamily: SANS, fontSize: compact ? "15px" : "16px", fontWeight: 700, lineHeight: "1.25", color: C.ink }}>{p.title}</Text>
  )
  const photo = p.image
    ? <Img src={p.image} alt={p.title} width="100%" style={{ display: "block", width: "100%", height: "auto", borderRadius: "5px 5px 0 0" }} />
    : <div style={{ height: "120px" }} />

  /* Offset paper edge in the tier colour (the site's specimen card). */
  return (
    <a href={href} style={{ textDecoration: "none", color: C.ink, display: "block" }}>
      <table role="presentation" cellPadding={0} cellSpacing={0} border={0} width="100%" style={{ backgroundColor: p.colors.edge, borderRadius: "9px" }}>
        <tbody><tr><td style={{ padding: "0 4px 4px 0" }}>
          <table role="presentation" cellPadding={0} cellSpacing={0} border={0} width="100%" style={{ backgroundColor: C.card, border: `1.5px solid ${C.ink}`, borderRadius: "7px" }}>
            <tbody>
              {compact ? (
                <tr>
                  <td width="38%" style={{ backgroundColor: p.colors.surface, borderRadius: "5px 0 0 5px", verticalAlign: "top" }}>{photo}</td>
                  <td style={{ padding: "12px 14px", verticalAlign: "top" }}>{badge}{name}{price}</td>
                </tr>
              ) : (
                <>
                  <tr><td style={{ backgroundColor: p.colors.surface, borderRadius: "5px 5px 0 0" }}>{photo}</td></tr>
                  <tr><td style={{ padding: "12px 14px 14px" }}>{badge}{name}{price}</td></tr>
                </>
              )}
            </tbody>
          </table>
        </td></tr></tbody>
      </table>
    </a>
  )
}

function Products({ block, products, campaignId, showPrices }: { block: ProductsBlock; products: Map<string, EmailProduct>; campaignId: string; showPrices: boolean }) {
  const items = block.productIds.map((id) => products.get(id)).filter((p): p is EmailProduct => !!p)
  if (!items.length) return null
  const show = showPrices && block.showPrices
  const title = block.title ? (
    <Text style={{ margin: "8px 0 12px", fontFamily: SERIF, fontSize: "24px", fontWeight: 780, letterSpacing: "-0.035em", color: C.ink }}>{block.title}</Text>
  ) : null
  if (block.layout === "list") {
    return (
      <>
        {title}
        {items.map((p) => (
          <div key={p.id} style={{ marginBottom: "14px" }}>
            <ProductCard p={p} showPrice={show} href={trackedUrl(p.url, campaignId)} compact />
          </div>
        ))}
        <div style={{ height: "6px" }} />
      </>
    )
  }
  const rows: EmailProduct[][] = []
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2))
  return (
    <>
      {title}
      <table role="presentation" cellPadding={0} cellSpacing={0} border={0} width="100%">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((p, j) => (
                <td key={p.id} width="50%" style={{ verticalAlign: "top", padding: `0 ${j === 0 ? "7px" : "0"} 14px ${j === 1 ? "7px" : "0"}` }}>
                  <ProductCard p={p} showPrice={show} href={trackedUrl(p.url, campaignId)} />
                </td>
              ))}
              {r.length === 1 ? <td width="50%" /> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ height: "6px" }} />
    </>
  )
}

function BlockView({ b, input }: { b: Block; input: RenderInput }) {
  const cid = input.campaignId
  switch (b.type) {
    case "heading":
      return b.text.trim() ? <Heading text={personalize(b.text, input.contact)} highlight={b.highlight} /> : null
    case "text":
      return b.text.trim() ? <Paragraphs text={personalize(b.text, input.contact)} campaignId={cid} /> : null
    case "button":
      return b.label.trim() ? <Button label={b.label} href={trackedUrl(b.url || "/products", cid)} /> : null
    case "image": {
      if (!b.url) return null
      const img = <Img src={b.url} alt={b.alt} width="100%" style={{ display: "block", width: "100%", height: "auto", borderRadius: "7px", border: `1.5px solid ${C.ink}` }} />
      return <div style={{ margin: "4px 0 18px" }}>{b.link ? <a href={trackedUrl(b.link, cid)}>{img}</a> : img}</div>
    }
    case "products":
      return <Products block={b} products={input.products} campaignId={cid} showPrices={input.showPrices !== false} />
    case "spacer":
      return <div style={{ height: b.size === "s" ? "8px" : b.size === "l" ? "40px" : "20px" }} />
  }
}

export function MarketingEmail(input: RenderInput) {
  const site = storefrontBase()
  return (
    <Html>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700;9..144,800&family=Inter:wght@500;700&display=swap" />
      </Head>
      {input.preheader ? <Preview>{input.preheader}</Preview> : null}
      <Body style={{ backgroundColor: C.paper, fontFamily: SANS, margin: 0, padding: "24px 12px" }}>
        <Container style={{ maxWidth: "600px", width: "100%", backgroundColor: C.card, border: `1.5px solid ${C.ink}`, borderRadius: "7px", overflow: "hidden" }}>
          <Section style={{ padding: "30px 24px 22px", textAlign: "center", backgroundColor: C.sage }}>
            <Link href={trackedUrl("/", input.campaignId)}>
              <Img src={`${site}/logos/mbsblack.png`} alt="Mind Body Spirit" height="52" style={{ display: "block", margin: "0 auto", height: "52px", width: "auto" }} />
            </Link>
          </Section>
          <div style={{ height: "2px", backgroundColor: C.ink }} />
          <Section style={{ padding: "32px 28px 18px" }}>
            {input.blocks.map((b) => <BlockView key={b.id} b={b} input={input} />)}
          </Section>
          <Section style={{ padding: "20px 28px 26px", backgroundColor: C.strip, textAlign: "center" }}>
            <Text style={{ margin: 0, fontFamily: SANS, fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em", color: C.ink, textTransform: "uppercase" }}>
              Mind Body Spirit
            </Text>
            <Text style={{ margin: "6px 0 0", fontFamily: SANS, fontSize: "12px", color: C.mute, lineHeight: "1.5" }}>
              13220 Murphy Rd, Suite 100 · Stafford, TX 77477
            </Text>
            <Text style={{ margin: "10px 0 0", fontFamily: SANS, fontSize: "12px", color: C.mute }}>
              <Link href="mailto:wholesale@hempmbs.com" style={{ color: C.ink, textDecoration: "underline", fontWeight: 600 }}>wholesale@hempmbs.com</Link>
              {" · "}
              <Link href={trackedUrl("/", input.campaignId)} style={{ color: C.ink, textDecoration: "underline", fontWeight: 600 }}>hempmbs.com</Link>
            </Text>
            <Text style={{ margin: "12px 0 0", fontFamily: SANS, fontSize: "11px", color: C.mute, fontStyle: "italic", lineHeight: "1.5" }}>
              Hemp-derived · 2018 Farm Bill compliant · For licensed retailers only
            </Text>
          </Section>
        </Container>
        <Container style={{ maxWidth: "600px", width: "100%" }}>
          <Text style={{ margin: "12px auto 0", fontFamily: SANS, fontSize: "11px", color: C.mute, textAlign: "center", lineHeight: "1.6" }}>
            You&rsquo;re getting this because you have a Mind Body Spirit wholesale account.{" "}
            <Link href={input.unsubscribeUrl ?? "#"} style={{ color: C.mute, textDecoration: "underline" }}>Unsubscribe</Link>
            {" "}from product emails. Order and account emails still arrive.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderMarketingEmail(input: RenderInput): Promise<{ html: string; text: string }> {
  const el = <MarketingEmail {...input} />
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })])
  return { html, text }
}
