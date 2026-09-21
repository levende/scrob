// Build identifier, injected by rollup via output.intro (see rollup.config.mjs).
// Falls back to 'dev' when the source runs unbundled.
export var BUILD = (typeof SCROB_BUILD !== 'undefined') ? SCROB_BUILD : 'dev'
