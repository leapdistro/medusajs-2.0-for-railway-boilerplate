import { Hr, Text } from '@react-email/components'
import { Base, Headline, P } from './base'

/** Template key — referenced by the /store/mbs/contact route. */
export const CONTACT_TEAM = 'contact-team'

export interface ContactTeamProps {
  subject: string
  name: string
  email: string
  phone?: string | null
  company?: string | null
  message: string
  preview?: string
}

export const isContactTeamData = (data: any): data is ContactTeamProps =>
  typeof data?.subject === 'string' &&
  typeof data?.name === 'string' &&
  typeof data?.email === 'string' &&
  typeof data?.message === 'string'

/** Team-side alert for a /contact form submission. Sender's email
 *  goes into Reply-To at the caller so a single click in Gmail / Outlook
 *  drafts a reply to the actual sender, not the team mailbox. */
export const ContactTeamEmail = ({
  subject,
  name,
  email,
  phone,
  company,
  message,
  preview,
}: ContactTeamProps) => {
  const previewLine = preview ?? `${subject} — ${name} (${email})`
  return (
    <Base preview={previewLine}>
      <Headline>Contact form: <span style={{ color: '#D93737' }}>{subject}.</span></Headline>

      <P><strong>From:</strong> {name}</P>
      <P><strong>Email:</strong> {email}</P>
      {phone ? <P><strong>Phone:</strong> {phone}</P> : null}
      {company ? <P><strong>Company:</strong> {company}</P> : null}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <Text
        style={{
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: '11px',
          color: '#4A4A45',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
          margin: '0 0 6px',
        }}
      >
        Message
      </Text>
      <Text
        style={{
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: '14px',
          lineHeight: 1.5,
          color: '#1A1A1A',
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {message}
      </Text>

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '28px 0 16px' }} />

      <P muted>Reply directly to this email — it goes to the sender.</P>
    </Base>
  )
}

ContactTeamEmail.PreviewProps = {
  subject: 'Wholesale inquiry',
  name: 'Jordan Lee',
  email: 'jordan@greenline.example',
  phone: '+1 (832) 555-0123',
  company: 'Greenline Provisions',
  message: 'Hey — interested in starting wholesale orders for our two Houston stores. Can you send pricing sheets?',
} as ContactTeamProps

export default ContactTeamEmail
