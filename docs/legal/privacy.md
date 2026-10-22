# Thoth trial server — Privacy notice (DRAFT)

> **Draft for the project owner.** Before publishing, fill in every `[[OWNER: …]]`
> placeholder, and have someone who knows the data-protection law where you
> live (for example Thailand's PDPA or the EU GDPR) review it. This draft
> describes what the code actually does (ADR-0013, ADR-0014). If the code
> changes, update this notice.

Last updated: [[OWNER: date of publication]]

## Who runs this service

The Thoth trial server at `api.thoth.creaml4tt3.me` and the website at
`thoth.creaml4tt3.me` are run by Creaml4tt3 as a free,
non-commercial trial of the open-source Thoth project. Contact:
creaml4tt3@gmail.com.

This notice covers only the hosted trial. The Thoth desktop app keeps your
Private Space on your own computer. Nothing in it is sent to this server unless
you move or copy a page into a workspace on this server.

## What we collect and why

| Data | Where it comes from | Why |
| --- | --- | --- |
| Account identifier from your sign-in provider (the provider's user ID), your display name, and your email address if the provider gives a verified one | Google or GitHub, when you sign in | To create and recognise your account, show your name to workspace members, and contact you about your account |
| Pages, page history, attachments and workspace membership you create | You | To provide the service |
| Sign-in sessions (stored only as hashes) | Created when you sign in | To keep you signed in |
| IP address and request counts | Each request | Rate limiting and abuse prevention |
| Server logs: time, method, path without query, status code, request ID | Each request | Operating and debugging the service |

We do not store passwords. Sign-in happens at Google or GitHub. We never
receive your Google or GitHub password, and we do not keep their access tokens
after sign-in.

We do not sell your data, show ads, or use your content to train AI models.

## Who can see your content

- Members of a workspace can see that workspace's pages, history and
  attachments, according to their role.
- The operator can technically access the database for operations, security
  and abuse handling, and does so only when needed for those purposes.

## Service providers

The trial runs on:

- **Vercel** (website and API hosting);
- **Neon** (PostgreSQL database), in region AWS Asia Pacific (Singapore);
- **Google** and **GitHub** (sign-in).

Each one processes data under its own terms and privacy policy. Your data may be
processed outside your country.

## How long we keep data

- **Earlier versions of a page** are deleted 30 days after they are replaced.
  The current version is kept until you delete it.
- **Inactive accounts.** An account with no sign-in for 90 days is deleted with
  its sole-owner workspaces. We show a warning in the app first. [[OWNER: if you
  set up email, add "and email you, when we have a verified address".]]
- **Logs** are kept for [[OWNER: e.g. 7 days; check your Vercel plan's log
  retention]].
- **Rate-limit counters** are deleted within a day.

This is a trial with **no uptime or retention guarantee**. Export anything you
want to keep: the desktop app can move or copy workspace pages into your local
Private Space at any time.

## Your choices and rights

You can export your content at any time. To delete your account, or to ask for
a copy or correction of your account data, write to creaml4tt3@gmail.com.
[[OWNER: add the rights that apply under your law, and how to complain to a
regulator.]]

## Cookies

The website sets one cookie on the API's address: a sign-in session cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`). It is strictly necessary to keep you
signed in. There are no analytics or advertising cookies.

## Children

The trial is not meant for children under [[OWNER: 13 or the age required by
your law]].

## Changes

We will post changes here and update the date above.
