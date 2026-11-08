export type DeliveryDates = {
  forecastDate: string;
  promisedDate: string;
};

export const isoDate = (value: unknown): string =>
  (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

export const delayDays = ({
  forecastDate,
  promisedDate,
}: DeliveryDates): number =>
  Math.max(
    0,
    Math.round(
      (Date.parse(forecastDate) - Date.parse(promisedDate)) / 86_400_000,
    ),
  );

export const otdPercentage = (orders: DeliveryDates[]): number => {
  if (orders.length === 0) return 0;
  return Math.round(
    (orders.filter((order) => delayDays(order) === 0).length / orders.length) *
      100,
  );
};

/**
 * The suffix a source task carries inside generated project identifiers.
 *
 * A task is identified as SO-202608136; the project, node, phase and subtask
 * identifiers derived from it drop the prefix and keep the rest. Both the
 * read model and the project state machine need this, so it lives here
 * rather than on either side.
 */
export const sourceTaskSuffix = (sourceTaskId: string): string =>
  sourceTaskId.replace(/^SO-/, "");

/** How late a delivery is, in days, measured from the promised date. */
export const delay = (forecast: unknown, promised: unknown): number =>
  delayDays({
    forecastDate: isoDate(forecast),
    promisedDate: isoDate(promised),
  });
