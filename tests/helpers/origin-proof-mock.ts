/**
 * Shared helper for origin-proof fetch mocks (tests/workspace-origin.test.ts).
 * The proof URL always carries `?nonce=<32 hex chars>` — this pattern lets
 * tests assert the nonce query was present without knowing its value.
 */
export const PROOF_NONCE_QUERY = /nonce=[0-9a-f]{32}/;
