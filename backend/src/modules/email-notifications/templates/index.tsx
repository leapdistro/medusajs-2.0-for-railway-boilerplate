import { ReactNode } from 'react'
import { MedusaError } from '@medusajs/framework/utils'
import { InviteUserEmail, INVITE_USER, isInviteUserData } from './invite-user'
import { OrderPlacedTemplate, ORDER_PLACED, isOrderPlacedTemplateData } from './order-placed'
import {
  WholesaleApplicationApplicantEmail,
  WHOLESALE_APPLICATION_APPLICANT,
  isWholesaleApplicationApplicantData,
} from './wholesale-application-applicant'
import {
  WholesaleApplicationTeamEmail,
  WHOLESALE_APPLICATION_TEAM,
  isWholesaleApplicationTeamData,
} from './wholesale-application-team'
import {
  PasswordResetEmail,
  PASSWORD_RESET,
  isPasswordResetData,
} from './password-reset'
import {
  ApplicationDeniedEmail,
  APPLICATION_DENIED,
  isApplicationDeniedData,
} from './application-denied'

export const EmailTemplates = {
  INVITE_USER,
  ORDER_PLACED,
  WHOLESALE_APPLICATION_APPLICANT,
  WHOLESALE_APPLICATION_TEAM,
  PASSWORD_RESET,
  APPLICATION_DENIED,
} as const

export type EmailTemplateType = keyof typeof EmailTemplates

export function generateEmailTemplate(templateKey: string, data: unknown): ReactNode {
  switch (templateKey) {
    case EmailTemplates.INVITE_USER:
      if (!isInviteUserData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.INVITE_USER}"`
        )
      }
      return <InviteUserEmail {...data} />

    case EmailTemplates.ORDER_PLACED:
      if (!isOrderPlacedTemplateData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.ORDER_PLACED}"`
        )
      }
      return <OrderPlacedTemplate {...data} />

    case EmailTemplates.WHOLESALE_APPLICATION_APPLICANT:
      if (!isWholesaleApplicationApplicantData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.WHOLESALE_APPLICATION_APPLICANT}"`
        )
      }
      return <WholesaleApplicationApplicantEmail {...data} />

    case EmailTemplates.WHOLESALE_APPLICATION_TEAM:
      if (!isWholesaleApplicationTeamData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.WHOLESALE_APPLICATION_TEAM}"`
        )
      }
      return <WholesaleApplicationTeamEmail {...data} />

    case EmailTemplates.PASSWORD_RESET:
      if (!isPasswordResetData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.PASSWORD_RESET}"`
        )
      }
      return <PasswordResetEmail {...data} />

    case EmailTemplates.APPLICATION_DENIED:
      if (!isApplicationDeniedData(data)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid data for template "${EmailTemplates.APPLICATION_DENIED}"`
        )
      }
      return <ApplicationDeniedEmail {...data} />

    default:
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown template key: "${templateKey}"`
      )
  }
}

export {
  InviteUserEmail,
  OrderPlacedTemplate,
  WholesaleApplicationApplicantEmail,
  WholesaleApplicationTeamEmail,
  PasswordResetEmail,
  ApplicationDeniedEmail,
}
