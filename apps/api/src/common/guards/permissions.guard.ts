import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * Declarative decorator to enforce granular `module:action:resource` permissions.
 * Example: @RequirePermissions('treasury:approve:disbursement', 'accounting:post:gl')
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuthenticatedUserPayload {
  id: string;
  email: string;
  branchCode: string;
  role: string;
  permissions: string[]; // Array of granted 'module:action:resource' strings
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If route has no explicit @RequirePermissions decorator, allow passage past RBAC layer
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUserPayload | undefined = request.user;

    if (!user || !Array.isArray(user.permissions)) {
      throw new UnauthorizedException(
        'Access denied: Missing authenticated security context.',
      );
    }

    const userPermissionSet = new Set(user.permissions);

    // Support wildcard super-admin capability ('*:*:*') or exact granular match
    const hasAllRequiredPermissions = requiredPermissions.every(
      (reqPerm) =>
        userPermissionSet.has('*:*:*') || userPermissionSet.has(reqPerm),
    );

    if (!hasAllRequiredPermissions) {
      throw new ForbiddenException(
        `Insufficient privileges. Required capability: [${requiredPermissions.join(', ')}]`,
      );
    }

    return true;
  }
}
