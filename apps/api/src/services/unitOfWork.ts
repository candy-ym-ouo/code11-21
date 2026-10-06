import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { notFound } from '../http/errors';
import * as audit from './auditService';

/** 路由层透传的操作者痕迹（IP / UA），与鉴权中间件 clientMeta 对齐。 */
export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** 单条审计记录。actorId / familyId 缺省时回落到工作单元上绑定的默认值。 */
export interface AuditEntry extends ActorMeta {
  familyId?: string | null;
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  diff?: unknown;
}

export interface ItemVersionInput {
  itemId: string;
  createdBy: string;
  snapshot: Prisma.InputJsonValue;
  /** 不传则在事务内读取当前最大版本号并 +1。 */
  version?: number;
}

/**
 * 统一工作单元。所有写路径都通过它执行：
 * - tx 保证同一事务，禁止再直接使用裸 prisma.$transaction；
 * - audit 写入与业务变更同生共死，杜绝「改了但没记录」；
 * - itemVersion 是条目类写路径的固定样板，集中在这里。
 */
export interface UnitOfWork {
  tx: Prisma.TransactionClient;
  audit(entry: AuditEntry): Promise<void>;
  /** 写入一条条目快照版本；version 缺省时按「当前最大版本号 + 1」生成。 */
  recordItemVersion(input: ItemVersionInput): Promise<void>;
}

export interface WriteContext {
  /** 审计默认操作者；单个 entry 可用 actorId 覆盖。 */
  actorId?: string;
  /** 审计默认家庭；单个 entry 可用 familyId 覆盖。 */
  familyId?: string | null;
}

/**
 * 在一个事务里执行业务写入，并保证审计、版本快照随事务一起提交或回滚。
 * 校验类操作必须放在调用之前完成，与既有行为保持一致。
 */
export async function withUnitOfWork<T>(
  context: WriteContext,
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const uow: UnitOfWork = {
      tx,
      async audit(entry) {
        const actorId = entry.actorId ?? context.actorId;
        if (!actorId) throw new Error('withUnitOfWork: 缺少审计操作者 actorId');
        await audit.record(
          {
            familyId: entry.familyId === undefined ? context.familyId ?? null : entry.familyId,
            actorId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId ?? null,
            diff: entry.diff,
            ip: entry.ip ?? null,
            userAgent: entry.userAgent ?? null,
          },
          tx,
        );
      },
      async recordItemVersion(input) {
        const version =
          input.version ??
          ((await tx.itemVersion.findFirst({ where: { itemId: input.itemId }, orderBy: { version: 'desc' } }))
            ?.version ?? 0) + 1;
        await tx.itemVersion.create({
          data: {
            itemId: input.itemId,
            version,
            snapshot: input.snapshot,
            createdBy: input.createdBy,
          },
        });
      },
    };
    return fn(uow);
  });
}

/** 未命中统一抛 404；无权访问的资源同样走这里，避免枚举资源是否存在。 */
export function assertFound<T>(value: T | null | undefined, message = '资源不存在'): T {
  if (value === null || value === undefined) throw notFound(message);
  return value;
}
