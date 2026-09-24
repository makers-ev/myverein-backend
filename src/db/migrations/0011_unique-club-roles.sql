-- Keep the oldest row of each duplicate group before adding the constraint.
DELETE FROM "club_roles" a USING "club_roles" b
WHERE a."member_id" = b."member_id"
  AND a."role_type" = b."role_type"
  AND a."department_id" IS NOT DISTINCT FROM b."department_id"
  AND (a."created_at", a."id"::text) > (b."created_at", b."id"::text);--> statement-breakpoint
ALTER TABLE "club_roles" ADD CONSTRAINT "club_roles_member_role_department_uq" UNIQUE NULLS NOT DISTINCT("member_id","role_type","department_id");
