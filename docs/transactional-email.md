# JustRide transactional email

Provider: Hostinger SMTP, using the existing active `info@justride.cc` mailbox.
The authenticated dashboard on October 11, 2026 showed Starter Business Email,
1,000 outgoing messages per rolling 24 hours, expiry October 11, 2027.
No extra purchase or Brevo account is needed. The existing plan is not a perpetual free tier.

## Environment

Set these in the ignored backend `.env` locally and the backend project's deployment environment:

- `MAIL_PROVIDER`: `hostinger-smtp`
- `MAIL_HOST`: `smtp.hostinger.com`
- `MAIL_PORT`: `465`
- `MAIL_SECURE`: `true`
- `MAIL_USER`: `info@justride.cc`
- `MAIL_PASSWORD`: existing mailbox password, never commit or print
- `MAIL_FROM_EMAIL`: `info@justride.cc`
- `MAIL_FROM_NAME`: `JustRide`
- `PUBLIC_WEBSITE_URL`: `https://www.justride.cc` (local development can use localhost)

The application requires the authenticated mailbox and sender to match `info@justride.cc`.
From is `JustRide <info@justride.cc>` and Reply-To is `info@justride.cc`.
The user chose existing SMTP credentials instead of creating an API token.

## Behavior

One central `sendEmail({to, subject, html, text})` service uses Nodemailer with TLS on port 465,
certificate verification, 10-second connection/socket timeouts and a 15-second overall limit.
Only an accepted SMTP recipient is counted as provider acceptance. No provider response bodies,
credentials, email addresses, reset tokens or OTP values are logged by the service.
Acceptance does not prove inbox delivery; verify the real test in Webmail and inspect headers.

Interest confirmations are attempted only after the record is saved. Duplicate submissions
never resend. Delivery status and safe failure codes are recorded on the interest record and
shown on the admin Interested Users page. A failed confirmation leaves the record intact.
The request awaits delivery, including on Vercel: no fire-and-forget work after the response.
Ambiguous sends are not automatically retried to prevent duplicate email.

Password reset, device unlink OTP, account creation and password reset completion use this
same service. Failed reset/OTP delivery clears only that request's matching token/code.
Reset replies are generic to avoid account enumeration; OTP failures return a safe error.
Reset email links use a URL fragment. The customer reset page was removed at the user's
request; the web reset journey is deferred until an approved reset interface is available.
Existing token-in-path API clients remain supported, but application request logs redact them.

Limits: existing auth/OTP IP protection; interest submissions 5/IP/hour; shared MongoDB
recipient limit 3/15 minutes; all app email at most 36/hour. With at most 25 intersecting
hourly windows, app traffic stays at or below 900 messages in any rolling 24 hours.
Database failures prevent sending rather than bypassing these limits. Counters consume an
attempt even if the provider fails. Provider limits still apply to manual mailbox usage.
The existing IP stores are per instance; database recipient and sender limits are shared.
For larger launch bursts, reassess the observed allowance and expected volume without purchasing.

## DNS and delivery checks

DNS is hosted in Vercel, not Hostinger. `email-dns-before.txt` records the original Vercel zone.
The missing email records were added in Vercel on October 11, 2026. Hostinger then
showed green checks for MX, SPF, DKIM and DMARC. `email-dns-after.txt` records the
resulting zone. This verifies provider DNS detection, not received-message authentication.
All SMTP settings have been saved to the backend Vercel project's Production environment;
`MAIL_PASSWORD` is an unrevealable Secret and is also stored in the ignored local `.env`.
Backend commit `7141c03` deployed successfully. The local SMTP test was received in the
approved `info@justride.cc` inbox on October 11, 2026. Its original message shows SPF,
DKIM and DMARC passing, aligned to `justride.cc`, and contains HTML and plain text parts.
The production early-interest request returned 201 and its database record shows
`confirmationEmailStatus: sent`, `confirmationEmailCode: SENT`.

Required records observed:

| Type | Name | Value | Priority |
| --- | --- | --- | --- |
| MX | @ | mx1.hostinger.com | 5 |
| MX | @ | mx2.hostinger.com | 10 |
| TXT | @ | v=spf1 include:_spf.mail.hostinger.com ~all | |
| CNAME | hostingermail-a._domainkey | hostingermail-a.dkim.mail.hostinger.com | |
| CNAME | hostingermail-b._domainkey | hostingermail-b.dkim.mail.hostinger.com | |
| CNAME | hostingermail-c._domainkey | hostingermail-c.dkim.mail.hostinger.com | |
| TXT | _dmarc | v=DMARC1; p=none | |

Check for existing records immediately before editing. Preserve website/CAA records;
merge any existing SPF and retain an existing DMARC policy. Never change nameservers.
Do not claim SPF/DKIM/DMARC passing until verified by provider or received-message headers.

Run `node --test test/email.test.js` for provider payload, secret-free failures, throttling,
HTML escaping, save-before-send and duplicate suppression without sending real mail.

Sources: [Nodemailer SMTP](https://nodemailer.com/smtp),
[Agentic Mail](https://www.hostinger.com/support/how-to-use-agentic-mail-in-hostinger/),
[Mail limits](https://www.hostinger.com/support/4625828-parameters-and-limits-of-hostinger-email/).
