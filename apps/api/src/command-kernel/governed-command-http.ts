import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch } from "@nestjs/common";
import type { GovernedCommandErrorCode } from "@dingjiang/contracts";

import { GovernedCommandFailure } from "./governed-command-kernel";

export type GovernedCommandHttpError = {
  status: number;
  error: {
    code: GovernedCommandErrorCode;
    message: string;
    retryable: boolean;
    requiresHuman: boolean;
  };
};

export const governedCommandHttpError = (
  exception: GovernedCommandFailure,
): GovernedCommandHttpError => ({
  status:
    exception.code === "UNAUTHORIZED"
      ? 401
      : exception.code === "PERMISSION_DENIED"
        ? 403
        : exception.code === "INVALID_REQUEST"
          ? 400
          : exception.code === "STALE_VERSION" || exception.code === "CONFLICT"
            ? 409
            : 500,
  error: {
    code: exception.code,
    message: exception.message,
    retryable: exception.retryable,
    requiresHuman:
      exception.code === "UNAUTHORIZED" ||
      exception.code === "PERMISSION_DENIED" ||
      exception.code === "INTERNAL_ERROR",
  },
});

@Catch(GovernedCommandFailure)
export class GovernedCommandExceptionFilter implements ExceptionFilter {
  catch(exception: GovernedCommandFailure, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    const mapped = governedCommandHttpError(exception);
    response.status(mapped.status).json({
      ok: false,
      error: mapped.error,
      correlationId: exception.correlationId,
    });
  }
}
