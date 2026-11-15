# Current site in Papyrus Midnight (test only)

`build.py` rethemes a copy of the live marketing site's build (`thoth-site/dist/`) as Papyrus Midnight by adding one
stylesheet. The site's palette is a dozen CSS variables plus about 20 literal colours, so nothing in the site repository
changes. All 77 pages are rethemed, and the script fails if any of its 32 text/background pairs is below WCAG AA.

    python3 docs/design/site-test/build.py ../thoth-site/dist /tmp/thoth-site-test/midnight
    python3 -m http.server 4802 --bind 127.0.0.1 -d /tmp/thoth-site-test/midnight

The site belongs to the Head of Marketing thread. This is for the owner to compare looks, not a change to the site.
