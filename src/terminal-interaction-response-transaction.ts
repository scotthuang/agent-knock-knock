type Awaitable<Value> = Value | Promise<Value>;

export type TerminalInteractionReservationFailureFence =
  | "write_started"
  | "confirmed";

export interface TerminalInteractionDispatchHooks<Context, Authorization> {
  authorize(context: Context): Awaitable<Authorization>;
  beforeDispatch(context: Context): Promise<void>;
}

export interface TerminalInteractionResponseTransaction<
  Context,
  Authorization,
  Reservation,
  Execution
> {
  /**
   * Managed legacy state may have committed even when its synchronous save
   * throws. Watch CAS writes only become authoritative after confirmation.
   */
  readonly reservationFailureFence: TerminalInteractionReservationFailureFence;
  dispatch(
    hooks: TerminalInteractionDispatchHooks<Context, Authorization>
  ): Promise<Execution>;
  authorize(context: Context): Awaitable<Authorization>;
  createReservation(context: Context): Reservation;
  reserve(
    context: Context,
    reservation: Reservation,
    /** Mark the exact durable-commit boundary before outer lock cleanup. */
    confirmReservation: () => void
  ): Awaitable<void>;
  release(reservation: Reservation, error: unknown): Awaitable<void>;
  releaseFailure(
    reservation: Reservation,
    error: unknown,
    releaseError: unknown
  ): Awaitable<unknown>;
  markUncertain(reservation: Reservation, error: unknown): Awaitable<void>;
  consume(reservation: Reservation, execution: Execution): Awaitable<void>;
  responded(execution: Execution): boolean;
  isInputNotStarted(error: unknown): boolean;
  duplicateReservationError(): unknown;
  inputNotStartedError(error: unknown): unknown;
  missingReservationError(): unknown;
}

export type TerminalInteractionResponseTransactionResult<
  Reservation,
  Execution
> =
  | {
      readonly state: "blocked";
      readonly execution: Execution;
      readonly reservation?: Reservation;
    }
  | {
      readonly state: "consumed";
      readonly execution: Execution;
      readonly reservation: Reservation;
    };

type ReservationPhase = "none" | "write_started" | "confirmed";

/**
 * Subject-neutral one-shot response transaction. The ports retain ownership
 * of Store shape, locking, audit wording, and native bridge semantics; this
 * kernel only keeps the reserve/release/uncertain/consume ordering identical.
 */
export async function executeTerminalInteractionResponseTransaction<
  Context,
  Authorization,
  Reservation,
  Execution
>(
  transaction: TerminalInteractionResponseTransaction<
    Context,
    Authorization,
    Reservation,
    Execution
  >
): Promise<TerminalInteractionResponseTransactionResult<Reservation, Execution>> {
  const state: {
    phase: ReservationPhase;
    reservation?: Reservation;
  } = { phase: "none" };
  let execution: Execution;
  try {
    execution = await transaction.dispatch({
      authorize: (context) => transaction.authorize(context),
      beforeDispatch: async (context) => {
        if (state.phase !== "none") {
          throw transaction.duplicateReservationError();
        }
        state.reservation = transaction.createReservation(context);
        state.phase = "write_started";
        await transaction.reserve(context, state.reservation, () => {
          state.phase = "confirmed";
        });
        if (state.phase === "write_started") {
          state.phase = "confirmed";
        }
      }
    });
  } catch (error) {
    if (
      transaction.isInputNotStarted(error) &&
      state.phase === "confirmed" &&
      state.reservation !== undefined
    ) {
      try {
        await transaction.release(state.reservation, error);
      } catch (releaseError) {
        throw await transaction.releaseFailure(
          state.reservation,
          error,
          releaseError
        );
      }
      throw transaction.inputNotStartedError(error);
    }
    const uncertain = state.phase === "confirmed" ||
      (state.phase === "write_started" &&
        transaction.reservationFailureFence === "write_started");
    if (uncertain && state.reservation !== undefined) {
      await transaction.markUncertain(state.reservation, error);
    }
    throw error;
  }

  if (!transaction.responded(execution)) {
    return { state: "blocked", execution, reservation: state.reservation };
  }
  if (state.phase !== "confirmed" || state.reservation === undefined) {
    throw transaction.missingReservationError();
  }
  await transaction.consume(state.reservation, execution);
  return { state: "consumed", execution, reservation: state.reservation };
}
