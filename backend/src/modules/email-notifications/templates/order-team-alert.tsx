import { Hr, Link, Text } from '@react-email/components'
import { Base, Headline, P } from './base'
import { OrderEmailAddress, OrderEmailLine, AddressBlock, KvLine, MoneyRow, SubHead } from './order-received'

export const ORDER_TEAM_ALERT = 'order-team-alert'

export type OrderTeamAlertProps = {
  displayId: string
  orderId: string
  customerEmail: string
  contactName: string
  businessName?: string | null
  items: OrderEmailLine[]
  itemsTotalFormatted: string
  shippingTotalFormatted: string
  taxTotalFormatted: string
  grandTotalFormatted: string
  shippingAddress: OrderEmailAddress
  billingAddress: OrderEmailAddress
  shippingMethodName: string
  paymentLabel: string
  preview?: string
}

export const isOrderTeamAlertData = (d: any): d is OrderTeamAlertProps =>
  typeof d?.displayId === 'string' && typeof d?.orderId === 'string' && Array.isArray(d?.items)

/** Internal alert sent to wholesale@ when an order is placed. Dense + scannable. */
export const OrderTeamAlertTemplate = (p: OrderTeamAlertProps) => {
  const adminBase = process.env.MEDUSA_ADMIN_URL || process.env.STOREFRONT_URL || ''
  const orderLink = adminBase ? `${adminBase.replace(/\/$/, '')}/app/orders/${p.orderId}` : null
  return (
    <Base preview={p.preview ?? `New order #${p.displayId} — ${p.grandTotalFormatted} from ${p.businessName || p.contactName}`}>
      <Headline>New <span style={{ color: '#D93737' }}>order.</span></Headline>
      <P muted>Confirm payment, then prep + ship.</P>

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <SubHead>Order #{p.displayId}</SubHead>
      <KvLine label="Customer" value={`${p.contactName} (${p.customerEmail})`} />
      {p.businessName && <KvLine label="Business" value={p.businessName} />}
      <KvLine label="Payment"  value={p.paymentLabel} />
      <KvLine label="Shipping" value={p.shippingMethodName} />

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <SubHead>Items</SubHead>
      {p.items.map((it, i) => (
        <Text key={i} style={{ margin: '0 0 6px', fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', color: '#0A0A0A' }}>
          {it.qty} × <strong>{it.title}</strong>{it.variantTitle ? ` (${it.variantTitle})` : ''} — {it.subtotalFormatted}
        </Text>
      ))}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <MoneyRow label="Items"    value={p.itemsTotalFormatted} />
      <MoneyRow label="Shipping" value={p.shippingTotalFormatted} />
      <MoneyRow label="Tax"      value={p.taxTotalFormatted} />
      <MoneyRow label="Total"    value={p.grandTotalFormatted} bold />

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <SubHead>Ship to</SubHead>
      <AddressBlock a={p.shippingAddress} />
      <div style={{ height: 12 }} />
      <SubHead>Bill to</SubHead>
      <AddressBlock a={p.billingAddress} />

      {orderLink && (
        <>
          <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />
          <Text style={{ margin: 0, fontSize: '14px', fontFamily: 'Helvetica, Arial, sans-serif', fontWeight: 700 }}>
            <Link href={orderLink} style={{ color: '#0A0A0A' }}>Open in Medusa admin →</Link>
          </Text>
        </>
      )}
    </Base>
  )
}

OrderTeamAlertTemplate.PreviewProps = {
  displayId: '12',
  orderId: 'order_01ABCDEF',
  customerEmail: 'jordan@greenline.example',
  contactName: 'Jordan Lee',
  businessName: 'Greenline Provisions',
  items: [{ title: 'Wedding Cake', variantTitle: '1/4 oz', qty: 2, unitPriceFormatted: '$120', subtotalFormatted: '$240' }],
  itemsTotalFormatted: '$240.00',
  shippingTotalFormatted: '$15.00',
  taxTotalFormatted: '$0.00',
  grandTotalFormatted: '$255.00',
  shippingAddress: { first_name: 'Jordan', last_name: 'Lee', address_1: '123 Main St', city: 'Austin', province: 'TX', postal_code: '78701', country_code: 'us' },
  billingAddress:  { first_name: 'Jordan', last_name: 'Lee', address_1: '123 Main St', city: 'Austin', province: 'TX', postal_code: '78701', country_code: 'us' },
  shippingMethodName: 'UPS Ground',
  paymentLabel: 'Check / Wire / Net Terms',
} as OrderTeamAlertProps

export default OrderTeamAlertTemplate
