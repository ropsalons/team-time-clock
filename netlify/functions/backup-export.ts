import { exportSnapshot } from './_shared/backup';

// Weekly automatic full-data backup (Mondays 09:00 UTC).
export default async (): Promise<Response> => {
  try {
    const r = await exportSnapshot();
    console.log(`[otc] weekly backup ${r.key} (${r.bytes} bytes, ${Object.values(r.counts).reduce((a, b) => a + b, 0)} rows)`);
    return new Response('ok');
  } catch (e) {
    console.error('[otc] weekly backup failed', e);
    return new Response('error', { status: 500 });
  }
};

export const config = { schedule: '0 9 * * 1' };
