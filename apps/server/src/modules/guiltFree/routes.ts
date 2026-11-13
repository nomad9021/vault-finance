import {
  GuiltFreeQuery,
  UpdateGuiltFreeRequest,
  type GuiltFreePerson,
  type GuiltFreeResponse,
  type WeekStart,
} from "@vault/shared";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { budgets, categories, transactions, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import { META_KEYS, readMeta, writeMeta } from "../../lib/app-meta.js";
import { daysInMonth, weekBounds } from "../budgets/period.js";

/**
 * Guilt-free spending (see the shared schema): a "Guilt-free spending"
 * category with one child per person, each with a weekly budget. Which
 * category belongs to whom is kept in app_meta; the weekly amount is the
 * budget itself, so editing it on the Budgets page is the same thing.
 */

interface Config {
  categoryId: string | null;
  /** userId → that person's category. */
  people: Record<string, string>;
}

const PARENT_NAME = "Guilt-free spending";
const PARENT_COLOR = "#e8a33d";
const PERSON_COLORS = ["#f0b860", "#e98a5b", "#d9a2e8", "#7cc6a4", "#79b0f0", "#f07c9a"];

async function readConfig(app: FastifyInstance): Promise<Config> {
  try {
    const raw = await readMeta(app.db, META_KEYS.guiltFree);
    const parsed = raw ? (JSON.parse(raw) as Partial<Config>) : {};
    return { categoryId: parsed.categoryId ?? null, people: parsed.people ?? {} };
  } catch {
    return { categoryId: null, people: {} };
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

export async function loadGuiltFree(app: FastifyInstance, request: FastifyRequest, weekStart: WeekStart): Promise<GuiltFreeResponse> {
  const config = await readConfig(app);
  const week = weekBounds(today(), weekStart);
  const people = await app.db
    .select({ id: users.id, displayName: users.displayName, avatarColor: users.avatarColor, avatarImage: users.avatarImage })
    .from(users)
    .orderBy(asc(users.createdAt));

  // Only categories that still exist count (one may have been deleted in Settings).
  const mapped = Object.values(config.people);
  const ids = [...mapped, ...(config.categoryId ? [config.categoryId] : [])];
  const existing = new Set(
    ids.length
      ? (await app.db.select({ id: categories.id }).from(categories).where(inArray(categories.id, ids))).map((r) => r.id)
      : [],
  );
  const catOf = (userId: string) => {
    const id = config.people[userId];
    return id && existing.has(id) ? id : null;
  };
  const catIds = people.map((p) => catOf(p.id)).filter((x): x is string => !!x);

  // The weekly amount: the latest budget row that has started.
  const amounts = new Map<string, number>();
  const purchases = new Map<string, GuiltFreePerson["purchases"]>();
  if (catIds.length) {
    const month = thisMonth();
    const rows = await app.db
      .select()
      .from(budgets)
      .where(and(inArray(budgets.categoryId, catIds), lte(budgets.startsOn, `${month}-01`)))
      .orderBy(budgets.categoryId, sql`${budgets.startsOn} desc`);
    for (const b of rows) {
      if (amounts.has(b.categoryId)) continue;
      amounts.set(b.categoryId, b.period === "weekly" ? b.amountCents : Math.round((b.amountCents * 7) / daysInMonth(month)));
    }
    const txns = await app.db
      .select()
      .from(transactions)
      .where(and(inArray(transactions.categoryId, catIds), gte(transactions.postedAt, week.start), lt(transactions.postedAt, week.end)))
      .orderBy(desc(transactions.postedAt), desc(transactions.createdAt));
    for (const t of txns) {
      const list = purchases.get(t.categoryId!) ?? [];
      list.push({ id: t.id, merchantName: t.merchantName, amountCents: -t.amountCents, postedAt: t.postedAt, manual: t.externalId === null });
      purchases.set(t.categoryId!, list);
    }
  }

  return {
    categoryId: config.categoryId && existing.has(config.categoryId) ? config.categoryId : null,
    weekStart: week.start,
    weekEnd: week.end,
    people: people.map((p) => {
      const categoryId = catOf(p.id);
      const list = categoryId ? (purchases.get(categoryId) ?? []) : [];
      return {
        userId: p.id,
        displayName: p.displayName,
        avatarColor: p.avatarColor,
        avatarImage: p.avatarImage,
        isMe: p.id === request.auth!.userId,
        categoryId,
        weeklyCents: categoryId ? (amounts.get(categoryId) ?? 0) : 0,
        spentCents: list.reduce((s, x) => s + x.amountCents, 0),
        purchases: list,
      };
    }),
  };
}

export default async function guiltFreeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/guilt-free", async (request): Promise<GuiltFreeResponse> => {
    const query = GuiltFreeQuery.parse(request.query);
    return loadGuiltFree(app, request, query.weekStart ?? "monday");
  });

  /**
   * Set weekly amounts. The first time sets up the categories: the parent,
   * then one per person named after them. Anyone in the household can set
   * anyone's, the same as any other budget.
   */
  app.put("/guilt-free", async (request): Promise<GuiltFreeResponse> => {
    const query = GuiltFreeQuery.parse(request.query);
    const body = UpdateGuiltFreeRequest.parse(request.body);
    const people = await app.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, body.people.map((p) => p.userId)));
    const nameOf = new Map(people.map((p) => [p.id, p.displayName]));
    const missing = body.people.find((p) => !nameOf.has(p.userId));
    if (missing) throw new AppError("VALIDATION_ERROR", 400, "That person isn't in this household.");

    await app.db.transaction(async (tx) => {
      const config = await readConfig(app);
      const exists = async (id: string | null | undefined) =>
        !!id && !!(await tx.query.categories.findFirst({ where: eq(categories.id, id) }));
      const nextOrder = async (parentId: string | null) => {
        const [row] = await tx
          .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
          .from(categories)
          .where(and(parentId ? eq(categories.parentCategoryId, parentId) : sql`${categories.parentCategoryId} is null`, eq(categories.kind, "expense")));
        return Number(row?.next ?? 0);
      };

      if (!(await exists(config.categoryId))) {
        // Reuse a top-level one with the same name rather than making a second.
        const same = await tx.query.categories.findFirst({
          where: and(sql`lower(${categories.name}) = lower(${PARENT_NAME})`, sql`${categories.parentCategoryId} is null`, eq(categories.kind, "expense")),
        });
        config.categoryId =
          same?.id ??
          (
            await tx
              .insert(categories)
              .values({ name: PARENT_NAME, color: PARENT_COLOR, parentCategoryId: null, sortOrder: await nextOrder(null), kind: "expense" })
              .returning({ id: categories.id })
          )[0]!.id;
      }
      const parentId = config.categoryId!;

      for (const [i, p] of body.people.entries()) {
        let catId = config.people[p.userId];
        if (!(await exists(catId))) {
          if (p.weeklyCents === 0) continue; // nothing to set up
          const name = `Guilt-free · ${nameOf.get(p.userId)!}`.slice(0, 60);
          const same = await tx.query.categories.findFirst({
            where: and(sql`lower(${categories.name}) = lower(${name})`, eq(categories.parentCategoryId, parentId)),
          });
          catId =
            same?.id ??
            (
              await tx
                .insert(categories)
                .values({
                  name,
                  color: PERSON_COLORS[(Object.keys(config.people).length + i) % PERSON_COLORS.length]!,
                  parentCategoryId: parentId,
                  sortOrder: await nextOrder(parentId),
                  kind: "expense",
                })
                .returning({ id: categories.id })
            )[0]!.id;
          config.people[p.userId] = catId;
        }
        if (p.weeklyCents > 0) {
          await tx
            .insert(budgets)
            .values({ categoryId: catId!, amountCents: p.weeklyCents, period: "weekly", rollover: false, startsOn: `${thisMonth()}-01` })
            .onConflictDoUpdate({
              target: [budgets.categoryId, budgets.startsOn],
              set: { amountCents: p.weeklyCents, period: "weekly", updatedAt: new Date() },
            });
        } else {
          await tx.delete(budgets).where(eq(budgets.categoryId, catId!));
        }
      }
      await writeMeta(tx as unknown as typeof app.db, META_KEYS.guiltFree, JSON.stringify(config));
    });
    return loadGuiltFree(app, request, query.weekStart ?? "monday");
  });
}
