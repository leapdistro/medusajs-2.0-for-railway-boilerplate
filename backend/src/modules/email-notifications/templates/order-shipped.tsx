import { Hr, Link, Text } from '@react-email/components'
import { Base, Headline, P, PrimaryButton } from './base'
import { AddressBlock, KvLine, OrderEmailAddress, SubHead } from './order-received'

export const ORDER_SHIPPED = 'order-shipped'

export type OrderShippedProps = {
  displayId: string
  contactName: string
  /** Carrier label — operator-typed at ship time. e.g. "UPS", "FedEx", "USPS". */
  carrier: string
  trackingNumber: string
  /** Optional pre-built tracking URL (operator paste, or carrier-specific). */
  trackingUrl?: string | null
  estimatedDelivery?: string | null
  shippingAddress: OrderEmailAddress
  operatorNote?: string | null
  contactEmail: string
  contactPhone?: string
  preview?: string
}

export const isOrderShippedData = (d: any): d is OrderShippedProps =>
  typeof d?.displayId === 'string' &&
  typeof d?.contactName === 'string' &&
  typeof d?.carrier === 'string' &&
  typeof d?.trackingNumber === 'string'

export const OrderShippedTemplate = (p: OrderShippedProps) => {
  const firstName = p.contactName.split(' ')[0] || p.contactName
  return (
    <Base preview={p.preview ?? `Order #${p.displayId} shipped via ${p.carrier} — ${p.trackingNumber}`}>
      <Headline>Order <span style={{ color: '#D93737' }}>shipped.</span></Headline>
      <P>Hi {firstName} — your Order #{p.displayId} is on its way.</P>

      <KvLine label="Carrier"   value={p.carrier} />
      <KvLine label="Tracking"  value={p.trackingNumber} />
      {p.estimatedDelivery && <KvLine label="ETA" value={p.estimatedDelivery} />}

      {p.trackingUrl && (
        <PrimaryButton href={p.trackingUrl}>Track Your Shipment</PrimaryButton>
      )}

      {p.operatorNote && p.operatorNote.trim().length > 0 && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <P><em>From our team:</em></P>
          <P>{p.operatorNote}</P>
        </>
      )}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <SubHead>Shipping to</SubHead>
      <AddressBlock a={p.shippingAddress} />

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '24px 0' }} />
      <P muted>
        Questions or didn&rsquo;t get what you expected? Reach out at <strong>{p.contactEmail}</strong>{p.contactPhone ? <> · {p.contactPhone}</> : null}.
      </P>
    </Base>
  )
}

OrderShippedTemplate.PreviewProps = {
  displayId: '12',
  contactName: 'Jordan Lee',
  carrier: 'UPS',
  trackingNumber: '1Z999AA10123456784',
  trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  estimatedDelivery: 'Tue, May 5',
  shippingAddress: { first_name: 'Jordan', last_name: 'Lee', address_1: '123 Main St', city: 'Austin', province: 'TX', postal_code: '78701', country_code: 'us' },
  operatorNote: 'Two boxes — 2 of 2 ships tomorrow.',
  contactEmail: 'wholesale@hempmbs.com',
  contactPhone: '(555) 123-4567',
} as OrderShippedProps

export default OrderShippedTemplate
