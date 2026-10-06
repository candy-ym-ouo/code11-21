import { prisma } from '../db';
import { conflict, forbidden, notFound } from '../http/errors';
import { cleanStory, escapeHtml } from '../utils/sanitize';
import { inUnit, type ActorMeta } from './unitOfWork';
import { appendItemVersion } from './versioning';
import { assertCan, itemWithAccess, type FamilyContext } from './permissionService';
import { toNoteDto } from '../serializers';

export type { ActorMeta } from './unitOfWork';

export async function listNotes(userId: string, ctx: FamilyContext, itemId: string) {
  await itemWithAccess(userId, ctx, itemId);
  const notes = await prisma.itemNote.findMany({
    where: { itemId },
    include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
  return notes.map(toNoteDto);
}

export async function createNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  input: { type: 'story' | 'comment' | 'correction'; body: string },
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  const family = await prisma.family.findUniqueOrThrow({ where: { id: ctx.familyId } });

  const allowed = access.canComment || (ctx.role === 'viewer' && family.allowViewerComment);
  if (!allowed) throw forbidden('你没有权限在这里补充内容');
  if (item.status !== 'published') throw conflict('只有已发布的条目才能补充故事');

  const note = await inUnit({ familyId: ctx.familyId, actorId: userId, meta }, async (uow) => {
    const created = await uow.tx.itemNote.create({
      data: { itemId, authorId: userId, type: input.type, body: input.body },
      include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    });
    await uow.audit({
      action: 'note.create',
      targetType: 'item',
      targetId: itemId,
      diff: { noteId: created.id, type: input.type },
    });
    return created;
  });
  return toNoteDto(note);
}

export async function acceptNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  assertCan(access, 'canEdit');

  const note = await prisma.itemNote.findFirst({
    where: { id: noteId, itemId },
    include: { author: { select: { displayName: true } } },
  });
  if (!note) throw notFound('补充内容不存在');
  if (note.status === 'accepted') throw conflict('该补充内容已被采纳');

  const addition = `<p><strong>${escapeHtml(note.author.displayName)}：</strong>${escapeHtml(note.body)}</p>`;
  const merged = cleanStory(`${item.storyHtml ?? ''}${addition}`);

  return inUnit({ familyId: ctx.familyId, actorId: userId, meta }, async (uow) => {
    const updatedItem = await uow.tx.item.update({
      where: { id: itemId },
      data: { storyHtml: merged.html, storyText: merged.text || null },
    });
    const updatedNote = await uow.tx.itemNote.update({
      where: { id: noteId },
      data: { status: 'accepted', decidedBy: userId, decidedAt: new Date() },
      include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    });
    await appendItemVersion(uow, updatedItem, userId);
    await uow.audit({
      action: 'note.accept',
      targetType: 'item',
      targetId: itemId,
      diff: { noteId },
    });
    return toNoteDto(updatedNote);
  });
}

export async function rejectNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
  reason: string,
  meta: ActorMeta,
) {
  const { access } = await itemWithAccess(userId, ctx, itemId);
  assertCan(access, 'canEdit');
  const note = await prisma.itemNote.findFirst({ where: { id: noteId, itemId } });
  if (!note) throw notFound('补充内容不存在');

  const updated = await inUnit({ familyId: ctx.familyId, actorId: userId, meta }, async (uow) => {
    const result = await uow.tx.itemNote.update({
      where: { id: noteId },
      data: { status: 'rejected', rejectReason: reason, decidedBy: userId, decidedAt: new Date() },
      include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    });
    await uow.audit({
      action: 'note.reject',
      targetType: 'item',
      targetId: itemId,
      diff: { noteId, reason },
    });
    return result;
  });
  return toNoteDto(updated);
}

export async function deleteNote(
  actor: { id: string; role: string },
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
) {
  const note = await prisma.itemNote.findFirst({ where: { id: noteId, itemId } });
  if (!note) throw notFound('补充内容不存在');
  const isAuthor = note.authorId === actor.id;
  const canDeleteAny = actor.role === 'owner' || actor.role === 'admin';
  if (!isAuthor && !canDeleteAny) throw forbidden('只能删除自己写的内容');
  await prisma.itemNote.delete({ where: { id: noteId } });
}

