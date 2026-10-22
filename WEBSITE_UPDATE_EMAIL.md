# Website update campaign

The fixed `aventura-website-refresh-v1` announcement has a preview, a test send to
`hanumansai72@gmail.com`, explicit admin approval, and per-recipient delivery state.
Testing never queues subscribers. Only ADMIN can preview/test/approve the campaign.
Approval requires a successful test of the current content and the reviewed
recipient count. Concurrent or repeated approval cannot reset the recipient list.

## Environment

Keep the existing MAIL_* settings. No email password belongs in source control.
Optional `PUBLIC_API_URL` defaults to `https://backend.justride.cc` and must use
HTTPS. `INTEREST_UNSUBSCRIBE_SECRET` can be a separate durable signing secret;
otherwise JWT_SECRET signs unsubscribe links. Changing that signing secret
invalidates old preference links. Never log these secrets or token URLs.

## Sending and scheduling

One approval queues the full selected audience. Website opt-in is the default. An admin can additionally include registered contacts only after explicitly recording directly confirmed permission for this mailing. This does not rewrite website consent, and recorded unsubscribes are always excluded. Messages are individual emails
through the existing shared 36/hour allowance; account/security emails share it.
Consent is checked again just before sending. Unsubscribe links open a confirmation
form; GET does not change preferences, so link scanners cannot unsubscribe people.

Persistent `server.js` deployments run the existing ten-second email worker, which
also drains this campaign. Serverless deployments need a protected scheduler to
continue after the admin closes the browser. Configure CRON_SECRET on the backend
and have your scheduler call GET `/api/early-interest/website-update/process` with
`Authorization: Bearer <CRON_SECRET>` every minute. Do not expose this secret in
client code. No scheduler, deployment, or bulk mailing is enabled by creating files.
Opening campaign progress also assists processing after an approved send.

Alternatively, run the worker on a trusted server with the backend environment:

    node scripts/website-update.cjs work

This only drains a campaign already approved in the admin. It cannot approve one.
An SMTP timeout or a crash during sending is never automatically retried because
the provider might already have accepted the message. Failed or stuck messages
must be reviewed against provider logs; do not reset them blindly.

## Test and inspect

    node scripts/website-update.cjs preview /absolute/path/preview.html
    node scripts/website-update.cjs status
    node scripts/website-update.cjs test hanumansai72@gmail.com
    node --test test/website-update.test.cjs

`SENT` means SMTP acceptance, not guaranteed inbox placement. The CLI prints counts
and outcomes rather than subscriber addresses. Use a test environment for automated
tests; they mock persistence and mail transport and never send messages.

## Explicit owner-directed operational approval

The trusted server CLI also supports an owner-approved mailing after the test:

    node scripts/website-update.cjs approve <reviewed-count> OWNER_CONFIRMED_DIRECT_PERMISSION

This records the owner confirmation source and note in the campaign, includes
registered contacts with directly confirmed permission, and excludes recorded
unsubscribes. It checks that the live unsubscribe endpoint accepts this server's
signed links before queuing anything. Never run it based solely on a list import.
