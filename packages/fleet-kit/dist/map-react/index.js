// @fleet-kit/core/map-react - React map components.
//
// Separate from ./map because that subpath is deliberately framework-agnostic:
// it holds pure TS (types, fit maths, layer compilation) with deck.gl and h3-js
// as its only peers. React and maplibre-gl are peers of THIS subpath only, and
// are declared optional in package.json so a consumer that imports ./map alone
// is not asked to supply them.
export { default as Basemap } from './basemap';
//# sourceMappingURL=index.js.map