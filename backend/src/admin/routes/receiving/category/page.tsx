import { Container, Text } from "@medusajs/ui"
import { useEffect } from "react"

/* The all-categories page moved to /app/receiving (4e); this keeps
 * old links and the chosen category working. */
const CategoryReceivingRedirect = () => {
  useEffect(() => { window.location.replace(`/app/receiving${window.location.search}`) }, [])
  return <Container className="p-6"><Text className="text-ui-fg-subtle">Opening Receiving…</Text></Container>
}

export default CategoryReceivingRedirect
