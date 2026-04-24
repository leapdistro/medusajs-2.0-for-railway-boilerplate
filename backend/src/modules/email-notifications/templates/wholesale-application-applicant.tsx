import { Hr } from '@react-email/components'
import { Base, Headline, P } from './base'

/** Template key — referenced by the /api/store/mbs/applications route. */
export const WHOLESALE_APPLICATION_APPLICANT = 'wholesale-application-applicant'

export interface WholesaleApplicationApplicantProps {
  contactName: string
  businessName: string
  preview?: string
}

export const isWholesaleApplicationApplicantData = (data: any): data is WholesaleApplicationApplicantProps =>
  typeof data?.contactName === 'string' && typeof data?.businessName === 'string'

/** Confirmation email sent to the applicant immediately after submitting
 *  the wholesale application form. */
export const WholesaleApplicationApplicantEmail = ({
  contactName,
  businessName,
  preview = 'We received your wholesale application — review takes about one business day.',
}: WholesaleApplicationApplicantProps) => {
  const firstName = contactName.split(' ')[0] || contactName
  return (
    <Base preview={preview}>
      <Headline>Application <span style={{ color: '#D93737' }}>received.</span></Headline>
      <P>
        Hi {firstName} — thanks for applying for a Mind Body Spirit wholesale
        account on behalf of <strong>{businessName}</strong>. Your application
        and uploaded documents are in.
      </P>
      <P>
        Our team reviews new accounts within{' '}
        <strong style={{ color: '#D93737' }}>one business day</strong>. Once
        approved, you&rsquo;ll get a welcome email with a link to set your
        password and start ordering at wholesale pricing.
      </P>

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '24px 0' }} />

      <P muted>
        Questions in the meantime? Just reply to this email — it goes
        straight to our wholesale team.
      </P>
      <P muted>— The Mind Body Spirit team</P>
    </Base>
  )
}

WholesaleApplicationApplicantEmail.PreviewProps = {
  contactName: 'Jordan Lee',
  businessName: 'Greenline Provisions',
} as WholesaleApplicationApplicantProps

export default WholesaleApplicationApplicantEmail
