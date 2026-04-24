import { Hr, Link, Section, Text } from '@react-email/components'
import { Base } from './base'

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
  preview,
}: WholesaleApplicationTeamProps) => {
  const adminBase = process.env.MEDUSA_ADMIN_URL || process.env.STOREFRONT_URL || ''
  const customerLink = customerId && adminBase
    ? `${adminBase.replace(/\/$/, '')}/app/customers/${customerId}`
    : null
  const previewLine = preview ?? `New application from ${businessName} (${contactName})`
  return (
    <Base preview={previewLine}>
      <Section className="mt-[16px]">
        <Text className="text-black text-[18px] leading-[26px] font-bold m-0">
          New wholesale application
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[18px] mt-[4px]">
          Review within one business day per the SLA we promise applicants.
        </Text>

        <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />

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
            <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />
            <Text className="text-black text-[13px] leading-[20px] font-bold m-0">Uploaded documents</Text>
            {einDocUrl && (
              <Text className="text-[13px] leading-[20px] m-0 mt-[6px]">
                EIN: <Link href={einDocUrl} className="text-blue-600">Open</Link>
              </Text>
            )}
            {licenseDocUrl && (
              <Text className="text-[13px] leading-[20px] m-0 mt-[6px]">
                License: <Link href={licenseDocUrl} className="text-blue-600">Open</Link>
              </Text>
            )}
          </>
        )}

        {customerLink && (
          <>
            <Hr className="border border-solid border-[#eaeaea] my-[20px] mx-0 w-full" />
            <Text className="text-[13px] leading-[20px] m-0">
              <Link href={customerLink} className="text-blue-600 font-bold">
                Open in Medusa admin →
              </Link>
            </Text>
            <Text className="text-[#666666] text-[11px] leading-[16px] mt-[8px]">
              To approve: change customer group to <strong>Approved</strong>.
              The applicant gets a welcome + password setup email automatically.
            </Text>
          </>
        )}
      </Section>
    </Base>
  )
}

const FieldRow = ({ label, value }: { label: string; value: string }) => (
  <Text className="text-[13px] leading-[20px] m-0 mt-[6px]">
    <span className="text-[#666666]">{label}: </span>
    <span className="text-black">{value}</span>
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
