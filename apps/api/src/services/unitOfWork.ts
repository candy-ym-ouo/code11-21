import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import * as audit from './auditService';

/** 请求来源信息（IP / UA），随审计一起落库。 */
export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 工作单元内所有写操作共用的默认上下文。
 * 省略的字段在每次 audit 调用时仍可单独给出（例如 actorId）。
 */
export interface UnitContext {
  familyId?: string | null;
  actorId?: string;
  meta?: ActorMeta;
}

/**
 * 一次审计记录。与 auditService.AuditInput 同构，但所有字段都允许省略：
 * 未给出的 familyId / actorId / ip / userAgent 由 UnitContext 补齐。
 */
export interface AuditEntry {
  familyId?: string | null;
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  diff?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** 工作单元：一个 Prisma 事务客户端 + 与该事务同生共死的审计写入。 */
export interface UnitOfWork {
  readonly tx: Prisma.TransactionClient;
  /** 在同一事务内写审计日志；family/actor/meta 缺省取自 UnitContext。 */
  audit(entry: AuditEntry): Promise<void>;
}

function mergeEntry(ctx: UnitContext, entry: AuditEntry): audit.AuditInput {
  return {
    familyId: entry.familyId === undefined ? ctx.familyId ?? null : entry.familyId,
    actorId: entry.actorId ?? ctx.actorId ?? '',
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    diff: entry.diff,
    ip: entry.ip === undefined ? ctx.meta?.ip ?? null : entry.ip,
    userAgent: entry.userAgent === undefined ? ctx.meta?.userAgent ?? null : entry.userAgent,
  };
}

/**
 * 统一写路径入口：
 * 业务写操作与审计写入永远运行在同一个交互式事务里，
 * 回调抛错则整体回滚，不存在「改了数据但没写审计」的中间态。
 *
 * 与直接 prisma.$transaction 等价的事务语义（同样的默认隔离级别/超时），
 * 只是把「拿 tx + 填审计样板」收敛到一处。
 */
export async function inUnit<T>(
  context: UnitContext,
  work: (uow: UnitOfWork) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  return prisma.$transaction(
    (tx) => {
      const uow: UnitOfWork = {
        tx,
        audit: (entry) => audit.record(mergeEntry(context, entry), tx),
      };
      return work(uow);
    },
    options ? { timeout: options.timeout, isolationLevel: options.isolationLevel } : undefined,
  );
}
