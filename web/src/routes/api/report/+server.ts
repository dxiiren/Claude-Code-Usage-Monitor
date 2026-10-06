import { json } from '@sveltejs/kit';
import { handle } from '$lib/server/api';
import { loadReport } from '$lib/server/reportData';

/** The report for a day, week or month: `?period=day|week|month&date=2026-10-06`. */
export const GET = ({ url }) => handle(() => json(loadReport(url.searchParams.get('period'), url.searchParams.get('date'))));
