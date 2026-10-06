import { redirect } from '@sveltejs/kit';
import { UserError } from '$lib/server/db';
import { SERVER } from '$lib/server/paths';
import { loadReport } from '$lib/server/reportData';
import { getSettings } from '$lib/server/settings';

export const load = ({ url, locals }) => {
	if (!SERVER) redirect(303, '/');
	const s = getSettings();
	let report;
	try {
		report = loadReport(url.searchParams.get('period'), url.searchParams.get('date'));
	} catch (e) {
		// a hand-typed bad date in the address: show today instead of an error page
		if (!(e instanceof UserError)) throw e;
		report = loadReport(url.searchParams.get('period'), null);
	}
	return {
		report,
		view: s.reportView,
		doc: { title: s.docTitle, company: s.docCompany, website: s.docWebsite, email: s.docEmail, footer: s.docFooter, notice: s.docNotice, format: s.docFormat, cover: s.docCover, contents: s.docContents, logo: s.docLogo },
		canEditSlots: !!locals.user?.screens.includes('settings'),
		username: locals.user?.username ?? ''
	};
};
