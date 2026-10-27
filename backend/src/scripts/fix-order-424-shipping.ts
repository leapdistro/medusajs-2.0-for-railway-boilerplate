import { createOrUpdateOrderPaymentCollectionWorkflow } from "@medusajs/medusa/core-flows"
/* One-off: order 424 got a stray $65 shipping method from the shipping
 * preview (Medusa's cancel left it on version 3). Soft-delete it, then
 * resize the unpaid payment collection to the order total. Dry run unless APPLY=1. */
const STRAY = "ordsm_01M5ZH6AAMHXRM2N4JRGACNC0J"
export default async function run({ container }: any) {
  const query = container.resolve("query")
  const order: any = container.resolve("order")
  const read = async () => (await query.graph({ entity: "order", fields: ["id", "shipping_total", "total", "shipping_methods.id", "shipping_methods.amount", "payment_collections.status", "payment_collections.amount"], filters: { display_id: 424 } })).data[0]
  const show = (o: any, tag: string) => console.log(tag, JSON.stringify({ shipping: Number(o.shipping_total?.numeric ?? o.shipping_total), total: Number(o.total?.numeric ?? o.total), methods: o.shipping_methods.map((m: any) => [m.id, Number(m.amount?.numeric ?? m.amount)]), pcs: o.payment_collections.map((p: any) => [p.status, Number(p.amount?.numeric ?? p.amount)]) }))
  const o = await read()
  show(o, "BEFORE")
  if (!o.shipping_methods.some((m: any) => m.id === STRAY)) return console.log("STRAY not on order — nothing to do")
  if (process.env.APPLY !== "1") return console.log("DRY RUN")
  await order.softDeleteOrderShippingMethods([STRAY])
  await createOrUpdateOrderPaymentCollectionWorkflow(container).run({ input: { order_id: o.id } as any })
  show(await read(), "AFTER")
}
