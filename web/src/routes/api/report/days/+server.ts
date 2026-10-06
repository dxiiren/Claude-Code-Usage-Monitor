import { json } from '@sveltejs/kit';
import { handle } from '$lib/server/api';
import { daysWithData } from '$lib/server/reportData';

/** Which days of `?month=2026-10` have readings (the dots in the report calendar). */
export const GET = ({ url }) => handle(() => json({ days: daysWithData(url.searchParams.get('month')) }));
