// Who runs this copy: the name in the menu, the mark beside it, and what downloaded documents
// carry. The values here are neutral; an organisation replaces this one file (and drops its logo
// files into web/static/) in its own build. The texts are only defaults: Settings can change them.
export const BRAND = {
	/** Side menu name. Text after a `*` is set lighter and in italics ("Acme*Usage"). */
	menuName: 'Claude Usage',
	/** Square mark for the side menu, e.g. '/brand-icon.svg'. Empty = the built-in neutral mark. */
	icon: '',
	/** Logo for the cover and page header of downloaded documents, e.g. '/brand-logo.png' (PNG). Empty = no logo. */
	logo: '',
	/** Logo height divided by its width. */
	logoRatio: 0.2,
	company: '',
	website: '',
	email: '',
	notice: 'This report is for internal use only. Do not share it outside the organisation without approval.',
	footer: 'Internal Use Only'
};
