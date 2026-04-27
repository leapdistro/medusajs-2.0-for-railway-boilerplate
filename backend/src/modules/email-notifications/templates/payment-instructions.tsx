import { Hr, Text } from '@react-email/components'
import { Base, Headline, P } from './base'
import { KvLine, SubHead } from './order-received'

export const PAYMENT_INSTRUCTIONS = 'payment-instructions'

export type PaymentInstructionsProps = {
  displayId: string
  contactName: string
  amountDueFormatted: string
  /** Resolved from mbs-settings.payment_info at send time. */
  payment: {
    dba: string
    mailing_address: string
    bank: {
      bank_name?: string
      beneficiary_name?: string
      routing_number?: string
      account_number?: string
      swift_code?: string
      account_type?: string
    }
    net_terms_default?: string
    memo_instruction?: string
  }
  /** From mbs-settings.contact_info — for footer / "questions?" line. */
  contactEmail: string
  contactPhone?: string
  preview?: string
}

export const isPaymentInstructionsData = (d: any): d is PaymentInstructionsProps =>
  typeof d?.displayId === 'string' &&
  typeof d?.contactName === 'string' &&
  typeof d?.amountDueFormatted === 'string' &&
  typeof d?.payment === 'object' &&
  typeof d?.contactEmail === 'string'

export const PaymentInstructionsTemplate = (p: PaymentInstructionsProps) => {
  const firstName = p.contactName.split(' ')[0] || p.contactName
  const bank = p.payment.bank ?? {}
  const hasBank = !!(bank.bank_name || bank.routing_number || bank.account_number)
  return (
    <Base preview={p.preview ?? `Payment instructions for Order #${p.displayId} — ${p.amountDueFormatted} due`}>
      <Headline>Payment <span style={{ color: '#D93737' }}>instructions.</span></Headline>
      <P>Hi {firstName} — here&rsquo;s how to send payment for Order #{p.displayId}. Once received, we&rsquo;ll cut your shipping label and email tracking.</P>

      <KvLine label="Order"       value={`#${p.displayId}`} />
      <KvLine label="Amount due"  value={p.amountDueFormatted} />

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <SubHead>Pay by check</SubHead>
      <P>
        Make payable to: <strong>{p.payment.dba}</strong><br />
        Mail to: <strong>{p.payment.mailing_address}</strong>
      </P>
      {p.payment.memo_instruction && <P muted>{p.payment.memo_instruction}</P>}

      {hasBank && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <SubHead>Pay by wire / ACH</SubHead>
          {bank.bank_name        && <KvLine label="Bank"        value={bank.bank_name} />}
          {bank.beneficiary_name && <KvLine label="Beneficiary" value={bank.beneficiary_name} />}
          {bank.routing_number   && <KvLine label="Routing / ABA" value={bank.routing_number} />}
          {bank.account_number   && <KvLine label="Account #"   value={bank.account_number} />}
          {bank.account_type     && <KvLine label="Account type" value={bank.account_type} />}
          {bank.swift_code       && <KvLine label="SWIFT (intl)" value={bank.swift_code} />}
        </>
      )}

      {p.payment.net_terms_default && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <SubHead>Net Terms</SubHead>
          <P>{p.payment.net_terms_default}</P>
        </>
      )}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '24px 0' }} />
      <P muted>
        Questions? Reach out at <strong>{p.contactEmail}</strong>{p.contactPhone ? <> · {p.contactPhone}</> : null}.
      </P>
    </Base>
  )
}

PaymentInstructionsTemplate.PreviewProps = {
  displayId: '12',
  contactName: 'Jordan Lee',
  amountDueFormatted: '$675.00',
  payment: {
    dba: 'MBS LLC',
    mailing_address: '13220 Murphy Rd, Suite 100, Stafford, TX 77477',
    bank: { bank_name: 'JPMorgan Chase', beneficiary_name: 'MBS LLC', routing_number: '021000021', account_number: '****6789', account_type: 'checking', swift_code: 'CHASUS33' },
    net_terms_default: 'Net 30 — invoice attached. Pay via check, wire, or ACH by the due date.',
    memo_instruction: "Include 'Order #12' on the memo line.",
  },
  contactEmail: 'wholesale@hempmbs.com',
  contactPhone: '(555) 123-4567',
} as PaymentInstructionsProps

export default PaymentInstructionsTemplate
