# gpack

gpack is a command-line tool to backup your coding projects to Google Drive by zipping them up.

## Features/Commands

- `gpack init`: Initialize a project, set storage location, and create `.gpackignore`.
- `gpack login`: Authenticate with your Google Account.
- `gpack push` (or just `gpack`): Backup the current project (zip & upload).
- `gpack list`: List backups and show storage usage for the current project.
- `gpack trim`: Reduce backup count (auto-keep last 5 or interactive).

## Installation

1.  **Prerequisites**: Node.js installed (v18+ recommended).
2.  **Clone or Download** this repository.
3.  **Install dependencies**:
    ```bash
    npm install
    # Build the project
    npm run build
    ```
4.  **Link globally** (optional, to run `gpack` from anywhere):
    ```bash
    npm link
    ```
    Now you can run `gpack` in any terminal.

## Setup Google Drive API

To use gpack, you need your own Google Cloud Project credentials (client ID and secret) currently, or you can use provided ones if available.

1.  Go to [Google Cloud Console](https://console.cloud.google.com/).
2.  Create a new project.
3.  Enable **Google Drive API**.
4.  Go to **Credentials** -> **Create Credentials** -> **OAuth client ID**.
5.  Application type: **Desktop app**.
6.  Copy the **Client ID** and **Client Secret**.
7.  Run `gpack login` and follow the prompts to enter these credentials.

### Important Note on "Production" Mode (Recommended)

To avoid your login expiring every 7 days:
1.  Go to **APIs & Services** -> **OAuth consent screen** in your Google Cloud Console.
2.  Click **Publish App** (or set status to **Production**).
3.  Confirm the push to production.
4.  You *do not* need to submit for verification.
5.  When you login, you will see a "Google hasn't verified this app" warning.
6.  Click **Advanced** -> **Go to (Project Name) (unsafe)**. This is safe for your own private app.

### FAQ: Why do I need a Google Cloud Project?

**Q: Does every user need to create a project?**
A: **Yes**, unless the app maintainer (you) goes through Google's "App Verification" process.

**The Trade-off:**
1.  **Bring Your Own Key (Recommended for Dev Tools):** correct way for open-source tools. Each user creates their own project. It's secure, free, and you own your data/quotas.
2.  **Shared Credentials (Unverified):** You *could* share your `client_id` and `client_secret` with others.
    -   **Pros:** Users don't need to setup Cloud Console.
    -   **Cons:** Users will see a scary "Google hasn't verified this app" warning. You might hit API rate limits if many people use it.
3.  **Verified App (Commercial/SaaS):** The maintainer submits the app to Google for a security review (can cost $15k+ annually for restricted scopes like Drive, though sometimes free for small tools). This removes the scary warnings and allows one set of credentials for everyone.

**Summary:** For a free, open-source CLI tool, asking developers to "Bring Your Own Key" is the standard practice (used by tools like `rclone`) to avoid security/quota issues.

## Usage

1.  Navigate to your project folder.
2.  Run `gpack init`.
    - Accept default `GPACK/ProjectName` or customize.
3.  Run `gpack login` (first time only).
4.  Run `gpack` to backup.

## Backup Naming

Backups are named using the following pattern:
`ProjectName_YYYY-MM-DDTHH-mm-ss-mssZ.zip`

For example: `gpack_2024-01-30T14-55-00-123Z.zip`


## Configuration

- Project config is stored in `.gpack/config.json`.
- Ignore rules are in `.gpackignore` (syntax similar to .gitignore). Default ignores: `node_modules`, `.git`, `dist`.
