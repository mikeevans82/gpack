import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import Conf from 'conf';
import open from 'open';
import inquirer from 'inquirer';
import picocolors from 'picocolors';
import http from 'http';
import { URL } from 'url';
import destroyer from 'server-destroy';

// Scope for accessing only files created by this app
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

interface TokenStore {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    expiry_date?: number;
    clientId?: string;
    clientSecret?: string;
}

const config = new Conf<TokenStore>({
    projectName: 'gpack-cli',
});

export async function getAuthenticatedClient(): Promise<OAuth2Client> {
    let clientId = config.get('clientId');
    let clientSecret = config.get('clientSecret');

    if (!clientId || !clientSecret) {
        throw new Error('Not logged in. Run `gpack login` first.');
    }

    const oAuth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        'http://localhost:3000/oauth2callback'
    );

    const tokens = {
        access_token: config.get('access_token'),
        refresh_token: config.get('refresh_token'),
        scope: config.get('scope'),
        token_type: config.get('token_type'),
        expiry_date: config.get('expiry_date'),
    };

    if (tokens.access_token) {
        oAuth2Client.setCredentials(tokens);
    } else {
        throw new Error('Not logged in. Run `gpack login` first.');
    }

    return oAuth2Client;
}

export async function loginFlow() {
    // Check if checks if user is already logged in
    if (config.get('access_token')) {
        console.log(picocolors.yellow('You are already logged in.'));
        console.log('Run `gpack logout` if you want to switch accounts or refresh credentials.');
        return;
    }

    console.log(picocolors.bold('Google Drive Login Setup'));
    console.log('You need a Google Cloud Project with the Drive API enabled.');
    console.log('1. Go to Cloud Resource Manager: ' + picocolors.underline('https://console.cloud.google.com/cloud-resource-manager'));
    console.log('   (Create a new project if needed)');
    console.log('2. Enable Drive API: ' + picocolors.underline('https://console.cloud.google.com/apis/library/drive.googleapis.com'));
    console.log('3. Create Credentials (OAuth Client ID): ' + picocolors.underline('https://console.cloud.google.com/apis/credentials/oauthclient'));
    console.log('   - Application type: "Desktop app"');

    // Check if we already have ID/Secret

    let clientId = config.get('clientId');
    let clientSecret = config.get('clientSecret');

    if (clientId && clientSecret) {
        console.log('Using saved Client ID and Secret.');
        const { parseNew } = await inquirer.prompt([{
            type: 'confirm',
            name: 'parseNew',
            message: 'Do you want to use different credentials?',
            default: false
        }]);
        if (parseNew) {
            clientId = '';
            clientSecret = '';
        }
    }

    if (!clientId || !clientSecret) {
        const answers = await inquirer.prompt([
            { type: 'input', name: 'clientId', message: 'Enter Client ID:' },
            { type: 'password', name: 'clientSecret', message: 'Enter Client Secret:' }
        ]);
        clientId = answers.clientId.trim();
        clientSecret = answers.clientSecret.trim();
        config.set('clientId', clientId);
        config.set('clientSecret', clientSecret);
    }

    // Use localhost redirect
    const oAuth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        'http://localhost:3000/oauth2callback'
    );

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });

    console.log('Authorize this app by visiting this url:');
    console.log(picocolors.underline(authUrl));
    await open(authUrl);

    // Create a local server to handle the callback
    const code = await new Promise<string>((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                if (req.url!.indexOf('/oauth2callback') > -1) {
                    const qs = new URL(req.url!, 'http://localhost:3000').searchParams;
                    res.end('Authentication successful! You can close this tab.');
                    (server as any).destroy();
                    resolve(qs.get('code')!);
                }
            } catch (e) {
                reject(e);
            }
        }).listen(3000, () => {
            // console.log('Listening on http://localhost:3000');
        });
        destroyer(server);
    });

    const { tokens } = await oAuth2Client.getToken(code.trim());
    oAuth2Client.setCredentials(tokens);

    if (tokens.access_token) config.set('access_token', tokens.access_token);
    if (tokens.refresh_token) config.set('refresh_token', tokens.refresh_token);
    if (tokens.scope) config.set('scope', tokens.scope);
    if (tokens.token_type) config.set('token_type', tokens.token_type);
    if (tokens.expiry_date) config.set('expiry_date', tokens.expiry_date);

    console.log(picocolors.green('Successfully authenticated!'));
}

export function logout() {
    config.delete('access_token');
    config.delete('refresh_token');
    config.delete('scope');
    config.delete('token_type');
    config.delete('expiry_date');
    config.delete('clientId');
    config.delete('clientSecret');
    console.log(picocolors.green('Logged out successfully. Credentials removed.'));
}

export async function findDriveFolderId(drive: any, path: string): Promise<string | null> {
    const parts = path.split('/').filter(p => p.trim().length > 0);
    let parentId = 'root';

    for (const part of parts) {
        const res = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${part}' and '${parentId}' in parents and trashed=false`,
            fields: 'files(id)',
            spaces: 'drive',
        });

        if (res.data.files && res.data.files.length > 0) {
            parentId = res.data.files[0].id;
        } else {
            return null;
        }
    }
    return parentId;
}

export async function ensureDriveFolder(drive: any, path: string): Promise<string> {
    const parts = path.split('/').filter(p => p.trim().length > 0);
    let parentId = 'root';

    for (const part of parts) {
        const res = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${part}' and '${parentId}' in parents and trashed=false`,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (res.data.files && res.data.files.length > 0) {
            parentId = res.data.files[0].id;
        } else {
            const folderMetadata = {
                name: part,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
            };
            const file = await drive.files.create({
                requestBody: folderMetadata,
                fields: 'id',
            });
            parentId = file.data.id;
        }
    }
    return parentId;
}
