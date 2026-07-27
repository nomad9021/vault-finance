import { z } from "zod";

export const CategoryKind = z.enum(["expense", "income"]);
export type CategoryKind = z.infer<typeof CategoryKind>;

export const Category = z.object({
  id: z.string().uuid(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  parentCategoryId: z.string().uuid().nullable(),
  /** Manual display order among siblings; lower sorts first. */
  sortOrder: z.number().int(),
  /** "expense" categories shape spending; "income" categories are income sources. */
  kind: CategoryKind,
  isSystem: z.boolean(),
});
export type Category = z.infer<typeof Category>;

export const CreateCategoryRequest = z.object({
  name: z.string().min(1).max(60),
  icon: z.string().max(40).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  parentCategoryId: z.string().uuid().nullish(),
  kind: CategoryKind.optional(),
});
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;

export const UpdateCategoryRequest = CreateCategoryRequest.partial();
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

/** Nudge a category one slot up or down among its siblings. */
export const MoveCategoryRequest = z.object({
  direction: z.enum(["up", "down"]),
});
export type MoveCategoryRequest = z.infer<typeof MoveCategoryRequest>;

export const CategoryListResponse = z.object({
  categories: z.array(Category),
});
export type CategoryListResponse = z.infer<typeof CategoryListResponse>;
