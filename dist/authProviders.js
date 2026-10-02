import { OAuth2Client } from 'google-auth-library';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { env } from './config.js';
const googleClient = new OAuth2Client();
export function normalizePhone(phone) {
    const parsed = parsePhoneNumberFromString(phone, env.DEFAULT_PHONE_REGION);
    if (!parsed?.isValid())
        throw new Error('Enter a valid phone number including its country code.');
    return parsed.number;
}
export async function sendSmsOtp(phone, code) {
    if (env.OTP_PROVIDER !== 'twilio' || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.OTP_SENDER) {
        throw new Error('OTP_PROVIDER_NOT_CONFIGURED');
    }
    const credentials = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const body = new URLSearchParams({ To: phone, From: env.OTP_SENDER, Body: `Your LemonTrip verification code is ${code}. It expires in 5 minutes.` });
    const result = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok)
        throw new Error('OTP_PROVIDER_SEND_FAILED');
}
export async function sendVerificationEmail(email, firstName, token) {
    if (env.EMAIL_PROVIDER !== 'resend' || !env.EMAIL_API_KEY || !env.EMAIL_FROM) {
        throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
    }
    const verificationUrl = `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/auth/email/verify?token=${encodeURIComponent(token)}`;
    const safeName = firstName.replace(/[<>"'&]/g, '');
    const result = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [email],
            subject: 'Verify your LemonTrip email',
            html: `<p>Hello ${safeName},</p><p>Verify your email to activate your LemonTrip account:</p><p><a href="${verificationUrl}">Verify email</a></p><p>This link expires in 30 minutes and can only be used once.</p>`,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok)
        throw new Error('EMAIL_PROVIDER_SEND_FAILED');
}
export async function verifyGoogleIdToken(idToken) {
    const audiences = [env.GOOGLE_CLIENT_ID, ...(env.GOOGLE_CLIENT_IDS ?? '').split(',')]
        .filter((value) => Boolean(value?.trim()))
        .map((value) => value.trim());
    if (!audiences.length)
        throw new Error('GOOGLE_PROVIDER_NOT_CONFIGURED');
    const ticket = await googleClient.verifyIdToken({ idToken, audience: audiences });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true)
        throw new Error('GOOGLE_IDENTITY_NOT_VERIFIED');
    return {
        providerUserId: payload.sub,
        email: payload.email.trim().toLowerCase(),
        name: payload.name?.trim() || payload.email.split('@')[0],
        firstName: payload.given_name?.trim() || payload.name?.trim().split(/\s+/)[0] || payload.email.split('@')[0],
        lastName: payload.family_name?.trim() || null,
    };
}
