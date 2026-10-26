import { Container, Text } from "@medusajs/ui"
import { useEffect } from "react"

/* The Pre-Rolls receiving page was retired (4e); bookmarks land on
 * the Receiving page with Pre-Rolls picked. */
const PreRollReceivingRedirect = () => {
  useEffect(() => { window.location.replace("/app/receiving?key=pre-roll") }, [])
  return <Container className="p-6"><Text className="text-ui-fg-subtle">Opening Receiving…</Text></Container>
}

export default PreRollReceivingRedirect
