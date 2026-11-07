import { json } from '@sveltejs/kit';
import { databaseStatus, schemaStatus } from '$lib/server/health';

// 503 when the database is down or lacks this build's migrations, so an uptime
// check sees the outage a page view would hit.
export async function GET() {
	const [database, schema] = await Promise.all([databaseStatus(), schemaStatus()]);
	const ok = database === 'ok' && schema === 'current';
	return json(
		{ status: ok ? 'ok' : 'degraded', app: 'remediate', database, schema },
		{ status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
}
