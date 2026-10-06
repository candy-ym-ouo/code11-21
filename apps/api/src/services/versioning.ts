import type { Item, Prisma } from '@prisma/client';
import type { UnitOfWork } from './unitOfWork';

/** 条目进入版本表时的快照字段；刻意只存业务内容，不含时间戳/计数字段。 */
export function toVersionSnapshot(item: Item): Prisma.InputJsonValue {
  return {
    title: item.title,
    category: item.category,
    status: item.status,
    visibility: item.visibility,
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
    acquiredPrecision: item.acquiredPrecision,
    acquiredLabel: item.acquiredLabel,
    acquiredNote: item.acquiredNote,
    placeText: item.placeText,
    placeCity: item.placeCity,
    placeProvince: item.placeProvince,
    placeCountry: item.placeCountry,
    placeLat: item.placeLat ? Number(item.placeLat) : null,
    placeLng: item.placeLng ? Number(item.placeLng) : null,
    storyHtml: item.storyHtml,
    condition: item.condition,
    storageLocation: item.storageLocation,
    tags: item.tags,
    coverMediaId: item.coverMediaId,
  } as unknown as Prisma.InputJsonValue;
}

/**
 * 追加一条条目版本快照。
 *
 * 版本号统一取当前最大值 + 1（新建时不存在历史版本，即为 v1），
 * 与审计一样必须在业务事务内调用，保证「内容变了就一定有版本可回溯」。
 * itemId+version 的唯一约束会在并发撞号时让事务回滚，行为与原先一致。
 */
export async function appendItemVersion(uow: UnitOfWork, item: Item, createdBy: string): Promise<number> {
  const last = await uow.tx.itemVersion.findFirst({
    where: { itemId: item.id },
    orderBy: { version: 'desc' },
  });
  const version = (last?.version ?? 0) + 1;
  await uow.tx.itemVersion.create({
    data: { itemId: item.id, version, snapshot: toVersionSnapshot(item), createdBy },
  });
  return version;
}
