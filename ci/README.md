# ci/

`deploy.yml` belongs at `.github/workflows/deploy.yml`.

It lives here because the token used to bootstrap this repo only had the `repo`
scope — GitHub refuses to accept a push that creates or edits a workflow file
unless the token also has `workflow`.

To activate it, either:

1. Re-issue a classic PAT with **`repo` + `workflow`**, then
   `git mv ci/deploy.yml .github/workflows/deploy.yml && git commit && git push`, or
2. Create the file through the GitHub web UI (browser sessions aren't scope-limited)
   and paste the contents of `ci/deploy.yml`.

Then set **Settings → Pages → Source = GitHub Actions**.

Until then the site is deployed from the `gh-pages` branch (`npm run build`, then
publish `dist/`). Both mechanisms produce the same URL; only one should be active.
