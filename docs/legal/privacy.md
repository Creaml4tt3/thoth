# Privacy notice

<!-- repo-only:start -->
> **Draft — have it reviewed by someone who knows Thai PDPA** before relying on
> it. It describes what the code does (ADR-0013, ADR-0014, ADR-0015); if the
> code changes, update this notice and its Thai version (`privacy.th.md`).
>
> The website (ADR-0039) publishes this file at `/privacy/` and the Thai version at
> `/th/privacy/`. The site leaves out this block (between the `repo-only`
> markers) and every HTML comment, so owner notes in comments stay in the repo.
>
> The "Last updated" date is pinned in thoth-site `test/build.test.ts` ("legal pages");
> change both together, or the site build fails.
<!-- repo-only:end -->

Last updated: 10 November 2026

## Who we are

Creaml4tt3, an individual in Thailand, runs the Thoth website at
`thothnotes.com`, the web version of Thoth at `thothnotes.com/app`,
the Thoth demo server at `api.thothnotes.com`, and the download site at
`download.thothnotes.com`. For the personal data
described here, Creaml4tt3 is the data controller under Thailand's Personal
Data Protection Act B.E. 2562 (2019) ("PDPA").

Contact: privacy@thothnotes.com

## What this notice covers

This notice covers the website, the web version, the demo server and the
download site. It does not cover:

- **The Thoth desktop app.** Your Private Space stays on your own computer.
  The app has no analytics and never sends your notes anywhere you didn't
  choose. On its own it does two things, and you can turn both off in Settings:
  - **Update check.** When it opens, and about once a day while it stays open,
    it asks the download site whether a new version is out, sending only its
    version number. Turn it off with Settings → Updates → "Tell me when a new
    version is out"; then it makes no request at all.
  - **Link previews.** When a link sits on its own line in one of your pages,
    for example a link you paste, it fetches that page's title, description and
    image from the linked site to show a preview card, which tells that site
    the page was looked at. Links in workspace pages are fetched only when you
    choose "Load preview". Settings → Editor → "Link previews" offers On, Only
    for links I paste, and Off.

  Everything else happens only when you choose it, such as connecting to a
  server or sending a problem report. The app also keeps a small log on your
  computer of errors and app events (about 3 MB at most). It is built to leave out page text and titles, and it
  masks file paths, links and email addresses. The log is sent only if you
  include it in a problem report, after you have seen every line. You can turn
  the log off in Settings, which also deletes it.
- **Servers run by other people.** If you connect to a Thoth server that
  someone else hosts, that person is responsible for your data on it.

## What we collect and why

| Data | Where it comes from | Why | Legal basis under the PDPA |
| --- | --- | --- | --- |
| Your account ID at your sign-in provider, your display name, and your email address if the provider gives a verified one | Google or GitHub, when you sign in | To create and recognise your account, show your name to members of your workspaces, and contact you about your account | Performing our agreement with you (the terms of use) |
| Pages, page history, attachments and workspace membership | You | To provide the service | Performing our agreement with you |
| Sign-in sessions (stored only as hashes) | Created when you sign in | To keep you signed in | Performing our agreement with you |
| IP address and request counts | Each request to the demo server | Rate limiting and preventing abuse | Our legitimate interest in keeping the service secure |
| IP address, country, user agent (for the app, its version number), time and path of each request to the download site: update checks and installer downloads | Your app or your browser | Delivering the files; counting, once a week, how many different addresses check for updates or download an installer, which tells us roughly how many people use Thoth | Our legitimate interest in running the download site and knowing whether Thoth is used |
| Server logs: time, method, path without query, status code, request ID | Each request to the demo server | Running and fixing the service | Our legitimate interest in running the service |
| Feedback you send from the website, the web version or the desktop app: your message, the kind, and, only if you give or include them, your email address, the app version, operating system, processor type and language, and the recent app log (from the desktop app, only if you tick "Include recent app log", after you have seen every line; built to leave out page text and titles; file paths, links and emails masked). If you are signed in when you send it, it is linked to your account | You, when you send it; the demo server only receives it if the app sends it there | To read and answer problems, ideas and questions, and to fix bugs | Our legitimate interest in answering you and fixing the app; for the app log, your consent, given by ticking the box |
| Website and web version analytics (see below) | Your browser, only if you accept analytics | Learning which pages and features people use, so we can improve them | Your consent |

We do not store passwords. You sign in at Google or GitHub: we never receive
your password there, and we do not keep their access tokens after sign-in.

We do not sell your data, show ads, or use your content to train AI models.

## Analytics on the website and in the web version

We use **Google Analytics 4**, a service of Google, only if you choose
**Accept** in the cookie banner. Until you accept, the website and the web
version load nothing from Google and send nothing to it. If you choose
**Decline**, nothing is sent.

If you accept, Google collects on our behalf:

- pseudonymous identifiers stored in analytics cookies (`_ga` and `_ga_<ID>`),
  which recognise your browser but not you by name;
- the pages of this website you view, and the page that sent you here;
- these events: playing the showcase video and how far it plays (25, 50, 75
  and 100 percent), turning its sound on, clicking "Open the web app" or
  "Download", switching language, and opening a question in the FAQ;
- your approximate location (country or city), which Google derives from your
  IP address, and your device type, operating system, browser and screen size.

In the **web version**, only anonymous events are sent: the screen name (for
example `/app` or `/app/page`), the action (signing in, opening, saving or
searching pages, a conflict shown or resolved), the sign-in provider you chose,
and the conflict option you picked. We never send page content, page titles,
page or workspace IDs, web addresses that contain IDs, search text, names or
email addresses. We do not set a user ID.

Google signals and ad personalisation are turned off, and consent for
advertising storage stays "denied". Google acts as our data processor for
analytics. We keep analytics data in Google Analytics for 2 months.
<!-- OWNER: set GA4 → Admin → Data collection and modification → Data retention to 2 months, or change this sentence to match. -->

Analytics is optional. You can change your choice at any time from **Cookie
settings** at the bottom of every page. If you withdraw consent, we stop
sending data and delete the analytics cookies on this website. Data already
sent stays in Google Analytics until the retention period ends.

## Who can see your content

- Members of a workspace can see its pages, history and attachments,
  according to their role.
- The operator can technically access the database. We do so only when needed
  to run the service, keep it secure, or handle abuse.

## Service providers and transfers outside Thailand

We use these providers, each under its own terms and privacy policy:

- **Vercel** (United States): hosting for the website, the web version and the
  demo server;
- **Neon** (United States), with the database in the AWS Asia Pacific
  (Singapore) region: the demo server's database;
- **Google** (United States): sign-in, and analytics if you accept it;
- **GitHub** (United States): sign-in;
- **Cloudflare** (United States): the download site.

Your data may therefore be transferred to and processed in other countries,
including the United States and Singapore, whose data protection standards may
differ from Thailand's. We rely on the providers' data processing terms and
contractual safeguards, as the PDPA allows for transfers abroad.

## How long we keep data

- **Earlier versions of a page** are deleted 30 days after they are replaced.
  The current version is kept until you delete it.
- **Inactive accounts.** An account with no sign-in or app use for 90 days is deleted,
  together with the workspaces it alone owns. The sign-in page states this rule; there is
  no separate warning before the deletion. An account that alone owns a workspace other
  people still use is kept. Where a deleted account's edits appear in the history of another
  workspace's pages, they show "Deleted account", without a name or email.
- **Server logs** are kept for up to 30 days.
  <!-- OWNER: check your Vercel plan's log retention and match this number. -->
- **Download site request records** are kept by Cloudflare for about a month
  (at least 31 days). We keep only the weekly totals, not the addresses.
  <!-- OWNER: Cloudflare documents "at least 31 days" for adaptive request analytics on every plan
       (developers.cloudflare.com/analytics/graphql-api/limits/). Check your zone's settings and match this if it differs. -->
- **Rate-limit counters** are deleted within a day.
- **Feedback**, and any app log sent with it, is deleted 90 days after it arrives.
- **Analytics data** is kept in Google Analytics for 2 months.
- **Your cookie choice** is kept in your browser until you clear it.

The demo server has **no uptime or retention guarantee**: it may be reset.
Keep anything you care about in your Private Space, where the desktop app can
copy or move workspace pages at any time.

## Your rights

Under the PDPA you have the right to:

- **access** your personal data and **get a copy** of it;
- **receive** your data in a commonly used, machine-readable format, and have
  it sent to another controller where this is technically possible
  (**portability**);
- **correct** data that is wrong, incomplete or out of date;
- have your data **deleted**, destroyed or made anonymous;
- **object** to processing based on our legitimate interests;
- **restrict** how we use your data;
- **withdraw your consent** at any time, for example to analytics from Cookie
  settings. Withdrawing does not affect processing done before.

To use these rights, email privacy@thothnotes.com. We may ask you to confirm that
the account is yours. We answer within 30 days. Some requests can be refused
where the PDPA allows it; if so, we tell you why.

If you think we handle your data unlawfully, you can complain to the Office of
the Personal Data Protection Committee (PDPC), Thailand: www.pdpc.or.th.

## Cookies and browser storage

- **Sign-in cookies**, on the demo server's address only: `__Secure-thoth_refresh`
  keeps you signed in to the web version, and `__Host-thoth_signin` lasts a few
  minutes while you sign in. Both are `HttpOnly` and `Secure`. They are
  strictly necessary and need no consent.
- **Your cookie choice**, in your browser's local storage (`thoth.consent` and
  `thoth.consent.version`), so we do not ask again. Strictly necessary.
- **Analytics cookies** `_ga` and `_ga_<ID>`, only after you accept. They last
  up to 2 years unless you withdraw consent or clear them.

There are no advertising cookies.

## Minors

Under the PDPA, a person under 20 is a minor. To give consent here you must be
at least 20 years old. If you are younger, use the website and the demo server
only with the consent of your parent or guardian. If we learn that we hold a
minor's personal data without that consent, we delete it.

## Security

Connections use HTTPS. Sign-in sessions and access tokens are stored only as
hashes, and we do not store passwords. No system is perfectly secure, so do
not store sensitive data on the demo server.

## Changes

We will post changes on this page and update the date above. If a change needs
your consent, we will ask for it again.
