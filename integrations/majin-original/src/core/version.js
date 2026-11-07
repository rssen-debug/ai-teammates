/**
 * The single place the version string lives.
 *
 * Everything that reports a version - the CLI banner, /healthz, /api/state, the `majin status` tool, the
 * installer's "MAJIN 0.1.1" display name and the update check's comparison - reads this. It is a literal
 * rather than a `package.json` import on purpose: the bundle, the pkg executable and the installer build
 * all have to agree without depending on where package.json ended up on disk, and a literal is the one form
 * that cannot fail to resolve in a packaged app. `test/version.test.js` is what keeps it honest: it fails if
 * package.json, the .iss default or the docs disagree, and it asserts the property that matters on a fresh
 * install - a program at the release it came from never reports an update.
 */
export const VERSION = '4.0.0-alpha.3';
