import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

export const AUDITABLE_METADATA_KEY = 'auditable_operation_meta';

export interface AuditableMetadata {
  module: string;
  action: string;
}

/**
 * Marks a mutating controller endpoint for automatic forensic audit logging.
 */
export const Auditable = (module: string, action: string) =>
  SetMetadata(AUDITABLE_METADATA_KEY, { module, action });

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auditMeta = this.reflector.get<AuditableMetadata>(
      AUDITABLE_METADATA_KEY,
      context.getHandler(),
    );

    if (!auditMeta) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const actorId: string = request.user?.id ?? 'SYSTEM_ANONYMOUS';
    const ipAddress: string =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.socket?.remoteAddress ||
      '0.0.0.0';
    const resourceId: string = request.params?.id ?? 'N/A';

    // Sanitize sensitive fields from request payload before persisting snapshot
    const sanitizedPayload = this.sanitizePayload(request.body);

    return next.handle().pipe(
      tap({
        next: async (responseBody: any) => {
          try {
            await this.prisma.immutableAuditLog.create({
              data: {
                actorId,
                ipAddress,
                module: auditMeta.module,
                action: auditMeta.action,
                resourceId: String(responseBody?.id ?? resourceId),
                requestPayload: sanitizedPayload,
                statusCode: context.switchToHttp().getResponse()?.statusCode ?? 200,
              },
            });
          } catch (err) {
            // Never crash a committed business transaction if async audit write hiccups,
            // but emit high-severity structured error for Zabbix/Log monitoring.
            this.logger.error(
              `Failed to persist forensic audit log for [${auditMeta.module}:${auditMeta.action}]`,
              err instanceof Error ? err.stack : String(err),
            );
          }
        },
      }),
    );
  }

  private sanitizePayload(body: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!body || typeof body !== 'object') return {};
    const redactKeys = new Set(['password', 'passwordHash', 'token', 'secret', 'pin']);
    const clone: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body)) {
      clone[key] = redactKeys.has(key) ? '[REDACTED]' : value;
    }
    return clone;
  }
}
