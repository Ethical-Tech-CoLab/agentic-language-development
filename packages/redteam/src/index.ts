/**
 * `@ald/redteam` — adversarial suites and side-channel measurement tooling
 * (BACKLOG ALD-040, ALD-067, ALD-068; SPECIFICATION.md §10.1, §10.2,
 * §10.3; EXPERIMENT-NOTEBOOK.md E01, E02).
 *
 * Four parts:
 *
 * - `fixtures/` — the pre-registered ALD-068 fixture set: deterministically
 *   generated PNGs (embedded bitmap typefaces, seeded PRNG, stored-DEFLATE
 *   encoding — no native dependency, no system font) plus a manifest of
 *   hashes, committed so tests load bytes rather than render them.
 * - `observation/` — the suite that runs every fixture through the real
 *   `@ald/scenario` quarantine and delivers approved bundles into an
 *   instrumented adapter sink, emitting a canonical
 *   `kind: 'red-team-observation'` attachment object.
 * - `measure/` — the generic timing/size/error-shape measurement library
 *   ALD-040 criterion 2 needs and ALD-067's active exploits reuse.
 * - `side-channel/` — active Gateway, transport, host-capability, and hidden
 *   correlation attacks, joined into the Mode P/Mode R comparison gate.
 *
 * Claim boundary (SPEC §5.1, §5.4): everything here is **software
 * readiness**. A green suite says the implemented filter quarantined the
 * implemented attack set; it is not the E01 or E02 result, and E01/E02 remain
 * `Not started` until the notebook says otherwise. The active Gateway attack
 * set lives under `src/side-channel/`; its Mode P/Mode R comparison is a
 * software-readiness gate rather than an E01 result.
 */
export {
  RedTeamError,
  assertFiniteSample,
  type RedTeamErrorCode,
} from './errors.js';
export {
  runHiddenStateCorrelationAttack,
  type CorrelationAttackReport,
} from './side-channel/correlation.js';
export {
  runGatewaySideChannelAttacks,
  type GatewayAttackCategory,
  type GatewayAttackResult,
  type GatewaySideChannelReport,
} from './side-channel/gateway.js';
export {
  evaluateHostIsolationAttacks,
  type HostAttackCategory,
  type HostAttackResult,
  type HostIsolationAttackReport,
} from './side-channel/isolation.js';
export {
  runActiveTransportAttacks,
  type ActiveTransportAttackOptions,
  type ActiveTransportAttackReport,
  type TransportAttackCondition,
  type TransportAttackObservation,
} from './side-channel/transport.js';
export {
  CARRIER_SIDE_FEATURE_ATTACK_PLAN,
  GENERATED_CARRIERS,
  runCarrierSideFeatureAttacks,
  type CarrierSideFeatureAttackResult,
  type CarrierSideFeatureReport,
  type GeneratedCarrier,
} from './side-channel/carrier-features.js';
export {
  SIDE_CHANNEL_ATTACK_CATEGORIES,
  SIDE_CHANNEL_MITIGATIONS,
  runSideChannelRedTeamSuite,
  type SideChannelAttackCategory,
  type SideChannelRedTeamOptions,
  type SideChannelRedTeamReport,
} from './side-channel/suite.js';
export {
  FIXTURE_SET_VERSION,
  FIXTURE_TYPEFACES,
  OBSERVATION_FIXTURES,
  fixtureAssetId,
  fixtureGeneratorConfig,
  type FixtureCategory,
  type FixtureDefinition,
  type FixtureStrings,
} from './fixtures/catalogue.js';
export {
  TYPEFACES,
  textMask,
  type GlyphMask,
  type TextMaskOptions,
  type Typeface,
  type TypefaceName,
} from './fixtures/bitmap-font.js';
export {
  encodeGrayscalePng,
  encodeRgbPng,
  storedZlibStream,
  type EncodePngOptions,
  type PngTextChunkInput,
  type PngTextChunkKind,
} from './fixtures/png-encode.js';
export {
  addNoise,
  blankPlane,
  drawText,
  planeToRgb,
  renderGradientPlane,
  renderNoisePlane,
  renderRandomStrokesPlane,
  renderShapesPlane,
  renderTextPlane,
  type DrawTextOptions,
  type Plane,
  type TextPlaneOptions,
} from './fixtures/render.js';
export {
  FIXTURE_MANIFEST_FILE,
  FixtureManifestEntrySchema,
  FixtureManifestSchema,
  fixtureFileName,
  hashBytes,
  hashUtf8,
  manifestEntryFor,
  readFixtureManifest,
  verifyCommittedFixtures,
  type FixtureManifest,
  type FixtureManifestEntry,
  type FixtureVerification,
} from './fixtures/manifest.js';
export {
  buildFixtureManifest,
  buildFixtureBytes,
  defaultFixtureDirectory,
  generateObservationFixtures,
  type GenerateFixturesResult,
} from './fixtures/generate.js';
export {
  FixtureIntegrityError,
  buildFixtureBundles,
  loadObservationFixtures,
  type LoadedFixture,
} from './fixtures/load.js';
export {
  InstrumentedAdapterSink,
  OBSERVATION_SUITE_CLAIM,
  OBSERVATION_SUITE_VERSION,
  runObservationRedTeamSuite,
  type DeliveryRecord,
  type ObservationRedTeamFixtureResult,
  type ObservationRedTeamResult,
  type ObservationRedTeamSummary,
  type RunObservationSuiteOptions,
} from './observation/suite.js';
export {
  cohensD,
  errorShapeWithinTolerance,
  incompleteBeta,
  ksDistance,
  ksTwoSampleP,
  mean,
  measureErrorShape,
  measureLabeledChannel,
  measureSizeChannel,
  measureTimingChannel,
  standardDeviation,
  studentTTwoSidedP,
  variance,
  welchT,
  withinTolerance,
  type ChannelMeasurement,
  type ChannelMetric,
  type ChannelTolerance,
  type ErrorShapeDecision,
  type ErrorShapeGroup,
  type ErrorShapeMeasurement,
  type ErrorShapeTolerance,
  type LabelSummary,
  type LabeledDuration,
  type LabeledResponse,
  type LabeledSize,
  type PairComparison,
  type ToleranceDecision,
  type ToleranceViolation,
  type WelchResult,
} from './measure/index.js';
