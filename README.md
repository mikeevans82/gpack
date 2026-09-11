# gpack

gpack is a command-line tool to backup your coding projects to Google Drive.

Backups are incremental. Each push uploads only what changed, and any file above
25 MB is stored once by content hash and then referenced by every later backup,
so a large asset is never uploaded twice.

## Features/Commands

- **Interactive Menu (`gpack`)**: Run `gpack` with no arguments to open an interactive dashboard showing project status, configured Google Drive destination, linked Google account, last backup time, change status, and option selections.
- `gpack init`: Initialize a project, set storage location, and create `.gpackignore`.
- `gpack login`: Authenticate with your Google Account. Supports logging into multiple accounts simultaneously and switching or linking them to specific projects.
- `gpack logout`: Disconnect your account and remove credentials. Supports logging out of a single account or all accounts.
- `gpack push` (or `gpack backup`): Back up the current project. Uploads only changed files. `--force` backs up even with no changes; `--full` repacks every file instead of writing an incremental.
- `gpack list`: List restore points and show how much is actually stored on Drive.
- `gpack trim`: Reduce backup count (auto-keep last N, or interactive deletion). Dependency-aware, so it never deletes data a newer backup still needs.
- `gpack load` (or `gpack restore`): List and restore backups. `--clean` also deletes local files that are not part of the selected backup.

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

## How Incremental Backups Work

Every push writes two things to Drive: an archive holding the files that
changed, and a manifest describing the complete project tree at that moment.
Because the manifest is complete rather than a delta, restoring reads one
manifest and immediately knows every file and where its bytes live.

Files are handled in two ways depending on size:

- **Under 25 MB**: packed into the push's archive when their contents changed.
  Unchanged files carry a pointer to the older archive that already holds them.
- **25 MB and over**: stored as a single object named by its SHA-256 hash. Once
  a given file's contents are on Drive they are never uploaded again, not even
  during a full backup. This is what keeps large assets from being re-sent.

Every tenth push writes a full backup, which repacks the small files so chains
stay short. Large files are still resolved by hash, so a full backup of a
project dominated by big assets costs almost nothing.

`gpack trim` understands these dependencies. Deleting an old backup keeps its
archive if a newer backup still points into it, and any stored large file that
nothing references any more is deleted.

You can tune both thresholds in `.gpack/config.json`:

```json
{
  "backupFolder": "GPACK/my-project",
  "fullEvery": 10,
  "largeFileThreshold": 26214400
}
```

## Smart Change Checking

Before packing anything, gpack compares the hash of every file against the last
manifest, so a backup runs only when contents actually differ. Editing a file
and undoing the edit correctly reports no change.

- **Before the first incremental backup**: there is no manifest to compare
  against, so gpack falls back to timestamps. For git projects it checks for new
  commits and uncommitted changes; otherwise it compares file modification times
  against the last backup.
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
This lists your restore points, downloads only the archives and large files the
selected point actually needs, rebuilds that exact tree in a temporary staging
directory, and then copies it into your project.

By default existing files are overwritten and unrelated local files are left
alone. To make the project match the backup exactly, deleting local files the
backup does not contain, run:

```bash
gpack load --clean
```

Backups made before incremental support have no manifest. They still restore,
by extracting the whole archive over the current directory, and are marked
`legacy` in listings.

## Backup Naming

Backups are named using the following pattern:
`ProjectName_YYYY-MM-DDTHH-mm-ss-mssZ.zip`

For example: `gpack_2024-01-30T14-55-00-123Z.zip`


## Configuration

- Project config is stored in `.gpack/config.json`.
- A local hash cache lives in `.gpack/state.json`. It only makes scans faster;
  deleting it costs one re-hash pass and nothing else.
- Ignore rules are in `.gpackignore` (gitignore syntax). Default ignores:
  `node_modules`, `.git`, `.gpack`, `.claude`, `dist`, `coverage`, `.env`.

`.claude` is excluded because Claude Code keeps git worktrees under it. Each one
is a full second copy of your project, so without the rule every backup stores
your source twice and churns whenever a worktree is created or removed.

A bare directory name such as `node_modules` now excludes the whole directory.
Earlier versions matched only the top-level entry, so the contents were archived
anyway; if your existing backups look far larger than your project, that is why.

### Layout on Google Drive

```
GPACK/<project>/
  <project>_<timestamp>.zip   a restore point's archive
  _gpack_meta/                one manifest per restore point
  _gpack_blobs/               large files, stored once and named by hash
```
