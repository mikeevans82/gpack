# gpack

gpack is a command-line tool to backup your coding projects to Google Drive by zipping them up.

## Features/Commands

- `gpack init`: Initialize a project, set storage location, and create `.gpackignore`.
- `gpack login`: Authenticate with your Google Account.
- `gpack logout`: Disconnect your account and remove credentials.
- `gpack push` (or just `gpack`): Backup the current project (zip & upload).
- `gpack list`: List backups and show storage usage for the current project.
- `gpack trim`: Reduce backup count (auto-keep last 5 or interactive).

## Installation

**Prerequisites**: Node.js installed (v18+ recommended).

### Quick Install (Run from anywhere)
```bash
npm install -g git+https://github.com/mikeevans82/gpack.git
```

### Manual Install (Development)

1.  **Clone or Download** this repository.
2.  **Install dependencies**:
    ```bash
    npm install
    # Build the project
    npm run build
    ```
3.  **Link globally** (optional, to run `gpack` from anywhere):
    ```bash
    npm link
    ```
    Now you can run `gpack` in any terminal.

## Setup Google Drive API

To use gpack, you need your own Google Cloud Project credentials (client ID and secret) currently, or you can use provided ones if available.

1.  Go to [Google Cloud Resource Manager](https://console.cloud.google.com/cloud-resource-manager).
2.  Create (or edit) a project.
3.  Enable **Google Drive API** in that project.
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
