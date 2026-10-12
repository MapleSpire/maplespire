// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

/**
 * Transactional email templates. Every template returns both an HTML body
 * (inline-styled — no external stylesheet, since mail clients strip `<style>`
 * blocks or ignore linked CSS) and a plain-text alternative, so `EmailMessage`
 * is always fully populated regardless of the recipient's client.
 *
 * All caller-supplied values (org name, inviter email, role, …) are untrusted —
 * an org admin can rename their org to anything, including markup — so every
 * interpolation into HTML goes through `escapeHtml`. The plain-text alternative
 * doesn't need escaping (no markup to break out of).
 */

const ACCENT = '#C2410C' // MapleSpire warm accent

/** Escape the five HTML-significant characters. Applied to every interpolated
 * value before it lands in an HTML template — untrusted org/user input must
 * never be able to inject markup into a transactional email. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Shared card chrome: system-ui font stack, white card on a light-gray page,
 * warm accent for the primary action. `bodyHtml` is pre-escaped by the caller. */
function layout(opts: { preheader: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0; padding:0; background:#f4f4f5; font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
    <span style="display:none; max-height:0; overflow:hidden;">${escapeHtml(opts.preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background:#ffffff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.08); overflow:hidden;">
            <tr>
              <td style="padding:32px;">
                <div style="font-size:14px; font-weight:700; letter-spacing:0.02em; color:${ACCENT}; text-transform:uppercase; margin-bottom:24px;">MapleSpire</div>
                ${opts.bodyHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function button(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block; margin-top:24px; padding:12px 24px; background:${ACCENT}; color:#ffffff; font-size:14px; font-weight:600; text-decoration:none; border-radius:8px;">${escapeHtml(label)}</a>`
}

/**
 * Invite a user to join an org. `acceptUrl` is a fully-qualified link the
 * server minted (token embedded server-side) — never build it from
 * caller-controlled path fragments.
 */
export function inviteEmail(a: {
  orgName: string
  inviterEmail: string
  role: string
  acceptUrl: string
}): { subject: string; html: string; text: string } {
  const orgName = escapeHtml(a.orgName)
  const inviterEmail = escapeHtml(a.inviterEmail)
  const role = escapeHtml(a.role)
  const subject = `You're invited to join ${a.orgName} on MapleSpire`

  const html = layout({
    preheader: `${a.inviterEmail} invited you to join ${a.orgName} on MapleSpire.`,
    bodyHtml: `
      <h1 style="margin:0 0 12px; font-size:20px; color:#18181b;">Join ${orgName}</h1>
      <p style="margin:0 0 8px; font-size:14px; line-height:1.6; color:#3f3f46;">
        <strong>${inviterEmail}</strong> invited you to join <strong>${orgName}</strong> on MapleSpire as <strong>${role}</strong>.
      </p>
      <p style="margin:0; font-size:14px; line-height:1.6; color:#3f3f46;">
        Accept the invite to get access to the org's landscapes.
      </p>
      ${button('Accept invite', a.acceptUrl)}
      <p style="margin:24px 0 0; font-size:12px; line-height:1.5; color:#a1a1aa;">
        If you weren't expecting this, you can ignore this email.
      </p>
    `,
  })

  const text = [
    `Join ${a.orgName} on MapleSpire`,
    '',
    `${a.inviterEmail} invited you to join ${a.orgName} on MapleSpire as ${a.role}.`,
    '',
    `Accept your invite: ${a.acceptUrl}`,
    '',
    "If you weren't expecting this, you can ignore this email.",
  ].join('\n')

  return { subject, html, text }
}

/**
 * Notify a user their access changed (grant/revoke, role change, deactivation).
 * `summary` is a short human-readable description of what changed, e.g.
 * "Your role in Acme Corp changed from Member to Admin." — pre-composed by the
 * caller (audit.ts / the admin mutation) so this template stays generic.
 */
export function accessChangedEmail(a: {
  orgName: string
  summary: string
  appUrl: string
}): { subject: string; html: string; text: string } {
  const orgName = escapeHtml(a.orgName)
  const summary = escapeHtml(a.summary)
  const subject = `Your access to ${a.orgName} changed`

  const html = layout({
    preheader: a.summary,
    bodyHtml: `
      <h1 style="margin:0 0 12px; font-size:20px; color:#18181b;">Access updated in ${orgName}</h1>
      <p style="margin:0; font-size:14px; line-height:1.6; color:#3f3f46;">${summary}</p>
      ${button('Open MapleSpire', a.appUrl)}
      <p style="margin:24px 0 0; font-size:12px; line-height:1.5; color:#a1a1aa;">
        If this doesn't look right, contact your org admin.
      </p>
    `,
  })

  const text = [
    `Access updated in ${a.orgName}`,
    '',
    a.summary,
    '',
    `Open MapleSpire: ${a.appUrl}`,
    '',
    "If this doesn't look right, contact your org admin.",
  ].join('\n')

  return { subject, html, text }
}

/** Confirm ownership before a local email/password account may sign in. */
export function verifyEmailAddressEmail(a: { verificationUrl: string }): { subject: string; html: string; text: string } {
  const subject = 'Confirm your email address for Maplespire'
  const html = layout({
    preheader: 'Confirm your email address to finish creating your Maplespire account.',
    bodyHtml: `
      <h1 style="margin:0 0 12px; font-size:20px; color:#18181b;">Confirm your email address</h1>
      <p style="margin:0; font-size:14px; line-height:1.6; color:#3f3f46;">
        Use the button below to finish creating your Maplespire account. This link expires in 24 hours.
      </p>
      ${button('Confirm email address', escapeHtml(a.verificationUrl))}
      <p style="margin:24px 0 0; font-size:12px; line-height:1.5; color:#a1a1aa;">
        If you did not create this account, you can ignore this email.
      </p>
    `,
  })
  const text = [
    'Confirm your email address', '',
    'Finish creating your Maplespire account with this link (valid for 24 hours):',
    a.verificationUrl, '',
    'If you did not create this account, you can ignore this email.',
  ].join('\n')
  return { subject, html, text }
}
