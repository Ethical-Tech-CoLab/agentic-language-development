/**
 * `measureChannel` library (ALD-040 criterion 2 and 3; SPEC §10.3).
 *
 * Generic, domain-free measurement tooling for the side channels §10.3
 * enumerates: timing, response size, and error behaviour. ALD-067's active
 * exploits reuse these functions rather than reimplementing them, which is
 * what ALD-040 criterion 3 requires — so nothing here imports the Gateway,
 * the runtime, or the isolation layer.
 */
export {
  measureLabeledChannel,
  measureSizeChannel,
  measureTimingChannel,
  withinTolerance,
  type ChannelMeasurement,
  type ChannelMetric,
  type ChannelTolerance,
  type LabelSummary,
  type LabeledDuration,
  type LabeledSize,
  type PairComparison,
  type ToleranceDecision,
  type ToleranceViolation,
} from './channel.js';
export {
  errorShapeWithinTolerance,
  measureErrorShape,
  type ErrorShapeDecision,
  type ErrorShapeGroup,
  type ErrorShapeMeasurement,
  type ErrorShapeTolerance,
  type LabeledResponse,
} from './error-shape.js';
export {
  cohensD,
  incompleteBeta,
  ksDistance,
  ksTwoSampleP,
  mean,
  standardDeviation,
  studentTTwoSidedP,
  variance,
  welchT,
  type WelchResult,
} from './stats.js';
