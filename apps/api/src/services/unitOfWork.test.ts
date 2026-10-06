import { beforeEach, describe, expect, it, vi } from 'vitest';

// inUnit 只通过 prisma.$transaction 拿事务客户端，用桩替换即可在无库环境验证契约
const { transaction, record } = vi.hoisted(() => ({ transaction: vi.fn(), record: vi.fn() }));
vi.mock('../db', () => ({
  prisma: {
    $transaction: transaction,
  },
}));
vi.mock('./auditService', () => ({
  record: (...args: unknown[]) => record(...args),
}));

import { inUnit } from './unitOfWork';
import type { Prisma } from '@prisma/client';

/** 模拟 Prisma 交互式事务：同步执行回调并把同一个 tx 交回去。 */
function mockInteractiveTransaction() {
  const tx = { __brand: 'tx' } as unknown as Prisma.TransactionClient;
  transaction.mockImplementationOnce(async (fn: (client: Prisma.TransactionClient) => Promise<unknown>) => fn(tx));
  return tx;
}

beforeEach(() => {
  transaction.mockReset();
  record.mockReset();
});

describe('inUnit 工作单元', () => {
  it('业务回调拿到事务客户端，且审计与业务写入共用同一事务', async () => {
    const tx = mockInteractiveTransaction();
    const writes: string[] = [];

    await inUnit(
      { familyId: 'fam-1', actorId: 'user-1', meta: { ip: '1.2.3.4', userAgent: 'ua' } },
      async (uow) => {
        expect(uow.tx).toBe(tx);
        writes.push('item');
        await uow.audit({ action: 'item.update', targetType: 'item', targetId: 'item-1', diff: { a: 1 } });
        writes.push('audit');
      },
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(['item', 'audit']);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toEqual({
      familyId: 'fam-1',
      actorId: 'user-1',
      action: 'item.update',
      targetType: 'item',
      targetId: 'item-1',
      diff: { a: 1 },
      ip: '1.2.3.4',
      userAgent: 'ua',
    });
    // 审计必须走事务连接，否则无法随业务一起回滚
    expect(record.mock.calls[0]![1]).toBe(tx);
  });

  it('回调抛错时错误原样向上抛，由 $transaction 保证整体回滚', async () => {
    mockInteractiveTransaction();
    const boom = new Error('唯一约束冲突');

    await expect(
      inUnit({ familyId: 'fam-1', actorId: 'user-1' }, async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);
  });

  it('单次审计可覆盖上下文缺省：注册场景无家庭，actorId 在 entry 里给出', async () => {
    const tx = mockInteractiveTransaction();

    await inUnit({ meta: { ip: null, userAgent: 'ua-x' } }, async (uow) => {
      await uow.audit({ actorId: 'user-9', action: 'auth.register', targetType: 'user', targetId: 'user-9' });
    });

    expect(record.mock.calls[0]![0]).toEqual({
      familyId: null,
      actorId: 'user-9',
      action: 'auth.register',
      targetType: 'user',
      targetId: 'user-9',
      diff: undefined,
      ip: null,
      userAgent: 'ua-x',
    });
    expect(record.mock.calls[0]![1]).toBe(tx);
  });

  it('entry 显式给出的 familyId / ip 优先于上下文', async () => {
    mockInteractiveTransaction();

    await inUnit(
      { familyId: 'fam-1', actorId: 'user-1', meta: { ip: '1.1.1.1' } },
      async (uow) => {
        await uow.audit({ familyId: 'fam-2', ip: '9.9.9.9', action: 'x', targetType: 't' });
      },
    );

    expect(record.mock.calls[0]![0]).toMatchObject({ familyId: 'fam-2', ip: '9.9.9.9' });
  });
});
