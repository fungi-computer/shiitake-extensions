import * as Schema from "effect/Schema";

/** Producer state: committed event identity survives reconnection and trimming. */
export function historySchema<E, EI>(event: Schema.Codec<E, EI>) {
  return Schema.Struct({
    /** Sequence to assign to the next committed event. */
    nextSequence: Schema.Int.check(Schema.isGreaterThan(0)),
    /** Number of older events removed by retention. */
    omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Retained committed events in sequence order. */
    events: Schema.Array(
      Schema.Struct({
        /** Stable event identity within this producer's history. */
        id: Schema.String,
        /** Producer-assigned event order. */
        sequence: Schema.Int,
        /** Event timestamp supplied by the owner. */
        at: Schema.Int,
        /** Associated accepted command, or null when none applies. */
        commandId: Schema.NullOr(Schema.String),
        /** Extension-specific event payload. */
        event,
      }),
    ),
  });
}
/** The extension's own persisted history, not a core cursor. */
export type History<E> = Readonly<{
  /** Sequence to assign to the next committed event. */
  nextSequence: number;
  /** Number of older events removed by retention. */
  omitted: number;
  /** Retained committed events in sequence order. */
  events: readonly Readonly<{
    /** Stable event identity within this producer's history. */
    id: string;
    /** Producer-assigned event order. */
    sequence: number;
    /** Event timestamp supplied by the owner. */
    at: number;
    /** Associated accepted command, or null when none applies. */
    commandId: string | null;
    /** Extension-specific event payload. */
    event: E;
  }>[];
}>;
/** A new producer counter; callers persist it alongside their Session state. */
export function emptyHistory<E>(): History<E> {
  return { nextSequence: 1, omitted: 0, events: [] };
}
const encoder = new TextEncoder();
/** Append once inside the owner's state transaction; retention never rejects work. */
export function appendHistory<E>(
  previous: History<E>,
  event: E,
  commandId: string | null,
  at: number,
): History<E> {
  const sequence = previous.nextSequence;
  const events = [
    ...previous.events,
    { id: String(sequence), sequence, at, commandId, event },
  ];
  const history = {
    nextSequence: sequence + 1,
    omitted: previous.omitted,
    events,
  };
  while (
    events.length > 32 ||
    encoder.encode(JSON.stringify(history)).length > 32 * 1024
  ) {
    if (events.length === 0) break;
    events.shift();
    history.omitted += 1;
  }
  return history;
}
