import { Hr, Img, Section, Text } from '@react-email/components'
import { Base, Headline, P } from './base'

export const ORDER_RECEIVED = 'order-received'

export type OrderEmailAddress = {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  country_code?: string | null
  phone?: string | null
}
export type OrderEmailLine = {
  title: string
  variantTitle?: string | null
  qty: number
  unitPriceFormatted: string
  subtotalFormatted: string
  /** Optional product thumbnail URL. Used by ORDER_RECEIVED only — falls
   *  back to a paper-colored placeholder square when missing so the
   *  layout stays aligned. ORDER_TEAM_ALERT ignores this field. */
  thumbnail?: string | null
}
export type OrderReceivedProps = {
  displayId: string
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
  needsPaymentInstructions: boolean
  preview?: string
}

export const isOrderReceivedData = (d: any): d is OrderReceivedProps =>
  typeof d?.displayId === 'string' &&
  typeof d?.contactName === 'string' &&
  Array.isArray(d?.items) &&
  typeof d?.shippingAddress === 'object' &&
  typeof d?.billingAddress === 'object'

export const OrderReceivedTemplate = (p: OrderReceivedProps) => {
  const firstName = p.contactName.split(' ')[0] || p.contactName
  return (
    <Base preview={p.preview ?? `Order #${p.displayId} received — ${p.grandTotalFormatted}`}>
      <Headline>Order <span style={{ color: '#D93737' }}>received.</span></Headline>
      <P>Hi {firstName} — thanks for your order. We&rsquo;ve got it and our team will prep it for shipment shortly.</P>

      <SubHead>Order #{p.displayId}</SubHead>
      <KvLine label="Payment" value={p.paymentLabel} />
      <KvLine label="Shipping" value={p.shippingMethodName} />
      {p.needsPaymentInstructions && (
        <P muted>
          We&rsquo;ll send a separate email with payment instructions (DBA, mailing address, wire info). Once payment is verified, we&rsquo;ll cut your shipping label and send tracking.
        </P>
      )}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <SubHead>Items</SubHead>
      {/* Table layout (not flex) for Outlook compat. Thumbnail column is
       *  fixed 60×60; text column takes the remaining width. */}
      {p.items.map((it, i) => (
        <table
          key={i}
          role="presentation"
          cellPadding={0}
          cellSpacing={0}
          border={0}
          style={{ width: '100%', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #F3F1EA' }}
        >
          <tbody>
            <tr>
              <td width="60" valign="top" style={{ width: 60, paddingRight: 12 }}>
                {it.thumbnail ? (
                  <Img
                    src={it.thumbnail}
                    alt={it.title}
                    width="60"
                    height="60"
                    style={{ display: 'block', width: 60, height: 60, objectFit: 'cover', border: '1px solid #E5E1D6' }}
                  />
                ) : (
                  <div style={{ width: 60, height: 60, backgroundColor: '#F3F1EA', border: '1px solid #E5E1D6' }} />
                )}
              </td>
              <td valign="top">
                <Text style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '14px', fontWeight: 600, color: '#0A0A0A' }}>
                  {it.title}
                </Text>
                {it.variantTitle && (
                  <Text style={{ margin: '2px 0 0', fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '12px', color: '#4A4A45' }}>
                    {it.variantTitle}
                  </Text>
                )}
                <Text style={{ margin: '4px 0 0', fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', color: '#1A1A1A' }}>
                  {it.qty} × {it.unitPriceFormatted} = <strong>{it.subtotalFormatted}</strong>
                </Text>
              </td>
            </tr>
          </tbody>
        </table>
      ))}

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <MoneyRow label="Items"    value={p.itemsTotalFormatted} />
      <MoneyRow label="Shipping" value={p.shippingTotalFormatted} />
      <MoneyRow label="Tax"      value={p.taxTotalFormatted} />
      <MoneyRow label="Total"    value={p.grandTotalFormatted} bold />

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '20px 0' }} />

      <Section style={{ display: 'block' }}>
        <SubHead>Ship to</SubHead>
        <AddressBlock a={p.shippingAddress} />
        <div style={{ height: 16 }} />
        <SubHead>Bill to</SubHead>
        <AddressBlock a={p.billingAddress} />
      </Section>

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '24px 0' }} />
      <P muted>Questions? Just reply — it goes straight to our wholesale team.</P>
    </Base>
  )
}

OrderReceivedTemplate.PreviewProps = {
  displayId: '12',
  contactName: 'Jordan Lee',
  businessName: 'Greenline Provisions',
  items: [
    { title: 'Wedding Cake', variantTitle: '1/4 oz', qty: 2, unitPriceFormatted: '$120.00', subtotalFormatted: '$240.00', thumbnail: 'https://placehold.co/120x120/0A0A0A/FAFAF7?text=WC' },
    { title: 'Pineapple Express', variantTitle: '1 oz', qty: 1, unitPriceFormatted: '$420.00', subtotalFormatted: '$420.00', thumbnail: null },
  ],
  itemsTotalFormatted: '$660.00',
  shippingTotalFormatted: '$15.00',
  taxTotalFormatted: '$0.00',
  grandTotalFormatted: '$675.00',
  shippingAddress: { first_name: 'Jordan', last_name: 'Lee', company: 'Greenline', address_1: '123 Main St', city: 'Austin', province: 'TX', postal_code: '78701', country_code: 'us', phone: '5125551234' },
  billingAddress:  { first_name: 'Jordan', last_name: 'Lee', company: 'Greenline', address_1: '123 Main St', city: 'Austin', province: 'TX', postal_code: '78701', country_code: 'us', phone: '5125551234' },
  shippingMethodName: 'UPS Ground',
  paymentLabel: 'Check / Wire / Net Terms',
  needsPaymentInstructions: true,
} as OrderReceivedProps

export const SubHead = ({ children }: { children: React.ReactNode }) => (
  <Text style={{
    margin: '0 0 8px',
    fontFamily: 'Helvetica, Arial, sans-serif',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: '#0A0A0A',
  }}>{children}</Text>
)

export const KvLine = ({ label, value }: { label: string; value: string }) => (
  <Text style={{ margin: '0 0 6px', fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', color: '#1A1A1A' }}>
    <span style={{ color: '#4A4A45' }}>{label}:</span> <strong>{value}</strong>
  </Text>
)

export const MoneyRow = ({ label, value, bold }: { label: string; value: string; bold?: boolean }) => (
  <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ width: '100%', marginBottom: 6 }}>
    <tbody>
      <tr>
        <td style={{ fontFamily: 'Helvetica, Arial, sans-serif', fontSize: bold ? '15px' : '13px', color: bold ? '#0A0A0A' : '#4A4A45', fontWeight: bold ? 700 : 400 }}>{label}</td>
        <td align="right" style={{ fontFamily: 'Helvetica, Arial, sans-serif', fontSize: bold ? '15px' : '13px', color: '#0A0A0A', fontWeight: bold ? 700 : 600 }}>{value}</td>
      </tr>
    </tbody>
  </table>
)

export const AddressBlock = ({ a }: { a: OrderEmailAddress }) => {
  const name = [a.first_name, a.last_name].filter(Boolean).join(' ').trim()
  return (
    <div>
      {name && <Text style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', fontWeight: 600, color: '#0A0A0A' }}>{name}</Text>}
      {a.company && <Text style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', color: '#1A1A1A' }}>{a.company}</Text>}
      {a.address_1 && <Text style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', color: '#1A1A1A' }}>{a.address_1}{a.address_2 ? `, ${a.address_2}` : ''}</Text>}
      <Text style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', color: '#1A1A1A' }}>
        {a.city}{a.city ? ', ' : ''}{a.province} {a.postal_code} {a.country_code?.toUpperCase()}
      </Text>
      {a.phone && <Text style={{ margin: 0, fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '13px', color: '#4A4A45' }}>{a.phone}</Text>}
    </div>
  )
}

export default OrderReceivedTemplate
