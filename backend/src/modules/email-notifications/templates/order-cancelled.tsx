import { Hr, Text } from '@react-email/components'
import { Base, Headline, P } from './base'
import { KvLine } from './order-received'

export const ORDER_CANCELLED = 'order-cancelled'

export type OrderCancelledProps = {
  displayId: string
  contactName: string
  /** Resolved from mbs-settings.cancellation_reasons by id at send time. */
  reasonLabel: string
  operatorNote?: string | null
  /** True when payment had been received and was refunded. */
  refunded?: boolean
  refundAmountFormatted?: string | null
  contactEmail: string
  contactPhone?: string
  preview?: string
}

export const isOrderCancelledData = (d: any): d is OrderCancelledProps =>
  typeof d?.displayId === 'string' &&
  typeof d?.contactName === 'string' &&
  typeof d?.reasonLabel === 'string'

export const OrderCancelledTemplate = (p: OrderCancelledProps) => {
  const firstName = p.contactName.split(' ')[0] || p.contactName
  return (
    <Base preview={p.preview ?? `Order #${p.displayId} cancelled`}>
      <Headline>Order <span style={{ color: '#D93737' }}>cancelled.</span></Headline>
      <P>Hi {firstName} — Order #{p.displayId} has been cancelled.</P>

      <KvLine label="Reason" value={p.reasonLabel} />
      {p.refunded && p.refundAmountFormatted && (
        <KvLine label="Refund" value={`${p.refundAmountFormatted} — refunded to your original payment method`} />
      )}
      {!p.refunded && (
        <P muted>No payment had been received yet, so there&rsquo;s nothing to refund.</P>
      )}

      {p.operatorNote && p.operatorNote.trim().length > 0 && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <P><em>From our team:</em></P>
          <P>{p.operatorNote}</P>
        </>
      )}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '24px 0' }} />
      <P muted>
        Want help re-ordering or have questions about this cancellation? Reach out at <strong>{p.contactEmail}</strong>{p.contactPhone ? <> · {p.contactPhone}</> : null}.
      </P>
    </Base>
  )
}

OrderCancelledTemplate.PreviewProps = {
  displayId: '12',
  contactName: 'Jordan Lee',
  reasonLabel: 'Out of stock',
  operatorNote: 'Sorry — that strain unexpectedly sold out before we could ship. Would you like a substitution?',
  refunded: false,
  contactEmail: 'wholesale@hempmbs.com',
  contactPhone: '(555) 123-4567',
} as OrderCancelledProps

export default OrderCancelledTemplate
