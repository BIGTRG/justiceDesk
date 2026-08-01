/**
 * Twilio SMS.
 *
 * Sending is off unless SMS_SENDING_ENABLED is exactly "true". Staging runs against real
 * case data with real phone numbers, and a stray reminder about someone's eviction is not
 * a recoverable mistake — so the default is silence and enabling it is deliberate.
 */

import { readSecretOptional } from '@justicedesk/shared'
import twilio from 'twilio'
import type { SmsSender } from './reminders.js'

export function createSmsSender(): SmsSender {
  const accountSid = readSecretOptional(process.env.TWILIO_ACCOUNT_SID_VAULT_KEY ?? 'twilio_account_sid', {
    allowEnvFallback: true,
  })
  const authToken = readSecretOptional(process.env.TWILIO_AUTH_TOKEN_VAULT_KEY ?? 'twilio_auth_token', {
    allowEnvFallback: true,
  })
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID

  if (!accountSid || !authToken || !messagingServiceSid) {
    return {
      async send() {
        throw new Error(
          'Twilio is not configured. Set the account SID, auth token and messaging service SID before enabling SMS.'
        )
      },
    }
  }

  const client = twilio(accountSid, authToken)

  return {
    async send(to, body) {
      const message = await client.messages.create({ to, body, messagingServiceSid })
      return { sid: message.sid }
    },
  }
}
