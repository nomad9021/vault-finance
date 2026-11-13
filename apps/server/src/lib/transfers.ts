import { sql } from "drizzle-orm";
import { transactions } from "../db/schema.js";
import type { Db } from "../plugins/db.js";

/**
 * Transfers between the household's own accounts aren't income or spending:
 * moving $500 from checking to savings, or paying the credit card from
 * checking, shows up as −$500 in one account and +$500 in another, and
 * counting both makes income and spending look $500 bigger each.
 *
 * A pair is two transactions in different accounts for the same amount with
 * opposite signs, within four days of each other, where at least one side's
 * description reads like a transfer or a payment. Both get isTransfer. Rows
 * the person marked (or unmarked) themselves are left alone, and each row
 * pairs at most once, closest date first.
 */
export const TRANSFER_WORDS =
  "transfer|xfer|trnsfr|tfr|payment|pymt|autopay|auto pay|thank you|to savings|from savings|to checking|from checking|online banking|internal|move money|zelle to self|credit crd|crd pmt|card pmt|epay|e-payment";

export function transferPairsSql(sinceDays = 120) {
  return sql`
    with candidates as (
      select a.id as a_id, b.id as b_id, abs(b.posted_at - a.posted_at) as gap
      from transactions a
      join transactions b
        on b.account_id <> a.account_id
       and b.amount_cents = -a.amount_cents
       and abs(b.posted_at - a.posted_at) <= 4
      where a.amount_cents < 0
        and not a.is_transfer and not b.is_transfer
        and not a.transfer_manual and not b.transfer_manual
        and a.posted_at >= current_date - ${sinceDays}::int
        and (a.merchant_name ~* ${TRANSFER_WORDS} or b.merchant_name ~* ${TRANSFER_WORDS}
             or coalesce(a.description, '') ~* ${TRANSFER_WORDS} or coalesce(b.description, '') ~* ${TRANSFER_WORDS})
    ),
    best as (
      select distinct on (a_id) a_id, b_id from candidates order by a_id, gap, b_id
    ),
    uniq as (
      select distinct on (b_id) a_id, b_id from best order by b_id, a_id
    )
    update transactions set is_transfer = true, updated_at = now()
    where id in (select a_id from uniq union select b_id from uniq)
    returning id`;
}

/** Flag new transfer pairs. Cheap enough to run after every import or sync. */
export async function detectTransfers(db: Db, sinceDays = 120): Promise<number> {
  const rows = await db.execute(transferPairsSql(sinceDays));
  return Array.isArray(rows) ? rows.length : ((rows as { rowCount?: number }).rowCount ?? 0);
}

/** For aggregate queries: leave transfers out of income and spending. */
export const notTransfer = sql`not ${transactions.isTransfer}`;
