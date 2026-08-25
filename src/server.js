import { createApp } from './app.js';
import { config, validateConfig } from './config.js';
import { logger } from './lib/logger.js';

const problems = validateConfig(config);
if (problems.length) {
  process.stderr.write(
    `\nThe bridge cannot start until these are fixed:\n${problems.map((p) => ` - ${p}`).join('\n')}\n\n` +
      `Copy .env.example to .env and fill it in, then run \`npm run discover\` to find your pipeline, stage and field ids.\n\n`,
  );
  process.exit(1);
}

const { app, queue, processor } = createApp({ config });

const server = app.listen(config.port, () => {
  logger.info('bridge listening', {
    port: config.port,
    webhookUrl: `http://<this-server>:${config.port}/webhooks/pylon`,
    dryRun: config.dryRun,
    locationId: config.ghl.locationId,
  });
  queue.resume();

  // Resolve pipeline/stage names up front so a typo is reported at boot rather
  // than at 2am when the first contract is signed.
  processor
    .resolveTargets()
    .catch((error) => logger.error('could not resolve the GoHighLevel pipeline/stage at startup', { error }));
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  queue.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }));
