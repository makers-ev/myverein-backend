# Graph Report - myverein-backend  (2026-09-24)

## Corpus Check
- 104 files · ~57,909 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 958 nodes · 1707 edges · 77 communities (61 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4cd684c0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 104|Community 104]]
- [[_COMMUNITY_Community 105|Community 105]]
- [[_COMMUNITY_Community 106|Community 106]]
- [[_COMMUNITY_Community 107|Community 107]]
- [[_COMMUNITY_Community 114|Community 114]]
- [[_COMMUNITY_Community 115|Community 115]]
- [[_COMMUNITY_Community 123|Community 123]]
- [[_COMMUNITY_Community 130|Community 130]]
- [[_COMMUNITY_Community 131|Community 131]]
- [[_COMMUNITY_Community 157|Community 157]]
- [[_COMMUNITY_Community 160|Community 160]]
- [[_COMMUNITY_Community 162|Community 162]]
- [[_COMMUNITY_Community 167|Community 167]]
- [[_COMMUNITY_Community 173|Community 173]]
- [[_COMMUNITY_Community 214|Community 214]]
- [[_COMMUNITY_Community 215|Community 215]]
- [[_COMMUNITY_Community 224|Community 224]]
- [[_COMMUNITY_Community 265|Community 265]]
- [[_COMMUNITY_Community 332|Community 332]]
- [[_COMMUNITY_Community 344|Community 344]]
- [[_COMMUNITY_Community 346|Community 346]]
- [[_COMMUNITY_Community 347|Community 347]]
- [[_COMMUNITY_Community 348|Community 348]]
- [[_COMMUNITY_Community 349|Community 349]]
- [[_COMMUNITY_Community 350|Community 350]]
- [[_COMMUNITY_Community 351|Community 351]]
- [[_COMMUNITY_Community 352|Community 352]]
- [[_COMMUNITY_Community 353|Community 353]]
- [[_COMMUNITY_Community 354|Community 354]]
- [[_COMMUNITY_Community 355|Community 355]]
- [[_COMMUNITY_Community 356|Community 356]]
- [[_COMMUNITY_Community 357|Community 357]]
- [[_COMMUNITY_Community 358|Community 358]]
- [[_COMMUNITY_Community 359|Community 359]]
- [[_COMMUNITY_Community 360|Community 360]]
- [[_COMMUNITY_Community 361|Community 361]]
- [[_COMMUNITY_Community 473|Community 473]]
- [[_COMMUNITY_Community 477|Community 477]]

## God Nodes (most connected - your core abstractions)
1. `db` - 38 edges
2. `user` - 26 edges
3. `member` - 20 edges
4. `Auth` - 20 edges
5. `closeDatabase()` - 19 edges
6. `rateLimit()` - 19 edges
7. `organization` - 18 edges
8. `NotFoundError` - 18 edges
9. `toAppError()` - 18 edges
10. `ValidationError` - 17 edges

## Surprising Connections (you probably didn't know these)
- `requireSession helper` --rationale_for--> `Better Auth as Single Identity Provider`  [EXTRACTED]
  src/middleware/session-guard.ts → README.md
- `internalStatsRoutes (Hono router)` --rationale_for--> `Shared Postgres Enables Transactional Audit Log`  [INFERRED]
  src/routes/internal-stats.ts → README.md
- `Repo Lead Orchestration Workflow` --semantically_similar_to--> `Adding a New API Route Checklist`  [INFERRED] [semantically similar]
  CLAUDE.md → README.md
- `MyVerein Backend` --references--> `MyVerein Logo`  [INFERRED]
  README.md → assets/myverein-logo.png
- `rateLimit middleware test suite` --references--> `CI backend job`  [INFERRED]
  src/middleware/rate-limit.test.ts → .github/workflows/ci.yml

## Hyperedges (group relationships)
- **Welcome Notification Override Flow** — auth_ts_user_create_hook, notifications_ts_notificationTemplate, admin_notification_templates_ts_patch, notifications_ts_notification [EXTRACTED 0.95]
- **Notification Translations Migration Flow** — migration_0003, migration_0004, migration_0005, notifications_ts_notification, notifications_ts_notificationTemplate [EXTRACTED 0.95]
- **Internal Stats Token-Gate for External Portal Caller** — internal_stats_ts_internalstatsroutes, internal_stats_ts_checktoken, rationale_internal_stats_token_gate, external_project_portal_backend [INFERRED 0.80]
- **Request auth/guard pipeline** — readme_session_guard, readme_club_guard, readme_admin_guard [EXTRACTED 1.00]
- **Club/membership data model** — readme_organization_club, readme_club_memberships, readme_club_roles, readme_member_role [EXTRACTED 1.00]
- **Backend build, review and CI pipeline** — api_dev_agent, backend_reviewer_agent, ci_workflow [INFERRED 0.75]

## Communities (77 total, 16 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.12
Nodes (16): callerDepartmentIds(), getVisibleCalendarIds(), isCalendarVisible(), body, clubId, conditions, createEventSchema, currentUser (+8 more)

### Community 1 - "Community 1"
Cohesion: 0.16
Nodes (13): pingDatabase(), pool, schema, logger, LoggerEnv, requestId, healthRoutes, app (+5 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (23): addInviteeSchema, attendanceBatchSchema, attendanceEntrySchema, body, candidates, candidatesParam, candidateStrs, clubId (+15 more)

### Community 3 - "Community 3"
Cohesion: 0.16
Nodes (10): AppErrorOptions, BadRequestError, ConflictError, ErrorCode, ForbiddenError, InternalError, isUniqueViolation(), err (+2 more)

### Community 4 - "Community 4"
Cohesion: 0.13
Nodes (15): adminGuard, Session, SessionEnv, adminEmailRoutes, sendVerificationSchema, app, appError, body (+7 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (31): api-dev agent, backend-reviewer agent, CI GitHub Actions workflow, Repo Orchestration Workflow (plan then delegate then review then graphify), Backend Service, Loopback-Only BIND_HOST Default, DATABASE_URL Compose-Network Override, Postgres DB Service (+23 more)

### Community 6 - "Community 6"
Cohesion: 0.11
Nodes (16): applySchema, assignRoleSchema, body, callerMembership, clubId, currentUser, guardianLinkSchema, { guardianMemberId } (+8 more)

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (11): account, accountRelations, invitation, invitationRelations, memberRelations, organizationRelations, sessionRelations, twoFactor (+3 more)

### Community 8 - "Community 8"
Cohesion: 0.10
Nodes (14): currentUser, filter, id, notificationRoutes, afterRead, afterUnread, app, appError (+6 more)

### Community 9 - "Community 9"
Cohesion: 0.18
Nodes (12): accessControl, adminRole, roles, statement, userRole, APP_NAME, BRAND, buildResetPasswordEmail() (+4 more)

### Community 10 - "Community 10"
Cohesion: 0.14
Nodes (14): user, app, appError, body, suffix, translations, NewNotificationRow, NewNotificationStateRow (+6 more)

### Community 11 - "Community 11"
Cohesion: 0.18
Nodes (12): calendarVisibility, calendarVisibilityRelations, CalendarVisibilityRow, NewCalendarVisibilityRow, CalendarRow, calendars, calendarsRelations, NewCalendarRow (+4 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (16): meetingAttendance, meetingAttendanceRelations, MeetingAttendanceRow, MeetingInviteeRow, meetingInvitees, meetingInviteesRelations, MeetingResolutionRow, meetingResolutions (+8 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (11): eventRoutes, icsRoutes, app, appError, body1, body2, { data: calendar }, { data: event } (+3 more)

### Community 14 - "Community 14"
Cohesion: 0.21
Nodes (9): Shared-Postgres audit trail enables transactional audit writes, Session Create Audit Hook, db, internalStatsRoutes, sevenDaysAgo, app, appError, body (+1 more)

### Community 15 - "Community 15"
Cohesion: 0.18
Nodes (9): Auth, closeDatabase(), shutdown() function, myClubRoutes, app, appError, body, suffix (+1 more)

### Community 16 - "Community 16"
Cohesion: 0.17
Nodes (11): adminNotificationTemplateRoutes, body, byKey, currentUser, data, key, NOTIFICATION_TEMPLATE_KEYS, NotificationTemplateKey (+3 more)

### Community 17 - "Community 17"
Cohesion: 0.17
Nodes (10): calendarRoutes, app, appError, { data: calendar }, { data: firstCal }, { data: list }, { data: refetched }, { data: secondCal } (+2 more)

### Community 18 - "Community 18"
Cohesion: 0.17
Nodes (10): locationRoutes, app, appError, body, getBody, hiddenBody, listBody, otherLocBody (+2 more)

### Community 19 - "Community 19"
Cohesion: 0.17
Nodes (9): mediaRoutes, app, appError, body, bytes, form, suffix, uploadBody (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.20
Nodes (8): ClubMembershipRow, clubMemberships, clubMembershipsRelations, NewClubMembershipRow, ClubRoleRow, clubRoles, clubRolesRelations, NewClubRoleRow

### Community 21 - "Community 21"
Cohesion: 0.20
Nodes (9): BOARD_ROLE_TYPES, CLUB_ROLE_TYPES, ClubPermission, clubPermissionsFor(), ClubRoleType, hasClubPermission(), ROLE_PERMISSIONS, requireInventoryWrite() (+1 more)

### Community 22 - "Community 22"
Cohesion: 0.18
Nodes (10): body, clubId, createCalendarSchema, currentUser, id, membership, roleTypes, updateCalendarSchema (+2 more)

### Community 23 - "Community 23"
Cohesion: 0.17
Nodes (8): clubMemberRoutes, app, appError, body, cleared, { data }, meBody, suffix

### Community 24 - "Community 24"
Cohesion: 0.09
Nodes (29): session, ActivityBucketResult, computeActivityBuckets(), dayKey(), DayRow, generateDayKeys(), generateWeekKeys(), periodKeyFn() (+21 more)

### Community 25 - "Community 25"
Cohesion: 0.18
Nodes (9): inventoryItemRoutes, app, appError, body, emptyBody, filteredBody, otherItemBody, suffix (+1 more)

### Community 26 - "Community 26"
Cohesion: 0.20
Nodes (7): meetingRoutes, app, appError, body, candidatesParam, listBody, suffix

### Community 27 - "Community 27"
Cohesion: 0.22
Nodes (8): EventAttendeeRow, eventAttendees, eventAttendeesRelations, NewEventAttendeeRow, EventRow, events, eventsRelations, NewEventRow

### Community 28 - "Community 28"
Cohesion: 0.22
Nodes (8): AvailabilityExceptionRow, availabilityExceptions, availabilityExceptionsRelations, AvailabilitySlotRow, availabilitySlots, availabilitySlotsRelations, NewAvailabilityExceptionRow, NewAvailabilitySlotRow

### Community 29 - "Community 29"
Cohesion: 0.14
Nodes (13): compilerOptions, jsx, jsxImportSource, module, outDir, rootDir, skipLibCheck, strict (+5 more)

### Community 30 - "Community 30"
Cohesion: 0.07
Nodes (28): AvailabilityInput, computeAvailability(), isMemberAvailable(), candidate, members, toDateString(), toSchemaWeekday(), availabilityRoutes (+20 more)

### Community 31 - "Community 31"
Cohesion: 0.29
Nodes (4): Single central AppError-to-HTTP mapping point, app.onError handler, AppError, toAppError()

### Community 32 - "Community 32"
Cohesion: 0.33
Nodes (5): member, GuardianLinkRow, guardianLinks, guardianLinksRelations, NewGuardianLinkRow

### Community 33 - "Community 33"
Cohesion: 0.33
Nodes (5): organization, ClubInfoPageRow, clubInfoPages, clubInfoPagesRelations, NewClubInfoPageRow

### Community 66 - "Community 66"
Cohesion: 0.06
Nodes (43): Admin Notification Templates Integration Tests, Admin Notification Templates Routes, DELETE /:key Revert Handler, PATCH /:key Upsert Handler, Admin Notifications Routes, POST / Create Admin Notification Handler, ADR-006 (Notification Content Models), ADR-009 (Translations JSONB Registry) (+35 more)

### Community 78 - "Community 78"
Cohesion: 0.20
Nodes (9): CI backend job, project-portal-backend / Fleet Dashboard, internal stats token-gate test suite, internalStatsRoutes (Hono router), TooManyRequestsError, rateLimit middleware test suite, rateLimit middleware factory, In-Memory Per-Instance Rate Limiting Trade-off (+1 more)

### Community 104 - "Community 104"
Cohesion: 0.15
Nodes (13): dependencies, better-auth, @better-auth/expo, dotenv, drizzle-orm, hono, @hono/node-server, @hono/zod-validator (+5 more)

### Community 105 - "Community 105"
Cohesion: 0.15
Nodes (13): devDependencies, @better-auth/cli, drizzle-kit, eslint, @eslint/js, pino-pretty, tsx, @types/node (+5 more)

### Community 106 - "Community 106"
Cohesion: 0.15
Nodes (13): dependencies, better-auth, @better-auth/expo, dotenv, drizzle-orm, hono, @hono/node-server, @hono/zod-validator (+5 more)

### Community 107 - "Community 107"
Cohesion: 0.15
Nodes (13): devDependencies, @better-auth/cli, drizzle-kit, eslint, @eslint/js, pino-pretty, tsx, @types/node (+5 more)

### Community 114 - "Community 114"
Cohesion: 0.17
Nodes (12): scripts, auth:generate, build, db:generate, db:migrate, db:migrate:runtime, dev, lint (+4 more)

### Community 115 - "Community 115"
Cohesion: 0.18
Nodes (11): scripts, auth:generate, build, db:generate, db:migrate, db:migrate:runtime, dev, lint (+3 more)

### Community 123 - "Community 123"
Cohesion: 0.25
Nodes (7): checkToken function, ServiceUnavailableError, UnauthorizedError, Token-Gated Internal Stats Instead of Session Auth, adminGuard middleware, requireSession helper, sessionGuard middleware

### Community 130 - "Community 130"
Cohesion: 0.25
Nodes (9): auth.ts (Better Auth instance), Better Auth (single identity provider), COOKIE_DOMAIN cross-subdomain login-loop runbook, sendEmail() (src/lib/email.ts), buildResetPasswordEmail(), buildVerifyEmailEmail(), layout() function, Key Decisions Section (+1 more)

### Community 131 - "Community 131"
Cohesion: 0.25
Nodes (7): BRAND palette object, globals.css theme tokens (--border etc.), LanguageContext (website/mobile templates), ADR-010 (branding config convention), primaryColor constant, Backend README, Rebranding This Template Section

### Community 157 - "Community 157"
Cohesion: 0.25
Nodes (9): Immediate membership grant (no approval queue), Calendar visibility allow-list algorithm, club_memberships table, club-permissions.ts / hasClubPermission, club_roles table, guardian_links table, member.role (coarse Better Auth role), Organization (Club) (+1 more)

### Community 160 - "Community 160"
Cohesion: 0.06
Nodes (42): NotFoundError, ValidationError, getObject(), putObject(), sanitizeFilename(), ClubEnv, clubGuard, MemberRow (+34 more)

### Community 162 - "Community 162"
Cohesion: 0.07
Nodes (32): body, clubId, conditions, createKeyHolderSchema, createLinkSchema, createLocationSchema, createWifiSchema, id (+24 more)

### Community 167 - "Community 167"
Cohesion: 0.06
Nodes (32): Adding a new API route, API reference, Architecture, code:block1 (cp .env.example .env   # set BETTER_AUTH_SECRET and POSTGRES), code:ts (app.route("/widgets", widgetRoutes);), code:groovy (pipeline {), code:bash (curl -si -X POST https://api.example.com/api/auth/sign-in/em), code:mermaid (flowchart LR) (+24 more)

### Community 173 - "Community 173"
Cohesion: 0.06
Nodes (37): addDaysUTC(), effectiveLoanStatus(), isLoanOverdue(), isMaintenanceDue(), LoanOverdueInput, maintenanceDueDate(), MaintenanceDueInput, now (+29 more)

### Community 214 - "Community 214"
Cohesion: 0.67
Nodes (5): deploy.sh script, check_env_file(), deploy(), restart(), seed_admin()

### Community 215 - "Community 215"
Cohesion: 0.43
Nodes (5): buildIcs(), escapeIcsText(), formatIcsDateTime(), IcsEventInput, ics

### Community 224 - "Community 224"
Cohesion: 0.29
Nodes (6): author, name, type, author, name, type

### Community 265 - "Community 265"
Cohesion: 0.20
Nodes (8): EmailAttachment, sendEmail(), createTransportMock, loadSendEmail(), originalEnv, resendCtorMock, resendSendMock, sendMailMock

### Community 332 - "Community 332"
Cohesion: 0.08
Nodes (28): api-dev Subagent, backend-reviewer Subagent, Graphify Usage Policy, Repo Lead Orchestration Workflow, account Table (Better Auth Credential Storage), accounts Resource (App-Owned), Adding a New API Route Checklist, /admin/activity-stats Route (+20 more)

### Community 344 - "Community 344"
Cohesion: 0.50
Nodes (4): auth.ts welcome-notification hook (databaseHooks.user.create), APP_NAME export, notification_template table, appName constant

### Community 346 - "Community 346"
Cohesion: 0.67
Nodes (3): Backend Email Branding, LPJ IT Solutions Brand Identity, LPJ ITS Logo

### Community 473 - "Community 473"
Cohesion: 0.50
Nodes (3): Available subagents in this repo, Graphify, Orchestration

## Ambiguous Edges - Review These
- `adminGuard middleware` → `/internal/stats endpoint`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to

## Knowledge Gaps
- **538 isolated node(s):** `name`, `author`, `type`, `dev`, `build` (+533 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `adminGuard middleware` and `/internal/stats endpoint`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `db` connect `Community 14` to `Community 0`, `Community 1`, `Community 2`, `Community 4`, `Community 6`, `Community 8`, `Community 9`, `Community 10`, `Community 11`, `Community 13`, `Community 15`, `Community 16`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 22`, `Community 23`, `Community 24`, `Community 25`, `Community 26`, `Community 30`, `Community 160`, `Community 162`, `Community 173`, `Community 66`?**
  _High betweenness centrality (0.154) - this node is a cross-community bridge._
- **Why does `db/migrate.ts (runtime migration runner)` connect `Community 66` to `Community 224`, `Community 1`, `Community 14`?**
  _High betweenness centrality (0.128) - this node is a cross-community bridge._
- **Why does `internal stats token-gate test suite` connect `Community 78` to `Community 66`, `Community 31`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
- **What connects `name`, `author`, `type` to the rest of the system?**
  _565 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.11695906432748537 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._