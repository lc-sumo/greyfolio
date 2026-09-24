import { createDb } from '@greystone/db';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { dbRepo } from './repo.db.js';
import { mailerFor } from './services/mail.js';
import { startDigestScheduler } from './services/notify.js';
import { ensureStarterPlaybooks, startPlaybookScheduler } from './services/playbooks.js';
import { ensureSuperAdmin } from './services/superadmin.js';

const config = configFromEnv();
const db = createDb();
const repo = dbRepo(db);
const mailer = mailerFor(config.mail);
const app = createApp(config, repo, { mailer });
const digest = startDigestScheduler({ repo, mailer, origin: config.appOrigin, appName: config.appName }, config.digestHourUtc);
const playbooks = startPlaybookScheduler({ repo, mailer, origin: config.appOrigin, appName: config.appName });
void ensureSuperAdmin(repo, config.superAdminEmail)
  .then(async (r) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', superAdmin: config.superAdminEmail, created: r.created }));
    // First run: nobody has a password yet. The setup screen needs this code, so it cannot be claimed by a passer-by.
    if (config.passwordAuth && !config.oidc && (await repo.repsWithPassword()).length === 0) console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', setup: 'open', setupCode: config.setupToken, hint: 'Enter this code on the sign-in screen to set the first admin password (or set SETUP_TOKEN)' }));
  })
  .catch((e) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', superAdmin: String(e) })));
void ensureStarterPlaybooks(repo).catch((e) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', playbooks: String(e) })));

const server = app.listen(config.port, () => {
  console.log(`api-server listening on ${config.baseUrl} (auth: ${config.oidc ? 'oidc' : 'none'}${config.passwordAuth ? ' + password' : ''}${config.devAuth ? ' + dev-login' : ''}; mail: ${mailer.kind}${config.digestHourUtc >= 0 ? `; renewal digest at ${config.digestHourUtc}:00 UTC` : ''})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    digest.stop();
    playbooks.stop();
    server.close(() => db.$client.end().then(() => process.exit(0)));
  });
}
