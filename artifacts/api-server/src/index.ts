import { createDb } from '@greystone/db';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { dbRepo } from './repo.db.js';

const config = configFromEnv();
const db = createDb();
const app = createApp(config, dbRepo(db));

const server = app.listen(config.port, () => {
  console.log(`api-server listening on ${config.baseUrl} (auth: ${config.oidc ? 'oidc' : 'none'}${config.devAuth ? ' + dev-login' : ''})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => db.$client.end().then(() => process.exit(0)));
  });
}
