import { prisma } from '../db';
import { notFound, unauthenticated } from '../http/errors';
import { randomToken, sha256Hex } from '../utils/crypto';
import { hashPassword, verifyPassword } from './authService';
import { inUnit, type ActorMeta } from './unitOfWork';
import { toItemDto, toShareLinkDto } from '../serializers';
import { itemWithAccess, type FamilyContext } from './permissionService';

export type { ActorMeta } from './unitOfWork';

export async function createShareLink(
  userId: string,
  ctx: FamilyContext,
  input: { itemIds: string[]; expiresInDays: number; password?: string | null; label?: string | null },
  meta: ActorMeta,
) {
  // 只能分享自己有权看到的条目，避免借分享链接绕过可见性
  for (const itemId of input.itemIds) {
    await itemWithAccess(userId, ctx, itemId);
  }

  const token = randomToken(24);
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);

  const link = await inUnit({ familyId: ctx.familyId, actorId: userId, meta }, async (uow) => {
    const created = await uow.tx.shareLink.create({
      data: {
        familyId: ctx.familyId,
        tokenHash: sha256Hex(token),
        passwordHash,
        label: input.label ?? null,
        expiresAt,
        createdBy: userId,
        items: { create: input.itemIds.map((itemId) => ({ itemId })) },
      },
    });
    await uow.audit({
      action: 'share.create',
      targetType: 'share_link',
      targetId: created.id,
      diff: { itemCount: input.itemIds.length, expiresAt: expiresAt.toISOString() },
    });
    return created;
  });

  return { ...toShareLinkDto(link, token), token };
}

export async function listShareLinks(ctx: FamilyContext) {
  const links = await prisma.shareLink.findMany({
    where: { familyId: ctx.familyId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return links.map((l) => toShareLinkDto(l));
}

export async function revokeShareLink(actorId: string, ctx: FamilyContext, linkId: string, meta: ActorMeta) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  await inUnit({ familyId: ctx.familyId, actorId, meta }, async (uow) => {
    await uow.tx.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
    await uow.audit({ action: 'share.revoke', targetType: 'share_link', targetId: linkId });
  });
}

export interface PublicShareView {
  familyName: string;
  label: string | null;
  expiresAt: string;
  requiresPassword: boolean;
  items: ReturnType<typeof toItemDto>[];
}

async function loadLink(token: string) {
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { family: { select: { id: true, name: true } } },
  });
  if (!link) throw notFound('分享链接不存在或已被撤销');
  if (link.revokedAt) throw notFound('分享链接已被撤销');
  if (link.expiresAt.getTime() < Date.now()) throw notFound('分享链接已过期');
  return link;
}

export async function viewShareLink(token: string, password?: string): Promise<PublicShareView> {
  const link = await loadLink(token);

  if (link.passwordHash) {
    if (!password) {
      return { familyName: link.family.name, label: link.label, expiresAt: link.expiresAt.toISOString(), requiresPassword: true, items: [] };
    }
    const ok = await verifyPassword(password, link.passwordHash);
    if (!ok) throw unauthenticated('访问密码不正确');
  }

  const rows = await prisma.item.findMany({
    where: { shareLinks: { some: { shareLinkId: link.id } }, deletedAt: null, status: { not: 'trashed' } },
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      _count: { select: { notes: true, media: true } },
    },
    orderBy: { sortAt: 'desc' },
  });

  await prisma.shareLink.update({
    where: { id: link.id },
    data: { accessCount: { increment: 1 }, lastAccessAt: new Date() },
  });

  return {
    familyName: link.family.name,
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    requiresPassword: false,
    items: rows.map((r) => toItemDto(r, link.familyId)),
  };
}

/** 访客读媒体：必须证明该媒体属于本链接覆盖的条目。 */
export async function assertPublicMedia(token: string, mediaId: string) {
  const link = await loadLink(token);
  const media = await prisma.itemMedia.findFirst({
    where: { id: mediaId, deletedAt: null, item: { shareLinks: { some: { shareLinkId: link.id } } } },
  });
  if (!media) throw notFound('媒体不存在');
  return media;
}

