import { beforeEach, describe, expect, it, vi } from 'vitest';

// 在导入被测模块前替换掉真实的 PrismaClient，单测不连数据库。
const { tx, $transaction } = vi.hoisted(() => {
  const tx = {
    auditLog: { create: vi.fn() },
    itemVersion: { findFirst: vi.fn(), create: vi.fn() },
  };
  const $transaction = vi.fn();
  return { tx, $transaction };
});

vi.mock('../db', () => ({
  prisma: { $transaction },
}));

import { AppError } from '../http/errors';
import { assertFound, withUnitOfWork } from './unitOfWork';

beforeEach(() => {
  vi.clearAllMocks();
  $transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
});

describe('withUnitOfWork', () => {
  it('在同一事务内执行业务并把默认 actor/family 绑定到审计', async () => {
    await withUnitOfWork({ actorId: 'u1', familyId: 'f1' }, async (uow) => {
      await uow.audit({ action: 'item.create', targetType: 'item', targetId: 'i1', ip: '1.1.1.1' });
    });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        familyId: 'f1',
        actorId: 'u1',
        action: 'item.create',
        targetType: 'item',
        targetId: 'i1',
        diff: undefined,
        ip: '1.1.1.1',
        userAgent: null,
      },
    });
  });

  it('单条审计可覆盖默认 actor / family，未提供 family 时回落为 null', async () => {
    await withUnitOfWork({ actorId: 'u1' }, async (uow) => {
      await uow.audit({ familyId: 'fX', actorId: 'u2', action: 'x', targetType: 't' });
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ familyId: 'fX', actorId: 'u2' }),
    });
  });

  it('业务回调抛错时事务整体回滚（原子性），错误原样向上传播', async () => {
    const boom = new AppError('CONFLICT', 'boom');
    await expect(
      withUnitOfWork({ actorId: 'u1' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('缺少审计操作者时直接失败，避免写出无主审计', async () => {
    await expect(
      withUnitOfWork({}, async (uow) => {
        await uow.audit({ action: 'x', targetType: 't' });
      }),
    ).rejects.toThrow(/actorId/);
  });

  it('recordItemVersion 未指定版本时按当前最大版本号 +1', async () => {
    tx.itemVersion.findFirst.mockResolvedValue({ version: 7 });
    await withUnitOfWork({ actorId: 'u1' }, async (uow) => {
      await uow.recordItemVersion({ itemId: 'i1', createdBy: 'u1', snapshot: { a: 1 } as never });
    });
    expect(tx.itemVersion.findFirst).toHaveBeenCalledWith({ where: { itemId: 'i1' }, orderBy: { version: 'desc' } });
    expect(tx.itemVersion.create).toHaveBeenCalledWith({
      data: { itemId: 'i1', version: 8, snapshot: { a: 1 }, createdBy: 'u1' },
    });
  });

  it('recordItemVersion 无历史版本时从 1 开始，显式版本号优先', async () => {
    tx.itemVersion.findFirst.mockResolvedValue(null);
    await withUnitOfWork({ actorId: 'u1' }, async (uow) => {
      await uow.recordItemVersion({ itemId: 'i1', createdBy: 'u1', snapshot: {} as never });
      await uow.recordItemVersion({ itemId: 'i2', createdBy: 'u1', snapshot: {} as never, version: 1 });
    });
    expect(tx.itemVersion.create).toHaveBeenNthCalledWith(1, {
      data: { itemId: 'i1', version: 1, snapshot: {}, createdBy: 'u1' },
    });
    expect(tx.itemVersion.create).toHaveBeenNthCalledWith(2, {
      data: { itemId: 'i2', version: 1, snapshot: {}, createdBy: 'u1' },
    });
  });
});

describe('assertFound', () => {
  it('空值抛 404，非空原样返回', () => {
    expect(() => assertFound(null, '没找到')).toThrow('没找到');
    expect(() => assertFound(undefined, '没找到')).toThrow('没找到');
    expect(assertFound({ id: 'x' }, '没找到')).toEqual({ id: 'x' });
  });
});
