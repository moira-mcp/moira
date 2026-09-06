/**
 * A bundle that ends its own process while loading. It reports nothing back, which is the case that
 * leaves a start with no answer at all — worse than an error, because nothing arrives to react to.
 */

process.exit(3);

export default { nodes: [] };
