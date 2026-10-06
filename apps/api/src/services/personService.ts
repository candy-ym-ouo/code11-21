import type { Person, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { conflict, notFound } from '../http/errors';
import * as audit from './auditService';
import { inUnit, type ActorMeta } from './unitOfWork';
import { toItemDto, toPersonDto } from '../serializers';
import type { FamilyContext } from './permissionService';
import { itemVisibilityWhere } from './visibility';

export type { ActorMeta } from './unitOfWork';

export interface PersonInput {
  name: string;
  relation?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
  bio?: string | null;
  avatarMediaId?: string | null;
}

/** 读取家庭内未删除的人物；不存在一律 404。条件与各写路径原先的查询保持一致。 */
async function loadActivePerson(familyId: string, personId: string): Promise<Person> {
  const person = await prisma.person.findFirst({
    where: { id: personId, familyId, deletedAt: null },
  });
  if (!person) throw notFound('人物不存在');
  return person;
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
  const person = await inUnit({ familyId: ctx.familyId, actorId, meta }, async (uow) => {
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
  const before = await loadActivePerson(ctx.familyId, personId);

  const person = await inUnit({ familyId: ctx.familyId, actorId, meta }, async (uow) => {
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
      diff: audit.diffOf({ name: before.name, relation: before.relation }, { name: updated.name, relation: updated.relation }),
    });
    return updated;
  });
  return toPersonDto(person);
}

export async function deletePerson(actorId: string, ctx: FamilyContext, personId: string, meta: ActorMeta) {
  const person = await loadActivePerson(ctx.familyId, personId);

  const linkCount = await prisma.itemPerson.count({ where: { personId } });
  if (linkCount > 0) {
    // 被条目引用时不允许直接删，避免「这东西是谁给的」永久丢线；引导用户改用合并
    throw conflict(`该人物已被 ${linkCount} 个条目引用，请改用「合并到其他人物」`, { linkCount });
  }

  await inUnit({ familyId: ctx.familyId, actorId, meta }, async (uow) => {
    await uow.tx.person.update({ where: { id: personId }, data: { deletedAt: new Date() } });
    await uow.audit({
      action: 'person.delete',
      targetType: 'person',
      targetId: personId,
      diff: { name: person.name } as Prisma.InputJsonValue,
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
    loadActivePerson(ctx.familyId, sourceId),
    loadActivePerson(ctx.familyId, targetId),
  ]);

  await inUnit({ familyId: ctx.familyId, actorId, meta }, async (uow) => {
    const { tx } = uow;
    const links = await tx.itemPerson.findMany({ where: { personId: sourceId } });
    for (const link of links) {
      const existing = await tx.itemPerson.findUnique({
        where: { itemId_personId_role: { itemId: link.itemId, personId: targetId, role: link.role } },
      });
      if (existing) {
        await tx.itemPerson.delete({ where: { id: link.id } });
      } else {
        await tx.itemPerson.update({ where: { id: link.id }, data: { personId: targetId } });
      }
    }
    await tx.person.update({ where: { id: sourceId }, data: { deletedAt: new Date(), mergedIntoId: targetId } });
    await uow.audit({
      action: 'person.merge',
      targetType: 'person',
      targetId,
      diff: { mergedFrom: sourceId } as Prisma.InputJsonValue,
    });
  });

  return getPerson(actorId, ctx, targetId);
}
