// App version + build time, injected at build (see vite.config define).
export const APP_VERSION = `v${__APP_VERSION__}`;

/** Build time formatted in Eastern time, e.g. "Jul 13, 2026 · 10:52 PM ET". */
export const BUILT_AT = new Date(__BUILD_TIME__).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: 'America/New_York',
}) + ' ET';
