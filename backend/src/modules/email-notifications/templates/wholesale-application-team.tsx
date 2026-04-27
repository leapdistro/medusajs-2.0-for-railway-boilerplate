import { Hr, Link, Text } from '@react-email/components'
import { Base, Headline, P } from './base'

/** Template key — referenced by the /api/store/mbs/applications route. */
export const WHOLESALE_APPLICATION_TEAM = 'wholesale-application-team'

export interface WholesaleApplicationTeamProps {
  businessName: string
  contactName: string
  email: string
  phone?: string | null
  address: string
  ein: string
  license: string
  website?: string | null
  volume?: string | null
  heard?: string | null
  message?: string | null
  einDocUrl?: string | null
  licenseDocUrl?: string | null
  customerId?: string | null
  /** True when this is a re-application from a previously-denied applicant.
   *  Changes the headline + adds a banner so the operator notices. */
  isReapplication?: boolean
  /** Label of the previous denial reason (resolved at send time from
   *  customer.metadata.denial_reason_label). Only used when isReapplication. */
  previousDenialReason?: string | null
  preview?: string
}

export const isWholesaleApplicationTeamData = (data: any): data is WholesaleApplicationTeamProps =>
  typeof data?.businessName === 'string' && typeof data?.email === 'string'

/** Internal alert sent to wholesale@hempmbs.com when a new application
 *  arrives. Dense + scannable — every field labeled. Links open the
 *  uploaded EIN/license PDFs and (if Medusa created a customer) jump to
 *  the admin profile. */
export const WholesaleApplicationTeamEmail = ({
  businessName,
  contactName,
  email,
  phone,
  address,
  ein,
  license,
  website,
  volume,
  heard,
  message,
  einDocUrl,
  licenseDocUrl,
  customerId,
  isReapplication,
  previousDenialReason,
  preview,
}: WholesaleApplicationTeamProps) => {
  const adminBase = process.env.MEDUSA_ADMIN_URL || process.env.STOREFRONT_URL || ''
  const customerLink = customerId && adminBase
    ? `${adminBase.replace(/\/$/, '')}/app/customers/${customerId}`
    : null
  const previewLine = preview ?? (
    isReapplication
      ? `Re-application from ${businessName} (${contactName})`
      : `New application from ${businessName} (${contactName})`
  )
  return (
    <Base preview={previewLine}>
      <Headline>
        {isReapplication ? <>Re-<span style={{ color: '#D93737' }}>application.</span></> : <>New <span style={{ color: '#D93737' }}>application.</span></>}
      </Headline>
      <P muted>
        Review within one business day per the SLA we promise applicants.
      </P>

      {isReapplication && (
        <div style={{
          background: '#FFF7E6',
          border: '1px solid #C98A00',
          padding: '12px 14px',
          margin: '12px 0 0',
        }}>
          <Text style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', lineHeight: 1.5, color: '#0A0A0A' }}>
            <strong>This applicant was previously denied.</strong>{previousDenialReason ? <> Reason: <em>{previousDenialReason}</em>.</> : null} Review whether the issue is now addressed before approving.
          </Text>
        </div>
      )}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <FieldRow label="Business" value={businessName} />
      <FieldRow label="Contact"  value={contactName} />
      <FieldRow label="Email"    value={email} />
      {phone   && <FieldRow label="Phone"   value={phone} />}
      {website && <FieldRow label="Website" value={website} />}
      <FieldRow label="Address"  value={address} />
      <FieldRow label="EIN"      value={ein} />
      <FieldRow label="License"  value={license} />
      {volume  && <FieldRow label="Est. monthly volume" value={volume} />}
      {heard   && <FieldRow label="Heard via"           value={heard} />}
      {message && <FieldRow label="Message"             value={message} />}

      {(einDocUrl || licenseDocUrl) && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <Text
            style={{
              margin: 0,
              fontFamily: 'Helvetica, Arial, sans-serif',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: '#0A0A0A',
            }}
          >
            Uploaded Documents
          </Text>
          {einDocUrl && (
            <Text style={{ margin: '8px 0 0', fontSize: '13px', fontFamily: 'Helvetica, Arial, sans-serif' }}>
              EIN: <Link href={einDocUrl} style={{ color: '#D93737', fontWeight: 600 }}>Open</Link>
            </Text>
          )}
          {licenseDocUrl && (
            <Text style={{ margin: '6px 0 0', fontSize: '13px', fontFamily: 'Helvetica, Arial, sans-serif' }}>
              License: <Link href={licenseDocUrl} style={{ color: '#D93737', fontWeight: 600 }}>Open</Link>
            </Text>
          )}
        </>
      )}

      {customerLink && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <Text
            style={{
              margin: 0,
              fontSize: '14px',
              fontFamily: 'Helvetica, Arial, sans-serif',
              fontWeight: 700,
            }}
          >
            <Link href={customerLink} style={{ color: '#0A0A0A' }}>
              Open in Medusa admin →
            </Link>
          </Text>
          <Text
            style={{
              margin: '8px 0 0',
              fontSize: '11px',
              color: '#4A4A45',
              fontFamily: 'Helvetica, Arial, sans-serif',
              lineHeight: '1.5',
            }}
          >
            To approve: click <strong>Approve &amp; Send Welcome</strong> on the
            customer detail page. The applicant gets a welcome + password
            setup email automatically.
          </Text>
        </>
      )}
    </Base>
  )
}

const FieldRow = ({ label, value }: { label: string; value: string }) => (
  <Text
    style={{
      margin: '0 0 8px',
      fontFamily: 'Helvetica, Arial, sans-serif',
      fontSize: '13px',
      lineHeight: '1.5',
    }}
  >
    <span
      style={{
        display: 'inline-block',
        width: '110px',
        color: '#4A4A45',
        fontWeight: 600,
        fontSize: '11px',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
    <span style={{ color: '#0A0A0A' }}>{value}</span>
  </Text>
)

WholesaleApplicationTeamEmail.PreviewProps = {
  businessName: 'Greenline Provisions',
  contactName:  'Jordan Lee',
  email:        'jordan@greenline.example',
  phone:        '+1 555 555 5555',
  address:      '123 Main St, Austin, TX 78701',
  ein:          '12-3456789',
  license:      'TX-RC-998877',
  website:      'https://greenline.example',
  volume:       '5-10k',
  heard:        'referral',
  message:      'Looking to add MBS flower to a 2-store chain.',
  einDocUrl:    'https://example.com/uploads/ein.pdf',
  licenseDocUrl:'https://example.com/uploads/license.pdf',
  customerId:   'cus_01ABCDEF',
} as WholesaleApplicationTeamProps

export default WholesaleApplicationTeamEmail
