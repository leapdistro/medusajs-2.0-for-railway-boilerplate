import { ReactNode } from 'react'
import { MedusaError } from '@medusajs/framework/utils'
import { InviteUserEmail, INVITE_USER, isInviteUserData } from './invite-user'
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
import {
  OrderReceivedTemplate,
  ORDER_RECEIVED,
  isOrderReceivedData,
} from './order-received'
import {
  OrderTeamAlertTemplate,
  ORDER_TEAM_ALERT,
  isOrderTeamAlertData,
} from './order-team-alert'
import {
  PaymentInstructionsTemplate,
  PAYMENT_INSTRUCTIONS,
  isPaymentInstructionsData,
} from './payment-instructions'
import {
  OrderShippedTemplate,
  ORDER_SHIPPED,
  isOrderShippedData,
} from './order-shipped'
import {
  OrderCancelledTemplate,
  ORDER_CANCELLED,
  isOrderCancelledData,
} from './order-cancelled'

export const EmailTemplates = {
  INVITE_USER,
  WHOLESALE_APPLICATION_APPLICANT,
  WHOLESALE_APPLICATION_TEAM,
  PASSWORD_RESET,
  APPLICATION_DENIED,
  ORDER_RECEIVED,
  ORDER_TEAM_ALERT,
  PAYMENT_INSTRUCTIONS,
  ORDER_SHIPPED,
  ORDER_CANCELLED,
} as const

export type EmailTemplateType = keyof typeof EmailTemplates

export function generateEmailTemplate(templateKey: string, data: unknown): ReactNode {
  switch (templateKey) {
    case EmailTemplates.INVITE_USER:
      if (!isInviteUserData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.INVITE_USER}"`)
      return <InviteUserEmail {...data} />

    case EmailTemplates.WHOLESALE_APPLICATION_APPLICANT:
      if (!isWholesaleApplicationApplicantData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.WHOLESALE_APPLICATION_APPLICANT}"`)
      return <WholesaleApplicationApplicantEmail {...data} />

    case EmailTemplates.WHOLESALE_APPLICATION_TEAM:
      if (!isWholesaleApplicationTeamData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.WHOLESALE_APPLICATION_TEAM}"`)
      return <WholesaleApplicationTeamEmail {...data} />

    case EmailTemplates.PASSWORD_RESET:
      if (!isPasswordResetData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.PASSWORD_RESET}"`)
      return <PasswordResetEmail {...data} />

    case EmailTemplates.APPLICATION_DENIED:
      if (!isApplicationDeniedData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.APPLICATION_DENIED}"`)
      return <ApplicationDeniedEmail {...data} />

    case EmailTemplates.ORDER_RECEIVED:
      if (!isOrderReceivedData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.ORDER_RECEIVED}"`)
      return <OrderReceivedTemplate {...data} />

    case EmailTemplates.ORDER_TEAM_ALERT:
      if (!isOrderTeamAlertData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.ORDER_TEAM_ALERT}"`)
      return <OrderTeamAlertTemplate {...data} />

    case EmailTemplates.PAYMENT_INSTRUCTIONS:
      if (!isPaymentInstructionsData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.PAYMENT_INSTRUCTIONS}"`)
      return <PaymentInstructionsTemplate {...data} />

    case EmailTemplates.ORDER_SHIPPED:
      if (!isOrderShippedData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.ORDER_SHIPPED}"`)
      return <OrderShippedTemplate {...data} />

    case EmailTemplates.ORDER_CANCELLED:
      if (!isOrderCancelledData(data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid data for "${EmailTemplates.ORDER_CANCELLED}"`)
      return <OrderCancelledTemplate {...data} />

    default:
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Unknown template key: "${templateKey}"`)
  }
}

export {
  InviteUserEmail,
  WholesaleApplicationApplicantEmail,
  WholesaleApplicationTeamEmail,
  PasswordResetEmail,
  ApplicationDeniedEmail,
  OrderReceivedTemplate,
  OrderTeamAlertTemplate,
  PaymentInstructionsTemplate,
  OrderShippedTemplate,
  OrderCancelledTemplate,
}
