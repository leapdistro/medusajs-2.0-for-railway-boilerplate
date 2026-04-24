import {
  Html,
  Body,
  Container,
  Preview,
  Tailwind,
  Head,
  Section,
  Text,
  Hr,
  Img,
  Link,
} from '@react-email/components'
import * as React from 'react'

interface BaseProps {
  preview?: string
  children: React.ReactNode
}

/**
 * MBS-branded email shell. All transactional templates wrap their content
 * here so wordmark / colors / typography stay consistent.
 *
 * Logo URL is the storefront's hosted PNG (Outlook 2019+ doesn't render
 * SVG reliably). Width auto-scales from the 2x source so the rendered
 * 56px-tall display stays crisp on retina.
 *
 * Email-client constraints we work within:
 *   - Inline-friendly styles only (Tailwind plugin handles inlining).
 *   - Web-safe fonts only (no @font-face / Google Fonts).
 *   - Tables / Sections instead of flex for layout.
 *   - No rounded corners — matches the brand's sharp-edge rule.
 */
const LOGO_URL = `${process.env.STOREFRONT_URL || 'https://mbs-storefront-blue.vercel.app'}/logos/mbsblack.png`
const STOREFRONT_BASE = process.env.STOREFRONT_URL || 'https://mbs-storefront-blue.vercel.app'

export const Base: React.FC<BaseProps> = ({ preview, children }) => {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body
          className="my-auto mx-auto"
          style={{
            backgroundColor: '#F3F1EA', /* --mbs-paper */
            fontFamily: 'Helvetica, Arial, sans-serif',
            margin: 0,
            padding: '24px 12px',
          }}
        >
          <Container
            className="mx-auto max-w-[560px] w-full overflow-hidden"
            style={{
              backgroundColor: '#FAFAF7', /* --mbs-white */
              border: '1px solid #C9C3B2', /* --mbs-line-strong */
              borderRadius: 0,
            }}
          >
            {/* Header: centered logo with red accent bar below. */}
            <Section
              style={{
                padding: '36px 24px 24px',
                textAlign: 'center',
                backgroundColor: '#FAFAF7',
              }}
            >
              <Img
                src={LOGO_URL}
                alt="Mind Body Spirit"
                height="56"
                style={{ display: 'block', margin: '0 auto', height: '56px', width: 'auto' }}
              />
              <Text
                style={{
                  margin: '12px 0 0',
                  fontFamily: 'Helvetica, Arial, sans-serif',
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.32em',
                  color: '#4A4A45', /* --mbs-mute */
                  textTransform: 'uppercase',
                }}
              >
                Premium Cannabis · Wholesale
              </Text>
            </Section>

            {/* Red accent bar — full width, separates header from content. */}
            <div style={{ height: '4px', backgroundColor: '#D93737' }} />

            {/* Content area — templates render here. */}
            <Section style={{ padding: '32px 32px 24px' }}>
              <div className="max-w-full break-words">
                {children}
              </div>
            </Section>

            {/* Brand footer band — DBA address (KAJA-required) + contact + compliance. */}
            <div style={{ height: '1px', backgroundColor: '#E5E1D6' }} />
            <Section
              style={{
                padding: '20px 32px 28px',
                backgroundColor: '#F3F1EA', /* paper background for visual separation */
                textAlign: 'center',
              }}
            >
              <Text
                style={{
                  margin: 0,
                  fontFamily: 'Helvetica, Arial, sans-serif',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  color: '#1A1A1A', /* --mbs-ink */
                  textTransform: 'uppercase',
                }}
              >
                Mind Body Spirit
              </Text>
              <Text
                style={{
                  margin: '6px 0 0',
                  fontFamily: 'Helvetica, Arial, sans-serif',
                  fontSize: '11px',
                  color: '#4A4A45',
                  lineHeight: '1.5',
                }}
              >
                13220 Murphy Rd, Suite 100 · Stafford, TX 77477
              </Text>
              <Text
                style={{
                  margin: '12px 0 0',
                  fontFamily: 'Helvetica, Arial, sans-serif',
                  fontSize: '11px',
                  color: '#4A4A45',
                }}
              >
                <Link
                  href={`mailto:wholesale@hempmbs.com`}
                  style={{ color: '#D93737', textDecoration: 'none', fontWeight: 600 }}
                >
                  wholesale@hempmbs.com
                </Link>
                {' · '}
                <Link
                  href={STOREFRONT_BASE}
                  style={{ color: '#D93737', textDecoration: 'none', fontWeight: 600 }}
                >
                  hempmbs.com
                </Link>
              </Text>
              <Text
                style={{
                  margin: '14px 0 0',
                  fontFamily: 'Helvetica, Arial, sans-serif',
                  fontSize: '10px',
                  color: '#4A4A45',
                  fontStyle: 'italic',
                  lineHeight: '1.5',
                }}
              >
                Hemp-derived · 2018 Farm Bill compliant · For licensed retailers only
              </Text>
            </Section>
          </Container>

          {/* Outer caption below the card — tiny "Why am I getting this?" line. */}
          <Container className="mx-auto max-w-[560px] w-full">
            <Text
              style={{
                margin: '12px auto 0',
                fontFamily: 'Helvetica, Arial, sans-serif',
                fontSize: '10px',
                color: '#4A4A45',
                textAlign: 'center',
                lineHeight: '1.5',
              }}
            >
              You&rsquo;re receiving this transactional email because you applied for or hold a Mind Body Spirit wholesale account.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

/* ───────────────────── Reusable atoms used by templates ────────────────── */

/** Big headline — used as the first element of each template body. */
export const Headline: React.FC<{ children: React.ReactNode; accent?: string }> = ({ children, accent }) => (
  <Text
    style={{
      margin: '0 0 16px',
      fontFamily: 'Helvetica, Arial, sans-serif',
      fontSize: '28px',
      fontWeight: 900,
      lineHeight: '1.15',
      letterSpacing: '0.005em',
      color: '#0A0A0A',
    }}
  >
    {children}
    {accent && <span style={{ color: '#D93737' }}> {accent}</span>}
  </Text>
)

/** Paragraph styled for body copy — generous line-height, ink color. */
export const P: React.FC<{ children: React.ReactNode; muted?: boolean }> = ({ children, muted }) => (
  <Text
    style={{
      margin: '0 0 14px',
      fontFamily: 'Helvetica, Arial, sans-serif',
      fontSize: '15px',
      lineHeight: '1.6',
      color: muted ? '#4A4A45' : '#1A1A1A',
    }}
  >
    {children}
  </Text>
)

/** Primary CTA button — black fill, red top/bottom bars (matches site .btn-primary). */
export const PrimaryButton: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ width: '100%', margin: '8px 0 16px' }}>
    <tbody>
      <tr>
        <td align="center">
          <a
            href={href}
            style={{
              display: 'inline-block',
              backgroundColor: '#0A0A0A',
              color: '#FAFAF7',
              fontFamily: 'Helvetica, Arial, sans-serif',
              fontSize: '14px',
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '16px 36px',
              borderTop: '3px solid #D93737',
              borderBottom: '3px solid #D93737',
              textDecoration: 'none',
              borderRadius: 0,
            }}
          >
            {children}
          </a>
        </td>
      </tr>
    </tbody>
  </table>
)
