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

import { loadProjectConfig, saveProjectConfig } from './config.js';

interface AccountCredentials {
    access_token: string;
    refresh_token: string;
    scope?: string;
    token_type?: string;
    expiry_date?: number;
    clientId: string;
    clientSecret: string;
    email: string;
}

interface TokenStore {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    expiry_date?: number;
    clientId?: string;
    clientSecret?: string;
    
    accounts?: { [email: string]: AccountCredentials };
    activeEmail?: string;
}

const config = new Conf<TokenStore>({
    projectName: 'gpack-cli',
});

export async function getAuthenticatedClient(specifiedEmail?: string): Promise<OAuth2Client> {
    let email = specifiedEmail;
    
    if (!email) {
        const projConfig = await loadProjectConfig();
        email = projConfig?.accountEmail;
    }
    
    const accounts = config.get('accounts') || {};
    
    if (!email) {
        const emails = Object.keys(accounts);
        if (emails.length === 0) {
            // Legacy single-account fallback
            const oldClientId = config.get('clientId');
            const oldClientSecret = config.get('clientSecret');
            const oldAccessToken = config.get('access_token');
            if (oldClientId && oldClientSecret && oldAccessToken) {
                const oAuth2Client = new google.auth.OAuth2(
                    oldClientId,
                    oldClientSecret,
                    'http://localhost:3000/oauth2callback'
                );
                oAuth2Client.setCredentials({
                    access_token: oldAccessToken,
                    refresh_token: config.get('refresh_token'),
                    scope: config.get('scope'),
                    token_type: config.get('token_type'),
                    expiry_date: config.get('expiry_date'),
                });
                return oAuth2Client;
            }
            throw new Error('Not logged in. Run `gpack login` first.');
        } else if (emails.length === 1) {
            email = emails[0];
            const projConfig = await loadProjectConfig();
            if (projConfig && !projConfig.accountEmail) {
                projConfig.accountEmail = email;
                await saveProjectConfig(projConfig);
            }
        } else {
            if (!process.stdin.isTTY) {
                email = emails[0];
            } else {
                const { chosenEmail } = await inquirer.prompt([{
                    type: 'list',
                    name: 'chosenEmail',
                    message: 'Multiple logged-in accounts found. Choose one for this project:',
                    choices: emails,
                }]);
                email = chosenEmail;
                const projConfig = await loadProjectConfig();
                if (projConfig) {
                    projConfig.accountEmail = email;
                    await saveProjectConfig(projConfig);
                }
            }
        }
    }
    
    const account = accounts[email!];
    if (!account) {
        throw new Error(`Account ${email} is not logged in. Run \`gpack login\` to authenticate.`);
    }
    
    const oAuth2Client = new google.auth.OAuth2(
        account.clientId,
        account.clientSecret,
        'http://localhost:3000/oauth2callback'
    );
    
    oAuth2Client.setCredentials({
        access_token: account.access_token,
        refresh_token: account.refresh_token,
        scope: account.scope,
        token_type: account.token_type,
        expiry_date: account.expiry_date,
    });
    
    oAuth2Client.on('tokens', (tokens) => {
        const currentAccounts = config.get('accounts') || {};
        if (currentAccounts[email!]) {
            if (tokens.access_token) currentAccounts[email!].access_token = tokens.access_token;
            if (tokens.refresh_token) currentAccounts[email!].refresh_token = tokens.refresh_token;
            if (tokens.expiry_date) currentAccounts[email!].expiry_date = tokens.expiry_date;
            config.set('accounts', currentAccounts);
        }
    });
    
    return oAuth2Client;
}

export async function loginFlow() {
    const accounts = config.get('accounts') || {};
    const emails = Object.keys(accounts);
    
    if (emails.length > 0) {
        console.log(picocolors.bold('Currently logged-in accounts:'));
        emails.forEach(email => console.log(`- ${picocolors.green(email)}`));
        console.log();
        
        const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
                'Log in to a new Google Account',
                'Select an existing account for this project',
                'Exit'
            ]
        }]);
        
        if (action === 'Exit') return;
        if (action === 'Select an existing account for this project') {
            const { selectedEmail } = await inquirer.prompt([{
                type: 'list',
                name: 'selectedEmail',
                message: 'Select account:',
                choices: emails
            }]);
            const projConfig = await loadProjectConfig();
            if (projConfig) {
                projConfig.accountEmail = selectedEmail;
                await saveProjectConfig(projConfig);
                console.log(picocolors.green(`Associated this project with account: ${selectedEmail}`));
            } else {
                console.log(picocolors.yellow('Project not initialized. Run `gpack init` first.'));
            }
            return;
        }
    }
    
    console.log(picocolors.bold('Google Drive Login Setup'));
    console.log('You need a Google Cloud Project with the Drive API enabled.');
    console.log('1. Go to Cloud Resource Manager: ' + picocolors.underline('https://console.cloud.google.com/cloud-resource-manager'));
    console.log('   (Create a new project if needed)');
    console.log('2. Enable Drive API: ' + picocolors.underline('https://console.cloud.google.com/apis/library/drive.googleapis.com'));
    console.log('3. Create Credentials (OAuth Client ID): ' + picocolors.underline('https://console.cloud.google.com/apis/credentials/oauthclient'));
    console.log('   - Application type: "Desktop app"');
    
    let clientId = config.get('clientId');
    let clientSecret = config.get('clientSecret');
    
    if (!clientId || !clientSecret) {
        const firstEmail = Object.keys(accounts)[0];
        if (firstEmail) {
            clientId = accounts[firstEmail].clientId;
            clientSecret = accounts[firstEmail].clientSecret;
        }
    }
    
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
        });
        destroyer(server);
    });
    
    const { tokens } = await oAuth2Client.getToken(code.trim());
    oAuth2Client.setCredentials(tokens);
    
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    const about = await drive.about.get({ fields: 'user(emailAddress)' });
    const email = about.data.user?.emailAddress;
    
    if (!email) {
        throw new Error('Failed to retrieve user email from Google Drive API.');
    }
    
    const currentAccounts = config.get('accounts') || {};
    currentAccounts[email] = {
        access_token: tokens.access_token!,
        refresh_token: tokens.refresh_token!,
        scope: tokens.scope ?? undefined,
        token_type: tokens.token_type ?? undefined,
        expiry_date: tokens.expiry_date ?? undefined,
        clientId: clientId!,
        clientSecret: clientSecret!,
        email
    };
    config.set('accounts', currentAccounts);
    config.set('activeEmail', email);
    
    const projConfig = await loadProjectConfig();
    if (projConfig) {
        projConfig.accountEmail = email;
        await saveProjectConfig(projConfig);
    }
    
    console.log(picocolors.green(`Successfully authenticated and linked to account: ${email}`));
}

export async function logout() {
    const accounts = config.get('accounts') || {};
    const emails = Object.keys(accounts);
    
    if (emails.length === 0) {
        if (config.get('access_token')) {
            config.delete('access_token');
            config.delete('refresh_token');
            config.delete('scope');
            config.delete('token_type');
            config.delete('expiry_date');
            config.delete('clientId');
            config.delete('clientSecret');
            console.log(picocolors.green('Logged out from legacy account successfully.'));
            return;
        }
        console.log(picocolors.yellow('No accounts are currently logged in.'));
        return;
    }
    
    const { emailToLogout } = await inquirer.prompt([{
        type: 'list',
        name: 'emailToLogout',
        message: 'Select account to log out:',
        choices: [...emails, 'Log out from ALL accounts', 'Cancel']
    }]);
    
    if (emailToLogout === 'Cancel') return;
    
    if (emailToLogout === 'Log out from ALL accounts') {
        config.delete('accounts');
        config.delete('activeEmail');
        config.delete('access_token');
        config.delete('refresh_token');
        config.delete('scope');
        config.delete('token_type');
        config.delete('expiry_date');
        config.delete('clientId');
        config.delete('clientSecret');
        console.log(picocolors.green('Logged out from all accounts successfully.'));
    } else {
        delete accounts[emailToLogout];
        config.set('accounts', accounts);
        console.log(picocolors.green(`Logged out from ${emailToLogout} successfully.`));
        
        const projConfig = await loadProjectConfig();
        if (projConfig && projConfig.accountEmail === emailToLogout) {
            delete projConfig.accountEmail;
            await saveProjectConfig(projConfig);
            console.log(picocolors.yellow('Removed account association from current project.'));
        }
    }
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
