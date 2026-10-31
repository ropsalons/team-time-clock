import { requireEmployee, isAdmin } from './_shared/auth';
import { json, error } from './_shared/http';
import { exportSnapshot, backupStore } from './_shared/backup';

// Admin-only. GET -> list snapshots; GET ?key= -> download one; POST -> back up now.
export default async (req: Request): Promise<Response> => {
  try {
    const { roles } = await requireEmployee(req);
    if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');

    const store = backupStore();

    if (req.method === 'POST') {
      const r = await exportSnapshot();
      return json({ ok: true, ...r });
    }

    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    if (key) {
      const data = await store.get(key, { type: 'text' });
      if (!data) return error(404, 'not_found', 'That backup no longer exists.');
      return new Response(data, { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${key}"` } });
    }

    const { blobs } = await store.list();
    const items = await Promise.all(
      blobs.filter((b) => b.key.startsWith('otc-backup-')).map(async (b) => {
        const meta = await store.getMetadata(b.key);
        const m = (meta?.metadata ?? {}) as { created_at?: string; bytes?: number; counts?: Record<string, number> };
        const total = m.counts ? Object.values(m.counts).reduce((a, n) => a + n, 0) : null;
        return { key: b.key, created_at: m.created_at ?? null, bytes: m.bytes ?? null, rows: total };
      }),
    );
    items.sort((a, b) => b.key.localeCompare(a.key));
    return json({ ok: true, backups: items });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] backups error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/backups' };
