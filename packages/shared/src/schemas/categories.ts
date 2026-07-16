import { z } from "zod";

export const Category = z.object({
  id: z.string().uuid(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  parentCategoryId: z.string().uuid().nullable(),
  isSystem: z.boolean(),
});
export type Category = z.infer<typeof Category>;

export const CreateCategoryRequest = z.object({
  name: z.string().min(1).max(60),
  icon: z.string().max(40).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  parentCategoryId: z.string().uuid().nullish(),
});
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;

export const UpdateCategoryRequest = CreateCategoryRequest.partial();
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

export const CategoryListResponse = z.object({
  categories: z.array(Category),
});
export type CategoryListResponse = z.infer<typeof CategoryListResponse>;
