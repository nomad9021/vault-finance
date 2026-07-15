import type { ApiError } from "@vault/shared";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError } from "../errors.js";

export default fp(
  async (app) => {
    app.setErrorHandler((err, request, reply) => {
      if (err instanceof AppError) {
        const body: ApiError = {
          error: {
            code: err.code,
            message: err.message,
            ...(err.fields ? { fields: err.fields } : {}),
          },
        };
        return reply.status(err.statusCode).send(body);
      }

      if (err instanceof ZodError) {
        const fields: Record<string, string> = {};
        for (const issue of err.issues) {
          fields[issue.path.join(".")] = issue.message;
        }
        const body: ApiError = {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed.",
            fields,
          },
        };
        return reply.status(400).send(body);
      }

      // Fastify's own errors (404 route, body too large, …) keep their status;
      // everything else is an opaque 500 so internals never leak to clients.
      const fastifyErr = err as { statusCode?: number; message?: string };
      const status =
        fastifyErr.statusCode && fastifyErr.statusCode >= 400
          ? fastifyErr.statusCode
          : 500;
      if (status >= 500) request.log.error({ err }, "unhandled error");
      const body: ApiError = {
        error: {
          code: status === 404 ? "NOT_FOUND" : "INTERNAL",
          message:
            status >= 500
              ? "Internal server error."
              : (fastifyErr.message ?? "Request failed."),
        },
      };
      return reply.status(status).send(body);
    });
  },
  { name: "error-handler" },
);
