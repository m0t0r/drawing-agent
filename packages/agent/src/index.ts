// The package root is intentionally bare. Consumers import the area they need
// through a subpath — `@repo/agent/loop`, `@repo/agent/canvas/ops`,
// `@repo/agent/scorers/overlaps` — so that the browser bundle never pulls in the
// eval-only half of the package by way of a barrel.
export {};
