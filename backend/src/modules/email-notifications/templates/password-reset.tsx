import { Button, Hr, Link, Section, Text } from '@react-email/components'
import { Base } from './base'

/** Template key — used by both the user-initiated /auth/forgot flow AND
 *  the approval-welcome flow (admin moves customer to "approved" group →
 *  reset is triggered server-side → this email lands with the link). */
export const PASSWORD_RESET = 'password-reset'

export interface PasswordResetProps {
  /** The full URL the customer clicks to set/reset their password. */
  resetUrl: string
  /** True when this email is going out as the welcome-on-approval. Subtly
   *  reframes the copy ("Welcome — set your password" vs "Reset"). */
  isWelcome?: boolean
  preview?: string
}

export const isPasswordResetData = (data: any): data is PasswordResetProps =>
  typeof data?.resetUrl === 'string'

/** One template, two contexts. The approval flow flips `isWelcome` so the
 *  copy reads as a welcome rather than a security-reset message. The
 *  underlying mechanism is the same Medusa reset token. */
export const PasswordResetEmail = ({
  resetUrl,
  isWelcome = false,
  preview,
}: PasswordResetProps) => {
  const previewLine = preview ?? (isWelcome
    ? 'Welcome to Mind Body Spirit — set your password to start ordering.'
    : 'Reset your Mind Body Spirit password.'
  )
  return (
    <Base preview={previewLine}>
      <Section className="mt-[16px]">
        <Text className="text-black text-[20px] leading-[28px] font-bold m-0">
          {isWelcome ? 'Welcome — you\'re approved.' : 'Reset your password'}
        </Text>
        <Text className="text-black text-[14px] leading-[22px] mt-[16px]">
          {isWelcome
            ? 'Your Mind Body Spirit wholesale account is approved. Set your password using the button below to start ordering at wholesale pricing.'
            : 'Click the button below to set a new password for your Mind Body Spirit wholesale account. The link expires in about 15 minutes.'}
        </Text>
        <Section className="mt-[24px] mb-[24px] text-center">
          <Button
            className="bg-black text-white text-[13px] font-bold no-underline px-6 py-3 rounded-none"
            href={resetUrl}
          >
            {isWelcome ? 'Set My Password' : 'Reset Password'}
          </Button>
        </Section>
        <Text className="text-[#666666] text-[12px] leading-[18px] m-0">
          Or copy and paste this URL into your browser:
        </Text>
        <Text style={{
          fontSize: '11px',
          maxWidth: '100%',
          wordBreak: 'break-all',
          overflowWrap: 'break-word',
          margin: '6px 0 0 0',
        }}>
          <Link href={resetUrl} className="text-blue-600 no-underline">
            {resetUrl}
          </Link>
        </Text>

        <Hr className="border border-solid border-[#eaeaea] my-[24px] mx-0 w-full" />
        <Text className="text-[#666666] text-[12px] leading-[18px] m-0">
          {isWelcome
            ? 'Questions? Reply to this email.'
            : 'Didn\'t request this? Ignore this email — your password stays unchanged.'}
        </Text>
        <Text className="text-[#666666] text-[12px] leading-[18px] mt-[8px]">
          — The Mind Body Spirit team
        </Text>
      </Section>
    </Base>
  )
}

PasswordResetEmail.PreviewProps = {
  resetUrl: 'https://hempmbs.com/auth/reset?token=abc123def456ghi789jkl0mno1pqr2stu3vwx4yz5&email=test%40example.com',
  isWelcome: true,
} as PasswordResetProps

export default PasswordResetEmail
