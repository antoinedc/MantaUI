// Stand-in for `@opencode/plugin` (V2) so the plugin entry can be imported under
// plain Node in unit tests. In the real binary the package is bundled in and
// `Plugin.define` returns the definition object it is given.

export const Plugin = { define: (definition) => definition };
