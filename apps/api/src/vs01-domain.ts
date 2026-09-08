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
