/**
 * THE REAL POLICY TEMPLATES, read from chain 2026-09-25.
 *
 * Publisher `ZTX3QFo5oc3Ep8rdJZKgfPDFNN29qjxn5ofED` on the deployed Template contract
 * `ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5` (Zetrix testnet), via
 * `listTemplateKeys` → `["native-v1","ztp20-v1"]` then `getTemplate` for each.
 *
 * WHY THIS FILE EXISTS. BT-2792 shipped `policy_preflight` before any template existed on chain, so
 * its vocabulary was invented from a field guide and then pinned by fixtures using the same invented
 * values — `uint`, `bool`, `RECIPIENT_LIST`. The tests were thorough, self-consistent, and validated
 * against nothing real. Measured against these templates, the type check and the empty-list blocker
 * both turned out to do nothing at all (BT-3000).
 *
 * So: fixtures here are COPIED FROM CHAIN, not written by hand. A fixture that could not exist on
 * chain is the defect, not a convenience. If these need updating, re-read them rather than editing
 * them to suit a test.
 */

/** The attribute types the deployed Template contract accepts — its own `VALID_ATTRIBUTE_TYPES`. */
export const VALID_ATTRIBUTE_TYPES = [
  'ADDRESS',
  'STRING',
  'NUMBER',
  'ADDRESS_LIST',
  'STRING_LIST',
  'NUMBER_LIST',
] as const

/** `native-v1` — 11 attributes. Native ZTX: no token address, no method list. */
export const NATIVE_V1 = {
  found: true,
  attributes: [
    { attributeName: 'assetScope', attributeType: 'STRING' },
    { attributeName: 'perTransactionMax', attributeType: 'NUMBER' },
    { attributeName: 'cumulativeMax', attributeType: 'NUMBER' },
    { attributeName: 'cumulativeWindow', attributeType: 'STRING' },
    { attributeName: 'velocityCap', attributeType: 'NUMBER' },
    { attributeName: 'velocityWindow', attributeType: 'STRING' },
    { attributeName: 'maxTransactionCount', attributeType: 'NUMBER' },
    { attributeName: 'countWindow', attributeType: 'STRING' },
    { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST' },
    { attributeName: 'recipientDenylist', attributeType: 'ADDRESS_LIST' },
    { attributeName: 'unknownAttributePolicy', attributeType: 'STRING' },
  ],
  templateAttributeIds: {
    assetScope: 'ae29f7ce809e95b005744cd302965c37e0a91e8fa27d8e2a560597a99cf0eaeb',
    perTransactionMax: 'ed96a58cfb652fddcc25df1a83ad16d202263349f8f765c92d5763cdba9e3d34',
    cumulativeMax: 'cfddf0644e3d02a3382126b387c5b345497d28ab178e27c2e5f3a5cff8f371c6',
    cumulativeWindow: 'bf86e68018c1918c73a67d20649b264fa6551b41f2892dff22602fd8e570250b',
    velocityCap: 'ba8ac24b560a7acbad9f475e542b8e5c8f3e14c93d2a60f3713bd96889934047',
    velocityWindow: 'be8bd9f2ea42f24d974daad3f023c24be6ae8a74c63e6f71ca697fb057642686',
    maxTransactionCount: '1ca72d69c413ae2d762a56abb2595dec24f281463d32969ab3e1b8fd79e00682',
    countWindow: 'f555966b73b396b5ca0e1890025ca67e08913b838c070c2f409d66f332cd9fca',
    recipientAllowlist: 'b3713f9e2a3aad8e7bdd64a02a37d4a4e7fbbcbe0d717fabbe8725465c2d4b1b',
    recipientDenylist: 'bde07370086af3d1e4c74bdd39067db7a5fb073185c3caf20c4dbe2a409f047b',
    unknownAttributePolicy: '11b969414be97e021ab713b2b693fc231577c2a130a6712d6c431c3dad315934',
  },
} as const

/** `ztp20-v1` — `native-v1` plus `tokenAddress` and `allowedMethods`. */
export const ZTP20_V1 = {
  found: true,
  attributes: [
    ...NATIVE_V1.attributes,
    { attributeName: 'tokenAddress', attributeType: 'ADDRESS' },
    { attributeName: 'allowedMethods', attributeType: 'STRING_LIST' },
  ],
  templateAttributeIds: {
    assetScope: 'f774cf85871c8ad48a64aa0050c730cc996aa0b118db8654ed31e0ddfab99151',
    perTransactionMax: '9e1eec5d6410c06b49dff6fed03df2a373d0490fe2950a72eed235b7a9d6c690',
    cumulativeMax: '2c9559df1ccb76c340bbe8bb6ebe17ddbe745c3664616e9709d835bc5634a8f4',
    cumulativeWindow: '1a2556b795d313c2a9ba2fadfe47bbfbed3fe5b7a6b96ac5b7fbc8801f91ea49',
    velocityCap: 'ec52ba76346642ed00287f141697435554a0725aceb23d04650d638e64a50482',
    velocityWindow: '1639434469594b968988527495e6b959259c17fa80d62c9c932bd7ec646f841a',
    maxTransactionCount: 'd62b17f317e608a6d447e248336793bef84d5950e38bfc1871b4b8bbfe61765d',
    countWindow: 'dba1a64801b3d8cb44bbebd1561f8f41d74b0370c55bf4bf7635c4057daef193',
    recipientAllowlist: '15bb3b96fcd4ce791bb99760e982f6f9a0b210ba2c178645b156ecf8f821504c',
    recipientDenylist: 'e12be5826550fdbade5cc0a7cf62bd696294469ba489dccf215470fe6d92e9f3',
    unknownAttributePolicy: 'fa8b8d07100685da082fa8e6779477e7c23e65a34c3520db7df5e168d0c40926',
    tokenAddress: 'e468af585d2e9334c47d4b91b2b8544d077054a607dc5a6b5f82bc76c13c9df5',
    allowedMethods: '965ec81d29489fc770b671af2ed3734ac478814d6576be82a1fab28ab8da1c12',
  },
} as const

/**
 * A `getPolicy` envelope exactly as the owner's Policy Contract returns it — the policy NESTED
 * under `policy`, with a `policyAttributeIds` sibling. Read from the contract source the Factory
 * deploys:
 *
 *   return { found: true, policy: policy, policyAttributeIds: _computeAttributeIds(...) }
 */
export const GET_POLICY_ENVELOPE = {
  found: true,
  policy: {
    attributes: [
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' },
      { attributeName: 'cumulativeWindow', attributeType: 'STRING', value: '43200' },
    ],
    validFromBlock: '0',
    validToBlock: '0',
    updatedAtBlock: 4248521,
    templateContractAddress: 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5',
    templateId: 'a'.repeat(64),
  },
  policyAttributeIds: {
    cumulativeMax: 'cfddf0644e3d02a3382126b387c5b345497d28ab178e27c2e5f3a5cff8f371c6',
    cumulativeWindow: 'bf86e68018c1918c73a67d20649b264fa6551b41f2892dff22602fd8e570250b',
  },
} as const

/**
 * THE v1 ATTRIBUTE VOCABULARY, from `AttributeName.java` in the ms-zetrix policy registry
 * (`developv2`, read 2026-09-25). Sixteen names; `VOCABULARY_VERSION = "v1"`.
 *
 * Separate from the templates above, and sourced differently: the templates are what is deployed,
 * this is what the service will accept. A template declares a SUBSET: `native-v1` carries 11 of
 * these and `ztp20-v1` carries 13 — a delta of TWO, `tokenAddress` and `allowedMethods`.
 *
 * Three ZTP20_ONLY names exist, not two. `approvalPolicy` is the third and it is in NEITHER
 * template, which nothing here explains — `ztp20-v1` could have carried it and did not, and
 * `settlementChannel` applies to both scopes and is likewise in neither. A template declares a
 * subset and needs no reason to omit a name, so the likeliest answer is simply that these two were
 * not wanted in the first two templates. The same honest wording is in `policy-window-rules.ts`
 * above `INFORMATIONAL_ATTRIBUTES`; an earlier version of this header quietly restated the
 * discarded reasoning instead, and got the arithmetic wrong doing it — 11 + 3 = 14, not 13 — which
 * reads as a missing row and invites someone to add `approvalPolicy` to `ZTP20_V1`, silently
 * changing what `policy_preflight` treats as declared for every ZTP20 draft (BT-3000 round 5,
 * APP-M02).
 *
 * WHY THIS EXISTS AS A FIXTURE rather than a literal in a test. `payToAllowlist` is in the
 * vocabulary and in neither template, so a test deriving the expected attribute set from the
 * templates alone rejects it. The response to that, once, was to delete the derived test and
 * hand-author the expected list inside the test file — which restated the thing it was checking and
 * let an invented `memoDenylist` row pass (BT-3000 round 4, APP-M01). Keeping the vocabulary here,
 * with its provenance, means adding a polarity row still costs evidence.
 *
 * UNVERIFIED FROM THIS REPO. ms-zetrix is not vendored here, so nothing in this project can prove
 * these sixteen names are current — the citation is the whole of the evidence. Re-read
 * `AttributeName.java` rather than editing this to make a test pass.
 */
export const V1_VOCABULARY = [
  { attributeName: 'assetScope', attributeType: 'STRING', ztp20Only: false },
  { attributeName: 'perTransactionMax', attributeType: 'NUMBER', ztp20Only: false },
  { attributeName: 'cumulativeMax', attributeType: 'NUMBER', ztp20Only: false },
  { attributeName: 'cumulativeWindow', attributeType: 'STRING', ztp20Only: false },
  { attributeName: 'velocityCap', attributeType: 'NUMBER', ztp20Only: false },
  { attributeName: 'velocityWindow', attributeType: 'STRING', ztp20Only: false },
  { attributeName: 'maxTransactionCount', attributeType: 'NUMBER', ztp20Only: false },
  { attributeName: 'countWindow', attributeType: 'STRING', ztp20Only: false },
  { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', ztp20Only: false },
  { attributeName: 'recipientDenylist', attributeType: 'ADDRESS_LIST', ztp20Only: false },
  { attributeName: 'unknownAttributePolicy', attributeType: 'STRING', ztp20Only: false },
  { attributeName: 'settlementChannel', attributeType: 'STRING', ztp20Only: false },
  { attributeName: 'payToAllowlist', attributeType: 'ADDRESS_LIST', ztp20Only: false },
  { attributeName: 'tokenAddress', attributeType: 'ADDRESS', ztp20Only: true },
  { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', ztp20Only: true },
  { attributeName: 'approvalPolicy', attributeType: 'STRING', ztp20Only: true },
] as const
