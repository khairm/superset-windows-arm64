import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
	sourceLocale: "en",
	locales: [
		"en",
		"ja",
		"zh-CN",
		"fr",
		"ko",
		"zh-TW",
		"es",
		"de",
		"pt-BR",
		"it",
		"ru",
		"tr",
		"pl",
		"nl",
		"id",
		"cs",
		"vi",
	],
	// Origins follow filesystem order, which differs between macOS and Linux
	// and would dirty the CI diff.
	format: formatter({ origins: false }),
	orderBy: "message",
	compileNamespace: "ts",
	catalogs: [
		{
			path: "<rootDir>/locales/{locale}/messages",
			include: [
				"<rootDir>/../../apps/desktop/src",
				"<rootDir>/../../apps/web/src",
				"<rootDir>/../../apps/marketing/src",
				"<rootDir>/../../apps/admin/src",
				"<rootDir>/../../apps/docs/src",
				"<rootDir>/../../apps/mobile/app",
				"<rootDir>/../../apps/mobile/screens",
				"<rootDir>/../../apps/mobile/components",
				"<rootDir>/../../apps/mobile/hooks",
				"<rootDir>/../../apps/mobile/lib",
				"<rootDir>/../../packages/ui/src",
				"<rootDir>/../../packages/chat-ui/src",
				"<rootDir>/../../packages/shared/src",
				"<rootDir>/src",
			],
			// (I18N-UPSTREAM-BACKFILL) Excludes are matched against the CWD the
			// CLI runs in, which is this package — so a bare pattern never
			// reaches the cross-app roots above and upstream's
			// `<Trans id="greeting" />` test fixture extracted as a real
			// message no locale could ever translate. The root-anchored twins
			// cover the whole repo; the bare ones stay for this package.
			exclude: [
				"**/node_modules/**",
				"**/*.test.*",
				"**/*.stories.*",
				"<rootDir>/../../**/*.test.*",
				"<rootDir>/../../**/*.stories.*",
			],
		},
	],
});
