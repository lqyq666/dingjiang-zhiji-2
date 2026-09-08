import { randomUUID } from "node:crypto";
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const response = host
      .switchToHttp()
      .getResponse<{ status(n: number): { json(value: unknown): void } }>();
    if (status < 500 && error instanceof HttpException) {
      response.status(status).json(error.getResponse());
      return;
    }
    const reference = randomUUID();
    // Never log SQL parameters, cookies, tokens, exception objects or request bodies.
    console.error(
      JSON.stringify({ event: "api_request_failed", reference, status }),
    );
    response.status(status).json({
      statusCode: status,
      message: "服务暂时不可用，请联系管理员并提供故障编号",
      reference,
    });
  }
}
