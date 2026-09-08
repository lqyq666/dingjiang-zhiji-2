export interface WorkerStatus {
  readonly service: "worker";
  readonly status: "ready";
}

export function createWorkerStatus(): WorkerStatus {
  return {
    service: "worker",
    status: "ready",
  };
}
