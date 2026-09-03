import { createDb } from '@greystone/db';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { dbRepo } from './repo.db.js';
import { mailerFor } from './services/mail.js';
import { startDigestScheduler } from './services/notify.js';

const config = configFromEnv();
const db = createDb();
const repo = dbRepo(db);
const mailer = mailerFor(config.mail);
const app = createApp(config, repo, { mailer });
const digest = startDigestScheduler({ repo, mailer, origin: config.appOrigin, appName: config.appName }, config.digestHourUtc);

const server = app.listen(config.port, () => {
  console.log(`api-server listening on ${config.baseUrl} (auth: ${config.oidc ? 'oidc' : 'none'}${config.passwordAuth ? ' + password' : ''}${config.devAuth ? ' + dev-login' : ''}; mail: ${mailer.kind}${config.digestHourUtc >= 0 ? `; renewal digest at ${config.digestHourUtc}:00 UTC` : ''})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    digest.stop();
    server.close(() => db.$client.end().then(() => process.exit(0)));
  });
}
