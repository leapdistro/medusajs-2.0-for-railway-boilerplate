import { MedusaService } from "@medusajs/framework/utils"
import { SystemSetting } from "./models/system-setting"

/**
 * Settings service. Inherits CRUD from MedusaService (listSystemSettings,
 * createSystemSettings, etc.) and adds typed get/set helpers so consumer
 * code reads like:
 *
 *   const payment = await settings.getSetting("payment_info", DEFAULT_PAYMENT)
 *   await settings.setSetting("contact_info", { email, phone })
 *
 * The helpers swallow "not found" (returns the default) so consumers never
 * have to handle missing-key errors — first read returns the default,
 * which the seed script also writes so admin sees something to edit.
 */
class MbsSettingsModuleService extends MedusaService({
  SystemSetting,
}) {
  async getSetting<T = unknown>(key: string, defaultValue: T | null = null): Promise<T | null> {
    const [row] = await (this as any).listSystemSettings({ key })
    if (!row) return defaultValue
    return (row.value as T) ?? defaultValue
  }

  async setSetting<T = unknown>(key: string, value: T, description?: string): Promise<void> {
    const [existing] = await (this as any).listSystemSettings({ key })
    if (existing) {
      await (this as any).updateSystemSettings({
        id: existing.id,
        value,
        ...(description !== undefined ? { description } : {}),
      })
    } else {
      await (this as any).createSystemSettings({ key, value, description: description ?? null })
    }
  }
}

export default MbsSettingsModuleService
