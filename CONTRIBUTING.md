# Contributing to Thoth

Thanks for helping. Thoth is licensed under [Apache-2.0](LICENSE). By
contributing you agree that your contribution is licensed the same way.

## Sign your commits (DCO)

Thoth uses the [Developer Certificate of Origin](DCO) (DCO 1.1) instead of a
contributor license agreement. You keep the copyright to your work. Each commit
must carry a sign-off line certifying the DCO:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it, using your `user.name` and `user.email`. Use a real
name and an email you can be reached at. To sign off commits you already made:

```sh
git rebase --signoff main
```

Pull requests with unsigned commits cannot be merged.

## Before you open a pull request

```sh
pnpm install
pnpm check   # type checks, schema/OpenAPI drift checks, all tests
pnpm e2e     # end-to-end tests, when you changed the app, importer or host
```

Read the relevant ADR in [`docs/adr/`](docs/adr/) first. Changing a decision an
ADR records needs a new or amended ADR in the same pull request.

Do not commit real exports, personal notes or secrets as test fixtures. Build
fixtures from synthetic content (see [`tests/fixtures/README.md`](tests/fixtures/README.md)).
