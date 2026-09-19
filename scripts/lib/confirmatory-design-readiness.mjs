const MEMBER_IDS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6a', 'H6b', 'H7', 'H8'];
const EXPERIMENTS = ['E11', 'E16', 'E15', 'E16', 'E13', 'E20', 'E20', 'E30', 'E32'];
const METRIC_STATUSES = new Set(['operationalized', 'unresolved']);
const MARGIN_STATUSES = new Set(['frozen', 'unfrozen']);

function fail(message) {
  throw new Error(`confirmatory design readiness: ${message}`);
}

export function validateConfirmatoryDesignReadiness(readiness) {
  if (readiness?.schemaVersion !== 1 ||
      readiness.classification !== 'prospective-confirmatory-design-readiness') {
    fail('unexpected artifact identity');
  }
  if (readiness.researchFinding !== false || readiness.scientificDisposition !== 'not-tested' ||
      readiness.independentHumanReview !== false || readiness.externalSpend !== 0) {
    fail('claim boundary or zero-spend status is invalid');
  }
  if (readiness.pilotRule?.requiredValidSlotsPerMember !== 20 ||
      readiness.pilotRule?.stage !== 'blinded-pilot' ||
      !Array.isArray(readiness.pilotRule?.prohibitedUses) ||
      readiness.pilotRule.prohibitedUses.length !== 4) {
    fail('blinded-pilot rule is incomplete');
  }
  if (!Array.isArray(readiness.members) || readiness.members.length !== MEMBER_IDS.length) {
    fail('exactly nine family members are required');
  }

  for (let index = 0; index < MEMBER_IDS.length; index += 1) {
    const member = readiness.members[index];
    if (member?.id !== MEMBER_IDS[index] || member?.experiment !== EXPERIMENTS[index]) {
      fail(`member ${index} is missing, reordered, or bound to the wrong experiment`);
    }
    if (!METRIC_STATUSES.has(member.metricStatus) || !MARGIN_STATUSES.has(member.marginStatus) ||
        typeof member.metric !== 'string' || member.metric.length < 30 ||
        typeof member.direction !== 'string' || member.direction.length === 0 ||
        !Array.isArray(member.reasonCodes) || member.reasonCodes.length === 0) {
      fail(`${member.id} has an incomplete metric or reason record`);
    }
    if (member.metricStatus === 'unresolved' ? member.scale !== null :
      typeof member.scale !== 'string' || member.scale.length === 0) {
      fail(`${member.id} metric scale contradicts its status`);
    }
    if (member.marginStatus === 'frozen' ?
      !Number.isFinite(member.practicalMargin) : member.practicalMargin !== null) {
      fail(`${member.id} practical margin contradicts its status`);
    }
    if (member.pilot?.status !== 'not-collected' || member.pilot.validSlots !== 0 ||
        member.pilot.varianceUpper !== null || member.simulation?.status !== 'not-run' ||
        member.simulation.repetitions !== 0 || member.simulation.memberMinimum !== null ||
        member.registrationEligible !== false) {
      fail(`${member.id} fabricates or prematurely promotes pilot/power state`);
    }
  }

  const h2 = readiness.members[1];
  const h4 = readiness.members[3];
  const h6b = readiness.members[6];
  if (h2.softwareFixtureCandidate !== 0.05 || h4.softwareFixtureCandidate !== 0.02 ||
      h2.marginStatus !== 'unfrozen' || h2.practicalMargin !== null ||
      h4.marginStatus !== 'unfrozen' || h4.practicalMargin !== null ||
      !h2.reasonCodes.includes('software-fixture-is-not-policy') ||
      !h4.reasonCodes.includes('software-fixture-is-not-policy')) {
    fail('software-only H2/H4 fixture values are not quarantined from policy');
  }
  if (h6b.marginStatus !== 'frozen' || h6b.practicalMargin !== 0.02 ||
      h6b.scale !== 'bits' || h6b.direction !== 'upper-bound') {
    fail('the already-frozen H6b leakage bound changed');
  }

  const summary = readiness.summary;
  const operationalized = readiness.members.filter((member) => member.metricStatus === 'operationalized').length;
  const frozen = readiness.members.filter((member) => member.marginStatus === 'frozen').length;
  if (summary?.members !== 9 || summary.operationalizedMetrics !== operationalized ||
      summary.unresolvedMetrics !== 9 - operationalized || summary.frozenMargins !== frozen ||
      summary.unfrozenMargins !== 9 - frozen || summary.pilotsCollected !== 0 ||
      summary.jointSimulationRepetitions !== 0 || summary.selectedPrimarySeeds !== null ||
      summary.registrationReady !== false) {
    fail('summary does not match the member-level gate state');
  }
  return { memberIds: MEMBER_IDS, operationalized, frozen };
}
