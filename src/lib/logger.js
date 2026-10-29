/**
 * One JSON line per event. No log framework: the hosting platform collects
 * stdout, and a dependency here is a dependency in every file.
 *
 * Never log a secret. `fields` is serialised as given, so passing a credential
 * or a whole Morning response body puts it in the platform's log store, and in
 * the case of a webhook secret, somewhere it can be read back.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

function emit(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, event, ...fields };
  const text = JSON.stringify(line, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value);
  if (level === 'error' || level === 'warn') console.error(text);
  else console.log(text);
}

export const log = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
