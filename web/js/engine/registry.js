/**
 * Engine registry so backends stay swappable.
 */

/** @type {Map<string, () => import('./types.js').Engine>} */
const factories = new Map();

/**
 * @param {string} id
 * @param {() => import('./types.js').Engine} factory
 */
export function registerEngine(id, factory) {
  factories.set(id, factory);
}

/**
 * @param {string} id
 * @returns {import('./types.js').Engine}
 */
export function createEngine(id) {
  const factory = factories.get(id);
  if (!factory) {
    throw new Error(`unknown engine: ${id}`);
  }
  return factory();
}

/**
 * @returns {string[]}
 */
export function listEngines() {
  return [...factories.keys()];
}
