import { Hr } from '@react-email/components'
import { Base, Headline, P } from './base'

/** Template key — referenced by the deny-application admin route. */
export const APPLICATION_DENIED = 'application-denied'

export interface ApplicationDeniedProps {
  /** Applicant's full name as captured at application time. */
  contactName: string
  /** Business name from the application form. */
  businessName?: string
  /** Human-readable label of the denial reason (resolved from
   *  mbs-settings.denial_reasons by id at send time, NOT the id itself). */
  reasonLabel: string
  /** Optional operator-typed note shown verbatim under the reason. */
  operatorNote?: string
  /** Resolved from mbs-settings.contact_info at send time. */
  contactEmail: string
  /** Optional — resolved from mbs-settings.contact_info if present. */
  contactPhone?: string
  preview?: string
}

export const isApplicationDeniedData = (data: any): data is ApplicationDeniedProps =>
  typeof data?.contactName === 'string' &&
  typeof data?.reasonLabel === 'string' &&
  typeof data?.contactEmail === 'string'

/** Sent when an operator denies a wholesale application from the admin
 *  customer detail page. Reason + optional operator note both come from
 *  the deny-application action; contact info comes from mbs-settings. */
export const ApplicationDeniedEmail = ({
  contactName,
  businessName,
  reasonLabel,
  operatorNote,
  contactEmail,
  contactPhone,
  preview = 'About your wholesale application.',
}: ApplicationDeniedProps) => {
  const firstName = contactName.split(' ')[0] || contactName
  return (
    <Base preview={preview}>
      <Headline>About your <span style={{ color: '#D93737' }}>application.</span></Headline>
      <P>
        Hi {firstName} — thank you for applying for a Mind Body Spirit
        wholesale account{businessName ? <> on behalf of <strong>{businessName}</strong></> : null}.
      </P>
      <P>
        After review, we&rsquo;re unable to approve your application at this
        time. Reason: <strong>{reasonLabel}</strong>.
      </P>

      {operatorNote && operatorNote.trim().length > 0 && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <P>
            <em>From our team:</em>
          </P>
          <P>{operatorNote}</P>
        </>
      )}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '24px 0' }} />

      <P muted>
        Questions, or want to re-apply once the issue is addressed? Reach out
        at <strong>{contactEmail}</strong>{contactPhone ? <> · {contactPhone}</> : null} and
        we&rsquo;ll point you in the right direction.
      </P>
      <P muted>— The Mind Body Spirit team</P>
    </Base>
  )
}

ApplicationDeniedEmail.PreviewProps = {
  contactName: 'Jordan Lee',
  businessName: 'Greenline Provisions',
  reasonLabel: 'Missing or expired license',
  operatorNote: 'Please re-apply once your DEA license renewal is complete.',
  contactEmail: 'wholesale@hempmbs.com',
  contactPhone: '(555) 123-4567',
} as ApplicationDeniedProps

export default ApplicationDeniedEmail
