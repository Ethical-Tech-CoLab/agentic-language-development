// Exit-code-rooted Compose failure detail for the LV01 detector collector.
//
// `docker compose up` reports routine progress (" Network …  Creating") on
// stderr, so quoting the first output line as the failure misattributes a
// normal status line (see
// evidence/lv01/detector-v1/lv01-detector-v1-p0001/receipt.json, whose failure
// cites " Network ald-lv01-detector-v1_baby-a-gateway  Creating" while the log
// shows the real cause: `service "controller-scenario" didn't complete
// successfully: exit 137`). Success or failure is judged by the process exit
// code; the detail line only names the cause once the exit code says it failed.

const ANSI_SEQUENCE = /\u001b\[[0-9;]*[A-Za-z]/gu;

// Routine Compose progress lines (" Network <name>  Creating"). These are
// normal even in a failed run and must never stand in as the failure cause.
const PROGRESS_LINE = /^\s*(?:Network|Container|Volume|Image)\s+\S.*\s+(?:Creating|Created|Starting|Started|Running|Restarting|Attaching|Attached|Stopping|Stopped|Removing|Removed|Killing|Killed|Pulling|Pulled|Building|Waiting|Finished|Done)\s*$/u;

// Lines that name a genuine failure rather than routine progress.
const FAILURE_LINE = /didn't complete successfully|exited with code [1-9]|exit [1-9]|failed|failure|error:|aborting on container exit/iu;

function outputLines(execution) {
  const text = `${execution?.stdout ?? ''}\n${execution?.stderr ?? ''}`
    .replace(ANSI_SEQUENCE, '');
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

// Null when the Compose process exited 0; otherwise a detail string rooted in
// the exit status whose cause is the last genuine failure line, so a normal
// "Network … Creating" status line can never stand in as the cause.
export function composeFailureDetail(execution) {
  if (execution?.status === 0) return null;
  if (execution == null) return 'compose did not run';
  if (execution.status === null || execution.status === undefined) {
    return `compose terminated by signal: ${execution.signal ?? execution.error?.message ?? 'unknown'}`;
  }
  const lines = outputLines(execution);
  const cause = [...lines].reverse()
    .find((line) => !PROGRESS_LINE.test(line) && FAILURE_LINE.test(line))
    ?? [...lines].reverse().find((line) => !PROGRESS_LINE.test(line));
  return cause === undefined
    ? `compose exited ${execution.status} with no output`
    : `compose exited ${execution.status}: ${cause}`;
}
