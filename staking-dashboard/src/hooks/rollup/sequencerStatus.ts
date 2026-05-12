/**
 * Sequencer status enum + label helper.
 *
 * Lives in its own module (rather than `useSequencerStatus.ts`) because
 * `useAttesterViewBestEffort` needs the enum, but `useSequencerStatus`
 * already depends on `useAttesterViewBestEffort` — putting them together
 * creates a circular import.
 *
 * Status values come straight from the rollup contract's `getAttesterView`:
 *   0 = NONE        — not registered in this rollup
 *   1 = VALIDATING  — active validator
 *   2 = ZOMBIE      — registered but not validating (e.g. slashed below threshold)
 *   3 = EXITING     — withdrawal initiated
 */
export enum SequencerStatus {
  NONE = 0,
  VALIDATING = 1,
  ZOMBIE = 2,
  EXITING = 3,
}

export function getStatusLabel(status: number | undefined): string {
  if (status === undefined) return "Unknown"
  switch (status) {
    case SequencerStatus.NONE:
      return "None"
    case SequencerStatus.VALIDATING:
      return "Validating"
    case SequencerStatus.ZOMBIE:
      return "Inactive"
    case SequencerStatus.EXITING:
      return "Exiting/Unstaking"
    default:
      return "Unknown"
  }
}
