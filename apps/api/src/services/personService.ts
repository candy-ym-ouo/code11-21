import type { Prisma, Person } from '@prisma/client';
import { prisma } from '../db';
import { conflict, notFound } from '../http/errors';
import { diffOf } from './auditService';
import { assertFound, withUnitOfWork, type ActorMeta } from './unitOfWork';
import { toItemDto, toPersonDto } from '../serializers';
import type { FamilyContext } from './permissionService';
import { itemVisibilityWhere } from './visibility';

export type { ActorMeta };

export interface PersonInput {
  name: string;
  relation?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
  bio?: string | null;
  avatarMediaId?: string | null;
}

async function loadActivePerson(ctx: FamilyContext, personId: string): Promise<Person> {
  const person = await prisma.person.findFirst({
    where: { id: personId, familyId: ctx.familyId, deletedAt: null },
  });
  return assertFound(person, '人物不存在');
}

export async function listPeople(ctx: FamilyContext, q?: string) {
  const where: Prisma.PersonWhereInput = { familyId: ctx.familyId, deletedAt: null, mergedIntoId: null };
  if (q) {
    where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { relation: { contains: q, mode: 'insensitive' } }];
  }
  const rows = await prisma.person.findMany({
    where,
    include: { _count: { select: { links: true } } },
    orderBy: [{ name: 'asc' }],
    take: 500,
  });
  return rows.map(toPersonDto);
}

export async function getPerson(userId: string, ctx: FamilyContext, personId: string) {
  const person = await prisma.person.findFirst({
    where: { id: personId, familyId: ctx.familyId, deletedAt: null },
    include: { _count: { select: { links: true } } },
  });
  if (!person) throw notFound('人物不存在');

  // 人物详情里的条目同样要过可见性，不能因为「在人物页」就漏出私密条目
  const links = await prisma.itemPerson.findMany({
    where: {
      personId,
      item: { AND: [{ familyId: ctx.familyId }, { deletedAt: null }, itemVisibilityWhere(userId, ctx.role)] },
    },
    include: {
      item: {
        include: {
          media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
          people: { include: { person: true } },
          _count: { select: { notes: true, media: true } },
        },
      },
    },
    take: 200,
  });

  return {
    ...toPersonDto(person),
    items: links.map((l) => ({ role: l.role, ...toItemDto(l.item, ctx.familyId) })),
  };
}

export async function createPerson(actorId: string, ctx: FamilyContext, input: PersonInput, meta: ActorMeta) {
  const person = await withUnitOfWork({ familyId: ctx.familyId, actorId }, async (uow) => {
    const created = await uow.tx.person.create({
      data: {
        familyId: ctx.familyId,
        name: input.name,
        relation: input.relation ?? null,
        birthYear: input.birthYear ?? null,
        deathYear: input.deathYear ?? null,
        bio: input.bio ?? null,
        avatarMediaId: input.avatarMediaId ?? null,
        createdBy: actorId,
      },
      include: { _count: { select: { links: true } } },
    });
    await uow.audit({
      action: 'person.create',
      targetType: 'person',
      targetId: created.id,
      diff: { name: created.name } as Prisma.InputJsonValue,
      ...meta,
    });
    return created;
  });
  return toPersonDto(person);
}

export async function updatePerson(
  actorId: string,
  ctx: FamilyContext,
  personId: string,
  input: Partial<PersonInput>,
  meta: ActorMeta,
) {
  const before = await loadActivePerson(ctx, personId);

  const person = await withUnitOfWork({ familyId: ctx.familyId, actorId }, async (uow) => {
    const updated = await uow.tx.person.update({
      where: { id: personId },
      data: {
        name: input.name ?? undefined,
        relation: input.relation === undefined ? undefined : input.relation,
        birthYear: input.birthYear === undefined ? undefined : input.birthYear,
        deathYear: input.deathYear === undefined ? undefined : input.deathYear,
        bio: input.bio === undefined ? undefined : input.bio,
        avatarMediaId: input.avatarMediaId === undefined ? undefined : input.avatarMediaId,
      },
      include: { _count: { select: { links: true } } },
    });
    await uow.audit({
      action: 'person.update',
      targetType: 'person',
      targetId: personId,
      diff: diffOf({ name: before.name, relation: before.relation }, { name: updated.name, relation: updated.relation }),
      ...meta,
    });
    return updated;
  });
  return toPersonDto(person);
}

export async function deletePerson(actorId: string, ctx: FamilyContext, personId: string, meta: ActorMeta) {
  const person = await loadActivePerson(ctx, personId);

  const linkCount = await prisma.itemPerson.count({ where: { personId } });
  if (linkCount > 0) {
    // 被条目引用时不允许直接删，避免「这东西是谁给的」永久丢线；引导用户改用合并
    throw conflict(`该人物已被 ${linkCount} 个条目引用，请改用「合并到其他人物」`, { linkCount });
  }

  await withUnitOfWork({ familyId: ctx.familyId, actorId }, async (uow) => {
    await uow.tx.person.update({ where: { id: personId }, data: { deletedAt: new Date() } });
    await uow.audit({
      action: 'person.delete',
      targetType: 'person',
      targetId: personId,
      diff: { name: person.name } as Prisma.InputJsonValue,
      ...meta,
    });
  });
}

export async function mergePerson(
  actorId: string,
  ctx: FamilyContext,
  sourceId: string,
  targetId: string,
  meta: ActorMeta,
) {
  if (sourceId === targetId) throw conflict('不能合并到自己');
  const [source, target] = await Promise.all([
    prisma.person.findFirst({ where: { id: sourceId, familyId: ctx.familyId, deletedAt: null } }),
    prisma.person.findFirst({ where: { id: targetId, familyId: ctx.familyId, deletedAt: null } }),
  ]);
  if (!source || !target) throw notFound('人物不存在');

  await withUnitOfWork({ familyId: ctx.familyId, actorId }, async (uow) => {
    const links = await uow.tx.itemPerson.findMany({ where: { personId: sourceId } });
    for (const link of links) {
      const existing = await uow.tx.itemPerson.findUnique({
        where: { itemId_personId_role: { itemId: link.itemId, personId: targetId, role: link.role } },
      });
      if (existing) {
        await uow.tx.itemPerson.delete({ where: { id: link.id } });
      } else {
        await uow.tx.itemPerson.update({ where: { id: link.id }, data: { personId: targetId } });
      }
    }
    await uow.tx.person.update({ where: { id: sourceId }, data: { deletedAt: new Date(), mergedIntoId: targetId } });
    await uow.audit({
      action: 'person.merge',
      targetType: 'person',
      targetId,
      diff: { mergedFrom: sourceId } as Prisma.InputJsonValue,
      ...meta,
    });
  });

  return getPerson(actorId, ctx, targetId);
}
