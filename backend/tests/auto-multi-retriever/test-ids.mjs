// Test fixture constants — extracted from seed.mjs so test scripts
// can import these WITHOUT triggering seed.mjs's main() invocation
// (which would otherwise seed the DB every time a test loads it).
//
// To run the seed:
//   node tests/auto-multi-retriever/seed.mjs --test=A
//   node tests/auto-multi-retriever/seed.mjs --test=B
//   ... etc.
//   node tests/auto-multi-retriever/seed.mjs              # seed all
//   node tests/auto-multi-retriever/seed.mjs --clean       # tear down all

export const TEST_IDS = Object.freeze({
  userA:  "11111111-1111-1111-1111-00000000000a", // Test A — high-affinity surfaces
  userB:  "11111111-1111-1111-1111-00000000000b", // Test B — affinity + hard filter
  userC:  "11111111-1111-1111-1111-0000000000c0", // Test C — cold-start user
  userD:  "11111111-1111-1111-1111-00000000000d", // Test D — deterministic
  userF:  "11111111-1111-1111-1111-00000000000f", // Test F — 2-family split
  brandA: "22222222-2222-2222-2222-00000000000a", // brand "TestBrandA"
  brandB: "22222222-2222-2222-2222-00000000000b", // brand "TestBrandB"
  phoneA: "33333333-3333-3333-3333-00000000000a", // affinity-eligible (passes filters)
  phoneB: "33333333-3333-3333-3333-00000000000b", // affinity-ineligible (low RAM)
  phoneF1:"33333333-3333-3333-3333-00000f000001", // brand-A phone (for Test F)
  phoneF2:"33333333-3333-3333-3333-00000f000002", // brand-B phone (for Test F)
});
