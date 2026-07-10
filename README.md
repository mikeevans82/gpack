# gpack

gpack is a command-line tool to backup your coding projects to Google Drive by zipping them up.

## Features/Commands

- **Interactive Menu (`gpack`)**: Run `gpack` with no arguments to open an interactive dashboard showing project status, configured Google Drive destination, linked Google account, last backup time, change status, and option selections.
- `gpack init`: Initialize a project, set storage location, and create `.gpackignore`.
- `gpack login`: Authenticate with your Google Account. Supports logging into multiple accounts simultaneously and switching or linking them to specific projects.
- `gpack logout`: Disconnect your account and remove credentials. Supports logging out of a single account or all accounts.
- `gpack push` (or `gpack backup`): Backup the current project (zip & upload). It checks if changes occurred before creating a new backup unless overridden.
- `gpack list`: List backups and show storage usage for the current project.
- `gpack trim`: Reduce backup count (auto-keep last 5, custom N, or interactive deletion).
- `gpack load` (or `gpack restore`): List and download backups of the project from Google Drive, and restore/extract the files back into the project.

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
2.  Run `gpack init` to configure the Google Drive destination folder.
3.  Run `gpack login` to log in to one or more Google Accounts. If multiple accounts are logged in, you can link the project to a specific account.
4.  Run `gpack` with no arguments to launch the interactive menu, or run `gpack push` to perform a quick backup.

## Smart Change Checking

To save storage and avoid duplicate backups, `gpack` performs a validation check before zipping and uploading:
- **For Git Projects**: Checks if any new commits have been made since the last backup date, and checks for uncommitted changes (`git status --porcelain`).
- **For Non-Git Projects**: Recursively walks the directory (ignoring node_modules, build outputs, and config files) to check if any file's modification time is newer than the last backup.
- **Bypassing the check**: You can override the change check and force a backup by running:
  ```bash
  gpack push --force
  # or
  gpack push -f
  ```
  You will also be asked if you want to force a backup if you choose the "Make a Backup" option in the interactive menu when no changes are present.

## Restoring Backups

To restore a backup, run:
```bash
gpack load
# or select "Load / Restore a Backup" in the interactive menu
```
This lists your backups on Google Drive, downloads your selected zip file to a temporary location, extracts it using the native system `tar` command (preserving your file structure), and cleans up.

## Backup Naming

Backups are named using the following pattern:
`ProjectName_YYYY-MM-DDTHH-mm-ss-mssZ.zip`

For example: `gpack_2024-01-30T14-55-00-123Z.zip`


## Configuration

- Project config is stored in `.gpack/config.json`.
- Ignore rules are in `.gpackignore` (syntax similar to .gitignore). Default ignores: `node_modules`, `.git`, `.gpack`, `dist`, `coverage`, `.env`.
