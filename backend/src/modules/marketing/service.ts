import { MedusaService } from "@medusajs/framework/utils"
import { MarketingCampaign } from "./models/campaign"
import { MarketingRecipient } from "./models/recipient"
import { MarketingSuppression } from "./models/suppression"

/** CRUD for campaigns, recipients and the suppression list. The sending
 *  logic lives in lib/marketing/send.ts. */
class MarketingModuleService extends MedusaService({
  MarketingCampaign,
  MarketingRecipient,
  MarketingSuppression,
}) {}

export default MarketingModuleService
