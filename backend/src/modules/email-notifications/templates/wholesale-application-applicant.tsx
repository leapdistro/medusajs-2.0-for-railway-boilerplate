import { Hr, Section, Text } from '@react-email/components'
import { Base } from './base'

/** Template key — referenced by the /api/store/mbs/applications route. */
export const WHOLESALE_APPLICATION_APPLICANT = 'wholesale-application-applicant'

export interface WholesaleApplicationApplicantProps {
  contactName: string
  businessName: string
  preview?: string
}

export const isWholesaleApplicationApplicantData = (data: any): data is WholesaleApplicationApplicantProps =>
  typeof data?.contactName === 'string' && typeof data?.businessName === 'string'

/**
 * Confirmation email sent to the applicant immediately after submitting
 * the wholesale application form. Friendly + sets expectation of a
 * one-business-day turnaround. Replies route to wholesale@hempmbs.com.
 */
export const WholesaleApplicationApplicantEmail = ({
  contactName,
  businessName,
  preview = 'We received your wholesale application — review takes about one business day.',
}: WholesaleApplicationApplicantProps) => {
  return (
    <Base preview={preview}>
      <Section className="mt-[16px]">
        <Text className="text-black text-[20px] leading-[28px] font-bold m-0">
          Hi {contactName.split(' ')[0] || contactName},
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[16px]">
          Thanks for applying for a Mind Body Spirit wholesale account on
          behalf of <strong>{businessName}</strong>. We received your application
          and uploaded documents.
        </Text>
        <Text className="text-black text-[14px] leading-[22px]">
          Our team reviews new applications within{' '}
          <strong>one business day</strong>. Once approved, you&rsquo;ll get a
          welcome email with a link to set your password and start ordering at
          wholesale pricing.
        </Text>
        <Hr className="border border-solid border-[#eaeaea] my-[24px] mx-0 w-full" />
        <Text className="text-[#666666] text-[12px] leading-[20px] m-0">
          Questions in the meantime? Just reply to this email — it goes
          straight to our wholesale team.
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[20px] mt-[8px]">
          — The Mind Body Spirit team
        </Text>
      </Section>
    </Base>
  )
}

WholesaleApplicationApplicantEmail.PreviewProps = {
  contactName: 'Jordan Lee',
  businessName: 'Greenline Provisions',
} as WholesaleApplicationApplicantProps

export default WholesaleApplicationApplicantEmail
