# Test order cleanup website

Two pages, hosted on Vercel:

| Page | Who | What |
|---|---|---|
| `/` | Anyone with the link, no login | Enter a phone number and a date: deletes that number's test orders placed since then, and shows what was deleted. Only numbers on the approved list work. |
| `/admin` | People with **Write** access to the `Test_Orders_Cleanup` repo, signed in with GitHub | Automatic deletion on/off, how often it runs, preview the orders that would be deleted and delete them, manage approved numbers, recent runs. |

Add someone as a collaborator on the repo and they get the admin page the next
time they sign in. Remove them and they lose it.

## How it stays safe without a login

- The public page only accepts numbers on `self_service_phone_numbers` in
  `config/test_accounts.yaml` (managed from the admin page). Anything else is
  refused, so nobody can delete a real customer's orders.
- Those runs delete **only** orders from the numbers typed in, never the name
  list, at most 100 orders, and only within the last 90 days.
- At most 3 self-service runs at once.
- The website's GitHub token is stored in Vercel and never sent to the browser.
- Admin actions use the signed-in person's own GitHub access, so every run
  shows who started it.

## Setup (about 20 minutes)

### 1. Create the website's GitHub token
github.com → profile picture → Settings → Developer settings → Personal access
tokens → **Fine-grained tokens** → Generate new token.

- Resource owner: the account that owns `Test_Orders_Cleanup`
- Repository access: **Only select repositories** → `Test_Orders_Cleanup`
- Repository permissions: **Actions: Read and write**, **Contents: Read-only**
  (Metadata read-only is added automatically)
- Expiration: up to a year. Put a reminder in your calendar to renew it.

Copy the token (starts with `github_pat_`).

### 2. Put the website on Vercel
1. Create a GitHub repo `cleanup-panel` (Private is fine) and upload all files
   from this folder: `api`, `lib`, `index.html`, `admin.html`, `package.json`,
   `package-lock.json`, `vercel.json`, `README.md`.
2. vercel.com → Add New → Project → import `cleanup-panel` → Framework Preset
   **Other** → Deploy.
3. Note the address Vercel gives you, e.g. `https://cleanup-panel.vercel.app`.

### 3. Create the GitHub sign-in app (for /admin)
github.com → Settings → Developer settings → **OAuth Apps** → New OAuth App.

- Application name: `HomeRun test order cleanup`
- Homepage URL: `https://cleanup-panel.vercel.app` (your address)
- Authorization callback URL: `https://cleanup-panel.vercel.app/api/auth/callback`

Register, copy the **Client ID**, click **Generate a new client secret** and
copy it.

### 4. Add the settings in Vercel
Vercel → your project → Settings → Environment Variables. Add:

| Name | Value |
|---|---|
| `GITHUB_REPO_OWNER` | `anushkashukla-cpu` (or the organization after a transfer) |
| `GITHUB_REPO_NAME` | `Test_Orders_Cleanup` |
| `GITHUB_SERVER_TOKEN` | the token from step 1 |
| `GITHUB_OAUTH_CLIENT_ID` | from step 3 |
| `GITHUB_OAUTH_CLIENT_SECRET` | from step 3 |
| `SESSION_SECRET` | any random text of 40+ characters (in Terminal: `openssl rand -hex 32`) |

Then Deployments → the latest one → **⋯** → **Redeploy**, so the settings take effect.

### 5. Try it
1. Open `/admin`, click **Sign in with GitHub**, approve.
2. Under "Numbers allowed on the self-service page", add your number.
3. Open `/`, enter that number and a date, click **Delete my test orders**.

If people see a Vercel login screen instead of the page, turn it off in
Vercel → Settings → **Deployment Protection** (protect previews only).

## When several people use it at once
Runs started by people run side by side. If two runs reach the same order,
the second one sees it's already gone and marks it "Already deleted" instead
of failing. Scheduled runs never overlap each other.

## Notes
- Orders placed in the last 30 minutes are skipped so Zoho can finish syncing.
- Reports are kept for 30 days (GitHub's artifact retention).
- If the repo moves to an organization, update `GITHUB_REPO_OWNER`, create a
  new server token for the new owner, and redeploy.

## Development
```
npm install
node --test test/api.test.js
```
