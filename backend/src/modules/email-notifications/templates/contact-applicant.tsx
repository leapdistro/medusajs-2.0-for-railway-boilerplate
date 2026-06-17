import { Hr } from '@react-email/components'
import { Base, Headline, P } from './base'

/** Template key — referenced by the /store/mbs/contact route. */
export const CONTACT_APPLICANT = 'contact-applicant'

export interface ContactApplicantProps {
  name: string
  subject: string
  preview?: string
}

export const isContactApplicantData = (data: any): data is ContactApplicantProps =>
  typeof data?.name === 'string' && typeof data?.subject === 'string'

/** Auto-reply sent to the contact-form sender immediately on submit.
 *  Generic confirmation — actual response comes from the team mailbox. */
export const ContactApplicantEmail = ({
  name,
  subject,
  preview = 'We got your message — we\u2019ll reply within one business day.',
}: ContactApplicantProps) => {
  const firstName = name.split(' ')[0] || name
  return (
    <Base preview={preview}>
      <Headline>Got your <span style={{ color: '#D93737' }}>message.</span></Headline>
      <P>
        Hi {firstName} — thanks for reaching out to Mind Body Spirit about{' '}
        <strong>{subject.toLowerCase()}</strong>. Your message is in.
      </P>
      <P>
        Our team replies within{' '}
        <strong style={{ color: '#D93737' }}>one business day</strong> Mon–Fri.
        Weekend messages get a response by end of day Monday.
      </P>

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '24px 0' }} />

      <P muted>
        Need a faster answer? Reply to this email or call 1-888-618-0533
        (Mon–Fri 9am–6pm CT).
      </P>
      <P muted>— The Mind Body Spirit team</P>
    </Base>
  )
}

ContactApplicantEmail.PreviewProps = {
  name: 'Jordan Lee',
  subject: 'Wholesale inquiry',
} as ContactApplicantProps

export default ContactApplicantEmail
