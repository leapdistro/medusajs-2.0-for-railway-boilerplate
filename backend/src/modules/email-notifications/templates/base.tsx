import { Html, Body, Container, Preview, Tailwind, Head, Section, Text, Hr } from '@react-email/components'
import * as React from 'react'

interface BaseProps {
  preview?: string
  children: React.ReactNode
}

/**
 * MBS-branded email shell. All transactional templates wrap their content
 * here so the wordmark / colors / typography stay consistent.
 *
 * Email-client constraints we work within:
 *   - Inline-friendly styles only (Tailwind plugin handles inlining).
 *   - Web-safe fonts only (Georgia for the brand wordmark since custom
 *     fonts don't reliably load in Gmail / Outlook).
 *   - Tables / Sections instead of flex for layout.
 *   - No rounded corners — matches the brand's sharp-edge rule.
 */
export const Base: React.FC<BaseProps> = ({ preview, children }) => {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body
          className="my-auto mx-auto font-sans"
          style={{ backgroundColor: '#F3F1EA' /* --mbs-paper */ }}
        >
          <Container
            className="my-[40px] mx-auto max-w-[520px] w-full overflow-hidden"
            style={{
              backgroundColor: '#FAFAF7', /* --mbs-white */
              border: '1px solid #C9C3B2', /* --mbs-line-strong */
              borderRadius: 0,
            }}
          >
            {/* Brand header band — wordmark + tagline + red accent bar. */}
            <Section
              style={{
                padding: '28px 24px 20px',
                borderBottom: '4px solid #D93737', /* --red accent bar */
                textAlign: 'center',
              }}
            >
              <Text
                style={{
                  margin: 0,
                  fontFamily: 'Georgia, "Times New Roman", serif',
                  fontSize: '24px',
                  fontWeight: 400,
                  letterSpacing: '0.01em',
                  color: '#0A0A0A', /* --mbs-black */
                  lineHeight: 1.1,
                }}
              >
                Mind Body Spirit
              </Text>
              <Text
                style={{
                  margin: '6px 0 0',
                  fontFamily: 'Arial, sans-serif',
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.3em',
                  color: '#4A4A45', /* --mbs-mute */
                  textTransform: 'uppercase',
                }}
              >
                Premium Cannabis · Wholesale
              </Text>
            </Section>

            {/* Content area — templates render here. */}
            <Section style={{ padding: '8px 24px 24px' }}>
              <div className="max-w-full break-words">
                {children}
              </div>
            </Section>

            {/* Brand footer — small print. */}
            <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '0 24px' }} />
            <Section style={{ padding: '16px 24px 24px', textAlign: 'center' }}>
              <Text
                style={{
                  margin: 0,
                  fontFamily: 'Arial, sans-serif',
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.18em',
                  color: '#4A4A45',
                  textTransform: 'uppercase',
                }}
              >
                hempmbs.com · wholesale@hempmbs.com
              </Text>
              <Text
                style={{
                  margin: '6px 0 0',
                  fontFamily: 'Arial, sans-serif',
                  fontSize: '10px',
                  color: '#4A4A45',
                  fontStyle: 'italic',
                }}
              >
                Hemp-derived · 2018 Farm Bill compliant · For licensed retailers
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}
