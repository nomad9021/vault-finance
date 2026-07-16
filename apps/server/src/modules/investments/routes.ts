import {
  CreateHoldingRequest,
  UpdateHoldingRequest,
  type Holding as ApiHolding,
  type InvestmentsResponse,
} from "@vault/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { accounts, investmentHoldings } from "../../db/schema.js";
import { notFound } from "../../errors.js";

function toApi(row: typeof investmentHoldings.$inferSelect): ApiHolding {
  return {
    id: row.id,
    accountId: row.accountId,
    symbol: row.symbol,
    name: row.name,
    quantity: row.quantity,
    costBasisCents: row.costBasisCents,
    marketValueCents: row.marketValueCents,
    asOfDate: row.asOfDate,
  };
}

export default async function investmentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/investments", async (): Promise<InvestmentsResponse> => {
    const investmentAccounts = await app.db.query.accounts.findMany({
      where: and(eq(accounts.type, "investment"), isNull(accounts.archivedAt)),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const holdings = await app.db.select().from(investmentHoldings);
    const byAccount = new Map<string, (typeof holdings)[number][]>();
    for (const h of holdings) {
      const list = byAccount.get(h.accountId) ?? [];
      list.push(h);
      byAccount.set(h.accountId, list);
    }

    const accountsOut = investmentAccounts.map((a) => {
      const rows = byAccount.get(a.id) ?? [];
      return {
        id: a.id,
        name: a.name,
        institution: a.institution,
        holdingsValueCents: rows.reduce((sum, h) => sum + h.marketValueCents, 0),
        costBasisCents: rows.reduce((sum, h) => sum + (h.costBasisCents ?? 0), 0),
        holdings: rows.map(toApi),
      };
    });

    const totalValueCents = accountsOut.reduce((s, a) => s + a.holdingsValueCents, 0);

    // Allocation across all accounts, merged by symbol.
    const bySymbol = new Map<string, { name: string | null; valueCents: number }>();
    for (const a of accountsOut) {
      for (const h of a.holdings) {
        const entry = bySymbol.get(h.symbol) ?? { name: h.name, valueCents: 0 };
        entry.valueCents += h.marketValueCents;
        bySymbol.set(h.symbol, entry);
      }
    }
    const allocation = [...bySymbol.entries()]
      .map(([symbol, { name, valueCents }]) => ({
        symbol,
        name,
        valueCents,
        share: totalValueCents > 0 ? valueCents / totalValueCents : 0,
      }))
      .sort((a, b) => b.valueCents - a.valueCents);

    return {
      accounts: accountsOut,
      totalValueCents,
      totalCostBasisCents: accountsOut.reduce((s, a) => s + a.costBasisCents, 0),
      allocation,
    };
  });

  app.post<{ Params: { accountId: string } }>(
    "/investments/:accountId/holdings",
    async (request, reply) => {
      const body = CreateHoldingRequest.parse(request.body);
      const account = await app.db.query.accounts.findFirst({
        where: and(
          eq(accounts.id, request.params.accountId),
          eq(accounts.type, "investment"),
        ),
      });
      if (!account) throw notFound("Investment account");

      const [row] = await app.db
        .insert(investmentHoldings)
        .values({
          accountId: account.id,
          symbol: body.symbol.toUpperCase(),
          name: body.name ?? null,
          quantity: body.quantity,
          costBasisCents: body.costBasisCents ?? null,
          marketValueCents: body.marketValueCents,
        })
        .returning();
      return reply.status(201).send(toApi(row!));
    },
  );

  app.patch<{ Params: { id: string } }>("/holdings/:id", async (request) => {
    const body = UpdateHoldingRequest.parse(request.body);
    const [row] = await app.db
      .update(investmentHoldings)
      .set({
        ...(body.symbol !== undefined ? { symbol: body.symbol.toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        ...(body.costBasisCents !== undefined
          ? { costBasisCents: body.costBasisCents }
          : {}),
        ...(body.marketValueCents !== undefined
          ? { marketValueCents: body.marketValueCents, asOfDate: new Date().toISOString().slice(0, 10) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(investmentHoldings.id, request.params.id))
      .returning();
    if (!row) throw notFound("Holding");
    return toApi(row);
  });

  app.delete<{ Params: { id: string } }>("/holdings/:id", async (request, reply) => {
    const [deleted] = await app.db
      .delete(investmentHoldings)
      .where(eq(investmentHoldings.id, request.params.id))
      .returning({ id: investmentHoldings.id });
    if (!deleted) throw notFound("Holding");
    return reply.status(204).send();
  });
}
