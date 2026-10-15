import * as Schema from "effect/Schema";

/** Producer state: committed event identity survives reconnection and trimming. */
export function historySchema<E, EI>(event: Schema.Codec<E, EI>) {
  return Schema.Struct({
    nextSequence: Schema.Int.check(Schema.isGreaterThan(0)),
    omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    events: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sequence: Schema.Int,
        at: Schema.Int,
        commandId: Schema.NullOr(Schema.String),
        event,
      }),
    ),
  });
}
/** The extension's own persisted history, not a core cursor. */
export type History<E> = Readonly<{
  nextSequence: number;
  omitted: number;
  events: readonly Readonly<{
    id: string;
    sequence: number;
    at: number;
    commandId: string | null;
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
