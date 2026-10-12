# MyVerein Backend

A Hono API for MyVerein, a club-management product for German-style Vereine (Mitgliederverwaltung, Kalender/Treffen, Lager/Material, Standort-Infocenter — see the [MyVerein Concept](../../lpj-its-vault/20_Products/MyVerein/01_Concept%20&%20Planning/Concept%20-%20MyVerein.md) in the company vault). Forked from the Better Auth Template Suite's `_template_better-auth-backend`; Better Auth still owns identity end to end (sign-up, sign-in, sessions, two-factor, organizations, admin roles) — nothing here re-implements auth.

A club is a Better Auth `organization`; a person's club identity is an app-owned `club_members` row (Wave 7, [ADR-003](../lpj-its-vault/20_Products/MyVerein/Architecture%20%26%20ADRs/ADR-003%20-%20Mitglied%20ohne%20Konto%20als%20eigene%20Entitaet.md): master data, status, category, member number, optionally linked to Better Auth's `member` account row — members without an account, e.g. children, exist too), plus a `club_roles` table for fine-grained board/department roles (Vorsitz, Kassenwart, Trainer, ...) layered on top of Better Auth's own coarse `member.role`. See [Data model](#data-model) for the full shape and [Key decisions](#key-decisions) for why the role model is split this way.

Clone it, set three environment variables, run `docker compose up`, and you have a working backend with an audit trail, rate limiting, and a real e-mail flow. The rest of this document explains what's actually in the box and why it's built the way it is.

## Table of contents

- [Getting started](#getting-started)
- [Architecture](#architecture)
- [Data model](#data-model)
- [API reference](#api-reference)
- [Rights and read scoping](#rights-and-read-scoping-wave-7-b7b8)
- [Adding a new API route](#adding-a-new-api-route)
- [Configuration](#configuration)
- [Security](#security)
- [Key decisions](#key-decisions)
- [Deployment](#deployment)
- [Operations](#operations)
- [Testing and CI](#testing-and-ci)
- [How this fits into the template suite](#how-this-fits-into-the-template-suite)
- [License](#license)

## Getting started

### Docker (recommended)

```
cp .env.example .env   # set BETTER_AUTH_SECRET and POSTGRES_PASSWORD at minimum
docker compose up -d
docker compose exec backend node dist/scripts/seed-admin.js
```

`npm run seed:admin` (see [Scripts](#scripts)) is the host-mode equivalent -- it isn't available inside the container itself, since the runner image ships only the compiled `dist/` output and production dependencies, not `package.json`, `src/`, or `tsx`.

The backend container runs the committed Drizzle migrations before starting the server, so tables exist after the first boot with nothing to run by hand. The admin account is a deliberately separate, explicit step — nothing is auto-provisioned from default credentials. The `db` service's port 5432 is published to the host for local inspection (psql, Drizzle Studio); remove that mapping for a deployment where only `backend` should be reachable.

### Host mode

```
npm install
cp .env.example .env   # point DATABASE_URL at a Postgres you already have running
npm run db:migrate
npm run dev
```

```
curl http://localhost:3000/health
```

### Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Hot-reloading dev server (`tsx watch`) |
| `npm run build` | Compile to `dist/` |
| `npm run start` | Run the compiled server |
| `npm run db:generate` | Generate a Drizzle migration from schema changes |
| `npm run db:migrate` | Apply migrations via the `drizzle-kit` CLI (host mode) |
| `npm run db:migrate:runtime` | Apply migrations via Drizzle's own migrator, no `drizzle-kit` dependency needed — what the Docker image runs |
| `npm run seed:admin` | Create or promote the admin user from `ADMIN_EMAIL`/`ADMIN_PASSWORD` |
| `npm run seed:club` | Bootstrap a demo club and make `ADMIN_EMAIL` its "vorsitz" — needed for local dev. Real users create clubs through the Wave 6 registration + review flow (`/club-registrations`, [Club registration](#club-registration)); `organization/create` is closed for end users, `seed:club` and the approval call `auth.api.createOrganization` server-side, which is still allowed. See `src/scripts/seed-club.ts` |
| `npm run auth:generate` | Regenerate `src/auth/auth-schema.ts` from the Better Auth config |
| `npm run lint` | ESLint |
| `npm test` | Vitest (unit + integration) |

## Architecture

Hono handles routing and middleware; Better Auth owns everything under `/api/auth/*`; Drizzle talks to Postgres. There is exactly one `betterAuth()` instance (`src/auth/auth.ts`) and exactly one Postgres pool (`src/db/client.ts`) — both are imported everywhere they're needed rather than re-created per request.

```mermaid
flowchart TD
    subgraph Clients
        Web["myverein-website\n(Next.js)"]
        Mobile["myverein-mobile\n(Expo)"]
    end

    subgraph Backend["myverein-backend"]
        CORS["CORS + secureHeaders + requestId\n(global middleware)"]
        Auth["/api/auth/*\nBetter Auth handler"]
        Members["/club-members/*\nsessionGuard + clubGuard"]
        Departments["/departments/*\nsessionGuard + clubGuard"]
        ClubInfo["/club-info/*\nsessionGuard + clubGuard"]
        Calendars["/calendars/*\nsessionGuard + clubGuard"]
        Events["/events/*, /events.ics\nsessionGuard + clubGuard"]
        Availability["/availability/*\nsessionGuard + clubGuard"]
        Meetings["/meetings/*\nsessionGuard + clubGuard"]
        Registrations["/club-registrations/*\nsession, verified e-mail"]
        AdminRegistrations["/admin/club-registrations/*\nsession + adminGuard"]
        Health["/health, /ready"]
        Stats["/internal/stats\nINTERNAL_STATS_TOKEN, no session"]
        AdminStats["/admin/activity-stats\nsession + adminGuard"]
    end

    Admin["myverein-admin\n(Next.js)"]
    Portal["fleet/portal tool\n(not an end-user client)"]
    DB[(Postgres)]

    Web --> CORS
    Mobile --> CORS
    Admin --> CORS
    CORS --> Auth
    CORS --> Members
    CORS --> Departments
    CORS --> ClubInfo
    CORS --> Calendars
    CORS --> Events
    CORS --> Availability
    CORS --> Meetings
    CORS --> Registrations
    CORS --> AdminRegistrations
    CORS --> Health
    CORS --> AdminStats
    Portal -->|bearer token| Stats
    Auth --> DB
    AdminStats --> DB
    Members --> DB
    Departments --> DB
    ClubInfo --> DB
    Calendars --> DB
    Events --> DB
    Availability --> DB
    Meetings --> DB
    Registrations --> DB
    AdminRegistrations --> DB
    Stats --> DB
    Health -.->|/ready only| DB
```

Request flow for anything under `/club-members`, `/club-applications`, `/departments`, `/club-info`, `/calendars`, `/events`, `/availability`, or `/meetings`: `requestId` middleware stamps an `X-Request-Id` and attaches a request-scoped logger, `secureHeaders` sets response headers, `cors` checks the origin against `trustedOrigins`, `rateLimit` checks a per-IP bucket, `sessionGuard` calls `auth.api.getSession()` and attaches `user`/`session`, `clubGuard` resolves which club (`organization`) the request is for and attaches `clubId`/`membership`/`clubRoleTypes` — and only then does the route handler run. `POST /club-members/apply` is the one exception: it deliberately skips `clubGuard` (the applicant isn't a member yet; `/club-applications` itself runs the full chain plus a `members:write` check), see [Key decisions](#key-decisions). `/club-registrations` (applicant, no club yet) runs `sessionGuard` plus a verified-e-mail check, `/admin/club-registrations` runs `adminGuard`; neither uses `clubGuard`, see [Club registration](#club-registration). `GET /events.ics` is mounted separately at top level (see [Layout](#architecture) below) but runs the same `sessionGuard` + `clubGuard` chain — there is no unauthenticated calendar-feed link, see [Key decisions](#key-decisions). Any error thrown at any stage becomes an `AppError` via `toAppError()` in `app.onError` — nothing unhandled ever reaches a client as a raw stack trace.

Layout:

```
src/
├── auth/             # Better Auth instance, generated schema, RBAC statements
├── db/                # Drizzle client, migrations, app-owned schema (club_members, member_categories, club_member_departments,
│                       #   club_member_status_history, club_member_invites, club_settings, club_exit_requests, club_memberships [deprecated, read-only], departments,
│                       #   club_roles, guardian_links, club_info_pages, club_applications, audit_log, calendars,
│                       #   calendar_visibility, events, event_attendees, availability_slots,
│                       #   availability_exceptions, meetings, meeting_invitees, meeting_attendance,
│                       #   meeting_resolutions, club_registrations, club_registration_documents, media_files)
├── lib/               # errors, email, logger, activity-stats, club-permissions, calendar-visibility,
│                       #   availability-match, ics, member-number, club-members, member-lifecycle, member-invites, exit-notice, club-settings, club-stats, club-slug, club-registrations, club-registration-mail, media, media-url, image-sanitize, member-photos, storage — cross-cutting, no HTTP awareness
├── middleware/         # session-guard, club-guard, rate-limit, request-id
├── routes/            # health, club-members, club-exit-requests, club-settings, club-stats, club-applications, club-registrations, admin-club-registrations, departments, club-info, calendars, events, availability,
│                       #   meetings, internal-stats, admin-stats, admin-clubs
└── scripts/           # seed-admin, seed-club (CLI, not server runtime)
```

## Data model

Better Auth manages its own tables (generated into `src/auth/auth-schema.ts` by `npm run auth:generate` — do not hand-edit that file), including `organization`/`member`/`invitation` from the `organization()` plugin, which MyVerein uses as its club/membership fundament (a club **is** an `organization`). The app owns thirty-seven more: the Wave 1 set — `club_memberships` (deprecated since Wave 7, no longer written), `club_applications` (Wave 5), `departments`, `club_roles`, `guardian_links`, `club_info_pages`, `audit_log`, and `notification`/`notification_state`/`notification_template` (unchanged from the suite) — the Wave 2 calendar/meeting set — `calendars`, `calendar_visibility`, `events`, `event_attendees`, `availability_slots`, `availability_exceptions`, `meetings`, `meeting_invitees`, `meeting_attendance`, `meeting_resolutions` — and the Wave 3 location/inventory set — `locations`, `location_key_holders`, `location_key_history` (Wave 7 B14), `location_wifi_networks`, `location_links`, `inventory_items`, `inventory_loans`, `inventory_damage_reports` — and the Wave 6 club-registration set — `club_registrations`, `club_registration_documents` — and the Wave 7 member-foundation set — `club_members`, `member_categories`, `club_member_departments`, `club_member_status_history`, `club_settings`, `club_exit_requests`, `club_member_invites`. See the company vault's [Data Model - MyVerein Backend](../../lpj-its-vault/30_Engineering%20&%20Tech/System%20Design/MyVerein/Data%20Model%20-%20MyVerein%20Backend.md) for the full planning doc.

```mermaid
erDiagram
    user ||--o{ session : "has"
    user ||--o{ account : "has"
    user ||--o{ member : "belongs to clubs via"
    user ||--o{ two_factor : "has"
    organization ||--o{ member : "has"
    organization ||--o{ invitation : "has"
    organization ||--o{ departments : "has"
    organization ||--o{ club_info_pages : "has"
    user ||--o{ club_applications : "applies via"
    organization ||--o{ club_applications : "receives"
    member ||--o{ club_applications : "decides (decided_by)"
    user ||--o{ club_registrations : "applies for a new club"
    user ||--o{ club_registrations : "reviews (reviewed_by)"
    organization ||--o| club_registrations : "created by (club_id)"
    club_registrations ||--o{ club_registration_documents : "proof"
    member ||--o| club_memberships : "extends (deprecated, read-only)"
    organization ||--o{ club_members : "has"
    member ||--o| club_members : "account of (member_id, nullable, unique)"
    organization ||--o{ member_categories : "defines"
    member_categories ||--o{ club_members : "categorises"
    club_members ||--o{ club_member_departments : "belongs to"
    departments ||--o{ club_member_departments : "has"
    club_members ||--o{ club_member_status_history : "logs"
    club_members ||--o{ club_exit_requests : "leaves via"
    club_members ||--o{ club_member_invites : "is invited via"
    organization ||--o| club_settings : "configures"
    club_members ||--o{ guardian_links : "is guarded (as ward)"
    member ||--o{ club_roles : "has"
    member ||--o{ guardian_links : "guards (as guardian)"
    departments ||--o{ club_roles : "scopes (optional)"
    organization ||--o{ calendars : "has"
    departments ||--o{ calendars : "scopes (optional)"
    calendars ||--o{ calendar_visibility : "has"
    calendars ||--o{ events : "has"
    events ||--o{ event_attendees : "has"
    member ||--o{ availability_slots : "has"
    member ||--o{ availability_exceptions : "has"
    organization ||--o{ meetings : "has"
    meetings ||--o{ meeting_invitees : "has"
    meetings ||--o{ meeting_attendance : "has"
    meetings ||--o{ meeting_resolutions : "has"
    organization ||--o{ locations : "has"
    locations ||--o{ location_key_holders : "has"
    locations ||--o{ location_key_history : "logs key handovers"
    locations ||--o{ location_wifi_networks : "has"
    locations ||--o{ location_links : "has"
    locations ||--o{ events : "hosts (optional)"
    locations ||--o{ meetings : "hosts (optional)"
    organization ||--o{ inventory_items : "has"
    locations ||--o{ inventory_items : "stores"
    inventory_items ||--o{ inventory_loans : "has"
    inventory_items ||--o{ inventory_damage_reports : "has"

    user {
        text id PK
        text email UK
        boolean email_verified
        text role
        boolean two_factor_enabled
    }
    organization {
        text id PK
        text slug UK
        text name
    }
    member {
        text id PK
        text organization_id FK
        text user_id FK
        text role "Better Auth org role: owner | member, coarse"
    }
    club_memberships {
        uuid id PK
        text member_id FK "1:1"
        text member_number
        text category "aktiv | passiv | foerdernd | ehrenmitglied | jugend"
        date joined_at
        date left_at
        date birth_date
        text emergency_contact_name
        text emergency_contact_phone
    }
    club_members {
        uuid id PK "canonical member id in the API"
        text club_id FK
        text member_id FK "Better Auth member, NULL = no account, unique, ON DELETE SET NULL"
        text display_name
        text first_name
        text last_name
        date birth_date
        text street
        text postal_code
        text city
        text phone
        text contact_email
        text emergency_contact_name
        text emergency_contact_phone
        text member_number "per club unique via API (409), not in DB"
        uuid category_id FK
        text status "interessent | probe | aktiv | ruhend | ausgetreten | ausgeschlossen | verstorben"
        date joined_at
        date left_at
        text exit_reason
        timestamptz account_unlinked_at "set by POST /:id/unlink, keeps the row from being closed or reused"
        text photo_key FK "media_files.storage_key (profile photo, B13), ON DELETE SET NULL; never a URL"
        timestamptz created_at
        timestamptz updated_at
    }
    club_member_invites {
        uuid id PK
        uuid club_member_id FK
        text email "invited address, lower case"
        text token_hash "HMAC-SHA256 of the token, unique"
        timestamptz expires_at
        timestamptz accepted_at "NULL = open; at most one open invite per member"
        text created_by FK "member.id"
        timestamptz created_at
    }
    member_categories {
        uuid id PK
        text club_id FK
        text key "UK with club_id"
        text name
        boolean voting_right
        int min_age
        int max_age
        text auto_transition_to_key
        int sort_order
        timestamptz archived_at
    }
    club_member_departments {
        uuid id PK
        uuid club_member_id FK
        uuid department_id FK
        date since
        date until "NULL = open, one open row per pair"
    }
    club_member_status_history {
        uuid id PK
        uuid club_member_id FK
        text from_status
        text to_status
        uuid from_category_id FK
        uuid to_category_id FK
        date effective_on
        text reason
        text changed_by FK "member.id"
    }
    club_settings {
        text club_id PK
        int notice_period_days
        text notice_mode "month_end | quarter_end | year_end | immediate"
        text member_number_prefix
        boolean allow_self_loans
    }
    club_exit_requests {
        uuid id PK
        uuid club_member_id FK
        text kind "cancellation | exclusion"
        text requested_by FK "member.id"
        date requested_on
        date desired_effective_on
        date effective_on
        text reason
        text status "pending | approved | rejected | withdrawn"
        text decided_by FK "member.id"
        timestamptz decided_at
        text decision_note
    }
    club_applications {
        uuid id PK
        text user_id FK
        text club_id FK
        text category
        date birth_date
        text status "pending | approved | rejected"
        timestamptz created_at
        timestamptz decided_at
        text decided_by FK "member.id"
    }
    club_registrations {
        uuid id PK
        text user_id FK "applicant"
        text club_name
        text legal_form "e_v | nicht_eingetragen | sonstige"
        text register_court
        text register_number
        text street
        text postal_code
        text city
        text website_url
        text claimed_role "vorsitz | stellv_vorsitz"
        text status "draft | pending | needs_info | approved | rejected"
        text review_note
        text reviewed_by FK "user.id"
        timestamptz reviewed_at
        text club_id FK "organization, set on approval"
        text slug_suggestion
        timestamptz created_at
        timestamptz updated_at
        timestamptz submitted_at
    }
    club_registration_documents {
        uuid id PK
        uuid registration_id FK
        text kind "registerauszug | satzung | freistellungsbescheid | gruendungsprotokoll | sonstiges"
        text storage_key "registrations/<id>/..."
        text filename
        text mime_type
        bigint size_bytes
        timestamptz created_at
    }
    departments {
        uuid id PK
        text club_id FK
        text name
        text lead_member_id FK
    }
    club_roles {
        uuid id PK
        text member_id FK
        text role_type "vorsitz | kassenwart | trainer | ... see club-permissions.ts (mitglied is implicit, never stored)"
        uuid department_id FK "only for department-bound roles"
        date term_ends_at
    }
    guardian_links {
        uuid id PK
        text guardian_member_id FK "member.id (account required)"
        uuid ward_club_member_id FK "club_members.id (account optional)"
    }
    club_info_pages {
        uuid id PK
        text club_id FK
        text slug "satzung | leitbild | geschichte | ..."
        text title
        text content_markdown
        text external_url
    }
    audit_log {
        uuid id PK
        text event_type
        text subject_id
        jsonb payload
    }
    calendars {
        uuid id PK
        text club_id FK
        uuid department_id FK "null = club-wide"
        text name
        boolean is_default
    }
    calendar_visibility {
        uuid id PK
        uuid calendar_id FK
        text member_id FK "exactly one of member/role/department set"
        text role_type
        uuid department_id FK
    }
    events {
        uuid id PK
        uuid calendar_id FK
        text title
        timestamp starts_at
        integer capacity
    }
    event_attendees {
        uuid id PK
        uuid event_id FK
        text member_id FK
        text status "angemeldet | abgesagt | warteliste"
    }
    availability_slots {
        uuid id PK
        text member_id FK
        integer weekday "0-6, Monday-Sunday"
        time start_time
        time end_time
    }
    availability_exceptions {
        uuid id PK
        text member_id FK
        date date
        boolean is_available
    }
    meetings {
        uuid id PK
        text club_id FK
        text type "vorstandssitzung | mitgliederversammlung | sonstige"
        timestamp scheduled_at "null while Terminfindung"
        text status
    }
    meeting_invitees {
        uuid id PK
        uuid meeting_id FK
        text member_id FK
        text response "ausstehend | zugesagt | abgesagt"
    }
    meeting_attendance {
        uuid id PK
        uuid meeting_id FK
        text member_id FK
        boolean present
        boolean has_voting_right
        text proxy_for_member_id FK "nullable, Vollmacht"
    }
    meeting_resolutions {
        uuid id PK
        uuid meeting_id FK
        text description
        text result "angenommen | abgelehnt"
        text correction_note "Berichtigungsvermerk, nullable"
        timestamp corrected_at
        text corrected_by FK "nullable"
    }
    locations {
        uuid id PK
        text club_id FK
        text name
        text address
        numeric latitude
        numeric longitude
        text photo_key "media_files.storage_key, never a URL (B18)"
    }
    location_key_holders {
        uuid id PK
        uuid location_id FK
        text member_id FK
        text key_label "which key / code (B14)"
    }
    location_key_history {
        uuid id PK
        uuid location_id FK
        text action "issued | returned"
        text member_id FK "SET NULL when the account is removed"
        text member_name "snapshot"
        text key_label
        text note
        text recorded_by FK "SET NULL"
        text recorded_by_name "snapshot"
        timestamptz created_at
    }
    location_wifi_networks {
        uuid id PK
        uuid location_id FK
        text ssid
        text password "plain text, see Security; '' when security = open"
        text security "open | wpa | wep | wpa3 (B14)"
        text visibility "gast | mitglied | vorstand"
    }
    location_links {
        uuid id PK
        uuid location_id FK
        text title
        text url
        text visibility "gast | mitglied | vorstand"
    }
    inventory_items {
        uuid id PK
        text club_id FK
        text name
        text condition "gut | beschaedigt | defekt"
        uuid location_id FK "nullable, ON DELETE SET NULL"
        integer acquisition_value_cents
        integer maintenance_interval_days
        date last_maintenance_at
    }
    inventory_loans {
        uuid id PK
        uuid item_id FK
        text member_id FK
        timestamp due_at
        timestamp returned_at
        text status "ausgeliehen | zurueckgegeben (ueberfaellig is derived, never stored)"
    }
    inventory_damage_reports {
        uuid id PK
        uuid item_id FK
        text reported_by FK
        text description
        text photo_key "media_files.storage_key, never a URL (B18)"
        text status "gemeldet | in_bearbeitung | behoben"
    }
    media_files {
        uuid id PK
        text club_id FK "NULL = platform level (club registration proofs), ON DELETE CASCADE"
        text storage_key "unique, <clubId>/<uuid>.<ext> or registrations/<id>/<uuid>.<ext>"
        text owner_type "unattached | damage_report | location | club_member | club_registration | legacy | ..."
        text owner_id
        text kind "image | document"
        text mime_type "verified via magic bytes, source of truth for Content-Type"
        integer size_bytes "after metadata stripping"
        text sha256
        text original_filename "sanitized, never part of the key"
        boolean sensitive "true = never a signed URL, only authenticated + audited stream"
        text visibility "private | club | public_opt_in"
        text uploaded_by FK "user.id, ON DELETE SET NULL"
        timestamptz created_at
        timestamptz deleted_at "tombstone: file removed, GET answers 404"
    }
```

`notification`/`notification_state`/`notification_template` are omitted from the diagram above for space — unchanged from [Data Model - Better Auth Backend](../../lpj-its-vault/30_Engineering%20&%20Tech/System%20Design/Better%20Auth%20Template%20Suite/Data%20Model%20-%20Better%20Auth%20Backend.md), see there for the full shape.

**Two role concepts, deliberately layered, not merged.** Better Auth's `member.role` is the org plugin's own coarse role (`owner`/`member` by default, unmodified) and only matters for Better-Auth-native organization actions. Everything MyVerein-specific — who can edit member data, assign roles, manage departments or club info — is decided by `club_roles.role_type` via `src/lib/club-permissions.ts`'s `hasClubPermission()`, independent of `member.role`. A membership can hold several `club_roles` rows at once (e.g. `kassenwart` + `trainer`), but never the same role twice for the same department (unique constraint). See [Key decisions](#key-decisions).

**`club_members` (Wave 7, ADR-003) is the club-side identity of a person** and replaces `club_memberships` as the home of master data. `member_id` (nullable, unique, `ON DELETE SET NULL`) links the Better Auth `member` account membership; `NULL` means "member without account" (e.g. a child). Everything that needs a login stays on `member.id` (`club_roles`, loans, RSVP, availability, `departments.lead_member_id`, `club_applications.decided_by`); `guardian_links.ward_club_member_id` points to `club_members.id` while `guardian_member_id` stays an account `member.id`. **Invariant: every `member` row has exactly one `club_members` row** — created by the Better Auth `afterAddMember`/`afterAcceptInvitation` hook (`src/auth/auth.ts`), and additionally by every explicit join path through `ensureClubMember` (`src/lib/club-members.ts`: application approval, club-registration approval, `seed:club`, `/me`, `GET /club-members`). `last_user_id` remembers the account that was linked last. **Removing the account membership** (Better Auth `removeMember`, `leave`, or deleting the user) keeps the `club_members` row (`member_id` → NULL) and closes it: status `ausgetreten`, `left_at` = today, `exit_reason` "Konto-Mitgliedschaft entfernt", a `club_member_status_history` entry — so no ghost active member remains. `afterRemoveMember` does this immediately; `leave` and user deletion fire no Better Auth hook, there the same closing happens lazily on `GET /club-members` and when a member is resolved by id (`markDetachedMembersLeft`). **Re-join** of the same person (`ensureClubMember` matches `last_user_id` in the club; blocked with `409` if that row is `ausgeschlossen`/`verstorben`, see [Member lifecycle](#member-lifecycle)) reuses the old row — same member number, status back to `aktiv`, new history entry "Konto-Mitgliedschaft wiederhergestellt" — instead of creating a duplicate. Members created by the board without account (`last_user_id` NULL) are never closed by this. **Open consequence (Wave 10):** the master data of a deleted account stays in `club_members` until the data-protection concept (deletion/anonymisation) is implemented. **Operations check:** `checkClubMemberConsistency(db, clubId?)` (`src/lib/club-members.ts`) returns per club `members`, `linked`, `missing`; `missing` must be 0 (every `member` row has its `club_members` row) — run it after deployments/imports; `GET /club-members` and id resolution repair gaps on their own. `member_number` is intentionally **not** unique in the database (legacy data may contain duplicates); the API enforces uniqueness per club with `409` on manual assignment. `member_categories` holds the per-club categories (the five defaults `aktiv`, `passiv`, `foerdernd`, `ehrenmitglied`, `jugend` are created per club by `ensureDefaultCategories`; voting right: `jugend` and `foerdernd` false); `club_member_departments` links members to departments with a validity period (`until IS NULL` = current; unique per open pair); `club_member_status_history` logs status/category changes (`POST /club-members` writes the first entry, `POST /club-members/:id/transition`, category moves, age transitions and account removal add more; see [Member lifecycle](#member-lifecycle)); `club_settings` (notice period/mode, member-number prefix, `allow_self_loans`; a club without a row runs on the defaults) and `club_exit_requests` (cancellation/exclusion, [Exit workflow](#exit-workflow)) have their routes since B6/B8. Migration `0017_member-search-index` adds `club_members_club_name_idx (club_id, lower(display_name))` for the paged name sort (B9) — an expression index on `lower(display_name)`, created next to the existing `(club_id, status)` and `(club_id, member_number)` indexes; `0016_roles-scoping` is the rights track. Migration `0018_member-invites-exit-requests` (B4/B6) adds the table `club_member_invites` (unique `token_hash`, partial unique `club_member_id WHERE accepted_at IS NULL` = one open invite per member), the column `club_members.account_unlinked_at` (a deliberate unlink, [Account linking](#account-linking); keeps `markDetachedMembersLeft` from closing the row and the re-join logic from reusing it) and the partial unique index `club_exit_requests_pending_uidx (club_member_id) WHERE status = 'pending'` (one open request per member). Migrations `0014_member-foundation` and `0015_member-lifecycle` (adds `last_user_id`, backfills it, folds umlaut legacy categories such as `Fördernd` into the default key `foerdernd`, warns about guardian links across club borders — they are kept) create the tables, **backfills** idempotently (default categories per club + unknown legacy categories as extra categories; one `club_members` row per `member` row with master data from `club_memberships` — status `ausgetreten` if `left_at <= today`, else `aktiv`; `joined_at` falls back to `member.created_at`; `display_name`/`contact_email` from the user), aborts with `club_members backfill count mismatch` if rows ≠ members (count check), moves `guardian_links` to `ward_club_member_id` (old `ward_member_id` dropped) and leaves `club_memberships` untouched as a read-only legacy table. The migrations run in one transaction (a failure leaves nothing half-migrated). They are tested against scratch databases migrated to Wave 6 state (`src/db/migration-member-foundation.test.ts`, `src/db/migration-member-edgecases.test.ts`: duplicate numbers, umlaut categories, empty slug, cross-club guardian link, re-run of the migrator, atomic rollback).

`club_memberships` (deprecated, no longer written) was a 1:1 sidecar on Better Auth's `member` row (not on `organization` — MyHome's `household_profiles` uses the org-level version of this pattern, this is the same idea one level down), the same way you'd extend a library-owned table you can't otherwise touch.

`club_applications` is the pending-approval queue behind `POST /club-members/apply`: `id`, `user_id` (FK `user`, cascade), `club_id` (FK `organization`, cascade), `category` (default `aktiv`), `birth_date` (nullable), `status` (`pending` | `rejected` | `approved`, free text validated in routes, default `pending`), `created_at`, `decided_at` (nullable), `decided_by` (nullable FK `member.id`, `ON DELETE SET NULL`). A partial unique index on `(user_id, club_id) WHERE status = 'pending'` allows only one open application per user and club. Migration `0012_club-applications`.

`club_registrations` holds the Wave 6 "Verein gründen" applications (see [Club registration](#club-registration)): `user_id` (applicant, FK `user`, cascade), the club data (`club_name`, `legal_form`, `register_court`/`register_number` — required for `e_v` —, `street`/`postal_code`/`city`, `website_url`), `claimed_role`, `status` (`draft` | `pending` | `needs_info` | `approved` | `rejected`, free text validated in the routes), `review_note`, `reviewed_by` (FK `user`, `SET NULL`), `reviewed_at`, `club_id` (FK `organization`, `SET NULL`, set on approval), `slug_suggestion`, `created_at`/`updated_at`/`submitted_at`. A partial unique index on `(user_id) WHERE status IN ('draft','pending','needs_info')` allows only one open registration per user. `club_registration_documents` stores the proof files: `registration_id` (FK, cascade), `kind`, `storage_key` (private path `registrations/<registration id>/<uuid>-<sanitized filename>`, never exposed), `filename`, `mime_type`, `size_bytes`. Migration `0013_club-registrations`.

<a id="member-numbers"></a>**Member numbers.** `club_members.member_number` is generated automatically in the format `<ABBR>-<NNNN>`: `ABBR` is the first 4 alphanumeric characters of the club slug, uppercased (`demo-sportverein` → `DEMO`, fallback `CLUB`), `NNNN` is the larger of the club's `club_members` row count (members without account included) and the highest numeric suffix already issued for that prefix, plus one, zero-padded to 4 digits (`DEMO-0001`). Implemented in `src/lib/member-number.ts` (`clubAbbreviation`, `nextMemberNumber`), which locks the club's `organization` row (`SELECT … FOR UPDATE`) inside the creating transaction so concurrent creations get distinct numbers. It is applied whenever a `club_members` row is created (`ensureClubMember`: every join path; `POST /club-members` unless `memberNumber` is sent); the board can overwrite it via `PATCH /club-members/:id` — a manually set number that is already used by another member of the club answers `409`. Deleted members therefore no longer cause a repeat, but a manually assigned number in a different format can still equal a later generated one — the column has no unique constraint in the DB (legacy duplicates), uniqueness is enforced by the API on manual writes only.

`guardian_links` is the scoping boundary for the externe Rolle (Erziehungsberechtigte, see the Concept doc's persona of the same name): a many-to-many table linking a guardian account membership (`guardian_member_id` = `member.id`) to the youth club member(s) (`ward_club_member_id` = `club_members.id`, may have no account) they're responsible for. Any route exposing per-member data to a `guest`-tier caller must check this table before returning anything about a member who isn't the caller's own row.

`audit_log` is written inside the same Postgres transaction as the domain mutation that triggered it (see `src/routes/club-members.ts`) and via a Better Auth `databaseHooks.session.create` hook (see `src/auth/auth.ts`) — session creation and every membership/role/department/info-page mutation leave a row. This only works because auth and domain data share one database.

`notification`/`notification_state` use a lazy-state model: no `notification_state` row for a given `(notification_id, user_id)` pair means "unread, not deleted" for that user — read/unread/delete only ever upsert one row (unique index on that pair) instead of pre-seeding a row per recipient on every broadcast. A `system` notification (e.g. the post-signup welcome, written by the `databaseHooks.user.create` hook in `src/auth/auth.ts`) carries `translation_key`/`params_json` so every client renders it in the viewer's own language; an `admin` notification (created via `/admin/notifications`) is pre-translated into a `translations` JSONB blob instead (`Record<langCode, {title, body}>`, keyed by the shared `SUPPORTED_LANGUAGES` registry used by the website/mobile `t()` contexts — see [[ADR-009]]), since there is no machine translation here.

`notification_template` lets an admin override a `system` notification's built-in translation-key text (see `/admin/notification-templates` below) — one row per known `translation_key` (the registry lives in `src/routes/admin-notification-templates.ts`'s `NOTIFICATION_TEMPLATE_KEYS`), holding a `translations` JSONB blob (`de`/`en` required, any other supported language optional) instead of a key clients resolve themselves. The `databaseHooks.user.create` hook looks this table up when it writes the welcome notification and bakes the override's `translations` into that row if one exists — so editing a template only affects *future* notifications of that kind, same as any other already-created row never retroactively changing. No override yet (the common case) means `translations` stays `null` and clients fall back to their local `translation_key` text, so this is not a breaking change. This table previously held fixed `title_de`/`title_en`/`body_de`/`body_en` columns — a JSONB blob replaced them so a new language is a registry entry, not a schema migration (see `src/db/migrations/0003_add-notification-translations-jsonb.sql` through `0005_drop-notification-legacy-de-en-columns.sql`).

**`calendar_visibility` is a zero-rows-default allow list**, computed by `src/lib/calendar-visibility.ts`'s `isCalendarVisible()`/`getVisibleCalendarIds()`, shared by `calendars.ts` (visibility config) and `events.ts` (event filtering). A calendar with no `calendar_visibility` rows at all is club-wide visible — no explicit "everyone" row needed. Once at least one row exists, a caller needs a matching grant: their own `memberId`, a `roleType` they hold via `club_roles`, or a `departmentId` they're scoped to via a department-bound `club_roles` row (abteilungsleitung/trainer). That department check is the one documented limitation of the model: there is no generic department-membership table in this repo, so a rank-and-file department member with no department-scoped `club_roles` row can never match a department grant, only the member/role rules. A caller holding `calendars:write` bypasses the algorithm entirely (inside `isCalendarVisible`/`getVisibleCalendarIds`, so for calendars, events and the iCal feed alike) — board oversight, they need to see and manage calendars they restricted to others.

**RSVP capacity and waitlisting are enforced under a row lock, not just an application-level count.** `POST /events/:id/rsvp` and `DELETE /events/:id/rsvp` both open with `SELECT ... FOR UPDATE` on the event row before counting confirmed attendees. That lock was added after review: under Postgres's default READ COMMITTED isolation, two concurrent RSVPs at `capacity - 1` both read "count < capacity" before either commits, and both get seated — an overbooked event with no error anywhere. The lock serializes the two requests instead, so the second one re-reads the up-to-date count once the first has committed and released it. The same lock guards waitlist promotion on cancel, for the mirrored reason: without it, two concurrent cancellations can both pick the same waitlisted row as "next in line," leaving a freed slot unfilled even though two members were waiting.

**Terminfindung (`GET /availability/overlap`, `GET /meetings/:id/overlap`) is pure precedence logic in `src/lib/availability-match.ts`, no DB access there.** For a given candidate timestamp, an `availability_exceptions` row for that date overrides the member's recurring `availability_slots` entirely, in both directions (an exception can mark someone unavailable on an otherwise-free weekday, or available on one they're normally not). With neither a matching slot nor an exception, a member is default-closed — "no data" is not treated as "free all the time." Both overlap endpoints deliberately return raw per-candidate, per-member availability for the board to eyeball rather than an auto-ranked "best slot" suggestion — an explicit Wave 2 product decision (see [Key decisions](#key-decisions)), not a missing feature.

**`GET /events.ics` is session-gated only.** It runs the same `sessionGuard` + `clubGuard` chain as everything else and returns events from whatever calendars the visibility algorithm grants the caller, built by the dependency-free RFC 5545 writer in `src/lib/ics.ts`. A static/token-based public link — so a calendar app can subscribe without a login — is a real, still-open question this repo's Wave 2 plan explicitly flags and defers, not an oversight.

**Meeting audit entries are per action, not per row, with one deliberate exception.** Create/update/delete on a meeting, adding/removing an invitee, and a member's own RSVP response each write their own `audit_log` row. Recording attendance (`PATCH /meetings/:id/attendance`) is the exception: it takes a batch of per-member entries but writes exactly one summarizing `meeting_attendance.record` audit row for the whole call, not one per attendee. Attendance and resolutions carry real legal weight (Mitgliederversammlung-Protokolle are judged by this data), but a per-row audit trail for a board recording forty members' presence in one sitting would be noise, not signal.

**Wifi/link visibility is a serverside filter applied in the `WHERE` clause, never a fetch-then-filter-in-JS step.** `location_wifi_networks`/`location_links` carry a `visibility` level `gast` < `mitglied` < `vorstand` (default `mitglied`; migration `0016` mapped the old boolean `visible_to_guests`: `true` → `gast`, `false` → `mitglied`, because until then every member saw everything — nothing became more restricted by the migration; the column is dropped). `src/routes/locations.ts` (`readableVisibilities`) restricts the query: a `guest`-role caller gets only `gast`, a member `gast` + `mitglied`, and only `locations:write` / `locations:read_access` additionally `vorstand`. API compatibility: requests still accept `visibleToGuests` (`true` → `gast`, `false` → `mitglied`; `visibility` wins if both are sent) and responses carry both `visibility` and the derived `visibleToGuests` (= `visibility === "gast"`, deprecated). Filtering after the fact would risk a future refactor accidentally logging or caching the unfiltered row before the filter runs — doing it in the query removes that class of mistake entirely.

**Media security layer (Wave 7 B18) — every upload and download of an image or document goes through `src/lib/media.ts`.** `media_files` (migration `0019_media-security-layer`) is the upload registry and the source of truth: content type (from magic bytes, never the file extension), size, sha256, owner (`owner_type`/`owner_id`), `visibility` (`private` | `club` | `public_opt_in`), `sensitive`, `uploaded_by`, tombstone `deleted_at`. Feature tables hold only the **storage key** (`club_members.photo_key`, `locations.photo_key`, `inventory_damage_reports.photo_key`, `club_registration_documents.storage_key`); the migration renamed the former `photo_url` columns to `photo_key` (values kept). URLs exist only in responses:

- **Upload** (`storeUpload`): allowlist (JPEG/PNG/WebP; PDF only for documents), size cap, **magic-byte check** that must also match the declared content type, **metadata removal by ALLOWLIST** without re-encoding (`src/lib/image-sanitize.ts`, dependency-free, one pre-allocated output buffer): PNG keeps only `IHDR PLTE IDAT IEND tRNS gAMA cHRM sRGB iCCP pHYs sBIT bKGD`; JPEG keeps frame/table/scan segments, a JFIF header **without thumbnail**, APP2 only if it is an ICC profile and the Adobe APP14 flag — and keeps filtering **after every scan** (progressive/multi-scan files cannot smuggle an APP1 between scans); WebP keeps `VP8X VP8 VP8L ALPH ANIM ANMF ICCP` (EXIF/XMP flags cleared). Trailing data is dropped, dimensions are checked for plausibility, and a file with more than 10 000 segments/chunks is refused (parser work is bounded). Corrupt/truncated/implausible images are `422`. The declared content type is normalised first (`image/JPG`, `image/pjpeg`, case, parameters), client filename sanitized and kept only in `original_filename` (the key is `<clubId>/<uuid>.<ext>`), optional virus-scan hook (`setUploadScanner`), **per-club quota** (`MEDIA_QUOTA_BYTES_PER_CLUB`, checked under a per-club advisory lock in the same transaction as the registry insert, `422` with error code `QUOTA_EXCEEDED` and `error.details.code = "club_quota"`), and a **per-user cap on unclaimed uploads** (`MEDIA_UNATTACHED_MAX_FILES_PER_USER` default 25, `MEDIA_UNATTACHED_MAX_BYTES_PER_USER` default 50 MB, same `QUOTA_EXCEEDED` but `error.details.code = "unattached_cap"`). Uploads that no feature row claims within `MEDIA_UNATTACHED_TTL_HOURS` (default 24) are swept (file + registry row) at startup and hourly (`startMediaSweeper`).
- **Signed URLs** (`src/lib/media-url.ts`): `https://<BACKEND_URL>/media/<key>?exp=<ms>&sig=<hmac>`, HMAC-SHA256 over `media-url:<key>:<exp>` with `MEDIA_URL_SECRET` (falls back to `BETTER_AUTH_SECRET`), constant-time comparison, TTL `MEDIA_URL_TTL_SECONDS` (default 1800). A feature route calls `signedMediaUrls(clubId, keys)` **only after its own permission check**; keys that are unknown, deleted, sensitive or of another club yield no URL (`null`). Clients treat the URL as short-lived and re-request the feature resource when it expires (`403`).
- **Serving** `GET /media/<key>`: no cookie needed (website `<img>` and the native app `Image` work), only signature + registry row; `Content-Type` from the registry, `Cache-Control: private, max-age=<remaining TTL>`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin` (set **only for `/media/*`** in `src/index.ts`; every other route keeps `same-origin`), `Content-Disposition` inline for images / attachment for documents; per-IP rate limit. The signature is verified first; the registry is consulted for an explicit `public_opt_in` only when the signature is missing/invalid. Sensitive files are never served here, whatever the signature.
- **Sensitive documents** (club registration proofs; later ID checks, personal files) are `sensitive = true`: never a signed URL, only streamed by an authenticated feature route via `streamSensitiveMedia`, `attachment`, `Cache-Control: private, no-store`, and an `audit_log` entry `media.sensitive_access` (`mediaId`, `ownerType`, `ownerId`, `accessedBy`) written **before** the bytes are read (fail closed).
- **`public_opt_in`**: the only way to serve a file without a signature (non-sensitive club images, `setMediaVisibility`; no route uses it yet — sponsor logos / club page are future opt-ins). `Cache-Control: public, max-age=300`.
- **Delete** (`deleteMedia` / `markMediaDeleted` + `purgeMediaFile`): registry tombstone + file removal; the quota is freed. Replacing a location/member photo deletes the old one.
- **Pre-registry files** (damage photos, location photos, wave-6 proofs written before `0019`) keep working: on first signing/streaming the file is registered from what is on disk (type from magic bytes, size capped at 10 MB **before** reading, images stripped of metadata and the file rewritten), "resign on read", no backfill job. Migration `0020_media-legacy-photo-keys` clears old `locations.photo_key` / `inventory_damage_reports.photo_key` values that are not `<ownClubId>/…` keys (external URLs, `/media/…` paths, foreign or traversal values; idempotent). Free-text values that are not keys of the asking club (old external `photo_url` strings) read as `null` and are never deleted.
- **Gate**: `src/lib/media-gate.test.ts` fails the build if code outside the layer imports `storage.ts`, serves files statically, hard-codes a `/media/` link, mints a URL itself, or if a schema gets a `*_photo_url`/`*_image_url`/… column.

Orientation: the EXIF orientation flag is removed with the rest of EXIF and images are **not** re-encoded or resized server-side (E6: no image dependency); clients send upright, reasonably sized images (the pickers bake the rotation in). Open: server-side thumbnails, removing a leaving member's photo (deletion concept Wave 10).

**`events.location_id`/`meetings.location_id` are real FKs on `locations.id` (`ON DELETE SET NULL`).** Wave 2 shipped them as bare `uuid` columns with no reference (the `locations` table didn't exist yet); Wave 3 wired the actual FK once it landed — no Wave 3 task package explicitly owned this, so it's called out here rather than left silently deferred.

**"ueberfaellig" (overdue) and maintenance-due status are computed at read time, never written by a job.** `src/lib/inventory-status.ts` derives both from a plain date comparison against `now()` — `isLoanOverdue`/`effectiveLoanStatus` for `inventory_loans.dueAt`, `isMaintenanceDue`/`maintenanceDueDate` for `inventory_items.maintenanceIntervalDays` counted from `lastMaintenanceAt` (falling back to `acquiredAt` if the item has never been serviced). The DB column itself only ever holds `"ausgeliehen"`/`"zurueckgegeben"`; a cron job that flips it to `"ueberfaellig"` would drift from `now()` between runs in a way a read-time derivation never can.

### Migrations 0014-0021 (Wave 7)

Committed in `src/db/migrations/`, applied in order by `npm run db:migrate:runtime` (Docker boot) or `npm run db:migrate`.

| Migration | What it does |
|---|---|
| `0014_member-foundation` | Creates `club_members` (ADR-003 identity, nullable link to Better Auth `member`), `member_categories`, `club_member_departments`, `club_member_status_history`, `club_settings`, `club_exit_requests`; adds `guardian_links.ward_club_member_id`. **Backfills** default categories per club, one `club_members` row per existing account membership, and the guardian ward links |
| `0015_member-lifecycle` | `club_members.last_user_id` (+ index `club_members_club_last_user_idx`) — remembers the last linked account so the exit/rejoin rules still resolve after the account row is unlinked |
| `0016_roles-scoping` | Read scoping for roles/meetings: `meetings.type` becomes the closed set `vorstandssitzung`/`mitgliederversammlung`/`sonstige` — **not lossless**, see [Rights and read scoping](#rights-and-read-scoping-wave-7-b7b8) |
| `0017_member-search-index` | Functional index `club_members_club_name_idx` on `(club_id, lower(display_name))` for the member list search |
| `0018_member-invites-exit-requests` | `club_member_invites` (hashed token, unique open invite per member), `club_members.account_unlinked_at`, partial unique index `club_exit_requests_pending_uidx` (one pending exit request per member) |
| `0019_media-security-layer` | `media_files` upload registry; renames `locations.photo_url` / `inventory_damage_reports.photo_url` to `photo_key`; adds `club_members.photo_key` (FK to `media_files.storage_key`) |
| `0020_media-legacy-photo-keys` | Idempotent clean-up: clears pre-registry `photo_key` values that are not of the form `<clubId>/<file>` (external URLs, `/media/...` paths, other clubs' keys, traversal) |
| `0021_key-history-wifi-security` | `location_key_history` (key handover log), `location_key_holders.key_label`, `location_wifi_networks.security` (default `wpa`) |

## API reference

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/auth/*` | GET, POST | varies | Better Auth's own routes: sign-up, sign-in, session, 2FA, organization, admin. See `/api/auth/reference` for the generated OpenAPI docs. |
| `/health` | GET | none | Liveness — never touches the database, can't flap on a Postgres blip |
| `/ready` | GET | none | Readiness — pings Postgres, returns 503 if unreachable |
| `/my-clubs` | GET | session | Clubs the caller already belongs to (`clubId`/`clubName`/`memberId`/`orgRole` per row) — how a client picks a `clubId` for every other club-scoped route below. **Clubs the person has left are not listed** (effective status `ausgetreten`/`ausgeschlossen`/`verstorben`, see [Exit workflow](#exit-workflow)). No "browse public clubs" directory in Wave 1 |
| `/club-members/apply` | POST | session | Aufnahmeantrag — writes ONLY a `pending` row into `club_applications` (no `member`/`club_members` row until a board member approves, see `/club-applications`). Body `{ clubId or clubSlug, category?, birthDate? }` (a client only ever has the slug; `clubId` is accepted too for server-to-server use). `201 { data: { application } }`. 404 for an unknown slug/club. **`409` with distinguishable codes** (nested format `{ error: { code, message, details } }`): `ALREADY_MEMBER` (`details: { clubId, clubMemberId }`) if the caller is a member, `APPLICATION_PENDING` (`details: { clubId, applicationId, submittedAt }` — the caller's own application; also for a parallel duplicate via the partial unique index) if one is open; a blocked re-join keeps `code: "CONFLICT"` with `details.code = "member_rejoin_blocked"`. Re-applying after a `rejected` application is allowed. **A former member** (effective status `ausgetreten`, account membership row still present) **may re-apply**; an `ausgeschlossen`/`verstorben` person gets `409` with `details.code = "member_rejoin_blocked"` until the board reopens them. Audit `club_member.apply` (`subjectId` = application id) |
| `/club-members` | GET | session + `clubGuard` | Member list **with and without account**, searchable and paged (B9). Query (all optional): `q` (name; member number and e-mail — contact + account — only count for callers with `members:read_sensitive`, otherwise ignored, so the search is no oracle), `status` (comma list of the 7 statuses, matched against the **effective** status), `category` (comma list of category keys), `departmentId` (current assignment), `hasAccount=true\|false`, `ageMin`/`ageMax` (whole years from `birth_date`; **403 without `members:read_sensitive`**), `sort=name\|joinedAt\|memberNumber` (default `name`; `memberNumber` needs `members:read_sensitive`, else 403) with `order=asc\|desc`, `page` (default 1), `pageSize` (default **50**, max 100). Invalid values → `422`. Sorting is stable (secondary key `id`); `sort=memberNumber` is **natural** (text prefix, then the numeric suffix without leading zeros: `X-2` < `X-0003` < `X-10`; members without number last). **Scoping:** external `guest` accounts get `403` (no member list for guardians; Wave 10 brings their own routes); callers with neither `members:write` nor `members:read_sensitive` only get members with an effective status `probe`/`aktiv`/`ruhend` plus their own row — former members and interessenten are hidden server-side and `status` filters only narrow that set (`total` matches). Response `{ data: [member shape], page, pageSize, total }` — **changed frame:** earlier versions returned every member in `data`; without query parameters you now get the first 50 by name, so clients must read `total` and page. E-mail, contact e-mail, member number, birth date, address, phone, emergency contact and `suggestedCategory` are included only for the caller's own row or with `members:read_sensitive`. Departments/roles/categories are batch-loaded for the page (no N+1) |
| `/club-members/invites/preview` | POST (GET deprecated) | session (no club membership needed) | **Preferred: `POST` with body `{ token }`** (the token stays out of URLs and access logs). The `GET ?token=` variant answers identically but is **deprecated** (adds a `Deprecation: true` header; it will be removed once the clients have moved) → `200 { data: { clubId, clubName, memberName (masked: "Max M."), invitedEmail (masked: "m***@example.com"), emailMatches, expiresAt } }`. `404` for unknown, expired or used tokens (indistinguishable), `422` for a malformed token. Rate limit 20/min per user (shared by preview and accept). See [Account linking](#account-linking) |
| `/club-members/invites/accept` | POST | session (no club membership needed) | Body `{ token }` → `200 { data: { clubId, clubName, clubMemberId, memberId, merged } }`: links the invited member to the signed-in account; if the account already is a member of the club with an untouched own record, that record is **merged** into the invited one (`merged: true`, `clubMemberId` = the kept invited row). `404` invalid/expired/used token, `403` if the (verified) account e-mail differs from the invited address (case-insensitive; checked before anything about merging is revealed), `409 details.code = "merge_conflict"` (+ `details.conflicts`: kinds only) if the account's own record holds data that cannot be merged automatically, `409` for a blocked re-join or a second invitation of an account that is already linked. Single use, race safe; the inviting board member gets a notification mail. See [Account linking](#account-linking) |
| `/club-members/import-template` | GET | session + `clubGuard` (`members:write`) | CSV template (`text/csv`, UTF-8 BOM, `;`) with the header row and one example line; ready for the importer (B10) |
| `/club-members/import` | POST | session + `clubGuard` (`members:write`, checked **before** the body is validated; 10 requests/min per user, `MEMBER_CSV_RATE_LIMIT_PER_MINUTE`) | CSV import with dry run (B10, see [Member CSV import/export](#member-csv)). Body `{ csv, dryRun? (default **true**), confirmToken?, mapping?, defaultCategoryKey? }`. Dry run `200` → `{ data: { dryRun: true, committable, delimiter, columns: [{ header, field }], summary: { rows, ok, duplicates, errors }, rows: [{ line, status: 'ok'\|'duplicate'\|'error', issues: [{ field, code, message }], duplicates: [{ reason: 'name_birthdate'\|'email', clubMemberId, line }] }], confirmToken, confirmTokenExpiresAt } }`; writes nothing. Commit (`dryRun: false` + `confirmToken` of a dry run of exactly this file) `201` → `{ data: { dryRun: false, created, skippedDuplicates, summary, rows } }`. File-level problems and a missing/foreign token are `422` with `details.code` (`csv_too_large`, `csv_too_many_rows`, `csv_empty`, `csv_malformed`, `csv_missing_name_column`, `import_not_confirmed`, `import_has_errors`, `import_nothing_to_do`); a token that was already used is `409 import_already_applied`. The commit response also carries `skippedSinceDryRun` (duplicates that appeared since the dry run) |
| `/club-members/export` (alias `/club-members/export.csv`) | GET | session + `clubGuard` (`members:write` or `members:read_sensitive`; sensitive columns need `members:read_sensitive`; 10/min per user) | CSV download for Excel DE (`text/csv; charset=utf-8`, BOM, `;`, CRLF, `Content-Disposition: attachment`, `Cache-Control: private, no-store`). Query: `columns=` comma list in the wanted order (default: all columns for `members:read_sensitive`, otherwise the non-sensitive ones), `status=`, `category=` (keys), `departmentId=`, `includeFormer=true` (without `status`, former members are left out). Unknown column `422` (`details.allowed`), a sensitive column without `members:read_sensitive` `403`. Cells starting with `=`, `+`, `-`, `@`, TAB or CR are prefixed with `'` (CSV/formula injection). Writes an `audit_log` entry `club_member.export` (actor, columns, filters, row count; no personal data) |
| `/club-members/categories` | GET | session + `clubGuard` | Non-archived member categories for **every** member (also needed by the apply/profile screens): `[{ id, key, name, votingRight, minAge, maxAge, autoTransitionToKey, sortOrder, archived, archivedAt, memberCount }]`, ordered by `sortOrder`, `name`. `memberCount` = members that still belong to the club (not left). `?includeArchived=true` needs `members:write` (403). Default categories are created on first access |
| `/club-members/categories` | POST | session + `clubGuard` (`members:write`) | Body `{ name (required), key?, votingRight? (default true), minAge?, maxAge?, autoTransitionToKey?, sortOrder? }`. `key` (a-z, 0-9, `_`, `-`; derived from the name if omitted, e.g. "Ehren Jugend" → `ehren-jugend`) is the stable identifier. `201` with the category; `409` for an existing key (archived categories keep theirs), `422` for `minAge > maxAge`, an `autoTransitionToKey` without `maxAge`, pointing to itself, to an unknown/archived category or closing a **cycle**. `sortOrder` defaults to last. Audit `member_category.create` |
| `/club-members/categories/:id` | PATCH | session + `clubGuard` (`members:write`) | Change `name`, `votingRight`, `minAge`, `maxAge`, `autoTransitionToKey` (null clears), `sortOrder`. **`key` is immutable** (`422` if sent). Same validation as POST on the resulting state. `404` for unknown/foreign ids. Audit `member_category.update` |
| `/club-members/categories/:id` | DELETE | session + `clubGuard` (`members:write`) | **Archives** the category (history and references stay valid). If members that still belong to the club use it, `?moveTo=<categoryId>` is mandatory (`409` with `details.memberCount` otherwise; `moveTo` must be another non-archived category of the club, else `422`): they are moved in the same transaction with a history entry "Kategorie archiviert". Members who already left keep the archived category. Other categories whose `autoTransitionToKey` pointed here are cleared. The default category `aktiv` cannot be archived (`409`); an archived one answers `409`. `200 { data: category + movedMembers + clearedAutoTransitions }`. Audit `member_category.archive` |
| `/club-members/transition-suggestions` | GET | session + `clubGuard` (`members:write` **and** `members:read_sensitive`, else `403` — the list is derived from birth dates; `/apply` only needs `members:write`) | Age transition proposals, derived at read time (no job; scheduler in Wave 9): members of categories with `autoTransitionToKey` + `maxAge` who are older than `maxAge`. `[{ id, name, category: {id,key,name}, suggestedCategory: {id,key,name} }]` — no birth dates |
| `/club-members/transition-suggestions/apply` | POST | session + `clubGuard` (`members:write`) | Body `{ memberIds: uuid[1..500] }`. One transaction: the suggestions are **recomputed on the locked rows**, qualifying members get the target category (history reason "Altersübergang", audit `club_member.age_transition`). `200 { data: { applied: [{id, fromCategoryId, toCategoryId}], skipped: [{id, reason: "no_suggestion"}] } }` (stale, foreign or unknown ids are skipped, never moved) |
| `/club-members/:id/transition` | POST | session + `clubGuard` (`members:write`) | Status and/or category change with history, see [Member lifecycle](#member-lifecycle). Body `{ toStatus?, categoryId? \| categoryKey?, effectiveOn? (YYYY-MM-DD), reason?, reopen? }` (at least `toStatus` or a category). `200 { data: <member shape>, transition: { kind: "status\|category\|scheduled_exit\|cancel_exit", fromStatus, toStatus, fromCategoryId, toCategoryId, effectiveOn } }`. `409` for a status outside the matrix (`details.allowed`), no-op or same category, `422` for invalid dates / missing `reopen`+`reason`, `404` for foreign ids, `403` without `members:write`. Audit `club_member.transition` (ids and dates, the free-text reason stays in the history) |
| `/club-members/:id/history` | GET | session + `clubGuard` (`members:read_sensitive`) | `club_member_status_history` of one member, newest first: `[{ id, fromStatus, toStatus, fromCategoryId, toCategoryId, effectiveOn, reason, changedBy, createdAt }]` (exit reasons are personal data → sensitive) |
| `/club-stats` | GET | session + `clubGuard` (`club_stats:read`: `vorsitz`, `stellv_vorsitz`, `schriftfuehrer`, `kassenwart`, `beisitzer`) | Club KPIs (B11), aggregates only — see [Club KPIs](#club-kpis). `403` for everybody else (including `owner` without a club role, trainers, plain members) |
| `/club-members` | POST | session + `clubGuard` (`members:write`) | Board creates a member **without account**. Body `{ displayName (required), categoryId \| categoryKey (one required), status? (interessent\|probe\|aktiv\|ruhend, default aktiv), joinedAt?, memberNumber?, firstName?, lastName?, birthDate?, street?, postalCode?, city?, phone?, contactEmail?, emergencyContactName?, emergencyContactPhone? }`. Member number is generated if absent; a manually set number already used in the club answers `409`; manual numbers are 1–50 characters without control characters (`422` otherwise). The response contains sensitive fields only for callers with `members:read_sensitive` (a Schriftführer:in with `members:write` gets the non-sensitive shape back). `201 { data: member }` (full shape). `422` for an unknown/archived/foreign category or invalid status. Writes the first `club_member_status_history` row and audit `club_member.create` |
| `/club-members/me` | GET | session + `clubGuard` | Caller's own member (full shape incl. all own contact data) plus `clubMemberId` (= `id`) and `permissions` (the caller's `ClubPermission[]`, now including `club_stats:read` for the board roles like every other permission, for client-side UI gating; `[]` for a plain `mitglied`, incl. the read permissions `meetings:read_board`/`locations:read_access` where granted) |
| `/club-members/me` | PATCH | session + `clubGuard` | Self-service update of `birthDate`, `emergencyContactName/Phone`, `street`, `postalCode`, `city`, `phone`, `contactEmail` (each nullable; `""` clears). Other fields (member number, category, status) are ignored. Returns the full member shape |
| `/club-members/me/photo` | PUT, DELETE, GET | session + `clubGuard` | Own profile photo (B13). PUT multipart `file` (JPEG/PNG/WebP, **5 MB**, magic bytes, EXIF/GPS stripped, quota), replaces and deletes the previous photo, returns the member shape with the new `photoUrl`; **`403` for a minor** (known birth date < 18: the board sets it). DELETE `204` (idempotent). GET streams the own photo authenticated (`private, no-store`), `404` without one. Audit `club_member.photo_set` / `club_member.photo_remove` (no file names) |
| `/club-members/:id/photo` | PUT, DELETE, GET | session + `clubGuard` (write: `members:write`) | Same for another member, also members **without an account** (and minors). Plain members get `403` on PUT/DELETE; other club's id `404`. GET streams the photo with the same rules as the member shape's `photoUrl` (own / `members:write` / `members:read_sensitive` / linked guardian, else `404`) |
| `/club-members/:id` | GET | session + `clubGuard` | One member; `:id` is the canonical `club_members.id` (uuid). **Scoping:** `404` (never 403) for another member's row when the caller is an external `guest`, and for members with another effective status than `probe`/`aktiv`/`ruhend` when the caller has neither `members:write` nor `members:read_sensitive` (own row always reachable); same rule for `/:id/departments`, `/:id/roles`, `/:id/guardians`. **Transition:** an id that is not a uuid is resolved as the Better Auth `member.id` (ADR-003) — both are strictly club-scoped, another club's id is `404`. Sensitive fields gated as in the list |
| `/club-members/:id` | PATCH | session + `clubGuard` (`members:write`) | Board-only master data: `displayName`, `firstName`, `lastName`, `memberNumber` (string, or `null` to clear — only when the key is in the body; duplicate in the club → `409`), `categoryId` or `categoryKey`/`category` (key; unknown → `422`), `birthDate`, `street`, `postalCode`, `city`, `phone`, `contactEmail`, `emergencyContactName/Phone`. **`status` and `leftAt` are rejected (`422`)** — status changes and exit dates go through `POST /club-members/:id/transition` (or the [exit requests](#exit-workflow)); clients that used `PATCH leftAt` must switch. A category change here also writes a history entry. Same response rule as POST (sensitive fields only with `members:read_sensitive` or on the caller's own row, so an empty PATCH cannot be used to read data). A `memberNumber` equal to the current one is accepted even if legacy data holds duplicates; only a changed number is checked for `409`. Audit `club_member.update` lists only the changed field names |
| `/club-members/:id/invite` | POST | session + `clubGuard` (`members:write`) | Body `{ email }` (lower-cased). Only for members **without account** (`409` otherwise, `409` for members who left). Creates the invitation (replaces an open one), TTL `MEMBER_INVITE_TTL_DAYS` (default 14), mails the link `${WEB_ORIGIN}/einladung?token=…` (German template, HTML-escaped). `201 { data: { id, clubMemberId, email, status: "pending", expiresAt, acceptedAt: null, createdAt, emailSent } }` — **the token is never returned**; a mail failure leaves `emailSent: false` (logged without the address) and blocks nothing. Rate limit **20/hour per user** (`429`). Audit `club_member.invite` (no address) |
| `/club-members/:id/invite` | GET, DELETE | session + `clubGuard` (`members:write`) | `GET` → `{ data: invite \| null }` (the open invite of the member; `status` `pending` \| `expired`) for the "Einladungsstatus" display; `DELETE` revokes it (`204`, `404` if none) |
| `/club-members/:id/invite/resend` | POST | session + `clubGuard` (`members:write`) | No body. Revokes the open invitation (also an expired one) and issues a new token + mail to the **same address** → `201` same shape as `POST /:id/invite` (`emailSent`; the token is never returned). `404` if there is no open invitation (or the member already has an account). Shares the **20/hour/user** limit with invitation creation (`429`). Audit `club_member.invite_resend` |
| `/club-members/:id/unlink` | POST | session + `clubGuard` (`members:write`) | Body `{ force? }`. Detaches the account: the `club_members` row stays (status unchanged — **not an exit**, `last_user_id` kept, `account_unlinked_at` set), the account's `member` row and everything bound to it (roles, loans, key holder entries, RSVPs) goes. `200 { data: <member shape> }` (`hasAccount: false`). `409` for a member without account, the caller's own account, an `owner` account, or an account with open loans/keys (`details.code = "account_has_open_items", openLoans, keys`) unless `force: true`. Audit `club_member.unlink` |
| `/club-members/:id/departments` | GET, POST, DELETE `/:departmentId` | session + `clubGuard` (POST/DELETE need `members:write`) | Department assignment with validity period. GET `[{ id, name, since, until }]`; POST `{ departmentId, since? }` → `201` (department must belong to the club, else `404`; already assigned → `409`); DELETE ends the open assignment (`until` = today or `?until=YYYY-MM-DD`) and keeps the history → `204`, `404` if none open |
| `/club-members/:id/roles` | GET, POST, DELETE `/:roleId` | session + `clubGuard` (write needs `roles:write`) | `club_roles` assignment on the **linked account** — `roleType` one of `CLUB_ROLE_TYPES` (`src/lib/club-permissions.ts`), optional `departmentId`/`termEndsAt`; assigning a role the member already holds returns `409`. **`mitglied` is implicit and cannot be assigned (`422`, not part of the enum) or revoked (`409`);** `GET` answers `{ data: [stored club_roles rows], implicit: ["mitglied"] }` — `data` is unchanged (only revocable rows), the implicit base role is listed separately. **A member without account answers `409 "Member has no account"`** on all three methods |
| `/club-members/:id/guardians` | GET, POST, DELETE `/:guardianMemberId` | session + `clubGuard` (write needs `members:write`) | `guardian_links` for the externe Rolle — board-managed only. `:id` is the **ward** (any club member, account optional); `guardianMemberId` (body / path) is a `club_members.id` or, for older clients, the guardian's `member.id`, and the guardian must have an account (`409` otherwise, `404` if not in this club, `422` if equal to the ward, `409` for a duplicate). **Reading** (`GET`) needs `members:read_sensitive` or being a guardian of this ward (`403` otherwise) because guardian names are personal data. Link shape: `{ id, guardianMemberId (member.id), guardianClubMemberId, guardianName, wardClubMemberId, wardMemberId (account id or null), createdAt }` |
| `/club-settings` | GET | session + `clubGuard` | `200 { data: { noticePeriodDays, noticeMode, memberNumberPrefix, allowSelfLoans } }` for **every** member (defaults `null`/`null`/`null`/`true` without a row; `memberNumberPrefix` is `null` when not set, i.e. the slug abbreviation is used) |
| `/club-settings` | PATCH | session + `clubGuard` (`members:write`) | Body (all optional): `noticePeriodDays` (int 0–365 \| null), `noticeMode` (`immediate` \| `month_end` \| `quarter_end` \| `year_end` \| null), `memberNumberPrefix` (1–10 letters/digits, stored upper case, null = slug abbreviation; used for NEW member numbers), `allowSelfLoans` (bool). Creates the row on demand; `200 { data: { noticePeriodDays, noticeMode, memberNumberPrefix, allowSelfLoans } }`. Audit `club_settings.update` |
| `/club-exit-requests/preview` | GET | session + `clubGuard` | `?requestedOn=YYYY-MM-DD` (default today Europe/Berlin; past → `422`) → `200 { data: { requestedOn, noticePeriodDays, noticeMode, earliestEffectiveOn } }` |
| `/club-exit-requests/mine` | GET | session + `clubGuard` | Own requests (about the caller's member row), newest first: `{ data: [request] }` |
| `/club-exit-requests` | GET | session + `clubGuard` (`members:write`) | Board queue. Query `status` (`pending`\|`approved`\|`rejected`\|`withdrawn`), `kind` (`cancellation`\|`exclusion`), `page`, `pageSize` (default 50, max 100). `{ data: [request], page, pageSize, total }`, newest first |
| `/club-exit-requests/:id` | GET | session + `clubGuard` | `{ data: request & { checklist } }` for the board, the requester and the member concerned (`404` for everybody else and for foreign clubs). `checklist` = `{ openLoans: [{ id, itemId, itemName, borrowedAt, dueAt, overdue }], keys: [{ id, locationId, locationName }], isEmpty }`, computed live from the **account's** open `inventory_loans` and `location_key_holders` (members without account: always empty) |
| `/club-exit-requests` | POST | session + `clubGuard` | **Member:** body `{ desiredEffectiveOn?, reason? }` (no `clubMemberId`, or the own one) → `201 { data: request & { adjustedToEarliest } }`, status `pending`. **Board** (`members:write`, `403` otherwise): `{ clubMemberId, kind: "cancellation" \| "exclusion", reason (required for exclusion), effectiveOn? }` → `201 { data: request, transition }`, recorded as `approved` at once. Rules: [Exit workflow](#exit-workflow). `409` (`details.code` `exit_request_pending` / `exit_already_scheduled`) for a second open request or a scheduled exit, `409` for a member who already left, `422` for dates before the earliest allowed date |
| `/club-exit-requests/:id/approve` | POST | session + `clubGuard` (`members:write`) | Body `{ effectiveOn?, note? }`. Claims the request (`UPDATE … WHERE status = 'pending'`) and applies the exit via `transitionMember` in one transaction → `200 { data: request, transition }`. `effectiveOn` ≥ earliest date, else `422 details.earliestEffectiveOn`. `409` if already decided |
| `/club-exit-requests/:id/reject` | POST | session + `clubGuard` (`members:write`) | Body `{ note }` (required, `422` if empty) → `200 { data: request }`; `409` if already decided |
| `/club-exit-requests/:id/withdraw` | POST | session + `clubGuard` | Requester or `members:write`; body `{ note? }`. `pending` → `withdrawn`; `approved` cancellation not yet effective → `withdrawn` **and** the scheduled exit is taken back (`left_at` cleared, history "Kündigung widerrufen"). `409` once effective or for an exclusion; `403` for the member concerned who is not the requester, `404` for strangers |
| `/club-applications` | GET | session + `clubGuard` (`members:write`) | Pending Aufnahmeantraege of the club, oldest first: `{ data: [ { id, userId, name, email, category, birthDate, status, createdAt } ] }`. `birthDate` is sensitive, but `members:write` is the deciding role. 403 without the permission |
| `/club-applications/:id/approve` | POST | session + `clubGuard` (`members:write`) | Approve a pending application: `auth.api.addMember({ role: 'member' })` (its `afterAddMember` hook creates the `club_members` row), then in one DB transaction the row gets the application's category/birthDate, `joinedAt` = today, status `aktiv` and an automatic member number, application set to `approved` with `decided_at`/`decided_by` (caller's `member.id`). `200 { data: { application, member, membership, clubMember } }` (`membership` is the pre-Wave-7 shape, deprecated; `clubMember` is the canonical `club_members` row). 404 for an unknown id or another club's application, 409 if not `pending` or if the applicant is already a member. **Exception — re-admission:** if the applicant is a former member (`ausgetreten`, account membership still present) no new `member` is created; the existing `club_members` row is reopened via `transitionMember` (`reopen`, reason "Wiederaufnahme per Aufnahmeantrag", application category/birth date applied, original `joinedAt` and number kept) and the same response shape is returned. If the transaction fails after Better Auth created the `member`, the `club_members` and `member` rows are removed again (best effort) and the application stays `pending`. Audit `club_application.approve` |
| `/club-applications/:id/reject` | POST | session + `clubGuard` (`members:write`) | Reject a pending application: status `rejected`, `decided_at`/`decided_by`, no member row. `200 { data: { application } }`. 404/409 as for approve. Audit `club_application.reject` |
| `/departments` | GET, POST, PATCH `/:id`, DELETE `/:id` | session + `clubGuard` (write needs `departments:write`) | Club sub-units (Fußball, Tennis, ...) |
| `/club-info` | GET | session + `clubGuard` | Aggregate Vereinsinfo: current board (members holding a board `role_type`; each entry has `photoUrl` = signed URL of the board member's profile photo, but **only** for callers with `members:write` / `members:read_sensitive` and for the person themselves — `null` for everyone else, adult or minor, until the Wave 10 consent management), departments, info pages — one request instead of three |
| `/club-info/:slug` | GET | session + `clubGuard` | One info page (Satzung/Leitbild/...) |
| `/club-info/:slug` | PUT | session + `clubGuard` (`club_info:write`) | Create-or-update by slug. Body `{ title, contentMarkdown?, externalUrl? }` |
| `/club-info/:slug` | DELETE | session + `clubGuard` (`club_info:write`) | |
| `/calendars` | GET | session + `clubGuard` | Every club calendar for a `calendars:write` caller, else only what `src/lib/calendar-visibility.ts` grants |
| `/calendars` | POST | session + `clubGuard` (`calendars:write`) | Body `{ name, departmentId?, isDefault?, icalImportUrl? }`. Setting `isDefault` unsets it on every other club calendar in the same transaction |
| `/calendars/:id` | GET | session + `clubGuard` | 404 unless visible to the caller (write permission or a matching grant) |
| `/calendars/:id` | PATCH, DELETE | session + `clubGuard` (`calendars:write`) | |
| `/calendars/:id/visibility` | GET | session + `clubGuard` (`calendars:write`) | Raw `calendar_visibility` rows for the calendar (board-facing config, not a public list) |
| `/calendars/:id/visibility` | POST | session + `clubGuard` (`calendars:write`) | Body: exactly one of `{ memberId }` \| `{ roleType }` \| `{ departmentId }` |
| `/calendars/:id/visibility/:visibilityId` | DELETE | session + `clubGuard` (`calendars:write`) | |
| `/events` | GET | session + `clubGuard` | Query `from?`/`to?` (ISO dates). Only events on calendars visible to the caller |
| `/events` | POST, `/events/:id` PATCH, DELETE | session + `clubGuard` (`calendars:write`) | Body includes `calendarId`/`title`/`startsAt`/`endsAt?`/`category?`/`capacity?`; moving `calendarId` re-checks it belongs to the caller's club |
| `/events/:id` | GET | session + `clubGuard` | 404 unless the event's calendar is visible to the caller |
| `/events/:id/rsvp` | POST | session + `clubGuard` | Self-service RSVP. Row-locks the event (`SELECT ... FOR UPDATE`) before counting confirmed attendees; returns `"angemeldet"` or `"warteliste"` once over capacity |
| `/events/:id/rsvp` | DELETE | session + `clubGuard` | Cancels the caller's own RSVP; same row lock, promotes the earliest-waitlisted member (FIFO) if the caller was confirmed |
| `/events.ics` | GET | session + `clubGuard` | iCal feed (`text/calendar`) of events on calendars visible to the caller. Session-gated only — no public/token link yet, see [Key decisions](#key-decisions) |
| `/availability/slots` | GET, POST | session + `clubGuard` | Caller's own recurring weekly `availability_slots`. Body `{ weekday, startTime, endTime, note? }` |
| `/availability/slots/:id` | PATCH, DELETE | session + `clubGuard` | Own row only |
| `/availability/exceptions` | GET, POST | session + `clubGuard` | Caller's own one-off `availability_exceptions`. Body `{ date, isAvailable, note? }` |
| `/availability/exceptions/:id` | PATCH, DELETE | session + `clubGuard` | Own row only |
| `/availability/overlap` | GET | session + `clubGuard` | Query `members`/`candidates` (comma-separated ids/ISO timestamps). Raw per-candidate, per-member availability — no auto-ranked suggestion, see [Key decisions](#key-decisions) |
| `/meetings` | GET, POST | session + `clubGuard` (write needs `meetings:write`) | Body `{ type: 'vorstandssitzung' \| 'mitgliederversammlung' \| 'sonstige', title, scheduledAt?, agenda? }` (other `type` values → 422). Omitting `scheduledAt` creates it in `"terminfindung"` status. **GET is read-scoped:** `vorstandssitzung` rows only for invitees and callers with `meetings:write`/`meetings:read_board`; **external `guest` accounts read no meetings at all (`404`)** (see [Rights and read scoping](#rights-and-read-scoping-wave-7-b7b8)) |
| `/meetings/:id` | GET | session + `clubGuard` | `404` (never 403) for a `vorstandssitzung` the caller may not read — same for every `/meetings/:id/*` read below |
| `/meetings/:id` | PATCH, DELETE | session + `clubGuard` (`meetings:write`) | PATCH also accepts `type`, `title`, `scheduledAt` (nullable), `agenda`, `status`, `minutes` |
| `/meetings/:id/invitees` | GET | session + `clubGuard` | |
| `/meetings/:id/invitees` | POST, DELETE `/:memberId` | session + `clubGuard` (`meetings:write`) | Same table serves the Terminfindung candidate list and post-scheduling zu-/absage tracking |
| `/meetings/:id/invitees/me` | PATCH | session + `clubGuard` | Self-service RSVP for the caller's own invitee row. Body `{ response: "zugesagt" \| "abgesagt" }` |
| `/meetings/:id/overlap` | GET | session + `clubGuard` | Query `candidates` only — auto-loads the meeting's own invitees instead of a caller-supplied `members` list |
| `/meetings/:id/attendance` | GET | session + `clubGuard` | |
| `/meetings/:id/attendance` | PATCH | session + `clubGuard` (`meetings:write`) | Body: array of `{ memberId, present?, hasVotingRight?, proxyForMemberId? (nullable) }`. **Partial update:** only the listed members and only the fields sent are written — omitted members/fields keep their stored value (re-saving never resets to "not present"); `proxyForMemberId: null` clears a Vollmacht. `proxyForMemberId` must be a member of the same club and differ from `memberId` (`422` self-reference, `404` foreign club); the whole batch is validated before anything is written. `GET` returns the stored rows (pre-fill). One audit entry for the whole batch, not per row |
| `/meetings/:id/resolutions` | GET, POST | session + `clubGuard` (write needs `meetings:write`) | Body `{ description, votesFor, votesAgainst, votesAbstain, result }` (Beschluss); vote counts are integers `0..100000` (`422` beyond) |
| `/meetings/:id/resolutions/:rid` | PATCH | session + `clubGuard` (`meetings:write`) | **Correction instead of silent overwrite:** body = any of the resolution fields **plus a mandatory `correctionNote`** (Berichtigungsvermerk, `422` without it or without a changed field; vote counts `0..100000`). Sets `correction_note`, `corrected_at`, `corrected_by`; audit `meeting_resolution.correct` stores the previous values. Resolutions cannot be deleted |
| `/internal/stats` | GET | `INTERNAL_STATS_TOKEN` bearer token | Aggregate counts only (total users, new users last 7 days, active sessions, `audit_log` event-type breakdown) — never raw rows. Not gated by a Better Auth session; see [Security](#security) for why. Returns 503 if `INTERNAL_STATS_TOKEN` is unset (fails closed) |
| `/admin/activity-stats` | GET | session + `adminGuard` | Query: `interval` (`day`\|`week`), `period` (`7d`\|`30d`\|`90d`). Per-bucket New/Active/Retained/Reactivated user counts plus period-over-period `changePercent`, for `_template_better-auth-admin`'s dashboard. "Active" = had a session created in the window (a login proxy, not request-level activity — this backend has none). Classification logic is a pure function in `src/lib/activity-stats.ts`, unit-tested separately from the DB query in `src/routes/admin-stats.ts` |
| `/admin/club-stats` | GET | session + `adminGuard` | `200 { clubs: { total }, registrations: { pending } }` — number of all clubs (rows in `organization`) and of club registrations with status `pending` (one COUNT query, so the admin navbar badge needn't load the review queue). Dashboard KPI of the admin panel (`src/routes/admin-clubs.ts`, tested in `admin-clubs.test.ts`) |
| `/admin/user-clubs` | GET | session + `adminGuard` | Query `userIds=<id1,id2,…>` (comma-separated, trimmed, de-duplicated, empty entries dropped; none left or more than 100 → 422). `200 { data: { "<userId>": [{ clubId, name, slug }] } }` via `member`→`organization`; every requested id is a key (empty array without membership), clubs per user sorted by name |
| `/admin/send-verification-email` | POST | session + `adminGuard` | Body: `{ userId, callbackURL? }`. Re-enters Better Auth server-side (no session) to send a verification e-mail for a **different** user — the client-side `sendVerificationEmail` endpoint requires the signed-in session's email to match the target (`EMAIL_MISMATCH`), so an admin can never use it for anyone else; the server-side anonymous path has no such check. 404 if the user doesn't exist, 409 if already verified. Backs the admin dashboard's "Resend verification email" button (`src/routes/admin-emails.ts`, integration-tested in `src/routes/admin-emails.test.ts`) |
| `/notifications` | GET | session | Own visible notifications (broadcast + targeted, minus own soft-deletes). Query: `filter` (`unread`\|`read`, omit for all) |
| `/notifications/unread-count` | GET | session | `{ count }` for the bell badge |
| `/notifications/:id/read` \| `/unread` | POST | session | Upserts the caller's `notification_state` row. 404 if the notification isn't visible to the caller |
| `/notifications/:id` | DELETE | session | Soft-delete (own `notification_state` row only). 403 if `deletable` is false, 404 if not visible to the caller |
| `/admin/notifications` | GET | session + `adminGuard` | All admin-authored notifications (not system ones), newest first. Each row includes `targetUserEmail` (joined for display, `null` for a broadcast) |
| `/admin/notifications` | POST | session + `adminGuard` | Body: `{ targetUserId?, translations, deletable }` where `translations` is `Record<langCode, {title, body}>` with `de`/`en` required. Omit `targetUserId` for a broadcast |
| `/admin/notifications/:id` | DELETE | session + `adminGuard` | Hard delete — cascades `notification_state` rows via FK |
| `/admin/notification-templates` | GET | session + `adminGuard` | One row per known `translation_key` (`NOTIFICATION_TEMPLATE_KEYS`), `translations` `null` when there's no override yet |
| `/admin/notification-templates/:key` | PATCH | session + `adminGuard` | Body: `{ translations }` (`Record<langCode, {title, body}>`, `de`/`en` required, other supported languages optional). Upserts the override. 404 if `key` isn't in `NOTIFICATION_TEMPLATE_KEYS` |
| `/admin/notification-templates/:key` | DELETE | session + `adminGuard` | Reverts to no-override (deletes the row, idempotent). 404 if `key` isn't in `NOTIFICATION_TEMPLATE_KEYS` |
| `/locations` | GET, POST | session + `clubGuard` (write needs `locations:write`) | Any member reads; body `{ name, address?, latitude?, longitude?, openingHours?, photoKey?, contactPerson?, accessNote? }`. `photoKey` is a key from `POST /media` (claimed exactly once; foreign/invented keys `422`); responses carry `photoUrl` (short-lived signed URL or `null`), never the key; the removed free-text `photoUrl` input is a `422`. **`accessNote` (Zutrittsinfo) is `null` and `accessRestricted: true` without `locations:write`/`locations:read_access`** (list and detail) |
| `/locations/:id` | GET, PATCH, DELETE | session + `clubGuard` (write needs `locations:write`) | PATCH `photoKey` replaces (old file deleted) or `null` removes the photo; DELETE removes the photo file too. Detail includes `keyHolders` (entries `{ id, locationId, memberId, keyLabel, memberName }`; `memberName` = linked club member's display name, also for departed members, else the newest key-history snapshot name, else `null`; key holders = access info: `[]` + `accessRestricted: true` without `locations:write`/`locations:read_access`) |
| `/locations/:id/key-holders` | POST, DELETE `/:memberId` | session + `clubGuard` (`locations:write`) | POST body `{ memberId, keyLabel? (≤120, "Schlüssel Nr. 3"), note? (≤500) }`; 409 on a duplicate `(locationId, memberId)`. DELETE takes an optional JSON body `{ note? }` (return note, body capped at 4 KiB; no body is fine, malformed or oversized → 422). Both write a `location_key_history` entry in the same transaction as the change (B14); the `audit_log` entry carries ids only, never names or notes |
| `/locations/:id/key-history` | GET | session + `clubGuard` (`locations:write` or `locations:read_access`; external guests and plain members `403`) | Key handover log, newest first: `?memberId=` `&page=1&pageSize=50` (max 200) → `{ data: [{ id, action: 'issued'\|'returned', memberId (null once the account is gone), memberName (snapshot), keyLabel, note, recordedBy, recordedByName, createdAt }], page, pageSize, total }`. Same access rule as the key-holder list (it is access info); the return checklist of the exit workflow still reads the live holder list. The snapshots (`member_name`, `recorded_by_name`) are personal data and belong to the Wave 10 deletion concept. Removing an account (`POST /club-members/:id/unlink`, Better Auth `removeMember` via a `beforeRemoveMember` hook) writes a `returned` entry with the note "Konto entfernt" for every key it held; `/leave` and deleting the user fire no hook, there the cascade removes the holder row **without** a `returned` entry (open point). Existing holders were backfilled with one `issued` entry (note "Bestand bei Einführung der Schlüsselhistorie", date = migration time) |
| `/locations/:id/wifi` | GET, POST, PATCH `/:wifiId`, DELETE `/:wifiId` | session + `clubGuard` (write needs `locations:write`) | GET filters by `visibility` (`guest` → `gast`; member → `gast`+`mitglied`; `locations:write`/`locations:read_access` → all). Body `{ label, ssid, password?, security? ('open'\|'wpa'\|'wep'\|'wpa3'), visibility? ('gast'\|'mitglied'\|'vorstand', default mitglied), visibleToGuests? (legacy) }`; responses carry `visibility` + derived `visibleToGuests`, `security` and `qrPayload` (the `WIFI:T:WPA\|WEP\|SAE\|nopass;S:…;P:…;;` string for the QR code, special characters escaped, all-hex SSIDs/passwords quoted, WPA3 as `SAE`; built in `src/lib/wifi-qr.ts`). **Security rules (B14):** without `security` an empty/missing password means `open` and anything else `wpa` (legacy clients keep working); `open` never stores a password; every other type requires one (`422`); PATCH keeps type and password consistent (emptying the password of a network without explicit type makes it `open`, setting one on an open network makes it `wpa`). Migration `0021` set existing password-less networks to `open`, all others to `wpa`. Passwords are never written to `audit_log` |
| `/locations/:id/links` | GET, POST, PATCH `/:linkId`, DELETE `/:linkId` | session + `clubGuard` (write needs `locations:write`) | Same visibility filter as `/wifi`. Body `{ title, url, icon?, visibility?, visibleToGuests? }` |
| `/inventory-items` | GET, POST | session + `clubGuard` (write needs `inventory:write`) | Any member reads; query `locationId?`/`category?` filters. Body `{ name, category?, condition, locationId?, acquisitionValueCents?, acquiredAt?, maintenanceIntervalDays?, lastMaintenanceAt? }`. Responses include derived `maintenanceDue`/`maintenanceDueAt` (see [Data model](#data-model)) |
| `/inventory-items/:id` | GET, PATCH, DELETE | session + `clubGuard` (write needs `inventory:write`) | |
| `/inventory-items/:id/loans` | GET, POST | session + `clubGuard` | Self-service: POST always borrows for the caller (`memberId` = caller's own membership). Body `{ dueAt? }`. **`403` when the club switched self-service borrowing off (`club_settings.allow_self_loans = false`, default `true`); `inventory:write` holders are exempt.** Responses' `status` is the live-derived value (`"ueberfaellig"` overrides the stored value once past due) |
| `/inventory-items/:id/loans/:loanId` | PATCH | session + `clubGuard` | Marks returned. Allowed for the borrower themself or a caller with `inventory:write`. 409 if already returned |
| `/inventory-items/:id/damage-reports` | GET, POST | session + `clubGuard` | Self-service: POST always reports as the caller. Body `{ description, photoKey? }`: `photoKey` must be an unattached image the caller uploaded to this club via `POST /media` (claimed once in the same transaction, else `422` and no report). Responses carry `photoUrl` = short-lived signed URL (or `null`), never the key |
| `/inventory-items/:id/damage-reports/:reportId` | PATCH | session + `clubGuard` (`inventory:write`) | Body `{ status }`. `resolvedAt` auto-set when `status` becomes `"behoben"`, cleared otherwise |
| `/media` | POST | session + `clubGuard` (per-user limit 30/min) | Multipart upload, field `file`. JPEG/PNG/WebP, 10 MB, magic bytes + declared type, metadata stripped, club quota. `201 { data: { key, url, mimeType, sizeBytes } }` (`url` = signed preview URL); the file is registered `unattached` and claimed once by a feature route (`photoKey`). `422` for wrong/corrupt/oversized/empty files and `QUOTA_EXCEEDED` (`error.details.code` = `club_quota` for the club storage quota, `unattached_cap` for the per-user cap on unclaimed uploads) |
| `/media/<key>?exp=&sig=` | GET | **none** (signed URL) | Serves a registered, live, non-sensitive file after verifying the HMAC signature (`403` missing/wrong/expired/tampered — also for unknown keys, so keys cannot be probed; `404` valid signature but deleted/unknown/sensitive/file gone). `public_opt_in` files need no signature. Headers: registry `Content-Type`, `Cache-Control: private, max-age=<remaining>`, `nosniff`, `Cross-Origin-Resource-Policy: cross-origin` |

<a id="club-registration"></a>
### Club registration (Wave 6)

End users create clubs themselves, but a club only exists after a platform admin (Better Auth role `admin`) has reviewed it. Flow: applicant creates a draft, uploads proof documents, submits (`pending`); an admin requests more info (`needs_info`, applicant edits and resubmits), rejects (`rejected`, applicant may file a new registration) or approves (`approved`). The routes are session-only (no `clubGuard` — the applicant has no club yet) and need a verified e-mail address (403 otherwise). A registration is private: someone else's id is always 404. Everything below returns `{ data: ... }`.

`registration` shape: `{ id, clubName, legalForm ('e_v'|'nicht_eingetragen'|'sonstige'), registerCourt|null, registerNumber|null, street, postalCode, city, websiteUrl|null, claimedRole ('vorsitz'|'stellv_vorsitz'), status ('draft'|'pending'|'needs_info'|'approved'|'rejected'), reviewNote|null, slugSuggestion|null, clubId|null, clubSlug|null (approved only), submittedAt|null, createdAt, documents: [{ id, kind ('registerauszug'|'satzung'|'freistellungsbescheid'|'gruendungsprotokoll'|'sonstiges'), filename, mimeType, sizeBytes }] }`.

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/club-registrations` | POST | session, verified e-mail | Create a draft. Body `{ clubName, legalForm, registerCourt?, registerNumber?, street, postalCode, city, websiteUrl?, claimedRole? = 'vorsitz' }` (`e_v` requires court + number; `websiteUrl` must be http(s)). `201 { data: { registration } }`. 422 on invalid input, 409 if the user already has an open (`draft`/`pending`/`needs_info`) registration. Rate limit 10 per hour per client IP. Audit `club_registration.create` |
| `/club-registrations/mine` | GET | session | Own registrations, newest first: `{ data: [registration] }` |
| `/club-registrations/:id` | GET | session | `{ data: { registration } }`; 404 for someone else's/unknown/malformed id |
| `/club-registrations/:id` | PATCH | session | Partial update of the draft fields (merged result is re-validated), only in `draft`/`needs_info` (409 otherwise). `200 { data: { registration } }` |
| `/club-registrations/:id/documents` | POST | session | `multipart/form-data` with `file` + `kind`. Only in `draft`/`needs_info` (409). Allowlist PDF/JPEG/PNG (declared type must match the file's magic bytes), max 10 MB, max 5 files per registration, else 422. Upload and delete share a per-user limit of 30 per hour. Filename is sanitized (path separators stripped), stored under the private `registrations/<id>/` path. `201 { data: { document } }`. Audit `club_registration.document_add` |
| `/club-registrations/:id/documents/:docId` | GET | session (applicant or admin) | Streams the file as an attachment (`Content-Type` from the allowlist, `Cache-Control: private, no-store`, RFC 5987 `filename*`). Admins may only read submitted (non-draft) registrations; every admin access is audit-logged (`club_registration.document_access`, `accessedBy`). 404 for everyone else |
| `/club-registrations/:id/documents/:docId` | DELETE | session | Remove a document (only `draft`/`needs_info`, checked under the same row lock as submit/upload). `204`. Audit `club_registration.document_remove` |
| `/club-registrations/:id/submit` | POST | session | `draft`/`needs_info` → `pending`. Needs at least one qualifying proof (`e_v`/`sonstige`: Registerauszug, Satzung, Freistellungsbescheid or Gründungsprotokoll; `nicht_eingetragen`: Satzung or Gründungsprotokoll; `sonstiges` alone never counts) else 422. 409 if an already approved club has the same register court + number (compared case/whitespace-insensitively; the message leaks no club data). All checks run in one transaction after locking the registration row (so a parallel document delete cannot produce a `pending` registration without proof). Limited to 5 submits per user per day (429); the reviewer mail is sent at most once per hour per registration. Writes `slug_suggestion`, clears `review_note`, sends the receipt mail to the applicant and the review notification (see `CLUB_REVIEW_NOTIFY_EMAIL`). `200 { data: { registration } }`. Audit `club_registration.submit` |
| `/admin/club-registrations` | GET | session + `adminGuard` | Review queue, oldest submission first, max 200. `?status=pending\|needs_info\|approved\|rejected` (omitted: all except drafts; `draft`/unknown → 422). `{ data: [{ ...registration, applicant: { id, name, email }, duplicateHints: [{ clubId, name, city, postalCode }] }] }`. `duplicateHints` (max 10) lists existing clubs approved through a registration with the same Registergericht + number (listed first), with the same name/generated slug, or with the same postal code + city; `city`/`postalCode` are `null` for clubs not created via a registration |
| `/admin/club-registrations/:id` | GET | session + `adminGuard` | Same shape, one object in `data`. 404 for drafts/unknown ids |
| `/admin/club-registrations/:id/documents/:docId` | GET | session + `adminGuard` | Authenticated file download (404 for drafts; every access is audit-logged as `club_registration.document_access`) |
| `/admin/club-registrations/:id/request-info` | POST | session + `adminGuard` | Body `{ note }` (required) → `needs_info`, mail to the applicant. `200 { data: { registration } }`. Audit `club_registration.request_info` |
| `/admin/club-registrations/:id/reject` | POST | session + `adminGuard` | Body `{ note }` (required reason) → `rejected`, mail to the applicant. `200 { data: { registration } }`. Audit `club_registration.reject` |
| `/admin/club-registrations/:id/approve` | POST | session + `adminGuard` | Body `{ slug? }`. Creates the club, see [Approval](#club-registration-approval). `200 { data: { registration, club: { id, name, slug } } }` |

All three decisions only work from `pending`; any other status (or a lost race between two admins) is `409`. A non-admin session on `/admin/club-registrations/*` is rejected by `adminGuard` with `401`, same as every other `/admin` route.

<a id="club-registration-approval"></a>**Approval.** `approve` takes a row lock on the registration (`SELECT … FOR UPDATE`), so parallel approvals serialize and the loser answers 409 without creating a second club. Inside that lock it first re-checks the register key (court + number, same normalization as the submit guard) against already approved registrations (409 — two pending registrations can share a key), then calls `auth.api.createOrganization({ name, slug, userId })` (server-side, no session — makes the applicant `owner`; the organization's `metadata` carries `{ registrationId }`; if the call fails after inserting the organization but before its owner member, that owner-less organization is recognised by this tag and removed before the next slug is tried), then in the same transaction marks the registration `approved` (`club_id`, `reviewed_by`, `reviewed_at`), makes sure the founder has a `club_members` row (category `aktiv`, automatic member number `<ABBR>-0001`, see [Member numbers](#member-numbers); the five default categories are seeded) and inserts a `club_roles` row for `claimed_role`, and writes audit `club_registration.approve`. `claimed_role` must grant `members:write` and `roles:write` (`vorsitz`, `stellv_vorsitz` do; checked against `club-permissions.ts`; `schriftfuehrer` lacks `roles:write` and was therefore removed from `CLAIMABLE_ROLES` in Wave 7 B16 — decision: do not widen its rights, and `POST /club-registrations` answers `422` for it), so the founder can run the club right away (e.g. `GET /club-applications`). If anything fails after the organization was created, the organization is deleted again and a failed cleanup is logged (`logger.error`), never swallowed; the registration stays `pending` and can be retried.

<a id="club-slug-rules"></a>**Slug rules** (`src/lib/club-slug.ts`). The slug is the public join key of a club (`clubSlug` in `POST /club-members/apply`) and is generated, not chosen by the applicant: lowercase, umlauts/ß transliterated (`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, other accents dropped), legal-form additions (`e.V.`, `eV`, `eingetragener Verein`) removed, everything outside `a-z0-9` collapsed to single `-`, 3–50 characters (too short names get `-verein` appended, names without usable characters become `verein`). (`æ→ae`, `œ→oe`, `ø→o`, `ł→l`, `đ→d`, `þ→th` as well). Reserved slugs (`admin`, `api`, `app`, `www`, `demo`, `vereine`, `join`, `dashboard`, `docs`, `impressum`, `datenschutz`, `me`, …, see `RESERVED_SLUGS`; `verein` is deliberately allowed, it is the fallback) get `-verein` appended. The suggestion is stored at submit but only *assigned* on approval (open registrations reserve nothing, so no squatting); on collision `-2`, `-3`, … is appended, and a collision that happens between lookup and insert is retried (`organization_slug_uidx` is the final arbiter). An admin may override the slug in `approve` (`slug`, validated: `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–50, not reserved, 422; already taken → 409, no automatic suffix). **The slug is immutable once assigned**: `POST /api/auth/organization/update` with a different `slug` is rejected (403, `beforeUpdateOrganization` hook in `src/auth/auth.ts`).

The scaffold's `/accounts` and `/examples` routes (ownership-scoped example resource / connectivity-check) were removed in Wave 1 (see [Key decisions](#key-decisions)) — `src/routes/club-members.ts` is now the reference implementation for "a real, club-scoped resource" that a new route should copy the pattern from, in place of the old `accounts.ts`.

`/internal/stats` exists for a different kind of caller than everything else in this table: not an end user's browser/app, but another backend — a central fleet/portal tool aggregating KPIs across many deployed instances of this template (see `project-portal-backend` in the company's `project-portal` repo for a real consumer). That's why it's token-gated instead of session-gated: such a caller has no user account on this instance at all.

## Rights and read scoping (Wave 7 B7/B8)

**Deny-by-default.** Every account member (`member.role` `owner`/`member`; **not** external `guest`s such as guardians) implicitly holds the base role **`mitglied`**: `clubGuard` (`src/middleware/club-guard.ts`) puts it first in `clubRoleTypes`; it is never stored in `club_roles`, cannot be assigned/revoked (see `/club-members/:id/roles`) and `ROLE_PERMISSIONS.mitglied` is explicitly `[]`. Writes need a role that grants them explicitly; the rights matrix test below enforces it.

| Permission | vorsitz | stellv_vorsitz | schriftfuehrer | kassenwart | beisitzer | abteilungsleitung | trainer / erziehungsberechtigt / mitglied |
|---|---|---|---|---|---|---|---|
| `members:write` | x | x | x | | | | |
| `members:read_sensitive` | x | x | | x | | | |
| `roles:write` | x | x | | | | | |
| `departments:write` | x | x | | | | x | |
| `club_info:write` | x | x | x | | | | |
| `calendars:write` | x | x | x | | | x | |
| `meetings:write` | x | x | x | | | | |
| `meetings:read_board` (new) | x | x | x | | x | | |
| `locations:write` | x | x | x | | | x | |
| `locations:read_access` (new) | x | x | x | | | x | |
| `inventory:write` | x | x | x | | | x | |
| `club_stats:read` (now a regular permission) | x | x | x | x | x | | |

**Read scoping** (404, never 403, so existence does not leak):

| Resource | Rule |
|---|---|
| Meetings `type = vorstandssitzung` (list, detail, invitees, overlap, attendance, resolutions) | only invitees (`meeting_invitees`) and callers with `meetings:write` or `meetings:read_board`; the list filters them out |
| Meetings `mitgliederversammlung` / `sonstige` | every member of the club |
| Locations: `accessNote`, key holders, wifi/links with `visibility = vorstand` | only `locations:write` / `locations:read_access` (shape stays stable: `accessNote: null`, `keyHolders: []`, `accessRestricted: true`) |
| Key history (`GET /locations/:id/key-history`, B14) | like key holders: only `locations:write` / `locations:read_access`; plain members and guests `403` (dedicated endpoint, so no `accessRestricted` stub) |
| Member CSV export / import (B10) | export: `members:write` or `members:read_sensitive`, sensitive columns only with `members:read_sensitive` (`403` otherwise); import and template: `members:write`. Plain members and external guests `403` |
| Wifi/links `mitglied` / `gast` | members see `gast` + `mitglied`; `guest`-role callers only `gast`. The legacy flag `visibleToGuests: false` lowers a `gast` row to `mitglied` but never raises a `vorstand` row |
| **External guests** (`member.role = guest`, e.g. guardians) | **no meetings** (`404` on the list and every `/meetings/:id/*` read), **no member list** (`GET /club-members` → `403`), other members' detail/`departments`/`roles`/`guardians` → `404`; own row, `/club-members/me`, club info, calendars and `gast` wifi/links stay. Wave 10 brings dedicated guardian routes |
| **Former members and interessenten** in `/club-members` | callers with neither `members:write` nor `members:read_sensitive` only see members whose **effective** status is `probe`/`aktiv`/`ruhend` (list and detail; detail of others → `404`; the own row is always reachable); `status` filters only narrow that set. `/club-stats` is unchanged (counts only) |
| Age transition suggestions (`GET /club-members/transition-suggestions`) | `members:write` **and** `members:read_sensitive` (derived from birth dates); `apply` only `members:write`, it recomputes on locked rows |
| Access after leaving | `clubGuard` answers `404 "Club not found"` once the effective status is `ausgetreten`/`ausgeschlossen`/`verstorben` ([Exit workflow](#exit-workflow)) |
| Inventory | everyone reads; management `inventory:write`; borrowing and damage reports stay self-service, borrowing switchable per club via `club_settings.allow_self_loans` (`403` when off) |

**Migration `0016_roles-scoping`:** **not lossless** — `meetings.type` free text → `vorstandssitzung` (contains `vorstand` or `sitzung`) | `mitgliederversammlung` (contains `versammlung`) | `sonstige`; ambiguous legacy values therefore land in the more restricted type, and the original free-text value is **lost** (the column is overwritten; no backup column). Adds `location_wifi_networks.visibility`/`location_links.visibility` (backfilled from `visible_to_guests`, which is dropped) and `meeting_resolutions.correction_note/corrected_at/corrected_by`.

**Rights matrix test (`src/routes/rights-matrix.test.ts`, B12 part).** It lists every router mounted in `src/index.ts` (a sync check fails if `index.ts` gets a router the test does not know), enumerates all registered `POST/PATCH/PUT/DELETE` routes from the Hono app and calls each with an account holding **only** `mitglied`; the expected answer is **`403` only** (`404` only for routes listed in `MAY_BE_404`; the `/admin/*` routes may answer `401` because `adminGuard` does so for authenticated non-admins). A `401` would mean a dead session and make the matrix vacuous, so the test first verifies that every test account's session is valid (`GET /club-members/me` → 200), and then repeats the whole run with an **external guest** account; guests must also be refused the sensitive reads (meetings, member list). A router registered with `.all()` would escape the per-method enumeration, so the test forbids `.all()` handlers. Self-service routes (own profile/availability/RSVP/notifications, join request, founding application, loans, damage reports, media upload) are in the explicit `SELF_SERVICE` allowlist with a reason (new: accepting an own invitation, the own cancellation `POST /club-exit-requests`, withdrawing an own request). Body validation runs before most permission checks, so routes with required bodies need an entry in `SAMPLE_BODIES` (the test says so on a `422`). **A new writing route without a permission check, allowlist entry or sample body fails the test.**

## Adding a new API route

A checklist for a new dev adding an endpoint. `src/routes/club-members.ts` is the reference implementation for a club-scoped resource — it uses every piece described below in one file. Keep it open while you read this.

**1. Pick or create a route file.** One file per resource under `src/routes/` — a new resource gets a new file (`events.ts`, `inventory-items.ts`, ...), a new action on an existing resource is a new handler in that file. A club-scoped resource exports its own `Hono<ClubEnv>()` and needs `sessionGuard` **and** `clubGuard`, in that order (`ClubEnv` extends `SessionEnv` — see `src/middleware/club-guard.ts`); a resource with no club concept (rare) uses plain `Hono<SessionEnv>()` with just `sessionGuard`, like `src/routes/notifications.ts`.

```ts
export const widgetRoutes = new Hono<ClubEnv>();
widgetRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
widgetRoutes.use("*", sessionGuard);
widgetRoutes.use("*", clubGuard);
```

**2. Validate the input.** Define a Zod schema and wire it with `@hono/zod-validator`'s `zValidator`, throwing `ValidationError` — not a bare `c.json(..., 400)` — on failure, so bad input goes through the same error path as everything else:

```ts
const createWidgetSchema = z.object({ name: z.string().max(100) }).strict();

widgetRoutes.post(
  "/",
  zValidator("json", createWidgetSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const body = c.req.valid("json");
    // ...
  },
);
```

`.strict()` isn't decoration — it's what stops an extra body field from silently reaching a query.

**3. Guard it.** `sessionGuard` (`src/middleware/session-guard.ts`) for anything that needs a logged-in user, `clubGuard` (`src/middleware/club-guard.ts`) additionally for anything club-scoped, `adminGuard` for admin-only, nothing at all for a genuinely public read. If a handler touches one specific row, filter by *both* the row's id and `clubId`/the caller's id in the same query, and respond with `NotFoundError` — never `ForbiddenError` — when it belongs to a different club or a different person. A 403 confirms the row exists; a 404 doesn't. `club-members.ts`'s `GET /:id` is the example. For a permission check *within* a club a caller does belong to (board-only write, etc.), use `hasClubPermission(c.get("clubRoleTypes"), "...")` from `src/lib/club-permissions.ts` and throw `ForbiddenError` on failure — that one legitimately is a 403, since the caller already knows the club/row exists. **Every writing route must also be covered by the rights matrix test** (`src/routes/rights-matrix.test.ts`, see [Rights and read scoping](#rights-and-read-scoping-wave-7-b7b8)): either check a permission that a plain `mitglied` lacks, or add the route to its `SELF_SERVICE` allowlist with a reason (and a `SAMPLE_BODIES` entry if the body is validated before the permission check).

**4. Throw errors, don't format them.** Every class in `src/lib/errors.ts` (`NotFoundError`, `ConflictError`, `TooManyRequestsError`, ...) maps to its HTTP status in exactly one place: `app.onError` in `src/index.ts`. Throw the typed error from inside the route and stop thinking about status codes there.

**5. Talk to the DB through Drizzle.** Import `db` from `src/db/client.ts` and the table from `src/db/schema/*.ts`. A new column or table means editing/adding a schema file there, then:

```
npm run db:generate   # writes a migration from the schema diff
npm run db:migrate    # applies it locally
```

Commit the generated migration file — it's what actually runs on deploy, the schema file alone changes nothing in a running database.

**6. Mount the router.** One line in `src/index.ts`, alongside the existing `app.route("/club-members", clubMemberRoutes)`:

```ts
app.route("/widgets", widgetRoutes);
```

Ordering only matters *within* a single file: a static path (`/search`) has to be registered before a dynamic one (`/:id`) that would otherwise swallow it as a parameter value.

**7. Test against a real session and a real second club, not a mock.** Add `widgets.test.ts` next to the route file. Mount just that router plus `app.onError` in a throwaway `Hono` instance, create real (verified) users and at least two clubs through `auth.api.createUser`/`signInEmail`/`createOrganization`, and reuse the session cookies — `club-members.test.ts`'s `signUpAndVerify` helper is the one to copy. Always include a cross-club case (a member of club A requesting club B's data gets 404) — that's the one class of bug a mocked session/club would never catch. This needs a real `DATABASE_URL` (`docker compose up -d db` gives you one).

That's the whole loop — schema → route file → validate → guard → mount → test. None of it is a framework decision; it's copying `club-members.ts` and changing the domain-specific middle.

<a id="club-members-api"></a>
### Club members API contract (Wave 7 B3)

`GET /club-members`, `GET|PATCH /club-members/:id`, `POST /club-members` and `/club-members/me` all return this **member shape** (`:id` / `id` = `club_members.id`):

```jsonc
{
  "id": "uuid",                // club_members.id -- the canonical member id
  "memberId": "string|null",   // Better Auth member.id (null = no account)
  "userId": "string|null",
  "hasAccount": true,
  "name": "Display Name",      // club_members.display_name
  "status": "aktiv",           // stored: interessent|probe|aktiv|ruhend|ausgetreten|ausgeschlossen|verstorben
  "effectiveStatus": "aktiv",  // derived at read time: left_at <= today turns a live status into "ausgetreten" -- show/filter THIS
  "category": "jugend",        // category KEY (string, unchanged from before Wave 7) or null
  "categoryId": "uuid|null",
  "categoryName": "Jugend",
  "categoryObject": { "id": "uuid", "key": "jugend", "name": "Jugend", "votingRight": false },
  "joinedAt": "2024-01-31", "leftAt": null,
  "orgRole": "owner|member|null",      // Better Auth org role, null without account
  "roles": [{ "id", "roleType", "departmentId", "termEndsAt" }],   // [] without account
  "departments": [{ "id", "name", "since", "until" }],             // until != null = ended
  "photoUrl": "https://.../media/<key>?exp=&sig=|null",   // signed, short-lived; only for the own row, members:write, members:read_sensitive and linked guardians -- null for other plain members
  // only for the own row or with members:read_sensitive:
  "email": "account e-mail|null", "contactEmail": "...", "memberNumber": "DEMO-0001",
  "birthDate": "2012-04-05", "street": "", "postalCode": "", "city": "", "phone": "",
  "emergencyContactName": "", "emergencyContactPhone": "",
  "suggestedCategory": { "id": "uuid", "key": "aktiv", "name": "Aktiv" }   // or null: age transition proposal (B5)
}
```

E-mail semantics: `email` is the **account** e-mail (null without account), `contactEmail` is the **club contact** e-mail. After the backfill both start equal; they diverge as soon as either is edited (the contact e-mail is not synced with later account changes). Both are sensitive fields.

Backward-compatibility decisions: `category` was a string key before Wave 7 and **stays one** (the object form is the additive `categoryObject`/`categoryId`/`categoryName`); `orgRole`, `roles`, `userId`, `joinedAt`, `leftAt` keep their meaning; `PATCH` responses switch from the old `club_memberships` row to the full member shape (it contains the former fields `memberNumber`, `birthDate`, `emergencyContact*`, `joinedAt`, `leftAt`, `category`; `memberId` stays the account id). `id` of a member changed from `member.id` to `club_members.id` — old calls with a `member.id` in the URL keep working during the transition (non-uuid ids resolve as `member.id`); clients should switch to `id`. `name` is the club-managed display name (set from the account name at join time; it is not kept in sync with later account renames).

`GET /club-members` wraps the shape: `{ "data": [member shape], "page": 1, "pageSize": 50, "total": 123 }` (see the route table for the query parameters). **Breaking for old clients:** the list used to contain every member; it is now paged (default 50), so a client that ignores `total`/`page` silently shows only the first 50. `POST /club-members/:id/transition` returns `{ data: <member shape>, transition: {...} }`. `GET /club-members/categories` returns `{ data: [category] }`, `GET /club-stats` `{ data: stats }`; both shapes are listed below.

<a id="member-lifecycle"></a>**Member lifecycle (B5).** Statuses: `interessent`, `probe`, `aktiv`, `ruhend` (live) and `ausgetreten`, `ausgeschlossen`, `verstorben` (left). Allowed changes (source = the *effective* status, `STATUS_TRANSITIONS` in `src/lib/member-lifecycle.ts`):

| from | to |
|---|---|
| `interessent` | `probe`, `aktiv`, `ausgetreten` (withdrawn), `verstorben` |
| `probe` | `aktiv`, `ausgetreten`, `ausgeschlossen`, `verstorben` |
| `aktiv` | `ruhend`, `ausgetreten`, `ausgeschlossen`, `verstorben` |
| `ruhend` | `aktiv`, `ausgetreten`, `ausgeschlossen`, `verstorben` |
| `ausgetreten`, `ausgeschlossen`, `verstorben` | `aktiv` only, with `reopen: true` **and** a `reason` (else `422`) |

- Every change runs in one transaction under a row lock and writes `club_member_status_history` (from/to status, from/to category, `effectiveOn`, `reason`, `changedBy` = caller's `member.id`). A category-only change writes `fromStatus = toStatus`. `PATCH /club-members/:id` with a category change and the age-transition apply also write history.
- **Exit and key date (Stichtag):** a leaving status sets `left_at = effectiveOn` (default today; not before `joined_at`) and `exit_reason`. `effectiveOn` in the **future** is only allowed for `ausgetreten` (a cancellation to a key date): the stored status stays, `left_at` is set, the history entry carries the future date, and `effectiveStatus` becomes `ausgetreten` by derivation on that day — no cron job. Sending the stored status again while such an exit is pending takes it back (`kind: "cancel_exit"`). `ausgeschlossen`/`verstorben` and all non-leaving statuses cannot be dated in the future (`422`). `PATCH /club-members/:id` no longer accepts `leftAt` (`422`, "use POST /:id/transition"). **"Today" is the calendar day in Europe/Berlin** (`todayBerlin()` in `src/lib/member-lifecycle.ts`): an exit dated 1 July is effective from 00:00 CEST, not from 02:00; the status derivation, the age calculation, the key-date checks and `clubGuard` all use it.
- **No automatic revival:** `ausgeschlossen` and `verstorben` are not reopened by a re-join. A person with such a (detached) `club_members` row cannot be added again by application approval (`409`, `details.code = "member_rejoin_blocked"`), `addMember` or an accepted invitation (rejected by the Better Auth hooks `beforeAddMember`/`beforeAcceptInvitation`) until the board reopens the member via `transition` (`reopen: true`, reason). `ausgetreten` re-joins keep reusing the old row as before.
- **Normalisation and locking.** `autoTransitionToKey` is trimmed and lower-cased everywhere (create, PATCH; `" Aktiv "` names `aktiv`), so suggestions, archive clean-up and cycle detection agree. Multi-row writes lock in one fixed order — all categories of the club (`FOR NO KEY UPDATE`, id order; plain reads of a referenced category use `FOR SHARE`) → member rows (id order) → organization row (member numbers) — and the category lookup, the cycle check and the `from` side of the history all happen **inside** the transaction after the lock, so parallel archive / move / PATCH requests serialize instead of deadlocking or writing a stale `from` category.
- **Age transition:** a category with `autoTransitionToKey` + `maxAge` marks members older than `maxAge` (whole years from `birth_date`) as `suggestedCategory`; nothing changes until `POST /club-members/transition-suggestions/apply`.

<a id="club-kpis"></a>**Club KPIs (`GET /club-stats`, B11)** — permission `club_stats:read` (a real `ClubPermission` in `src/lib/club-permissions.ts`: `vorsitz`, `stellv_vorsitz`, `schriftfuehrer`, `kassenwart`, `beisitzer`; listed in `/club-members/me` → `permissions` for UI gating). Counts only, no personal data:

```jsonc
{ "data": {
  "members": { "total": 9, "active": 7, "withAccount": 5, "withoutAccount": 4 },
  "byStatus": { "interessent": 1, "probe": 1, "aktiv": 7, "ruhend": 1, "ausgetreten": 1, "ausgeschlossen": 0, "verstorben": 0 },
  "byCategory": [{ "key": "aktiv", "name": "Aktiv", "count": 7 }],
  "byDepartment": [{ "id": "uuid", "name": "Fußball", "count": 2 }],
  "ageBuckets": [{ "label": "0–5", "count": 0 }, { "label": "6–12", "count": 1 } /* 13–17, 18–29, 30–49, 50–64, 65+ */],
  "ageUnknown": 6,
  "movement": [{ "month": "2026-10", "joined": 6, "left": 1 }]   // last 12 months incl. the current one, oldest first
} }
```

Rules: a member counts independent of an account (ADR-003). `members.total` = effective status `probe`, `aktiv` or `ruhend` (`interessent` and everyone who left are not counted); `active` = `aktiv`; `withAccount` + `withoutAccount` = `total`. `byStatus` covers the whole club history with the effective status (a stored `aktiv` with `left_at <= today` counts as `ausgetreten`). `byCategory`/`byDepartment` (current assignments)/`ageBuckets` describe the counted population; archived categories only appear while they still have members; `ageUnknown` = counted members without `birth_date`. `movement.joined` = `joined_at` in the month (not `interessent`), `movement.left` = `left_at` of members who have left plus exits from the status history of members who were reopened later. **Accepted limitation (no k-anonymity):** the KPIs are exact counts with no minimum group size, so in a tiny category or age bucket a count of 1 identifies a person. This is deliberate — the readers are the board, who know their members anyway, and plain members have no access (`403`); it must be revisited before the numbers are shown to anyone else (e.g. a member-facing dashboard).

Member category shape: `{ id, key, name, votingRight, minAge, maxAge, autoTransitionToKey, sortOrder, archived, archivedAt, memberCount? }`.

<a id="exit-workflow"></a>**Exit workflow (B6).** Routes: `/club-settings`, `/club-exit-requests` (see the API table). Everything that changes the member goes through `transitionMember` — the same history, the same Stichtag derivation, the same matrix as `POST /club-members/:id/transition`.

- **Earliest exit date** (`earliestExitDate` in `src/lib/exit-notice.ts`, pure, Europe/Berlin): `requestedOn + noticePeriodDays`, then rounded **up** to the end of the month / quarter / year for `noticeMode` `month_end` / `quarter_end` / `year_end` (a date that already is such an end stays); `immediate` or no mode: no rounding; no settings: today. Examples with 30 days / `month_end`: request on 11 Oct → 30 Nov; request on 1 Nov → 31 Dec. `GET /club-exit-requests/preview?requestedOn=` returns it so clients can show the notice hint before submitting.
- **Cancellation by the member** (`POST /club-exit-requests`, own account): request `pending`, nothing changes yet. **Decision: a `desiredEffectiveOn` before the earliest date is raised to the earliest date, not refused** (`422` would make the member guess dates); the response says so (`adjustedToEarliest`) and shows `earliestEffectiveOn` / `proposedEffectiveOn = max(desired, earliest)`. A later wish is kept. One open request per member (`409`, enforced by a partial unique index), no second one while an exit is scheduled (`409`).
- **Board decisions.** `approve` takes `effectiveOn` (default = proposal, may be moved to a **later** date only; earlier than the earliest date → `422` with `details.earliestEffectiveOn`, computed from the request date and the *current* settings). The request is claimed with `UPDATE … WHERE status = 'pending'`; claim, `transitionMember` (→ `ausgetreten`) and audit run in one transaction, so a parallel approve/reject has exactly one winner and a failing transition leaves the request `pending`. A future date becomes a **scheduled exit** (`left_at` = date, stored status unchanged, `effectiveStatus` flips on the day — no job); today or earlier takes effect at once (a late approval of an in-time notice may carry a past date, never one before the earliest date). `reject` needs a note.
- **Recorded by the board** (`members:write`, `clubMemberId` in the body — the way to cancel for members without account): the decision is the caller's, so the request is stored `approved` immediately (no second click). Cancellation: `effectiveOn` default = earliest date, earlier → `422`. **Exclusion** (`kind: "exclusion"`): `reason` is mandatory, takes effect immediately (`ausgeschlossen`, `effectiveOn` today or earlier, never in the future), is audited, supersedes a pending cancellation of the same member (that request becomes `rejected`, note "Ersetzt durch Ausschluss"), and cannot be withdrawn — only `transition` with `reopen` brings the person back. The board cannot exclude itself (`422`).
- **Protected accounts.** Exclusion, a board-recorded cancellation and the *approval* of any request refuse (`409 details.code = owner_protected`) an organization **owner** account — nobody removes the owner through the workflow, and an owner cannot file their own cancellation either — and require `roles:write` (`vorsitz`/`stellv_vorsitz`) for holders of `vorsitz`/`stellv_vorsitz` (`403 board_protected`). `src/lib/member-protection.ts`.
- **Four eyes and consistency.** `approve` is refused for the requester (`403 self_approval`; board-recorded requests are created `approved` and never pass through it) and for a member with an already scheduled exit (`409 exit_already_scheduled`). A direct exit via `POST /club-members/:id/transition` closes the member's open requests (`rejected`, "Ersetzt durch direkte Statusänderung"). **Lock order** in this workflow is always member row first, then request rows (create, exclusion, approve, withdraw, transition), so parallel decisions serialize instead of deadlocking.
- **Withdrawal** (`POST /:id/withdraw`, the member for their *own* cancellation, otherwise `members:write` — a board member who merely recorded a request loses the right with `members:write`): `pending` → `withdrawn`; an approved cancellation that is not yet effective is withdrawn and the scheduled exit taken back in the same transaction; after the exit date it is `409`.
- **Return checklist** (`GET /club-exit-requests/:id`): live from open `inventory_loans` and `location_key_holders` of the member's **account** (both are account-bound, ADR-003 — a member without account always has an empty list). It informs; it does not block the approval.
- **End of access.** `clubGuard` answers `404 "Club not found"` for an account whose `club_members` row has the effective status `ausgetreten`/`ausgeschlossen`/`verstorben` — derived on every request (`left_at <= today` Europe/Berlin), no job. `/my-clubs` no longer lists such a club. As a consequence `GET /club-members/me` and `GET /club-exit-requests/mine` are **not reachable** for a former member either (documented decision: no club data after the exit). The club keeps the records (`club_members`, history, audit); retention/deletion is the data-protection concept of Wave 10. The account itself and its other clubs are untouched.
- **Re-joining.** A former member (`ausgetreten`) can re-apply with `POST /club-members/apply` and is re-admitted by the board's application approval (the existing row is reopened with reason "Wiederaufnahme per Aufnahmeantrag") or directly via `POST /club-members/:id/transition` with `reopen`. `ausgeschlossen`/`verstorben` persons are blocked (`409 member_rejoin_blocked`) until the board reopens them.
- Request shape: `{ id, clubMemberId, memberName, hasAccount, kind, status, requestedBy (member.id), requestedOn, desiredEffectiveOn, effectiveOn, earliestEffectiveOn (cancellations), proposedEffectiveOn (cancellations), reason, decidedBy, decidedAt, decisionNote, createdAt }`. Audit events `club_exit_request.create|approve|reject|withdraw` carry ids and dates only, never the free-text reason (it lives in `club_member_status_history`, readable with `members:read_sensitive`).

<a id="member-csv"></a>**Member CSV import/export (B10).** Replaces the Excel member list. Code: `src/lib/member-csv.ts` (parser, writer, formula escaping), `src/lib/member-import.ts` (mapping, row checks, duplicates, confirmation token), routes in `src/routes/club-members.ts` (registered before `/:id`).

- **File format.** UTF-8 (BOM allowed), delimiter auto-detected (`;` preferred, `,` or TAB), RFC 4180 quoting, header row required, blank lines skipped. Columns are recognised by name (case/umlaut/punctuation-insensitive, German and English): `Mitgliedsnummer`, `Name` (or `Vorname` + `Nachname`; the name is required), `Geburtsdatum`, `Kategorie` (key **or** name of a non-archived category; empty = `defaultCategoryKey`, default `aktiv`), `Status` (`interessent`/`probe`/`aktiv`/`ruhend`; empty = `aktiv`; leaving the club is not an import), `Eintrittsdatum` (empty = today), `Straße`, `PLZ`, `Ort`, `Telefon`, `E-Mail`, `Notfallkontakt`, `Notfalltelefon`. Dates: `YYYY-MM-DD` or `DD.MM.YYYY`, must be real calendar dates (birth date not in the future, not before 1900). Unknown columns are ignored and listed with `field: null`; `mapping: { "Spalte im File": "<field>" | "ignore" }` overrides the detection (field names: `memberNumber`, `displayName`, `firstName`, `lastName`, `birthDate`, `category`, `status`, `joinedAt`, `street`, `postalCode`, `city`, `phone`, `contactEmail`, `emergencyContactName`, `emergencyContactPhone`). A leading `'` in front of `=`, `+`, `-`, `@` (what the export adds) is removed, so an export can be re-imported.
- **Limits.** `MEMBER_IMPORT_MAX_ROWS` data rows (default 2000), `MEMBER_IMPORT_MAX_BYTES` (default 1 MiB), at most 60 columns, 500 characters per cell (field-specific limits like in `POST /club-members`) — over the file limits `422`, over the cell limits an error on that row. The parser aborts as soon as the row, column (60) or cell (2000 characters) limit is exceeded instead of reading the whole file; e-mail plausibility is a linear check (length ≤ 320 first, no regex), and `mapping` only honours own keys (no prototype keys).
- **Row checks (dry run).** Per row `ok`, `duplicate` or `error`. Error codes: `required`, `invalid_date`, `invalid_category`, `invalid_status`, `invalid_email`, `too_long`, `invalid_value` (control characters), `member_number_taken`, `member_number_duplicate_in_file`. **Duplicates** (skipped on commit, never an error): same name (case/whitespace-insensitive) **and** birth date, or same e-mail (compared with `contact_email` and the account e-mail of existing members), against the club's members and against earlier rows of the same file. Rows without birth date are only checked by e-mail. The report never echoes cell values.
- **Commit.** The dry run returns a stateless `confirmToken` (`HMAC-SHA256(BETTER_AUTH_SECRET)` over club, user, SHA-256 of file + mapping + default category, 30 min, unique per dry run, **single use**: the token id is stored in the `club_member.import` audit entry and checked under the organization lock, a second commit with the same token is `409 import_already_applied`). The commit needs the token of exactly that file for the same club and user; it then re-runs all checks **inside one transaction** (locks: categories → organization row, like every member write) and refuses with `422 import_has_errors` (nothing is written) if anything turned into an error since the dry run. Members are created without account (`member_id` NULL, link them later via invitation), with status history entry `reason: "import"`; explicit member numbers are inserted first, the remaining rows get numbers from the same generator as `POST /club-members` (`nextMemberNumber`, club prefix). One `audit_log` entry `club_member.import` per commit (counts, actor, SHA-256 of the file — no names).
- **Export.** Columns (keys for `columns=`): `memberNumber`\*, `displayName`, `firstName`, `lastName`, `birthDate`\*, `category`, `status` (effective status), `joinedAt`, `leftAt`, `street`\*, `postalCode`\*, `city`\*, `phone`\*, `contactEmail`\*, `emergencyContactName`\*, `emergencyContactPhone`\*, `departments` (current, comma-separated), `accountEmail`\* (\* = sensitive, needs `members:read_sensitive` — the same split as the member shape). Limit 50,000 rows. Headers are the German names of the template.
- Rate limit: `import-template`, `import` and `export` share a per-user limit (10/min; `MEMBER_CSV_RATE_LIMIT_PER_MINUTE`). Nothing in these paths logs cell values.

<a id="account-linking"></a>**Account linking (B4).** A member without account (ADR-003) gets a login by e-mail invitation:

1. `POST /club-members/:id/invite { email }` (board) — token = 32 random bytes (base64url) that exists **only in the mail**; the database keeps `HMAC-SHA256(BETTER_AUTH_SECRET, token)`. TTL `MEMBER_INVITE_TTL_DAYS` (default 14). A new invite for the same member replaces the open one (the old link dies). Mail: German, `buildMemberInviteEmail` in `src/lib/emailTemplate.ts`, all user text HTML-escaped, link `${WEB_ORIGIN}/einladung?token=…` (the **first** entry of `WEB_ORIGIN` if several are configured; the token travels in the query string — known limitation: it can land in browser history/proxy logs, mitigated by single use, 14-day TTL and the e-mail binding; the website page page `/einladung` reads the token, signs the person in or up, then calls preview/accept). A failed send is logged (error name and ids, **no address**) and reported as `emailSent: false`.
2. `POST /club-members/invites/preview { token }` — shows club and masked names so the invitee can check they are in the right place. `GET /club-members/invites/preview?token=` is **deprecated** (same answer plus a `Deprecation: true` header; the token would land in URLs/logs). The mail link stays `${WEB_ORIGIN}/einladung?token=…`; the website page reads the token and strips it from the address bar, then calls the POST endpoints. **Resend:** `POST /club-members/:id/invite/resend` (`members:write`) replaces the open invite by a new token and mails it to the same address (20/hour/user, shared with creation).
3. `POST /club-members/invites/accept { token }` — order of checks: token valid/unexpired/unused (`404`, always the same answer) → the account e-mail is **verified** and equals the invited address, case-insensitive (`403`; before anything about the account's own membership is revealed) → no rejoin block (`409`) → then one of two paths. **(a) The account is not yet a member of the club:** the token is **claimed atomically** (`UPDATE … WHERE accepted_at IS NULL AND expires_at > now()`), Better Auth `addMember` creates the account membership (the `afterAddMember` hook is told via an `AsyncLocalStorage` context not to create a second `club_members` row) and `club_members.member_id` of the **invited** row is set (same row, same number and history; `member_id` is unique). A failure after the claim removes what was created and releases the token. **(b) The account already is a member (own `club_members` row, e.g. joined by application before the board created the account-less record) — merge:** in ONE transaction (both rows locked in id order, token claimed inside it) the account membership (`member.id`, so roles, loans, keys, RSVPs, availability and led departments stay untouched) is linked to the **invited** row; the invited row keeps its member number, name, status, category and join date; profile fields it lacks (first/last name, birth date, address, phone, emergency contact, contact e-mail) and — only if it has none — the member number are copied from the own row; `guardian_links.ward_club_member_id` (duplicates dropped), `club_applications.club_member_id`, `form_submissions.subject_club_member_id` and `member_field_values` are repointed; a guardian link of the account to itself is removed; the own row is deleted (its creation history goes with it) and the trace stays in `audit_log` `club_member.merge` (ids only) plus the history entry `merged` on the kept row. **Merge conflicts (`409`, `details: { code: "merge_conflict", conflicts: [...] }`)** — the own row is not "untouched" if it has: a different member number than the invited row (`member_number`) — **heuristic:** if the own number has the club's automatic format (`PREFIX-NNNN`, prefix from `club_settings.member_number_prefix` or the slug abbreviation) it is simply discarded (the invited row's number stays; the merge audit notes only "own number discarded", never the number), a manual or differently formatted number stays a conflict; an external guest account (`member.role = guest`, `guest_account`), any department assignment (`departments`), a profile photo (`photo`), any status/category change or earlier link/merge (`status_history`; creation entries are fine), any exit request (`exit_requests`), or a custom field value the invited row also has (`custom_fields`). The error lists **kinds only** — no names, numbers or values of the other row — and consumes nothing (invitation stays valid; board-side resolution, e.g. unlink/delete one row and resend, is manual for now). Accepts of one account in one club are serialized (single replica) and a session-level Postgres **advisory lock per (club, account)** spans the whole accept: `ensureClubMember` (repair paths of `GET /club-members`, id resolution, `/me`) takes the same lock first, so a repair cannot create a competing `club_members` row. Two invitations to the same address end with one link; the second one then finds an account row that has history (link/merge entry) and answers `409 merge_conflict`. After the link the **inviting board member** (`created_by`, if still a member with `members:write` and an e-mail) gets a German notification mail with the member's display name and the club only (no token, no address; `buildMemberLinkedEmail`). Only sent to **active board members**: the inviter must still be an account member (not `guest`) with a `club_members` row that has not left, a verified e-mail and `members:write`. It is sent after lock and transaction are released, fire-and-forget with a 10 s timeout; a failure or hang is logged without address and never delays or fails the accept. The merge transaction runs with `lock_timeout` 5 s (a concurrent application approval for the same account could otherwise deadlock on the advisory lock vs. the application row); on timeout the accept answers `409 merge_busy` and can simply be repeated. History entry "Konto verknüpft (Einladung)" (or `merged`), audit `club_member.invite_accept` (`merged` flag).
4. `POST /club-members/:id/unlink` (board) — the reverse. Better Auth's own `removeMember` needs an organization owner/admin session and fires `afterRemoveMember` (which closes the row as an exit), so the `member` row is deleted directly in the same transaction and `club_members.account_unlinked_at` marks it as a **deliberate unlink**: status and `last_user_id` stay, `markDetachedMembersLeft` skips it (an account removed by Better Auth `removeMember`/`leave`/user deletion is still closed as `ausgetreten`), and a later re-join of the same person creates a new row. Refused for the caller's own account and owner accounts; board accounts (roles `vorsitz`…`beisitzer`) need `roles:write` (`403 board_protected`, `force` does not help); without `force` also refused (`409 account_has_open_items`) when anything would vanish with the account — `details: { openLoans, keys, guardianLinks, departmentsLed, eventRsvps, meetingInvites, roles }`. Application approval, club registration and `addMember` joins are unchanged.

## Configuration

All variables live in `.env.example`. The ones worth calling out specifically:

| Variable | Required | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | Signs/encrypts cookies and tokens. Generate with `npx @better-auth/cli secret` |
| `DATABASE_URL` | yes | Postgres connection string, shared by Drizzle and Better Auth's adapter |
| `WEB_ORIGIN` | yes | Website's origin, added to `trustedOrigins` |
| `MOBILE_SCHEME` | no | Mobile app's deep-link scheme, added to `trustedOrigins` for OAuth callbacks. Expo Go's dev-mode `exp://<lan-ip>:<port>` origin is trusted automatically instead (see `BACKEND_URL` below), no separate config needed for that |
| `BACKEND_URL` | yes | This server's own public URL, passed as `baseURL` so it doesn't guess its origin behind a reverse proxy. Its scheme (`http://` vs `https://`) also decides whether cookies are `Secure`-flagged and whether Expo Go's `exp://` origin is trusted — see `src/auth/auth.ts`'s `isHttpsDeployment` and [Security](#security) |
| `RESEND_API_KEY` / `EMAIL_FROM` | no | Enables real verification/reset-password e-mails via Resend. Unset in dev falls back to logging the e-mail instead of sending it |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` | no | Alternative e-mail path via your own SMTP server (`src/lib/email.ts`, `nodemailer`). Takes priority over `RESEND_API_KEY` when both are set — precedence is SMTP → Resend → dev log fallback |
| `DB_POOL_MAX` / `DB_POOL_MIN` / `DB_POOL_IDLE_TIMEOUT_MS` / `DB_POOL_CONNECTION_TIMEOUT_MS` | no | Explicit `pg` pool bounds — an unbounded pool was a documented weakness of a previous version of this stack |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | no | Consumed only by `npm run seed:admin`, never read by the running server |
| `INTERNAL_STATS_TOKEN` | no | Bearer token for `GET /internal/stats`. Unset means the endpoint always responds 503, not a silent 401 — fails closed by default. Generate any long random value, e.g. `openssl rand -hex 32` |
| `CLUB_REVIEW_NOTIFY_EMAIL` | no | Recipient(s) of the "new club registration to review" mail sent on `POST /club-registrations/:id/submit` — comma-separated for several. Unset: only a log warning, nothing fails. Mails around registrations (receipt, review notice, info request, rejection, approval with slug) are best effort: a send failure is logged and never blocks or rolls back a status change |
| `MEMBER_INVITE_TTL_DAYS` | no | Validity of a member invitation link in days (default `14`, clamped to 1–60; `src/lib/member-invites.ts`) |
| `MEMBER_IMPORT_MAX_ROWS` | no | Maximum data rows of a member CSV import (`POST /club-members/import`); default `2000`, clamped to 1–20000 |
| `MEMBER_IMPORT_MAX_BYTES` | no | Maximum size of the import CSV in bytes; default `1048576`, clamped to 1024–10485760 |
| `MEMBER_CSV_RATE_LIMIT_PER_MINUTE` | no | Per-user rate limit shared by the member CSV template/import/export routes; default `10` |
| `MEDIA_URL_TTL_SECONDS` | no | Validity of signed media URLs in seconds (default `1800`, clamped 30–86400; `src/lib/media-url.ts`) |
| `MEDIA_URL_SECRET` | no | HMAC key for signed media URLs. Unset falls back to `BETTER_AUTH_SECRET`; set a separate value to rotate media links independently of sessions |
| `MEDIA_QUOTA_BYTES_PER_CLUB` | no | Storage quota per club in bytes over live `media_files` (default `1073741824` = 1 GiB); exceeding it is `422 QUOTA_EXCEEDED` with `details.code = club_quota` |
| `MEDIA_UNATTACHED_TTL_HOURS` | no | Hours until an upload that no feature row claimed is swept (default `24`) |
| `MEDIA_UNATTACHED_MAX_FILES_PER_USER` / `MEDIA_UNATTACHED_MAX_BYTES_PER_USER` | no | Cap on unclaimed uploads per user (defaults `25` files / `52428800` bytes); exceeding it is `422 QUOTA_EXCEEDED` with `details.code = unattached_cap` |
| `PORT` | no | Port the Hono server listens on (default `3000`) |
| `COOKIE_DOMAIN` | no | Registrable base domain (e.g. `example.com`) for cross-subdomain session cookies; only effective when `BACKEND_URL` is `https://` |
| `BIND_HOST` | no | Host interface `compose.yml` binds the backend port to (default `127.0.0.1`, loopback only; set `0.0.0.0` only for LAN device testing). Read by compose, not by the Node process |
| `UPLOADS_DIR` | no | Local-disk root for uploaded files (photos and club registration proofs; only `src/lib/media.ts` reads/writes it) (defaults to `./uploads` for host-mode dev; the Docker image sets `/data/uploads`, mounted as the `uploads` named volume in `compose.yml` so the non-root `hono` user can write and files survive redeploys), served back through the media layer (signed `GET /media/<key>` or an authenticated stream). See `src/lib/storage.ts` |

The verification and password-reset e-mails are HTML, built by `src/lib/emailTemplate.ts` (`buildVerifyEmailEmail`/`buildResetPasswordEmail`) and wired up in `src/auth/auth.ts` (`emailVerification.sendVerificationEmail` and `emailAndPassword.sendResetPassword`) — no external template system, just template-literal HTML passed to `sendEmail()`. The card layout, colors, and `assets/lpj-its-logo.png` logo (embedded via `cid:`, see `sendEmail`'s `attachments` param in `src/lib/email.ts`) are LPJ IT-Solutions' generic template branding — the product name and primary color come from `src/project.config.ts` (`appName`/`primaryColor`, re-exported by `emailTemplate.ts` as `APP_NAME`/`BRAND.primary`); the rest of `BRAND` and the logo file are edited directly. The link target inside those e-mails is controlled by the client apps, not here — see the website's/mobile's own README for `NEXT_PUBLIC_SITE_URL`/`EXPO_PUBLIC_WEBSITE_URL`. Exception: for the password-reset e-mail, `sendResetPassword` appends a fallback `callbackURL` pointing at the website's `/reset-password` page (first `WEB_ORIGIN`) when the calling client doesn't pass a `redirectTo` — otherwise the emailed link would dead-end on the backend's callback handler (it rejects links without a `callbackURL`).

### Rebranding this template for a new project

| What | Where |
|---|---|
| Product name, primary color | `src/project.config.ts` (`appName`, `primaryColor`) — a plain TS module rather than JSON, since this repo's Node-ESM + tsx runtime needs an import attribute for JSON imports that a TS module doesn't. Also update the German subject lines in `src/auth/auth.ts` if you rename the product in a way that changes how they should read |
| Rest of the email brand palette | `src/lib/emailTemplate.ts`'s `BRAND` — kept in sync by hand with the website/admin templates' `--primary`/`--border` CSS tokens, since mail clients can't read CSS variables |
| Email logo | `assets/lpj-its-logo.png` — also update `Dockerfile`'s `COPY ... ./assets` step only if you rename the directory, not the file |
| Email language | `src/lib/emailTemplate.ts`/`src/auth/auth.ts`'s subject lines are hardcoded German (`lang="de"`) — there's no language on the user record to pick from, so a different default means editing these strings directly |
| Deployed origins / secrets | `.env` — `BETTER_AUTH_SECRET`, `DATABASE_URL`/`POSTGRES_*`, `WEB_ORIGIN`, `MOBILE_SCHEME`, `BACKEND_URL`, `COOKIE_DOMAIN` |
| First admin account | `.env`'s `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_NAME`, consumed once by `npm run seed:admin` |

## Security

- Session and token validation is entirely Better Auth's — there is no hand-rolled JWT verification anywhere in this codebase.
- Authorization is a typed access-control statement set (`src/auth/permissions.ts`), not scattered `if (user.role === ...)` checks.
- Every route that touches a specific row filters by both the row's ID and the caller's `ownerId` in the same query — a request for someone else's resource returns 404, never a 403 that would confirm the resource exists.
- CORS is locked to an explicit `trustedOrigins` list, never a wildcard.
- Cookies are `Secure`-flagged only when `BACKEND_URL` starts with `https://` (**not** `NODE_ENV`, which is unreliable for this — the Docker `backend` service always sets `NODE_ENV=production` for its own unrelated reason, even for plain-HTTP local/LAN/Expo-Go testing; keying `Secure` off that would make every spec-compliant HTTP client silently drop the session cookie post-sign-in). Same `isHttpsDeployment` signal also gates whether Expo Go's dev-mode `exp://` origin is trusted.
- `secureHeaders` sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, and a `Referrer-Policy`. There is deliberately no Content-Security-Policy here — this is a JSON API with no HTML to protect; the nonce-based CSP in the website template would be meaningless noise on this server.
- Rate limiting is in-memory and per-instance (expired buckets are swept once per window, so the maps don't grow without bound) and keyed by the `x-forwarded-for` header as sent by the client, falling back to one shared bucket — it is only meaningful behind a reverse proxy that overwrites that header; a directly exposed instance can have it spoofed. Sensitive per-account actions (registration submit, document upload/delete) therefore use an additional per-user key. Correct for this template's single-replica default, wrong once you run more than one backend replica behind a load balancer (each instance keeps its own counters). Swap `src/middleware/rate-limit.ts`'s `Map` for a Redis-backed limiter (for example `@upstash/ratelimit`) before scaling horizontally.
- Errors are normalized through `AppError`/`toAppError()` before they ever reach a response — an unhandled exception becomes an opaque 500 with a logged stack trace server-side, never a leaked internal message.
- **Media access control (Wave 7 B18).** `GET /media/<key>` needs a valid, unexpired HMAC signature that a feature route minted after its own permission check (plus a live registry row) — no signature, no file, and unsigned requests get `403` for unknown keys too (no key probing). Raw files are only reachable through `src/lib/media.ts`; keys are resolved against `UPLOADS_DIR` with a `path.resolve` + prefix check, and the registry (not the extension) decides the content type. Sensitive documents are never signed, only streamed authenticated and audited. Uploads are checked by magic bytes and stripped of EXIF/GPS. Responses are `Cache-Control: private` + `nosniff`. See [Data model](#data-model).
- **Club creation is server-side only.** `organization({ allowUserToCreateOrganization: false })` in `src/auth/auth.ts` makes Better Auth refuse `POST /api/auth/organization/create` for any signed-in user (before Wave 6 anyone with a session could create clubs with arbitrary slugs, i.e. squat join keys and become `owner`). `auth.api.createOrganization({ body: { userId } })` without a session — used by the registration approval and `npm run seed:club` — is treated as a system action and still works. Owners cannot delete their club (`disableOrganizationDeletion: true`; otherwise the freed slug could be re-squatted and the approved registration would be left with `club_id` NULL), cannot change its slug **or name** through `organization/update` (the reviewed name stays stable; other fields such as `logo` remain editable; renaming is a platform/DB operation), and `organization/check-slug` answers 404 (it would be a slug-existence oracle). See [Slug rules](#club-slug-rules).
- Registration proof documents are private and **sensitive media**: stored under `registrations/<id>/` (`media_files.club_id` NULL, `sensitive = true`), never a signed URL, served only through the authenticated applicant/admin download routes with an audit entry (`media.sensitive_access`, plus `club_registration.document_access` for admins) per retrieval, content type from a PDF/JPEG/PNG allowlist verified against the file's magic bytes (images lose EXIF/GPS), 10 MB / 5 files cap, client filenames sanitized. Retention/deletion of the proofs is not implemented yet (needs a scheduler).
- `GET /internal/stats` is deliberately **not** gated by a Better Auth session/`adminGuard` — its caller is another backend, with no user account here at all (see [API reference](#api-reference)). A single static token, compared with `crypto.timingSafeEqual` rather than `===` (constant-time, so a wrong guess can't be narrowed down via response timing), is the whole auth mechanism. It can only ever read this one aggregate endpoint — nothing else `adminGuard` protects is reachable with it.

## Key decisions

Short version of decisions with real consequences if reversed. Full ADRs for the ones that affect the whole suite live in the company vault, not duplicated here in full.

- **Better Auth as the single identity provider.** No hand-rolled JWT verification, no second session mechanism anywhere in the suite. A previous Keycloak-based backend had incomplete JWT audience validation; centralizing on one library's own session lookups closes that entire class of bug rather than patching one instance of it.
- **One shared Postgres for auth and domain data**, not a separate identity database. This is what makes the transactional `audit_log` writes possible, and it's the reason a project doesn't need a second database just to add its own tables next to Better Auth's.
- **In-memory rate limiting**, not a Redis dependency, as the template default. Correct for a single instance, a real trade-off once you scale — see [Security](#security). Adding a new dependency for a template that might never need it would be the wrong default; the upgrade path is documented in the code, not built in advance.
- **Resend with a console-log dev fallback for e-mail**, rather than requiring an e-mail provider account just to run the template locally. `requireEmailVerification: true` needs *some* way to actually send the verification link — logging it in development means the flow is fully testable with zero external accounts, and production just needs one API key.
- **`/accounts` and `/examples` removed in Wave 1**, not kept alongside the real domain (see [MyCouple's precedent](../../lpj-its-vault/30_Engineering%20&%20Tech/System%20Design/MyCouple/Data%20Model%20-%20MyCouple%20Backend.md) for the same call in a sister product) — dead scaffold routes are attack surface and reader confusion, not a feature.
- **Two-tier role model: Better Auth `member.role` (coarse) + `club_roles.roleType` (fine), never merged into one.** `member.role` only gates Better-Auth-native org actions; every MyVerein-specific permission (`members:write`, `roles:write`, `departments:write`, `club_info:write`) is derived from `club_roles` via `src/lib/club-permissions.ts`'s config-code mapping, not a database rights-matrix table — the mapping changes per deployment, not per club at runtime, so a table would be complexity with no real flexibility payoff. See the company vault's Architecture Overview - MyVerein §7 for the full reasoning.
- **`POST /club-members/apply` creates a pending application; a board member decides.** Since Wave 5 the Concept doc's "digitaler Aufnahmeantrag" is a real approval queue: `/apply` only inserts into `club_applications` (`pending`), and `POST /club-applications/:id/approve` (needs `members:write`) creates the Better Auth `member` + `club_members` row, `/reject` closes it without one. One pending application per user+club (partial unique index `WHERE status = 'pending'`), re-applying after a rejection is allowed. This replaces the Wave 1 simplification of granting membership immediately.
- **`guardian_links` is board-managed only, never self-service.** A guardian membership (externe Rolle) must never be able to grant itself visibility into an arbitrary member's data — only a caller with `members:write` can create or remove a guardian↔ward link.
- **Calendars reuse the existing two-tier permission model, not a new rights system.** `calendars:write`/`meetings:write` are two more entries in `src/lib/club-permissions.ts`'s `ClubPermission` union and `ROLE_PERMISSIONS` map, same config-code pattern as `members:write`/`roles:write`/etc — no new database rights-matrix table for Wave 2. Reversing this (a bespoke calendar ACL system) would mean two different authorization models to reason about in one codebase for no real gain, since the existing mapping already handles "which roles can do X."
- **Terminfindung shows raw overlap data, not an auto-ranked best-slot suggestion.** `GET /availability/overlap` and `GET /meetings/:id/overlap` return every candidate's per-member availability and stop there — the board picks manually. This is an explicit Wave 2 scope decision, not a missing feature; building a ranking/scoring algorithm on top would mean guessing at a board's real-world scheduling constraints (quorum, who's indispensable, etc.) that this data model doesn't capture.
- **`GET /events.ics` is session-gated, not a public link.** Every other calendar-adjacent route requires a session; the iCal feed does too, which means a calendar app can't subscribe to it without embedding a user's credentials. A public/token-based feed URL is a real, still-open question flagged in the Wave 2 plan, deliberately deferred rather than shipped half-thought-through (e.g. a leaked link would expose event data indefinitely with no way to scope or revoke it without also breaking every legitimate subscriber).
- **RSVP capacity is enforced with `SELECT ... FOR UPDATE`, added after review found a race.** The first cut counted confirmed attendees without locking the event row; under READ COMMITTED, two concurrent RSVPs at `capacity - 1` could both read "under capacity" and both get seated. The row lock serializes RSVP (and cancel/waitlist-promotion) requests against the same event instead of trusting an unlocked read-then-write. Removing the lock would silently reintroduce the overbooking race under real concurrent load, not just in theory.
- **WiFi passwords are plain `text`, not a Zero-Knowledge vault entry.** Unlike a per-person secret, a club WiFi password is deliberately shared with a whole role group — there's no individual to keep it secret from within the club, only from unauthorized guests, which `visibleToGuests` already handles server-side. Adding client-side crypto for this would be real complexity (device key management, no-recovery-if-lost UX) for a threat model this data doesn't have.
- **Media goes through one security layer: keys in tables, signed short-lived URLs in responses.** Copied from MyCouple's access-control fix instead of repeating its mistake: authorization happens where the feature route already decides (member list, damage reports, locations, club info), the route then signs; `GET /media/*` needs no cookie because a native `Image` cannot send one. Sensitive documents are the exception (authenticated stream + audit). Member photos (also in the club-info board list) are visible by default only to the person, `members:write`/`members:read_sensitive` and, in member shapes, linked guardians (E6, consent management follows in Wave 10); minors (known birth date < 18) cannot set their own photo — with an unknown birth date the own photo is allowed, but it is never shown to third parties without those rights. No image-processing dependency (E6): metadata is stripped structurally, no thumbnails yet. Replaces the earlier session-gated `GET /media/:key` (which guessed the type from the extension, had no registry/quota/audit and forced a cookie).

## Deployment

`deploy.sh` (repo root) is a general-purpose deploy/redeploy script, part of
this template — every project scaffolded via `create-better-auth-app` gets
it automatically, since it's just a file in this repo. It's docker-compose
based (build + a `db` dependency) and mirrors the suite-wide
`redeploy-websites.sh`'s calling convention (positional args, manual-env-file
→ Infisical → standard secrets fallback), so a Jenkins pipeline for this
repo can call it the same way an existing website pipeline calls
`redeploy-websites.sh`:

```groovy
pipeline {
    agent any

    environment {
        SERVER_IP = "<server-ip>"
        SSH_USER = "jenkins"
        SSH_CREDENTIAL_ID = "<jenkins-ssh-credential-id>"
        TARGET_DIR = "/var/www/vhosts/<domain>/httpdocs"
        PORT = "3000"
        INFISICAL_PROJECT_ID = "<infisical-project-id>"
        INFISICAL_URL = "https://app.infisical.com/api"
    }

    stages {
        stage('Checkout Code') {
            steps {
                checkout scm
            }
        }

        stage('Deploy to Server') {
            steps {
                sshagent([SSH_CREDENTIAL_ID]) {
                    sh "ssh -o StrictHostKeyChecking=no ${SSH_USER}@${SERVER_IP} 'mkdir -p ${TARGET_DIR}'"
                    // Excludes .git and Jenkinsfile, same as the website pipelines --
                    // deploy.sh travels with the rest of the repo, so no separate
                    // "two directories up" shared script needed like
                    // redeploy-websites.sh.
                    sh "rsync -rlvz --exclude='.git' --exclude='Jenkinsfile' ./ ${SSH_USER}@${SERVER_IP}:${TARGET_DIR}/"

                    sh """
                    ssh -o StrictHostKeyChecking=no ${SSH_USER}@${SERVER_IP} '
                        cd ${TARGET_DIR} &&
                        sudo ./deploy.sh deploy ${PORT} ${INFISICAL_PROJECT_ID} ${INFISICAL_URL}
                    '
                    """
                }
            }
        }
    }
}
```

`./deploy.sh deploy [port] [infisical-project-id] [infisical-domain] [env-file]`
always binds to `127.0.0.1` (not `compose.yml`'s own local/LAN-dev default of
`0.0.0.0`) — this script represents an actual deploy, so the raw port is
never exposed to the internet directly, only through whatever reverse proxy
sits in front of it. Run without arguments for an interactive menu (deploy,
restart without rebuilding, seed/promote an admin).

## Operations

Common procedures. Longer, execution-ready runbooks (including things you'd only need once, like restoring from a backup) live in the company vault's `20_Products/Better Auth Template Suite/Known Issues & Runbooks/`.

**Media endpoint behind a proxy.** The per-IP rate limit of `GET /media/*` (and every other limiter without a user key) uses the `x-forwarded-for` header as sent by the client; there is no `TRUST_PROXY` switch. Run the backend only behind a reverse proxy that **overwrites** that header with the real client IP — without a proxy all clients without the header share one bucket (`unknown`, 600 requests/minute for media), and with a proxy that merely appends, a client can pick its own bucket. Media links are signed, so a bypassed limiter does not expose files, only request volume. Rotate `MEDIA_URL_SECRET` (or `BETTER_AUTH_SECRET` if it is the fallback) to invalidate all issued media links at once.

**Rotate `BETTER_AUTH_SECRET`.** Every existing session and signed cookie becomes invalid the moment the secret changes — treat it as a "log everyone out" operation, not a silent hot-swap. Generate a new one with `npx @better-auth/cli secret`, update it wherever the backend reads its environment (`.env`, your host's secret store), and restart the process.

**Promote a user to admin.** `npm run seed:admin` is idempotent: if `ADMIN_EMAIL` already exists, it promotes that account to `role: "admin"` and marks it verified instead of erroring. Safe to re-run. That `npm` script only works host-mode (`tsx`, a devDependency, isn't in the production image) — against a deployed container, use `./deploy.sh seed-admin` instead (see [Deployment](#deployment)), which prompts for the email/password/name interactively rather than reading them from `.env`.

**Check readiness before routing traffic.** `GET /ready` is the one that actually checks Postgres; `GET /health` intentionally never touches the database, so point your orchestrator's liveness probe at `/health` and its readiness/load-balancer registration at `/ready` — not the other way around.

**Website/admin stuck in a login loop in production, across subdomains.** By default Better Auth scopes the session cookie to the exact host that answered sign-in. Deploying the backend and its clients on *different* subdomains of the same domain (e.g. `app.example.com` for the website, `api.example.com` for this backend, `admin.example.com` for an admin dashboard) means the cookie the backend sets is invisible to the other subdomains unless explicitly widened. Sign-in itself still succeeds (200, valid session in the response body) — the loop happens purely because the follow-up request from the website/admin carries no cookie at all. Fix: set `COOKIE_DOMAIN` in `.env` to the shared *registrable* domain (`example.com`, not `api.example.com`) — `src/auth/auth.ts` already reads it and enables Better Auth's `crossSubDomainCookies` for it, gated behind `isHttpsDeployment` (see that file's comment for why the gate matters — an unconditional `Domain` there would silently break local/LAN dev). No code change needed for this specific fix, just the env var.

**Then verify the fix actually shipped before touching anything else** — an env var change alone does not fix a *running* deployment:

```bash
curl -si -X POST https://api.example.com/api/auth/sign-in/email \
  -H "Content-Type: application/json" -d '{"email":"...","password":"..."}' | grep -i set-cookie
```

Confirm `Domain=example.com` is present in the output. If it's missing, the *running container* is still using the old `.env` — a `docker compose restart` doesn't re-read `.env`, and a `build` that raced an old crash-looping container and never actually became the live one leaves the old config running indefinitely with no error anywhere (check `docker container list`'s `IMAGE` column for a bare hash instead of the expected tag — that's the tell). Always `docker compose down && docker compose up -d` (recreate, not restart) after a `.env` change in production, and re-run the `curl` check above to confirm before assuming it's fixed. Don't chase CORS or `SameSite`/`__Secure-` cookie-prefix theories first — verify the actual `Set-Cookie` header with `curl` before forming a hypothesis; it rules out or confirms most of the credible causes in one step.

## Testing and CI

`npm test` runs Vitest: 702 tests across 55 files as of the last full run (2026-10-12) (run it from a checkout without nested `.claude/worktrees`, Vitest would pick up their copies of the tests too; or add `--exclude '.claude/**'`). The test files share one database and run in parallel, so assertions must be scoped to their own club. `migration-roles-scoping.test.ts` occasionally logs an unhandled `57P01` (a scratch database dropped while a pooled connection is still open) without failing a test. Unit tests for `club-slug.ts` (slugify rules, reserved words, collision suffixes), `club-registration-mail.ts`, the rate limiter (including per-user keys), `permissions.ts`, `club-permissions.ts`, `errors.ts`, the rate-limit middleware, `availability-match.ts`'s Terminfindung precedence logic, and `ics.ts`'s RFC 5545 writer need nothing running; the club-scoping/permission integration tests — `club-members.test.ts`, `club-applications.test.ts`, `club-registrations.test.ts` (Wave 6: closed `organization/create` and immutable slug, registration lifecycle, approval effects incl. owner/role/member number/immediate permissions, request-info + resubmit, double and parallel decisions, parallel slug collision, compensation, one open registration per user, IDOR, admin gating, upload hardening, duplicate guard, mail failures not blocking, owner cannot delete/rename the club or probe slugs, per-user submit limit, delete-vs-submit race, register-key duplicate on approve, orphan organization cleanup, audit of admin document access), `club-members-foundation.test.ts` (Wave 7 B2/B3: every join path creates `club_members`, account-less members, `POST/PATCH` rules, member-number `409`, e-mail/address only with `members:read_sensitive`, IDOR with `club_members` ids and foreign ids, `member.id` fallback, roles `409` without account, departments, guardians with an account-less ward), `club-members-lifecycle.test.ts` (review fixes: no sensitive data in write responses, member-number robustness/validation, parallel numbering, removal and re-join, lazy closing, invitation hook, repair and consistency check, approve race, guardian read gating, `mitglied` 403 on all write routes), `club-members-b5.test.ts` (Wave 7 B5: status matrix and history, Stichtag derivation and scheduled exit, reopen rules, categories CRUD incl. key immutability / cycles / archiving with `moveTo`, age suggestions and apply, excluded person cannot re-join), `club-members-review-fixes.test.ts` (review fixes: external guests read no meetings/member list, `autoTransitionToKey` normalisation incl. suggestion/archive/cycle, `leftAt` rejected on PATCH, suggestions right, former members hidden from plain members, natural member-number sort, parallel archive/move/PATCH and cycle races without deadlock), `club-exit-requests.test.ts` (Wave 7 B6: club settings, notice preview, member cancellation incl. clamping/duplicate/parallel submit, approve/reject/withdraw races, return checklist, board-recorded cancellation and exclusion, end of access in `clubGuard`/`/my-clubs`, re-admission, audit without free text, club scoping), `club-member-invites.test.ts` (Wave 7 B4: token lifecycle — valid, expired, reused, wrong account, wrong/unverified e-mail, merge of an untouched own row, `merge_conflict` without leaking the other row, parallel merge accepts, inviter notification, POST preview, resend incl. shared limit —, parallel accepts, club scoping, mail failure without address in the log, per-user rate limit, unlink is not an exit and is not reused on re-join), `media.test.ts` (Wave 7 B18 media layer: magic bytes, declared type, EXIF/GPS stripped from the stored bytes for JPEG/PNG/WebP, size/empty/corrupt rejection, per-club quota incl. parallel uploads, signed URL valid/missing/wrong/expired/tampered/other-key → 403, unknown/deleted/sensitive/file-gone → 404, no key probing, `public_opt_in`, legacy files, sensitive streaming with audit), `club-members-photo.test.ts` (B13: own and board-managed upload/replace/delete, visibility for self/board/guardian/plain member/unlinked guardian, club scoping, minors, club-info board photos), `club-members-apply-codes.test.ts` (B15: `ALREADY_MEMBER`/`APPLICATION_PENDING` incl. parallel apply), `media-gate.test.ts` (grep gate), `migration-media-layer.test.ts` (journal order, snapshot chain, `0019` data path), unit tests `image-sanitize.test.ts`, `media-url.test.ts`, `exit-notice.test.ts` (month/quarter/year rounding, leap years, year change) and `member-invites.test.ts`, `club-members-list.test.ts` (B9: paging/filter/sort/search incl. no oracle for callers without `members:read_sensitive`; B11: `/club-stats` against reference data, board-only access, no personal data), unit tests `member-lifecycle.test.ts` and `club-stats.test.ts` (matrix, derivation and age suggestion with a fixed date, `todayBerlin` around 00:30 CEST, KPI aggregation), `migration-member-edgecases.test.ts`, `migration-member-foundation.test.ts` (migrates a scratch database to Wave 6 state, loads sample data, applies `0014`, checks backfill, count check, idempotency and the guardian move; needs a role that may `CREATE DATABASE`), `calendars.test.ts`, `events.test.ts`, `availability.test.ts`, `meetings.test.ts` — and the `internal-stats.test.ts` token-gate tests and `admin-clubs.test.ts` (admin gating, club total + pending-registration count, per-user clubs ordering/validation/limit) all need a real `DATABASE_URL` (the same Postgres `docker compose up -d db` gives you) since they exercise actual sign-up/sign-in/organization-creation against Better Auth and real cross-club IDOR checks rather than mocking either. `events.test.ts` covers the capacity-1 waitlist flow end to end (second RSVP gets `"warteliste"`, then gets promoted once the first cancels) sequentially — it doesn't fire concurrent requests, so the row lock itself is exercised by inspection/code review rather than a dedicated race test. `.github/workflows/ci.yml` runs lint, `tsc --noEmit`, migrations, build, and the full test suite against a Postgres service container on every push and pull request.

## How this fits into the template suite

```mermaid
flowchart LR
    Mobile["_template_better-auth-mobile"]
    Web["_template_better-auth-website"]
    Backend["_template_better-auth-backend"]
    ViewOnly["_template_website-view-only"]

    Mobile --> Backend
    Web --> Backend
```

Both `_template_better-auth-website` and `_template_better-auth-mobile` are pure clients of this server — neither has a session store, a user table, or any auth logic of its own. The website calls this API directly from the browser (see its `src/lib/auth-client.ts`); the mobile app does the same over `@better-auth/expo`'s client plugin, with sessions in the OS keychain via `expo-secure-store`. This server registers the matching server-side `expo()` plugin (`src/auth/auth.ts`) — required, not optional, since the mobile client sends a custom `expo-origin` header instead of a real `Origin` (native `fetch` can't set that reserved header), and better-auth's own origin-check middleware would otherwise reject every authenticated mutation the mobile app makes. `_template_website-view-only` has no backend connection at all and is unrelated to this server. Adding a new client to the suite means pointing `createAuthClient({ baseURL })` at this backend's `BACKEND_URL` and adding that client's origin to `trustedOrigins` — nothing here needs to change to support it.

## License

See [LICENSE](./LICENSE).

---

&copy; [lpj.app](https://github.com/lpj-app). Proprietary -- all rights reserved.
