import { Hr, Link, Text } from '@react-email/components'
import { Base, Headline, P, PrimaryButton } from './base'

/** Used by both /auth/forgot AND welcome-on-approval flow. */
export const PASSWORD_RESET = 'password-reset'

export interface PasswordResetProps {
  resetUrl: string
  isWelcome?: boolean
  preview?: string
}

export const isPasswordResetData = (data: any): data is PasswordResetProps =>
  typeof data?.resetUrl === 'string'

/** One template, two contexts. The approval flow flips `isWelcome` so the
 *  copy reads as a welcome rather than a security-reset message. */
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
      {isWelcome ? (
        <Headline>You&rsquo;re <span style={{ color: '#D93737' }}>approved.</span></Headline>
      ) : (
        <Headline>Reset your <span style={{ color: '#D93737' }}>password.</span></Headline>
      )}

      <P>
        {isWelcome
          ? 'Your Mind Body Spirit wholesale account is approved. Set your password using the button below to start ordering at wholesale pricing.'
          : 'Click the button below to set a new password for your Mind Body Spirit wholesale account. The link expires in about 15 minutes.'}
      </P>

      <PrimaryButton href={resetUrl}>
        {isWelcome ? 'Set My Password' : 'Reset Password'}
      </PrimaryButton>

      <Text
        style={{
          margin: '8px 0 6px',
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: '11px',
          color: '#4A4A45',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        Or paste this URL into your browser
      </Text>
      <Text
        style={{
          margin: 0,
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: '11px',
          maxWidth: '100%',
          wordBreak: 'break-all',
          overflowWrap: 'break-word',
        }}
      >
        <Link href={resetUrl} style={{ color: '#1A1A1A', textDecoration: 'underline' }}>
          {resetUrl}
        </Link>
      </Text>

      <Hr style={{ border: 0, borderTop: '1px solid #E5E1D6', margin: '28px 0 16px' }} />

      <P muted>
        {isWelcome
          ? 'Questions? Reply to this email — it goes straight to our wholesale team.'
          : 'Didn\'t request this? Ignore this email — your password stays unchanged.'}
      </P>
    </Base>
  )
}

PasswordResetEmail.PreviewProps = {
  resetUrl: 'https://hempmbs.com/auth/reset?token=abc123def456ghi789jkl0mno1pqr2stu3vwx4yz5&email=test%40example.com',
  isWelcome: true,
} as PasswordResetProps

export default PasswordResetEmail
