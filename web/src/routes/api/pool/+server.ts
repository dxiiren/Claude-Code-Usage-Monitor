import { handle } from '$lib/server/api';
import { poolResponse } from '$lib/server/pool';

/** Read-only: totals from the local LLM pool ledger (no prompts exist in it). */
export const GET = () => handle(() => poolResponse());
