<script lang="ts">
	import { level, pctText, resetsIn } from './format';

	interface Props {
		label: string;
		title: string;
		pct: number | null | undefined;
		resetsAt: number | null | undefined;
		now: number;
		seconds?: boolean;
	}
	let { label, title, pct, resetsAt, now, seconds = false }: Props = $props();

	const lv = $derived(level(pct));
	const width = $derived(pct === null || pct === undefined ? 0 : Math.max(1, Math.min(100, pct)));
</script>

<div class="row" data-level={lv}>
	<span class="lab" {title}>{label}</span>
	<div
		class="track"
		role="meter"
		aria-label="{title} used"
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={pct ?? 0}
	>
		<div class="fill" style:width="{width}%"></div>
	</div>
	<span class="val">
		<strong>{pctText(pct)}</strong>
		{#if lv === 'full'}<span class="blocked">limit reached</span>{/if}
		<span class="reset">
			{#if pct === null || pct === undefined}no data{:else}resets in {resetsIn(resetsAt, now, seconds)}{/if}
		</span>
	</span>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: 2rem minmax(3rem, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
	}
	.lab {
		color: var(--muted);
		font-weight: 500;
	}
	.track {
		height: 6px;
		border-radius: 3px;
		background: var(--track);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: 3px;
		background: var(--green);
		transition: width 0.4s ease;
	}
	[data-level='warn'] .fill {
		background: var(--amber);
	}
	[data-level='high'] .fill,
	[data-level='full'] .fill {
		background: var(--red);
	}
	[data-level='full'] .track {
		outline: 1px solid var(--red);
		outline-offset: 1px;
	}
	.val {
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.val strong {
		font-weight: 600;
		min-width: 2.6rem;
		text-align: right;
	}
	.blocked {
		color: var(--red);
		font-weight: 600;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.reset {
		color: var(--muted);
		font-size: 0.75rem;
	}
	@media (max-width: 520px) {
		.row {
			grid-template-columns: 2rem 1fr;
			row-gap: 0.15rem;
		}
		.val {
			grid-column: 2;
		}
		.val strong {
			min-width: 0;
			text-align: left;
		}
	}
</style>
